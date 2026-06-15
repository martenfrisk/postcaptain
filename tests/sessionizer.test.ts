import { expect, test } from "bun:test";
import { type Event, type EventKind, makeEvent } from "../src/events.ts";
import { DEFAULT_GAP_MS, sessionize } from "../src/sessionizer.ts";

let seq = 0;
function ev(
  ts: number,
  opts: { ticket?: string | null; project?: string | null; kind?: EventKind } = {},
): Event {
  return makeEvent({
    eventId: `e${seq++}`,
    kind: opts.kind ?? "ai_interaction",
    source: "copilot",
    ts,
    sensitivity: "sensitive",
    payload: {},
    project: opts.project ?? "repo",
    ticket: opts.ticket ?? null,
  });
}

const MIN = 60 * 1000;

test("contiguous events on one key form a single session", () => {
  const sessions = sessionize([
    ev(0, { ticket: "ABC-1" }),
    ev(5 * MIN, { ticket: "ABC-1" }),
    ev(10 * MIN, { ticket: "ABC-1" }),
  ]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.eventCount).toBe(3);
  expect(sessions[0]!.durationMs).toBe(10 * MIN);
  expect(sessions[0]!.key).toBe("ABC-1");
});

test("a gap beyond the threshold splits the session", () => {
  const sessions = sessionize([
    ev(0, { ticket: "ABC-1" }),
    ev(DEFAULT_GAP_MS + 1, { ticket: "ABC-1" }),
  ]);
  expect(sessions).toHaveLength(2);
});

test("a ticket switch splits even without a gap", () => {
  const sessions = sessionize([ev(0, { ticket: "ABC-1" }), ev(MIN, { ticket: "ABC-2" })]);
  expect(sessions).toHaveLength(2);
  expect(sessions.map((s) => s.key)).toEqual(["ABC-1", "ABC-2"]);
});

test("keys on ticket, falling back to project", () => {
  const [s] = sessionize([ev(0, { ticket: null, project: "myrepo" })]);
  expect(s!.key).toBe("myrepo");
  expect(s!.ticket).toBeNull();
  expect(s!.project).toBe("myrepo");
});

test("unsorted input is ordered, and per-kind counts + max sensitivity track", () => {
  const a = ev(10 * MIN, { ticket: "ABC-1", kind: "commit" });
  const b = ev(0, { ticket: "ABC-1", kind: "ai_interaction" });
  const sessions = sessionize([a, b]);
  expect(sessions).toHaveLength(1);
  const s = sessions[0]!;
  expect(s.startTs).toBe(0);
  expect(s.endTs).toBe(10 * MIN);
  expect(s.kinds.ai_interaction).toBe(1);
  expect(s.kinds.commit).toBe(1);
  expect(s.sensitivity).toBe("sensitive");
});

test("empty input yields no sessions", () => {
  expect(sessionize([])).toEqual([]);
});
