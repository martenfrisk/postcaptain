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

test("the generic high-entropy rule spares long kebab-case slugs but catches real tokens", () => {
  // a 37-char lowercase slug is prose, not a secret — must survive
  const slug = redactText(
    "signature explore:establish-secure-ci-debugging-pattern",
    EMPTY_DENYLIST,
    SALT,
  );
  expect(slug).toContain("establish-secure-ci-debugging-pattern");
  // a 40-char mixed-case/digit token is high-entropy — must be masked
  const token = redactText(
    "token aB3xQ9zL5kP2mN7wR4tY8uV1cD6eF0gH2jK5lM9n here",
    EMPTY_DENYLIST,
    SALT,
  );
  expect(token).toContain("[secret]");
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

test("pseudonymizes emails, tickets, and denylist literals (strict, stable + one-way)", () => {
  const text =
    "Jane Doe (jane@example-corp.com) pushed to example-corp/checkout-service for ABC-123";
  const out = redactText(text, denylist, SALT, "strict");
  expect(out).not.toContain("jane@example-corp.com");
  expect(out).not.toContain("example-corp");
  expect(out).not.toContain("checkout-service");
  expect(out).not.toContain("ABC-123");
  expect(out).not.toContain("Jane Doe");
  expect(out).toMatch(/user:[0-9a-f]{4}/);
  expect(out).toMatch(/repo:[0-9a-f]{4}/);
  expect(out).toMatch(/ticket:[0-9a-f]{4}/);

  // stable: same value → same token across calls
  expect(redactText("ABC-123", denylist, SALT, "strict")).toBe(
    redactText("ABC-123", denylist, SALT, "strict"),
  );
  // salt-dependent (one-way, not reversible without the salt)
  expect(redactText("ABC-123", denylist, "other-salt", "strict")).not.toBe(
    redactText("ABC-123", denylist, SALT, "strict"),
  );
});

test("keeps public doc URLs but pseudonymizes internal/file URLs (strict)", () => {
  const out = redactText(
    "docs at https://developer.mozilla.org/en-US/docs vs https://jira.example-corp.com/browse/ABC-1 and file:///Users/me/secret.txt",
    denylist,
    SALT,
    "strict",
  );
  expect(out).toContain("https://developer.mozilla.org/en-US/docs");
  expect(out).not.toContain("jira.example-corp.com");
  expect(out).not.toContain("file:///Users/me/secret.txt");
  expect(out).toMatch(/url:[0-9a-f]{4}/);
});

test("pseudonymizes absolute filesystem paths (strict)", () => {
  const out = redactText(
    "edited /Users/marten/work/repo/src/index.ts today",
    EMPTY_DENYLIST,
    SALT,
    "strict",
  );
  expect(out).not.toContain("/Users/marten/work/repo/src/index.ts");
  expect(out).toMatch(/path:[0-9a-f]{4}/);
});

// --- tiers -------------------------------------------------------------------

test("identifiers tier: keeps names + strips code, but still masks secrets", () => {
  const out = redactText(
    "deploy checkout-service for ABC-123 with AWS_KEY=AKIAIOSFODNN7EXAMPLE and `npm run x`",
    denylist,
    SALT,
    "identifiers",
  );
  // identifiers stay readable (the point of relaxing)
  expect(out).toContain("checkout-service");
  expect(out).toContain("ABC-123");
  // ...but code is stripped and secrets are still masked
  expect(out).toContain("[code]");
  expect(out).toContain("[secret]");
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
});

test("raw tier: keeps verbatim code + names, but STILL masks secrets", () => {
  const out = redactText(
    "see ```\nconst k = 'AKIAIOSFODNN7EXAMPLE'\n``` in checkout-service",
    denylist,
    SALT,
    "raw",
  );
  expect(out).toContain("const k ="); // verbatim code kept
  expect(out).toContain("checkout-service"); // identifier kept
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE"); // credential never survives
  expect(out).toContain("[secret]");
});

test("assertClean: denylist check only at strict; secret check at EVERY tier", () => {
  // denylist literal is allowed through at relaxed tiers...
  expect(() => assertClean("leaked example-corp.com here", denylist, "identifiers")).not.toThrow();
  // ...but flagged at strict
  expect(() => assertClean("leaked example-corp.com here", denylist, "strict")).toThrow(
    RedactionError,
  );
  // a surviving credential is fail-closed regardless of tier
  for (const level of ["strict", "identifiers", "raw"] as const) {
    expect(() => assertClean("AKIAIOSFODNN7EXAMPLE", EMPTY_DENYLIST, level)).toThrow(
      RedactionError,
    );
  }
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

test("redactInsight (strict) scrubs every text field and reduces evidence to a count", () => {
  const r = redactInsight(insight(), denylist, SALT, "strict");
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
