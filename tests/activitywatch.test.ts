/**
 * Tests for the ActivityWatch collector against a synthetic aw-server (peewee)
 * datastore: `bucketmodel` + `eventmodel`, one bucket per watcher, events whose
 * `datastr` is the watcher's JSON data dict.
 *
 * NOTE: AW is not installed on the dev machine, so this verifies the collector
 * *logic* against the documented schema — validate on a real AW install.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, parseAwTimestamp } from "../src/collectors/activitywatch.ts";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "postcaptain-aw-test-"));
  dbPath = join(root, "peewee-sqlite.v2.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Bucket {
  key: number;
  id: string;
  type: string;
}
interface AwEvent {
  bucketKey: number;
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
}

function seed(buckets: Bucket[], events: AwEvent[]): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE bucketmodel (
      key INTEGER PRIMARY KEY, id TEXT, created TEXT, name TEXT,
      type TEXT, client TEXT, hostname TEXT, datastr TEXT
    );
    CREATE TABLE eventmodel (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bucket_id INTEGER,
      timestamp TEXT, duration REAL, datastr TEXT
    );
  `);
  const bi = db.query(
    "INSERT INTO bucketmodel (key, id, type, client, hostname) VALUES ($k, $id, $t, 'c', 'host')",
  );
  for (const b of buckets) bi.run({ $k: b.key, $id: b.id, $t: b.type });
  const ei = db.query(
    "INSERT INTO eventmodel (bucket_id, timestamp, duration, datastr) VALUES ($b, $ts, $d, $data)",
  );
  for (const e of events) {
    ei.run({ $b: e.bucketKey, $ts: e.timestamp, $d: e.duration, $data: JSON.stringify(e.data) });
  }
  db.close();
}

const BASE = Date.parse("2026-06-10T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOW = { since: BASE - 7 * 86_400_000, until: BASE + 7 * 86_400_000 };

const BUCKETS: Bucket[] = [
  { key: 1, id: "aw-watcher-afk_host", type: "afkstatus" },
  { key: 2, id: "aw-watcher-window_host", type: "currentwindow" },
  { key: 3, id: "aw-watcher-vscode_host", type: "app.editor.activity" },
  { key: 4, id: "aw-watcher-web-chrome_host", type: "web.tab.current" },
];

test("parseAwTimestamp handles both the space and ISO renderings as UTC", () => {
  const ms = Date.parse("2026-06-10T10:00:00.000Z");
  expect(parseAwTimestamp("2026-06-10 10:00:00+00:00")).toBe(ms);
  expect(parseAwTimestamp("2026-06-10T10:00:00Z")).toBe(ms);
  expect(parseAwTimestamp("2026-06-10 10:00:00.000000")).toBe(ms); // no tz → assumed UTC
});

test("returns [] when the datastore does not exist", () => {
  expect(collect({ dbPath: join(root, "nope.db"), ...WINDOW })).toEqual([]);
});

test("maps each bucket type to the right kind, payload, and sensitivity", () => {
  seed(BUCKETS, [
    { bucketKey: 1, timestamp: iso(BASE), duration: 300, data: { status: "not-afk" } },
    { bucketKey: 2, timestamp: iso(BASE), duration: 120, data: { app: "Slack", title: "general" } },
    {
      bucketKey: 3,
      timestamp: iso(BASE + 1000),
      duration: 600,
      data: { file: "src/x.ts", project: "budgetera", language: "typescript", branch: "ABC-9-fix" },
    },
    {
      bucketKey: 4,
      timestamp: iso(BASE + 2000),
      duration: 90,
      data: { url: "https://x.dev", title: "Docs" },
    },
  ]);
  const byKind = new Map(collect({ dbPath, ...WINDOW }).map((e) => [e.kind, e]));

  expect(byKind.get("afk")!.payload.status).toBe("not-afk");
  expect(byKind.get("afk")!.sensitivity).toBe("low");

  expect(byKind.get("focus")!.payload.app).toBe("Slack");
  expect(byKind.get("focus")!.sensitivity).toBe("medium");

  const edit = byKind.get("edit")!;
  expect(edit.payload.project).toBe("budgetera");
  expect(edit.project).toBe("budgetera");
  expect(edit.ticket).toBe("ABC-9"); // pulled from the branch
  expect(edit.payload.durationMin).toBe(10);

  expect(byKind.get("reading")!.payload.url).toBe("https://x.dev");
});

test("skips unknown bucket types and events outside the window", () => {
  seed(
    [...BUCKETS, { key: 9, id: "aw-watcher-strange_host", type: "mystery.bucket" }],
    [
      { bucketKey: 2, timestamp: iso(BASE), duration: 60, data: { app: "Code", title: "in" } },
      { bucketKey: 9, timestamp: iso(BASE), duration: 60, data: { foo: "bar" } }, // unknown type
      { bucketKey: 2, timestamp: iso(BASE + 30 * 86_400_000), duration: 60, data: { app: "late" } },
    ],
  );
  const events = collect({ dbPath, ...WINDOW });
  expect(events.length).toBe(1);
  expect(events[0]!.payload.app).toBe("Code");
});

test("produces stable, idempotent event ids across runs", () => {
  seed(BUCKETS, [
    { bucketKey: 2, timestamp: iso(BASE), duration: 60, data: { app: "Code", title: "t" } },
  ]);
  const a = collect({ dbPath, ...WINDOW });
  const b = collect({ dbPath, ...WINDOW });
  expect(a[0]!.eventId).toBe("activitywatch:aw-watcher-window_host:1");
  expect(a[0]!.eventId).toBe(b[0]!.eventId);
});
