/**
 * Calendar collector — meeting load & time-shape signal (design §4).
 *
 * On macOS the Calendar app keeps a unified local store at
 * `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`.
 * **Any account added to Calendar.app — including a work Outlook/Exchange
 * account — syncs into this one DB**, so reading it captures Teams/Outlook
 * meetings without touching Microsoft Graph or any remote API (local-first, §8).
 *
 * Schema (verified against live data, may shift between macOS versions — keep
 * parsing defensive):
 *   - `CalendarItem` — one row per event: `summary`, `start_date`/`end_date`
 *     (Core Data epoch: seconds since 2001-01-01, see `CORE_DATA_EPOCH`),
 *     `all_day`, `has_attendees`, `calendar_id`, `UUID`/`unique_identifier`.
 *     `entity_type = 2` is an event (NOT the documented EventKit `0` — the
 *     on-disk code differs); reminders/other types are excluded.
 *   - `Calendar` — `title`, `store_id`; `Store.type` distinguishes account kinds.
 *   - `Participant` — attendees, joined by `owner_id = CalendarItem.ROWID`.
 *
 * We read a **read-only temp copy** (with its `-wal`/`-shm`) so a running
 * Calendar.app is never disturbed and recent (still-in-WAL) events aren't missed.
 * Emits one `meeting` event per calendar item. Metadata only — but titles can
 * name people/projects, so a titled or attended meeting is `medium` sensitivity.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, extractTicket, makeEvent, stableEventId } from "../events.ts";

/** Core Data reference date (2001-01-01 UTC) in unix seconds. */
const CORE_DATA_EPOCH = 978_307_200;
/** The on-disk `entity_type` for a calendar event (verified; not EventKit's 0). */
const ENTITY_TYPE_EVENT = 2;
/** Default capture window: trailing days of history (time-shape is backward-looking). */
const DEFAULT_SINCE_DAYS = 120;

/** The standard macOS unified Calendar store. */
export function defaultCalendarDb(): string {
  return join(
    homedir(),
    "Library",
    "Group Containers",
    "group.com.apple.calendar",
    "Calendar.sqlitedb",
  );
}

function coreDataToMs(value: number): number {
  return Math.round((value + CORE_DATA_EPOCH) * 1000);
}

function msToCoreData(ms: number): number {
  return ms / 1000 - CORE_DATA_EPOCH;
}

interface ItemRow {
  ROWID: number;
  summary: string | null;
  start_date: number;
  end_date: number | null;
  all_day: number | null;
  has_attendees: number | null;
  status: number | null;
  uuid: string | null;
  unique_identifier: string | null;
  cal_title: string | null;
  store_type: number | null;
}

export interface CollectOptions {
  /** Path to `Calendar.sqlitedb` (defaults to the macOS group container). */
  dbPath?: string;
  /** Capture window start, epoch ms (default: `sinceDays` ago). */
  since?: number;
  /** Capture window end, epoch ms (default: now). */
  until?: number;
  /** Trailing-window size when `since` is unset (default 120). */
  sinceDays?: number;
}

/**
 * Collect `meeting` events from the local macOS Calendar store. Never throws and
 * never writes the source DB: a missing/locked DB yields `[]`. Pass `dbPath` to
 * point at a fixture (used by tests).
 */
export function collect(opts: CollectOptions = {}): Event[] {
  const dbPath = opts.dbPath ?? defaultCalendarDb();
  if (!existsSync(dbPath)) return [];
  const until = opts.until ?? Date.now();
  const since = opts.since ?? until - (opts.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000;

  const dir = mkdtempSync(join(tmpdir(), "postcaptain-cal-"));
  const copy = join(dir, "Calendar.sqlitedb");
  // Copy the WAL/SHM too so events not yet checkpointed into the main file are seen.
  copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }

  // The copy is disposable, so open read-write (avoids readonly+WAL replay issues);
  // the real DB is never opened.
  const db = new Database(copy);
  try {
    const attendees = attendeeCounts(db);
    const rows = db
      .query(
        `SELECT ci.ROWID, ci.summary, ci.start_date, ci.end_date, ci.all_day,
                ci.has_attendees, ci.status, ci.UUID AS uuid, ci.unique_identifier,
                c.title AS cal_title, s.type AS store_type
           FROM CalendarItem ci
           LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
           LEFT JOIN Store s ON c.store_id = s.ROWID
          WHERE ci.entity_type = ?
            AND ci.start_date IS NOT NULL
            AND ci.start_date >= ? AND ci.start_date < ?
          ORDER BY ci.start_date ASC`,
      )
      .all(ENTITY_TYPE_EVENT, msToCoreData(since), msToCoreData(until)) as ItemRow[];
    return rows.map((r) => toEvent(r, attendees.get(r.ROWID) ?? 0));
  } catch {
    return [];
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Attendee count per CalendarItem ROWID, in one pass (avoids N+1). */
function attendeeCounts(db: Database): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const rows = db
      .query("SELECT owner_id, COUNT(*) AS c FROM Participant GROUP BY owner_id")
      .all() as { owner_id: number | null; c: number }[];
    for (const r of rows) if (r.owner_id != null) out.set(r.owner_id, r.c);
  } catch {
    // Participant table absent/odd — fall back to has_attendees per row.
  }
  return out;
}

function toEvent(r: ItemRow, attendeeCount: number): Event {
  const startMs = coreDataToMs(r.start_date);
  const endMs = r.end_date != null ? coreDataToMs(r.end_date) : startMs;
  const allDay = Boolean(r.all_day);
  const durationMin = Math.max(0, Math.round((endMs - startMs) / 60_000));
  const title = r.summary ?? "";
  const attendees = attendeeCount || (r.has_attendees ? 1 : 0);
  // Pure time-blocks (all-day, no attendees) are low-signal; titled/attended
  // meetings can name people or projects → medium (design §4/§8).
  const sensitivity = allDay && attendees === 0 ? "low" : "medium";
  const naturalKey = r.uuid ?? r.unique_identifier ?? String(r.ROWID);

  return makeEvent({
    eventId: stableEventId("calendar", naturalKey),
    kind: "meeting",
    source: "calendar",
    ts: startMs,
    sensitivity,
    project: null,
    ticket: extractTicket(title),
    payload: {
      title,
      startMs,
      endMs,
      durationMin,
      allDay,
      attendeeCount: attendees,
      calendar: r.cal_title ?? null,
      storeType: r.store_type ?? null,
      status: r.status ?? null,
    },
  });
}
