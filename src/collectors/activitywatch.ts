/**
 * ActivityWatch collector — the whole-day time-shape signal (design §4).
 *
 * ActivityWatch runs a local server (`aw-server`) that stores everything in a
 * local SQLite (peewee ORM) — no cloud. Watchers each write to a *bucket*; the
 * bucket `type` says which watcher, and every event is `{timestamp, duration,
 * data}` where `data` is a small JSON dict. We map the common bucket types onto
 * our event kinds:
 *
 *   - `afkstatus`            → `afk`     `{status, durationSec}`
 *   - `currentwindow`        → `focus`   `{app, title, durationSec}`  (the generic backbone)
 *   - `app.editor.activity`  → `edit`    `{file, project, language, durationSec}`  (aw-watcher-vscode)
 *   - `web.tab.current`      → `reading` `{url, title, durationSec}`  (aw-watcher-web)
 *
 * Reading all buckets generically means the user's *install footprint is their
 * choice* — full window+afk watchers, or just the VS Code watcher — without any
 * code change here. Unknown bucket types are skipped.
 *
 * Like the other collectors this is read-only and never disturbs the source: it
 * copies the (WAL-active, server-locked) DB to temp and reads the copy. Targets
 * the default Python `aw-server` (peewee `bucketmodel`/`eventmodel` schema). The
 * Rust server uses a different schema and is not yet supported.
 *
 * NOTE: developed against AW's documented schema + fixtures — not installed on
 * the dev machine, so verify on a machine actually running ActivityWatch.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Event,
  type EventKind,
  extractTicket,
  makeEvent,
  type Sensitivity,
  stableEventId,
} from "../events.ts";

const DEFAULT_SINCE_DAYS = 30; // window events are dense; keep the default window modest

/** The default macOS `aw-server` (peewee) datastore. */
export function defaultActivityWatchDb(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "activitywatch",
    "aw-server",
    "peewee-sqlite.v2.db",
  );
}

export interface CollectOptions {
  /** Path to the aw-server peewee SQLite (defaults to the macOS location). */
  dbPath?: string;
  /** Capture window start, epoch ms (default: `sinceDays` ago). */
  since?: number;
  /** Capture window end, epoch ms (default: now). */
  until?: number;
  /** Trailing-window size when `since` is unset (default 30). */
  sinceDays?: number;
}

interface RawRow {
  event_id: number;
  timestamp: string;
  duration: number;
  datastr: string;
  bucket_id: string;
  bucket_type: string;
}

/**
 * Parse an aw-server timestamp into epoch ms. AW stores UTC; peewee may render
 * it as `YYYY-MM-DD HH:MM:SS.ffffff+00:00` or ISO with `T`. Normalize both, and
 * assume UTC when no offset is present.
 */
export function parseAwTimestamp(value: string | number): number {
  if (typeof value === "number") return value;
  let t = value.trim();
  if (t.includes(" ") && !t.includes("T")) t = t.replace(" ", "T");
  if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  return Date.parse(t);
}

/** Bucket type → our event kind. Returns null for types we don't model. */
function kindForBucket(type: string): EventKind | null {
  const t = type.toLowerCase();
  if (t.includes("afk")) return "afk";
  if (t.includes("editor")) return "edit";
  if (t.includes("web")) return "reading";
  if (t.includes("currentwindow") || t === "window" || t.includes("window")) return "focus";
  return null;
}

/**
 * Collect time-shape events from a local ActivityWatch datastore. Never throws
 * and never writes the source: a missing/locked/foreign-schema DB yields `[]`.
 * Pass `dbPath` to point at a fixture (used by tests).
 */
export function collect(opts: CollectOptions = {}): Event[] {
  const dbPath = opts.dbPath ?? defaultActivityWatchDb();
  if (!existsSync(dbPath)) return [];
  const until = opts.until ?? Date.now();
  const since = opts.since ?? until - (opts.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000;

  const dir = mkdtempSync(join(tmpdir(), "postcaptain-aw-"));
  const copy = join(dir, "aw.db");
  copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }

  const db = new Database(copy);
  try {
    // Date-level lower bound is safe for both timestamp renderings (space or T);
    // precise filtering happens in JS after parsing.
    const sinceDay = new Date(since).toISOString().slice(0, 10);
    const rows = db
      .query(
        `SELECT e.id AS event_id, e.timestamp, e.duration, e.datastr,
                b.id AS bucket_id, b.type AS bucket_type
           FROM eventmodel e
           JOIN bucketmodel b ON e.bucket_id = b.key
          WHERE e.timestamp >= ?
          ORDER BY e.timestamp ASC`,
      )
      .all(sinceDay) as RawRow[];

    const events: Event[] = [];
    for (const r of rows) {
      const kind = kindForBucket(r.bucket_type);
      if (!kind) continue;
      const ts = parseAwTimestamp(r.timestamp);
      if (!Number.isFinite(ts) || ts < since || ts >= until) continue;
      const data = parseData(r.datastr);
      events.push(toEvent(kind, ts, Number(r.duration) || 0, data, r.bucket_id, r.event_id));
    }
    return events;
  } catch {
    return []; // foreign schema (e.g. aw-server-rust) or unexpected shape
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseData(datastr: string): Record<string, unknown> {
  try {
    const d = JSON.parse(datastr);
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toEvent(
  kind: EventKind,
  ts: number,
  durationSec: number,
  data: Record<string, unknown>,
  bucketId: string,
  awEventId: number,
): Event {
  const durationMin = Math.round((durationSec / 60) * 100) / 100;
  let payload: Record<string, unknown>;
  let sensitivity: Sensitivity;
  let project: string | null = null;
  let ticket: string | null = null;

  if (kind === "afk") {
    payload = { status: str(data.status) ?? "unknown", durationSec, durationMin };
    sensitivity = "low";
  } else if (kind === "edit") {
    const file = str(data.file) ?? null;
    project = str(data.project) ?? null;
    ticket = extractTicket(str(data.branch), project, file ?? undefined);
    payload = { file, project, language: str(data.language) ?? null, durationSec, durationMin };
    sensitivity = "medium"; // file/project names are identifiers (§8)
  } else if (kind === "reading") {
    payload = {
      url: str(data.url) ?? null,
      title: str(data.title) ?? null,
      durationSec,
      durationMin,
    };
    sensitivity = "medium"; // URLs/titles can be sensitive
  } else {
    // focus (active window)
    payload = {
      app: str(data.app) ?? null,
      title: str(data.title) ?? null,
      durationSec,
      durationMin,
    };
    sensitivity = "medium"; // window titles can leak doc names / message snippets
  }

  return makeEvent({
    eventId: stableEventId("activitywatch", bucketId, awEventId),
    kind,
    source: "activitywatch",
    ts,
    sensitivity,
    project,
    ticket,
    payload,
  });
}
