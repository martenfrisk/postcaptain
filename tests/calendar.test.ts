/**
 * Tests for the Calendar collector against a synthetic `Calendar.sqlitedb` that
 * mirrors the live macOS schema (CalendarItem / Calendar / Store / Participant,
 * Core Data REAL dates, entity_type=2 for events).
 *
 * NOTE: the *collector logic* is verified here, but the real target — a work
 * Outlook/Exchange account synced into macOS Calendar — must be validated on the
 * machine that actually has it. This machine's calendar is sparse/personal.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collectors/calendar.ts";

const CORE_DATA_EPOCH = 978_307_200;
const cd = (ms: number) => ms / 1000 - CORE_DATA_EPOCH;

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "postcaptain-cal-test-"));
  dbPath = join(root, "Calendar.sqlitedb");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Item {
  rowid: number;
  summary: string | null;
  startMs: number;
  endMs: number;
  allDay?: number;
  hasAttendees?: number;
  uuid?: string;
  entityType?: number;
  calendarId?: number;
}

function seed(items: Item[], participants: { ownerId: number }[] = []): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE Store (ROWID INTEGER PRIMARY KEY, type INTEGER);
    CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT, store_id INTEGER);
    CREATE TABLE CalendarItem (
      ROWID INTEGER PRIMARY KEY, summary TEXT, start_date REAL, end_date REAL,
      all_day INTEGER, has_attendees INTEGER, status INTEGER, calendar_id INTEGER,
      entity_type INTEGER, UUID TEXT, unique_identifier TEXT
    );
    CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY, owner_id INTEGER, email TEXT);
    INSERT INTO Store (ROWID, type) VALUES (1, 2);
    INSERT INTO Calendar (ROWID, title, store_id) VALUES (1, 'Work', 1);
  `);
  const ins = db.query(
    `INSERT INTO CalendarItem (ROWID, summary, start_date, end_date, all_day, has_attendees, status, calendar_id, entity_type, UUID)
     VALUES ($id, $s, $sd, $ed, $ad, $ha, 1, $cal, $et, $uuid)`,
  );
  for (const it of items) {
    ins.run({
      $id: it.rowid,
      $s: it.summary,
      $sd: cd(it.startMs),
      $ed: cd(it.endMs),
      $ad: it.allDay ?? 0,
      $ha: it.hasAttendees ?? 0,
      $cal: it.calendarId ?? 1,
      $et: it.entityType ?? 2,
      $uuid: it.uuid ?? `uuid-${it.rowid}`,
    });
  }
  const pins = db.query("INSERT INTO Participant (owner_id, email) VALUES ($o, $e)");
  participants.forEach((p, i) => {
    pins.run({ $o: p.ownerId, $e: `p${i}@example.com` });
  });
  db.close();
}

const BASE = Date.parse("2026-06-10T09:00:00Z");
const HOUR = 3_600_000;
const WINDOW = { since: BASE - 30 * 86_400_000, until: BASE + 30 * 86_400_000 };

test("returns [] when the calendar DB does not exist", () => {
  expect(collect({ dbPath: join(root, "nope.sqlitedb"), ...WINDOW })).toEqual([]);
});

test("maps events: time conversion, duration, attendee count, and stable id", () => {
  seed(
    [{ rowid: 10, summary: "Sprint planning", startMs: BASE, endMs: BASE + HOUR, hasAttendees: 1 }],
    [{ ownerId: 10 }, { ownerId: 10 }, { ownerId: 10 }],
  );
  const events = collect({ dbPath, ...WINDOW });
  expect(events.length).toBe(1);
  const e = events[0]!;
  expect(e.kind).toBe("meeting");
  expect(e.source).toBe("calendar");
  expect(e.ts).toBe(BASE); // Core Data REAL → epoch ms round-trips
  expect(e.eventId).toBe("calendar:uuid-10");
  expect(e.payload.durationMin).toBe(60);
  expect(e.payload.attendeeCount).toBe(3); // from the Participant join, not has_attendees
  expect(e.payload.calendar).toBe("Work");
  expect(e.sensitivity).toBe("medium"); // titled + attended
});

test("excludes non-event entity types and anything outside the window", () => {
  seed([
    { rowid: 1, summary: "In window", startMs: BASE, endMs: BASE + HOUR },
    { rowid: 2, summary: "A reminder", startMs: BASE, endMs: BASE + HOUR, entityType: 5 },
    {
      rowid: 3,
      summary: "Long ago",
      startMs: BASE - 200 * 86_400_000,
      endMs: BASE - 200 * 86_400_000 + HOUR,
    },
  ]);
  const events = collect({ dbPath, ...WINDOW });
  expect(events.map((e) => e.payload.title)).toEqual(["In window"]);
});

test("all-day, unattended blocks are low sensitivity; a ticket key is extracted from the title", () => {
  seed([
    { rowid: 1, summary: "OOO", startMs: BASE, endMs: BASE + 86_400_000, allDay: 1 },
    {
      rowid: 2,
      summary: "ABC-123 design review",
      startMs: BASE + HOUR,
      endMs: BASE + 2 * HOUR,
      hasAttendees: 1,
    },
  ]);
  const events = collect({ dbPath, ...WINDOW });
  const byTitle = new Map(events.map((e) => [e.payload.title, e]));
  expect(byTitle.get("OOO")!.sensitivity).toBe("low");
  expect(byTitle.get("OOO")!.payload.allDay).toBe(true);
  expect(byTitle.get("ABC-123 design review")!.ticket).toBe("ABC-123");
});

test("is idempotent — same UUIDs produce the same event ids across runs", () => {
  seed([{ rowid: 7, summary: "Standup", startMs: BASE, endMs: BASE + HOUR, uuid: "fixed-uuid" }]);
  const a = collect({ dbPath, ...WINDOW });
  const b = collect({ dbPath, ...WINDOW });
  expect(a[0]!.eventId).toBe("calendar:fixed-uuid");
  expect(a[0]!.eventId).toBe(b[0]!.eventId);
});
