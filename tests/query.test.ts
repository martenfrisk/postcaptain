import { expect, test } from "bun:test";
import { type Event, type EventKind, makeEvent } from "../src/events.ts";
import type { LlmClient } from "../src/llm.ts";
import { answer, buildContext } from "../src/query.ts";
import { sessionize } from "../src/sessionizer.ts";

let seq = 0;
function ev(kind: EventKind, ts: number, payload: Record<string, unknown>, ticket?: string): Event {
  return makeEvent({
    eventId: `e${seq++}`,
    kind,
    source: kind === "commit" ? "github" : "copilot",
    ts,
    sensitivity: "sensitive",
    project: "budgetera",
    ticket: ticket ?? null,
    payload,
  });
}

const events = [
  ev("ai_interaction", 1000, { prompt: "how to fix the vite proxy config" }, "ABC-1"),
  ev("commit", 2000, { subject: "ABC-1 fix proxy", insertions: 3, deletions: 1 }, "ABC-1"),
  ev("ai_interaction", 3000, { prompt: "write a postgres index migration" }, "ABC-2"),
];

function fakeClient(capture: (prompt: string) => void): LlmClient {
  return {
    async generate(prompt) {
      capture(prompt);
      return "Here is the answer.";
    },
    async embed() {
      return [];
    },
  };
}

test("buildContext includes summary, sessions, and keyword-relevant events", () => {
  const ctx = buildContext("what did I do about the proxy?", events, sessionize(events));
  expect(ctx).toContain("ACTIVITY SUMMARY");
  expect(ctx).toContain("budgetera");
  // "proxy" keyword should surface the proxy events, not the postgres one
  expect(ctx).toContain("vite proxy config");
  expect(ctx).toContain("fix proxy");
  expect(ctx).not.toContain("postgres index");
});

test("buildContext falls back to recent events when nothing matches", () => {
  const ctx = buildContext("zzzznomatch", events, sessionize(events));
  expect(ctx).toContain("RELEVANT EVENTS");
  expect(ctx).toContain("postgres index"); // recent events included as fallback
});

test("answer feeds context + question to the model and returns its reply", async () => {
  let seen = "";
  const reply = await answer(
    "proxy?",
    events,
    sessionize(events),
    fakeClient((p) => {
      seen = p;
    }),
  );
  expect(reply).toBe("Here is the answer.");
  expect(seen).toContain("QUESTION: proxy?");
  expect(seen).toContain("ACTIVITY SUMMARY");
});

test("answer handles an empty store and a model error gracefully", async () => {
  expect(
    await answer(
      "anything",
      [],
      [],
      fakeClient(() => {}),
    ),
  ).toContain("No activity captured");

  const throwing: LlmClient = {
    async generate() {
      throw new Error("connection refused");
    },
    async embed() {
      return [];
    },
  };
  const reply = await answer("proxy?", events, sessionize(events), throwing);
  expect(reply).toContain("Could not reach the local model");
});
