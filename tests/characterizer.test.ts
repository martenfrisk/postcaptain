import { expect, test } from "bun:test";
import { buildPrompt, characterize, characterizeAll } from "../src/characterizer.ts";
import type { Candidate } from "../src/detectors.ts";
import { type Event, makeEvent } from "../src/events.ts";
import { cosineDistance, type LlmClient } from "../src/llm.ts";

const candidate: Candidate = {
  detector: "repetition",
  signature: "repetition:foo",
  headline: "Recurring prompt used 4× across 2 days",
  whatHappened: "You sent a near-identical prompt 4 times.",
  suggestion: "Save it as a snippet.",
  category: "shortcut",
  artifactType: "snippet",
  evidence: ["e0", "e1"],
  confidence: 0.7,
};

function ev(id: string): Event {
  return makeEvent({
    eventId: id,
    kind: "ai_interaction",
    source: "copilot",
    ts: 1,
    sensitivity: "sensitive",
    project: "demo",
    ticket: "ABC-1",
    payload: { prompt: "how do I configure vite proxy", model: "copilot/gpt-4.1" },
  });
}

/** A fake client returning a fixed response, recording the prompt it saw. */
function fakeClient(response: string): LlmClient & { lastPrompt: string } {
  const c = {
    lastPrompt: "",
    async generate(prompt: string) {
      c.lastPrompt = prompt;
      return response;
    },
    async embed() {
      return [1, 0, 0];
    },
  };
  return c;
}

test("buildPrompt includes the detector finding and evidence", () => {
  const prompt = buildPrompt(candidate, [ev("e0"), ev("e1")]);
  expect(prompt).toContain("Detector: repetition");
  expect(prompt).toContain("Recurring prompt used 4×");
  expect(prompt).toContain("configure vite proxy");
});

test("characterize parses a well-formed model response into an insight", async () => {
  const client = fakeClient(
    JSON.stringify({
      headline: "Save your recurring vite-proxy prompt",
      what_happened: "Asked the same thing 4 times.",
      suggestion: "Store a reusable snippet.",
      category: "shortcut",
      artifact_type: "snippet",
      artifact_draft: "## Configure vite proxy\nserver.proxy = { '/api': 'http://localhost:3000' }",
      confidence: 0.82,
    }),
  );
  const insight = await characterize(candidate, [ev("e0")], client);
  expect(insight.characterized).toBe(true);
  expect(insight.headline).toBe("Save your recurring vite-proxy prompt");
  expect(insight.artifactType).toBe("snippet");
  expect(insight.artifactDraft).toContain("server.proxy");
  expect(insight.confidence).toBeCloseTo(0.82);
  expect(insight.evidence).toEqual(["e0", "e1"]); // evidence comes from the candidate
});

test("characterize falls back to the candidate on invalid JSON", async () => {
  const insight = await characterize(candidate, [ev("e0")], fakeClient("not json at all"));
  expect(insight.characterized).toBe(false);
  expect(insight.headline).toBe(candidate.headline);
  expect(insight.confidence).toBe(candidate.confidence);
});

test("characterize falls back when the client throws (Ollama down)", async () => {
  const throwing: LlmClient = {
    async generate() {
      throw new Error("connection refused");
    },
    async embed() {
      return [];
    },
  };
  const insight = await characterize(candidate, [], throwing);
  expect(insight.characterized).toBe(false);
  expect(insight.suggestion).toBe(candidate.suggestion);
});

test("characterize validates enum/range fields, ignoring bad model output", async () => {
  const client = fakeClient(
    JSON.stringify({ category: "nonsense", artifact_type: "bogus", confidence: 5 }),
  );
  const insight = await characterize(candidate, [ev("e0")], client);
  expect(insight.category).toBe("shortcut"); // fell back to candidate
  expect(insight.artifactType).toBe("snippet");
  expect(insight.confidence).toBe(1); // clamped to 0..1
});

test("characterizeAll applies the confidence bar and resolves evidence", async () => {
  const lo: Candidate = { ...candidate, signature: "lo", confidence: 0.3 };
  const byId = new Map([["e0", ev("e0")]]);
  const out = await characterizeAll([candidate, lo], byId, fakeClient("{}"), {
    minConfidence: 0.6,
  });
  expect(out).toHaveLength(1); // lo filtered out
  expect(out[0]!.signature).toBe("repetition:foo");
});

test("cosineDistance: identical vectors are 0, orthogonal are 1", () => {
  expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
  expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
});
