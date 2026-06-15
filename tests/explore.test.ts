import { expect, test } from "bun:test";
import { type Event, type EventKind, makeEvent } from "../src/events.ts";
import { buildActivityLog, exploreCandidates, parseExploreCandidates } from "../src/explore.ts";
import { EMPTY_DENYLIST } from "../src/redact.ts";
import type { CopilotRunner } from "../src/synthesis.ts";

const SALT = "test-salt";

let seq = 0;
function ev(kind: EventKind, payload: Record<string, unknown>, ticket?: string): Event {
  return makeEvent({
    eventId: `e${seq++}`,
    kind,
    source: kind === "commit" ? "github" : "copilot",
    ts: 1_000 + seq,
    sensitivity: "sensitive",
    project: "budgetera",
    ticket: ticket ?? null,
    payload,
  });
}

const events: Event[] = [
  ev("ai_interaction", { prompt: "refactor the formatter", isCanceled: true }, "ABC-1"),
  ev("ai_interaction", { prompt: "fix the failing test" }, "ABC-1"),
  ev("commit", { subject: "ABC-1 reformat" }, "ABC-1"),
];

test("parseExploreCandidates maps cited indices back to event ids", () => {
  const raw = JSON.stringify([
    {
      headline: "Repeated manual reformatting",
      what_happened: "Asked AI to reformat then committed by hand.",
      suggestion: "Add a format-on-save hook.",
      category: "shortcut",
      artifact_type: "workflow",
      confidence: 0.7,
      evidence: [0, 2],
    },
  ]);
  const [c] = parseExploreCandidates(raw, events);
  expect(c!.detector).toBe("explore");
  expect(c!.signature).toBe("explore:repeated-manual-reformatting");
  expect(c!.evidence).toEqual([events[0]!.eventId, events[2]!.eventId]);
  expect(c!.artifactType).toBe("workflow");
});

test("parseExploreCandidates tolerates a ```json fence and caps confidence", () => {
  const raw = '```json\n[{"headline":"X","confidence":0.99,"evidence":[]}]\n```';
  const [c] = parseExploreCandidates(raw, events);
  expect(c!.headline).toBe("X");
  expect(c!.confidence).toBeLessThanOrEqual(0.85); // unverified guesses can't outrank the backbone
});

test("parseExploreCandidates returns [] on garbage rather than throwing", () => {
  expect(parseExploreCandidates("not json at all", events)).toEqual([]);
  expect(parseExploreCandidates('{"not":"an array"}', events)).toEqual([]);
});

test("buildActivityLog masks secrets even at the raw tier", () => {
  const log = buildActivityLog(
    [ev("ai_interaction", { prompt: "key AKIAIOSFODNN7EXAMPLE here" })],
    EMPTY_DENYLIST,
    SALT,
    "raw",
  );
  expect(log).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(log).toContain("[secret]");
});

test("exploreCandidates runs the runner and returns parsed candidates; [] on failure", async () => {
  const ok: CopilotRunner = async () =>
    JSON.stringify([{ headline: "Found something", confidence: 0.6, evidence: [1] }]);
  const found = await exploreCandidates(events, ok, { denylist: EMPTY_DENYLIST, salt: SALT });
  expect(found.length).toBe(1);
  expect(found[0]!.evidence).toEqual([events[1]!.eventId]);

  const boom: CopilotRunner = async () => {
    throw new Error("copilot down");
  };
  expect(await exploreCandidates(events, boom, { denylist: EMPTY_DENYLIST, salt: SALT })).toEqual(
    [],
  );
});
