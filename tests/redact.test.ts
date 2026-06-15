import { expect, test } from "bun:test";
import type { Insight } from "../src/characterizer.ts";
import {
  assertClean,
  type Denylist,
  EMPTY_DENYLIST,
  RedactionError,
  redactInsight,
  redactText,
} from "../src/redact.ts";

const SALT = "test-salt-deadbeef";

const denylist: Denylist = {
  companyDomains: ["example-corp.com"],
  repoOrgs: ["example-corp"],
  repoNames: ["checkout-service"],
  internalHosts: ["jira.example-corp.com"],
  people: ["Jane Doe"],
};

test("strips fenced code blocks and inline code", () => {
  const out = redactText(
    "see ```\nconst x = 1\nfoo()\n``` and `inline()` too",
    EMPTY_DENYLIST,
    SALT,
  );
  expect(out).toContain("[code: 3 lines]");
  expect(out).toContain("[code]");
  expect(out).not.toContain("const x");
  expect(out).not.toContain("inline()");
});

test("masks secret shapes", () => {
  const out = redactText(
    "key AKIAIOSFODNN7EXAMPLE and token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD and API_KEY=supersecretvalue",
    EMPTY_DENYLIST,
    SALT,
  );
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  expect(out).not.toContain("supersecretvalue");
  expect(out).toContain("[secret]");
});

test("pseudonymizes emails, tickets, and denylist literals (stable + one-way)", () => {
  const text =
    "Jane Doe (jane@example-corp.com) pushed to example-corp/checkout-service for ABC-123";
  const out = redactText(text, denylist, SALT);
  expect(out).not.toContain("jane@example-corp.com");
  expect(out).not.toContain("example-corp");
  expect(out).not.toContain("checkout-service");
  expect(out).not.toContain("ABC-123");
  expect(out).not.toContain("Jane Doe");
  expect(out).toMatch(/user:[0-9a-f]{4}/);
  expect(out).toMatch(/repo:[0-9a-f]{4}/);
  expect(out).toMatch(/ticket:[0-9a-f]{4}/);

  // stable: same value → same token across calls
  expect(redactText("ABC-123", denylist, SALT)).toBe(redactText("ABC-123", denylist, SALT));
  // salt-dependent (one-way, not reversible without the salt)
  expect(redactText("ABC-123", denylist, "other-salt")).not.toBe(
    redactText("ABC-123", denylist, SALT),
  );
});

test("keeps public doc URLs but pseudonymizes internal/file URLs", () => {
  const out = redactText(
    "docs at https://developer.mozilla.org/en-US/docs vs https://jira.example-corp.com/browse/ABC-1 and file:///Users/me/secret.txt",
    denylist,
    SALT,
  );
  expect(out).toContain("https://developer.mozilla.org/en-US/docs");
  expect(out).not.toContain("jira.example-corp.com");
  expect(out).not.toContain("file:///Users/me/secret.txt");
  expect(out).toMatch(/url:[0-9a-f]{4}/);
});

test("pseudonymizes absolute filesystem paths", () => {
  const out = redactText("edited /Users/marten/work/repo/src/index.ts today", EMPTY_DENYLIST, SALT);
  expect(out).not.toContain("/Users/marten/work/repo/src/index.ts");
  expect(out).toMatch(/path:[0-9a-f]{4}/);
});

test("assertClean throws when a denylist literal survives (fail-closed)", () => {
  expect(() => assertClean("leaked example-corp.com here", denylist)).toThrow(RedactionError);
  expect(() => assertClean("nothing identifying here", denylist)).not.toThrow();
});

test("assertClean throws when a hard secret shape survives", () => {
  expect(() => assertClean("AKIAIOSFODNN7EXAMPLE", EMPTY_DENYLIST)).toThrow(RedactionError);
});

function insight(over: Partial<Insight> = {}): Insight {
  return {
    detector: "repetition",
    signature: "sig-1",
    headline: "Repeatedly asked AI to scaffold tests for checkout-service",
    whatHappened: "5 near-identical prompts in example-corp/checkout-service for ABC-123",
    suggestion: "Save a `bun:test` scaffold snippet",
    category: "shortcut",
    artifactType: "snippet",
    artifactDraft: "```ts\ntest('x', () => {})\n```",
    evidence: ["e1", "e2", "e3"],
    confidence: 0.8,
    characterized: true,
    ...over,
  };
}

test("redactInsight scrubs every text field and reduces evidence to a count", () => {
  const r = redactInsight(insight(), denylist, SALT);
  const blob = JSON.stringify(r);
  expect(blob).not.toContain("checkout-service");
  expect(blob).not.toContain("example-corp");
  expect(blob).not.toContain("ABC-123");
  expect(r.artifactDraft).toContain("[code:"); // fenced code stripped
  expect(r.evidenceCount).toBe(3);
  expect(r).not.toHaveProperty("evidence");
  // non-text fields pass through untouched
  expect(r.detector).toBe("repetition");
  expect(r.confidence).toBe(0.8);
});
