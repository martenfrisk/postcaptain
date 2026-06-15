import { expect, test } from "bun:test";
import {
  canceledDetector,
  detectAll,
  followupHabitDetector,
  normalizePrompt,
  repetitionDetector,
  struggleDetector,
} from "../src/detectors.ts";
import { type Event, makeEvent } from "../src/events.ts";
import { sessionize } from "../src/sessionizer.ts";

let seq = 0;
function ai(
  ts: number,
  payload: Record<string, unknown>,
  opts: { ticket?: string | null } = {},
): Event {
  return makeEvent({
    eventId: `e${seq++}`,
    kind: "ai_interaction",
    source: "copilot",
    ts,
    sensitivity: "sensitive",
    project: "repo",
    ticket: opts.ticket ?? null,
    payload,
  });
}

const DAY = 24 * 60 * 60 * 1000;

test("normalizePrompt strips code and collapses whitespace", () => {
  expect(normalizePrompt("Fix   THIS\n```ts\nlet x=1\n``` now")).toBe("fix this now");
});

test("repetition: same prompt across multiple days is flagged", () => {
  const events = [
    ai(0, { prompt: "How do I configure the vite proxy?" }),
    ai(DAY, { prompt: "How do I configure the vite proxy?" }),
    ai(2 * DAY, { prompt: "How do I configure the vite proxy?" }),
  ];
  const out = repetitionDetector({ events, sessions: [] });
  expect(out).toHaveLength(1);
  expect(out[0]!.evidence).toHaveLength(3);
  expect(out[0]!.category).toBe("shortcut");
  expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.6);
});

test("repetition: same-day-only or too-few repeats are ignored", () => {
  const sameDay = [
    ai(0, { prompt: "the same longish question repeated" }),
    ai(60_000, { prompt: "the same longish question repeated" }),
    ai(120_000, { prompt: "the same longish question repeated" }),
  ];
  expect(repetitionDetector({ events: sameDay, sessions: [] })).toHaveLength(0);
});

test("struggle: a high-churn single session is flagged", () => {
  const events = Array.from({ length: 7 }, (_, i) =>
    ai(i * 60_000, { prompt: `step ${i}` }, { ticket: "ABC-1" }),
  );
  const sessions = sessionize(events);
  const out = struggleDetector({ events, sessions });
  expect(out).toHaveLength(1);
  expect(out[0]!.detector).toBe("struggle");
  expect(out[0]!.evidence.length).toBe(7);
});

test("followup-habit: many multi-turn sessions become a lesson", () => {
  const events: Event[] = [];
  // 6 sessions on distinct tickets, each with 3 prompts → all multi-turn.
  for (let s = 0; s < 6; s++) {
    for (let i = 0; i < 3; i++) {
      events.push(ai(s * DAY + i * 60_000, { prompt: `s${s} step ${i}` }, { ticket: `ABC-${s}` }));
    }
  }
  const out = followupHabitDetector({ events, sessions: sessionize(events) });
  expect(out).toHaveLength(1);
  expect(out[0]!.category).toBe("lesson");
});

test("canceled: a high cancel rate is flagged", () => {
  const events = [
    ai(0, { prompt: "a", isCanceled: true }),
    ai(1, { prompt: "b", isCanceled: true }),
    ai(2, { prompt: "c", isCanceled: true }),
    ai(3, { prompt: "d" }),
    ai(4, { prompt: "e" }),
  ];
  const out = canceledDetector({ events, sessions: [] });
  expect(out).toHaveLength(1);
  expect(out[0]!.evidence).toHaveLength(3);
});

test("detectAll returns candidates sorted by confidence", () => {
  const events = Array.from({ length: 7 }, (_, i) =>
    ai(i * 60_000, { prompt: "How do I configure the vite proxy here?" }, { ticket: "ABC-1" }),
  );
  // spread across days for repetition too
  events.push(
    ai(2 * DAY, { prompt: "How do I configure the vite proxy here?" }, { ticket: "ABC-1" }),
  );
  const candidates = detectAll({ events, sessions: sessionize(events) });
  expect(candidates.length).toBeGreaterThan(0);
  for (let i = 1; i < candidates.length; i++) {
    expect(candidates[i - 1]!.confidence).toBeGreaterThanOrEqual(candidates[i]!.confidence);
  }
});
