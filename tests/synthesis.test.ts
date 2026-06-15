import { expect, test } from "bun:test";
import { type Event, type EventKind, makeEvent } from "../src/events.ts";
import type { LlmClient } from "../src/llm.ts";
import { EMPTY_DENYLIST, type RedactedInsight } from "../src/redact.ts";
import {
  buildDigestInput,
  buildSynthesisPrompt,
  type CopilotRunner,
  type DigestInput,
  previewText,
  synthesize,
  type WeekStats,
  weekRange,
} from "../src/synthesis.ts";

const SALT = "test-salt";

const ZERO_STATS: WeekStats = {
  aiInteractions: 0,
  canceled: 0,
  commits: 0,
  promptTokensEst: 0,
  responseTokensEst: 0,
  projects: 0,
  tickets: 0,
};

const SAMPLE_REDACTED: RedactedInsight = {
  detector: "repetition",
  signature: "s",
  headline: "h",
  whatHappened: "w",
  suggestion: "sg",
  category: "shortcut",
  artifactType: "snippet",
  artifactDraft: "d",
  confidence: 0.8,
  evidenceCount: 3,
};

function mkInput(over: Partial<DigestInput> = {}): DigestInput {
  return {
    week: weekRange(new Date("2026-06-17T12:00:00Z")),
    level: "identifiers",
    stats: ZERO_STATS,
    insights: [],
    redacted: [SAMPLE_REDACTED],
    ...over,
  };
}

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

// A fake local model that returns a valid characterizer JSON object.
const fakeLocal: LlmClient = {
  async generate() {
    return JSON.stringify({
      headline: "Recurring scaffold prompt",
      what_happened: "Sent the same prompt several times.",
      suggestion: "Save it as a snippet.",
      category: "shortcut",
      artifact_type: "snippet",
      artifact_draft: "test('x', () => {})",
      confidence: 0.8,
    });
  },
  async embed() {
    return [];
  },
};

test("weekRange spans a Mon–Sun 7-day window", () => {
  const w = weekRange(new Date("2026-06-17T12:00:00Z")); // a Wednesday
  expect(w.endTs - w.startTs).toBe(7 * 86_400_000);
  expect(new Date(w.startTs).getUTCDay()).toBe(1); // Monday
  expect(w.label).toBe("2026-06-15 — 2026-06-21");
});

test("buildDigestInput filters to the week, characterizes locally, and redacts", async () => {
  const w = weekRange(new Date("2026-06-17T12:00:00Z"));
  const inWeek = w.startTs + 86_400_000; // Tue
  const nextDay = w.startTs + 2 * 86_400_000; // Wed
  const prompt = "write a bun:test scaffold for this module";
  const events = [
    ev("ai_interaction", inWeek, { prompt }, "ABC-1"),
    ev("ai_interaction", inWeek + 1000, { prompt }, "ABC-1"),
    ev("ai_interaction", nextDay, { prompt }, "ABC-1"), // 3 across 2 days → repetition fires
    ev("ai_interaction", w.startTs - 10 * 86_400_000, { prompt }, "ABC-1"), // last week, excluded
  ];
  const input = await buildDigestInput(events, fakeLocal, EMPTY_DENYLIST, SALT, {
    day: new Date("2026-06-17T12:00:00Z"),
    minConfidence: 0.6,
  });
  expect(input.insights.length).toBe(1);
  expect(input.redacted.length).toBe(1);
  // redacted object carries an evidence COUNT, not the raw ids
  expect(input.redacted[0]!.evidenceCount).toBeGreaterThan(0);
  expect(input.redacted[0]).not.toHaveProperty("evidence");
});

test("buildSynthesisPrompt embeds stats + the redacted payload and forbids tool use", () => {
  const p = buildSynthesisPrompt(mkInput({ stats: { ...ZERO_STATS, aiInteractions: 12 } }));
  expect(p).toContain("WEEKLY work digest");
  expect(p).toContain("Do not use any tools");
  expect(p).toContain('"detector": "repetition"');
  expect(p).toContain("STATS:");
  expect(p).toContain('"aiInteractions": 12');
});

test("synthesize calls the runner with the redacted prompt and returns the digest", async () => {
  let seen = "";
  const runner: CopilotRunner = async (prompt, model) => {
    seen = `${model}::${prompt}`;
    return "## Top insights\n- do the thing";
  };
  const result = await synthesize(mkInput(), runner, "auto");
  expect(result.sent).toBe(true);
  expect(result.digest).toContain("Top insights");
  expect(seen).toContain("auto::");
  expect(seen).toContain("WEEKLY work digest");
});

test("synthesize does NOT call the runner when there are no insights", async () => {
  let called = false;
  const runner: CopilotRunner = async () => {
    called = true;
    return "should not happen";
  };
  const result = await synthesize(mkInput({ redacted: [] }), runner, "auto");
  expect(called).toBe(false);
  expect(result.sent).toBe(false);
});

test("previewText shows the week, the tier, and the exact payload to be sent", () => {
  const preview = previewText(mkInput());
  expect(preview).toContain("Week: 2026-06-15 — 2026-06-21");
  expect(preview).toContain("Redaction tier: identifiers");
  expect(preview).toContain("what would be sent");
  expect(preview).toContain('"detector": "repetition"');
});
