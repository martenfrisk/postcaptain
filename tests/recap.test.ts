import { expect, test } from "bun:test";
import { type Event, type EventKind, makeEvent } from "../src/events.ts";
import { availableDays, dailyRecap, dayOf } from "../src/recap.ts";

let seq = 0;
function ev(kind: EventKind, ts: number, payload: Record<string, unknown>, ticket?: string): Event {
  return makeEvent({
    eventId: `e${seq++}`,
    kind,
    source: kind === "commit" ? "github" : "copilot",
    ts,
    sensitivity: "sensitive",
    project: "repo",
    ticket: ticket ?? null,
    payload,
  });
}

// 2026-01-02T10:00:00Z and same-day later; plus a different day.
const D1 = Date.parse("2026-01-02T10:00:00Z");
const D1_LATER = Date.parse("2026-01-02T10:20:00Z");
const D2 = Date.parse("2026-01-03T09:00:00Z");

test("dayOf and availableDays", () => {
  expect(dayOf(D1)).toBe("2026-01-02");
  const days = availableDays([ev("commit", D1, {}), ev("commit", D2, {})]);
  expect(days).toEqual(["2026-01-03", "2026-01-02"]); // most recent first
});

test("recap aggregates AI usage, commits, sessions and tickets for a day", () => {
  const events = [
    ev(
      "ai_interaction",
      D1,
      { tokensEst: 100, agentMode: "agent", model: "copilot/gpt-4.1" },
      "ABC-1",
    ),
    ev(
      "ai_interaction",
      D1_LATER,
      { tokensEst: 50, agentMode: "ask", model: "copilot/gpt-4.1", isCanceled: true },
      "ABC-1",
    ),
    ev("commit", D1_LATER, { insertions: 10, deletions: 3 }, "ABC-1"),
    ev("ai_interaction", D2, { tokensEst: 999 }, "ABC-2"), // different day, excluded
  ];
  const r = dailyRecap(events, "2026-01-02")!;
  expect(r.date).toBe("2026-01-02");
  expect(r.eventCount).toBe(3);
  expect(r.ai.interactions).toBe(2);
  expect(r.ai.tokensEst).toBe(150);
  expect(r.ai.ask).toBe(1);
  expect(r.ai.agent).toBe(1);
  expect(r.ai.canceled).toBe(1);
  expect(r.ai.topModel).toBe("copilot/gpt-4.1");
  expect(r.commits).toEqual({ count: 1, insertions: 10, deletions: 3 });
  expect(r.sessions.count).toBe(1); // same ticket, within gap
  expect(r.tickets).toEqual(["ABC-1"]);
});

test("recap defaults to the most recent day", () => {
  const events = [ev("commit", D1, {}), ev("ai_interaction", D2, { tokensEst: 5 })];
  expect(dailyRecap(events)!.date).toBe("2026-01-03");
});

test("recap is null when there are no events", () => {
  expect(dailyRecap([])).toBeNull();
});
