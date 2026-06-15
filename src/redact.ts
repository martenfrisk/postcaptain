/**
 * Redaction gate (design §8) — the deterministic, local, ordered pipeline that
 * every insight passes through before the single remote call (the weekly
 * synthesis via Copilot CLI). Nothing identifying or proprietary is supposed to
 * leave the machine; this is the safety net.
 *
 * It runs over already-abstracted insight objects (never raw events). Order
 * matters — coarse structural strips first, then secrets, then identifiers — so
 * later passes see less:
 *
 *   1. strip code & verbatim blocks   →  [code: N lines]
 *   2. mask secrets (shapes/entropy)  →  [secret]
 *   3. pseudonymize identifiers       →  stable one-way HMAC tokens
 *      (emails, URLs, tickets, denylist domains/repos/hosts/people)
 *   4. drop residual absolute paths   →  path:xxxx
 *
 * Pseudonyms are stable (so longitudinal grouping survives across weeks) and
 * one-way (the remote can't reverse them): `HMAC-SHA256(local_salt, value)`
 * truncated, typed by kind (`repo:7f3a`, `host:1c9e`, `ticket:a04b`, …). The
 * salt lives only on the machine.
 *
 * A fail-closed self-check (§8) asserts no denylist literal and no obvious
 * secret shape survived; if one did, redaction throws and the send is aborted.
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Insight } from "./characterizer.ts";

/** The hand-maintained, environment-specific denylist (`redaction.toml`, §8). */
export interface Denylist {
  companyDomains: string[];
  repoOrgs: string[];
  repoNames: string[];
  internalHosts: string[];
  people: string[];
}

export const EMPTY_DENYLIST: Denylist = {
  companyDomains: [],
  repoOrgs: [],
  repoNames: [],
  internalHosts: [],
  people: [],
};

/** Thrown when the fail-closed self-check finds a leak survived the pipeline. */
export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactionError";
  }
}

// --- denylist + salt loading -------------------------------------------------

/** All denylist literals as one flat list (for the self-check). */
function denylistLiterals(d: Denylist): string[] {
  return [...d.companyDomains, ...d.repoOrgs, ...d.repoNames, ...d.internalHosts, ...d.people]
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse one `key = ["a", "b"]` array out of a tiny TOML file (no TOML dep). */
function tomlArray(text: string, key: string): string[] {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((q) => q[1] ?? q[2] ?? "").filter(Boolean);
}

/** Load the denylist from `redaction.toml`. Returns the empty denylist if absent. */
export function loadDenylist(path = "./redaction.toml"): Denylist {
  if (!existsSync(path)) return { ...EMPTY_DENYLIST };
  const text = readFileSync(path, "utf8");
  return {
    companyDomains: tomlArray(text, "company_domains"),
    repoOrgs: tomlArray(text, "repo_orgs"),
    repoNames: tomlArray(text, "repo_names"),
    internalHosts: tomlArray(text, "internal_hosts"),
    people: tomlArray(text, "people"),
  };
}

/**
 * Load the local HMAC salt, creating it once if absent. The salt never leaves
 * the machine; losing it only breaks cross-week pseudonym stability.
 */
export function loadOrCreateSalt(path = "./.postcaptain.salt"): string {
  if (existsSync(path)) {
    const s = readFileSync(path, "utf8").trim();
    if (s) return s;
  }
  const salt = randomBytes(32).toString("hex");
  writeFileSync(path, salt, { mode: 0o600 });
  return salt;
}

// --- the pipeline ------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A typed, stable, one-way pseudonym: `type:7f3a`. */
function pseudonym(type: string, value: string, salt: string): string {
  const digest = createHmac("sha256", salt).update(value.toLowerCase()).digest("hex");
  return `${type}:${digest.slice(0, 4)}`;
}

// Secret shapes (§8 step 2). Specific shapes first, generic high-entropy last.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM private key header
  /\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/g, // KEY=value / .env lines
  /\b[A-Za-z0-9_-]{32,}\b/g, // generic high-entropy token
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s)>\]]+/gi;
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
// Absolute unix/home paths. The lookbehind keeps it from biting a kept URL's
// path (a `/` preceded by `:` or a word char, as in `https://host/path`).
const PATH_RE = /(?<![:\w/])(?:~|\.{0,2})\/[\w.\-/]*[\w.-]/g;

