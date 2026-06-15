import { describe, expect, test } from "bun:test";
import {
  extractTicket,
  makeEvent,
  SENSITIVITY_RANK,
  stableEventId,
} from "../src/events.ts";

describe("extractTicket", () => {
  test("from branch names", () => {
    expect(extractTicket("ABC-123-new-feature")).toBe("ABC-123");
    expect(extractTicket("feature/PROJ-42-thing")).toBe("PROJ-42");
  });

  test("first match across fallbacks", () => {
    expect(extractTicket(null, "", "see WEB-9 for context")).toBe("WEB-9");
    expect(extractTicket("no key here", "DEV-7")).toBe("DEV-7");
  });

  test("no match", () => {
    expect(extractTicket("just-a-branch", null)).toBeNull();
    expect(extractTicket("abc-123")).toBeNull(); // lowercase doesn't match
  });
});

test("stableEventId is deterministic", () => {
  expect(stableEventId("copilot", "sess", "req")).toBe("copilot:sess:req");
});

test("sensitivity rank ordering", () => {
  expect(SENSITIVITY_RANK.low).toBeLessThan(SENSITIVITY_RANK.medium);
  expect(SENSITIVITY_RANK.medium).toBeLessThan(SENSITIVITY_RANK.sensitive);
});

describe("makeEvent", () => {
  test("defaults ingestedAt and nullable keys", () => {
    const before = Date.now();
    const e = makeEvent({
      eventId: "x",
      kind: "ai_interaction",
      source: "copilot",
      ts: 1,
      sensitivity: "sensitive",
      payload: {},
    });
    expect(e.project).toBeNull();
    expect(e.ticket).toBeNull();
    expect(e.ingestedAt).toBeGreaterThanOrEqual(before);
  });

  test("rejects unknown enum values", () => {
    expect(() =>
      // @ts-expect-error invalid kind on purpose
      makeEvent({ eventId: "x", kind: "nope", source: "copilot", ts: 1, sensitivity: "low", payload: {} }),
    ).toThrow(/unknown kind/);
  });
});
