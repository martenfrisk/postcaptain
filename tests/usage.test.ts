import { expect, test } from "bun:test";
import { makeRecord, parseCredits, summarizeUsage, type UsageRecord } from "../src/usage.ts";

test("parseCredits reads the figure from varied Copilot footers", () => {
  expect(parseCredits("Total: 0.8 AI Credits used")).toBe(0.8);
  expect(parseCredits("used 2 credits")).toBe(2);
  expect(parseCredits("no figure here")).toBeUndefined();
});

test("makeRecord estimates tokens and retains no content", () => {
  const r = makeRecord({
    purpose: "digest",
    model: "auto",
    prompt: "x".repeat(400),
    response: "y".repeat(40),
    stderr: "1.5 credits",
  });
  expect(r.promptTokensEst).toBe(100); // 400 / 4
  expect(r.responseTokensEst).toBe(10);
  expect(r.credits).toBe(1.5);
  expect(JSON.stringify(r)).not.toContain("xxxx"); // sizes only, no payload
});

test("summarizeUsage aggregates counts, tokens, and per-purpose calls", () => {
  const recs: UsageRecord[] = [
    {
      ts: 100,
      purpose: "explore",
      model: "auto",
      promptChars: 0,
      responseChars: 0,
      promptTokensEst: 10,
      responseTokensEst: 5,
      credits: 1,
    },
    {
      ts: 200,
      purpose: "digest",
      model: "auto",
      promptChars: 0,
      responseChars: 0,
      promptTokensEst: 20,
      responseTokensEst: 5,
      // no credits reported on this one
    },
  ];
  const s = summarizeUsage(recs);
  expect(s.calls).toBe(2);
  expect(s.promptTokensEst).toBe(30);
  expect(s.responseTokensEst).toBe(10);
  expect(s.credits).toBe(1);
  expect(s.creditsKnown).toBe(1);
  expect(s.byPurpose).toEqual({ explore: 1, digest: 1 });

  // sinceTs filters older records
  expect(summarizeUsage(recs, 150).calls).toBe(1);
});