/** Is this URL safe to keep (a public http(s) doc URL, host not on the denylist)? */
function isPublicUrl(url: string, denyHosts: Set<string>): boolean {
  if (!/^https?:\/\//i.test(url)) return false; // file:, ftp: → never public
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  for (const h of denyHosts) {
    if (host === h || host.endsWith(`.${h}`)) return false;
  }
  return true;
}

/**
 * Redact one string through the ordered pipeline. Pure and deterministic given
 * the same salt + denylist.
 */
export function redactText(input: string, denylist: Denylist, salt: string): string {
  let s = input;

  // 1. Strip code & verbatim blocks (backstop against a leaked snippet).
  s = s.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split("\n").length - 1;
    return `[code: ${lines} lines]`;
  });
  s = s.replace(/`[^`\n]+`/g, "[code]");

  // 2. Mask secrets.
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[secret]");

  // 3. Pseudonymize identifiers (emails → URLs → tickets → denylist literals).
  s = s.replace(EMAIL_RE, (m) => pseudonym("user", m, salt));

  // Public doc URLs may pass (reading is low-sensitivity); pseudonymize
  // internal/file URLs outright. PATH_RE's lookbehind leaves kept URLs intact.
  const denyHosts = new Set(
    [...denylist.companyDomains, ...denylist.internalHosts].map((h) => h.toLowerCase()),
  );
  s = s.replace(URL_RE, (m) => (isPublicUrl(m, denyHosts) ? m : pseudonym("url", m, salt)));
  s = s.replace(TICKET_RE, (m) => pseudonym("ticket", m, salt));

  // Denylist literals — force-pseudonymized even if a generic rule missed them.
  const literal = (values: string[], type: string) => {
    for (const v of values) {
      if (!v.trim()) continue;
      s = s.replace(new RegExp(escapeRe(v), "gi"), pseudonym(type, v, salt));
    }
  };
  literal(denylist.companyDomains, "host");
  literal(denylist.internalHosts, "host");
  literal(denylist.repoOrgs, "repo");
  literal(denylist.repoNames, "repo");
  literal(denylist.people, "user");

  // 4. Drop residual absolute paths.
  s = s.replace(PATH_RE, (m) => pseudonym("path", m, salt));

  return s;
}

/**
 * Fail-closed self-check (§8): assert no denylist literal and no obvious secret
 * shape survived. Throws {@link RedactionError} if a leak is found.
 */
export function assertClean(redacted: string, denylist: Denylist): void {
  const haystack = redacted.toLowerCase();
  for (const lit of denylistLiterals(denylist)) {
    if (haystack.includes(lit.toLowerCase())) {
      throw new RedactionError(`denylist literal survived redaction: "${lit}"`);
    }
  }
  // The generic KEY=value rule is too broad to re-assert (it would flag the
  // pseudonyms themselves), so re-check only the unambiguous secret shapes.
  const hardShapes = SECRET_PATTERNS.slice(0, 4);
  for (const re of hardShapes) {
    re.lastIndex = 0;
    if (re.test(redacted)) throw new RedactionError(`secret shape survived redaction: ${re}`);
  }
}

// --- insight redaction -------------------------------------------------------

/**
 * The abstracted, redacted insight object that is eligible to go remote. It
 * carries conclusions only — never raw evidence. Evidence is reduced to a count.
 */
export interface RedactedInsight {
  detector: string;
  signature: string;
  headline: string;
  whatHappened: string;
  suggestion: string;
  category: string;
  artifactType: string;
  artifactDraft: string;
  confidence: number;
  evidenceCount: number;
}

/** Redact one insight, running every text field through the pipeline + self-check. */
export function redactInsight(insight: Insight, denylist: Denylist, salt: string): RedactedInsight {
  const clean = (field: string): string => {
    const out = redactText(field, denylist, salt);
    assertClean(out, denylist);
    return out;
  };
  return {
    detector: insight.detector,
    signature: clean(insight.signature),
    headline: clean(insight.headline),
    whatHappened: clean(insight.whatHappened),
    suggestion: clean(insight.suggestion),
    category: insight.category,
    artifactType: insight.artifactType,
    artifactDraft: clean(insight.artifactDraft),
    confidence: insight.confidence,
    evidenceCount: insight.evidence.length,
  };
}

/** Redact a batch of insights (fail-closed: any leak aborts the whole batch). */
export function redactInsights(
  insights: Insight[],
  denylist: Denylist,
  salt: string,
): RedactedInsight[] {
  return insights.map((i) => redactInsight(i, denylist, salt));
}
