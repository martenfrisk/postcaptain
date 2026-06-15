import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, makeEvent } from "../src/events.ts";
import { EventStore } from "../src/store.ts";

let dir: string;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "postcaptain-store-"));
  store = new EventStore(join(dir, "t.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ev(overrides: Partial<Event> = {}): Event {
  return makeEvent({
    eventId: "copilot:s:r",
    kind: "ai_interaction",
    source: "copilot",
    ts: 1000,
    sensitivity: "sensitive",
    payload: { prompt: "hi", tokensEst: 3 },
    project: "repo",
    ticket: "ABC-1",
    ...overrides,
  });
}

test("roundtrip", () => {
  expect(store.add(ev())).toBe(true);
  const got = store.query({ kind: "ai_interaction" });
  expect(got).toHaveLength(1);
  expect(got[0]!.eventId).toBe("copilot:s:r");
  expect(got[0]!.payload.tokensEst).toBe(3);
  expect(got[0]!.ticket).toBe("ABC-1");
});

test("insert is idempotent", () => {
  expect(store.add(ev())).toBe(true);
  expect(store.add(ev())).toBe(false); // same eventId → ignored
  expect(store.count()).toBe(1);
});

test("query filters and ordering", () => {
  store.addMany([
    ev({ eventId: "a", ts: 100, project: "p1", ticket: "ABC-1" }),
    ev({ eventId: "b", ts: 200, project: "p2", ticket: "ABC-2" }),
    ev({ eventId: "c", ts: 300, project: "p1", ticket: "ABC-1" }),
  ]);
  expect(store.query({ project: "p1" })).toHaveLength(2);
  expect(store.query({ ticket: "ABC-2" })).toHaveLength(1);
  expect(store.query({ since: 150, until: 250 })).toHaveLength(1);
  expect(store.query().map((e) => e.eventId)).toEqual(["a", "b", "c"]);
});
