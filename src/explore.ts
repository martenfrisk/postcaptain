/**
 * Open-ended detector (the answer to "why only 4 insights?"). The deterministic
 * catalog in `detectors.ts` only finds the handful of shapes someone hand-coded.
 * This stage does the opposite: it hands a redacted week of activity to a strong
 * *remote* model and asks it to surface whatever patterns stand out — the
 * "throw it all at a capable model and see what sticks" idea the local-first
 * design was originally reaching for.
 *
 * It runs through the same redaction tier as the digest (secrets always masked,
 * fail-closed), emits the same {@link Candidate} shape the deterministic
 * detectors do, and merges into the one characterize → rank → digest pipeline.
 * The deterministic detectors stay the reliable backbone; this widens the net.
 */

import type { ArtifactType, Candidate, Category } from "./detectors.ts";
import type { Event } from "./events.ts";
import {
  assertClean,
  DEFAULT_LEVEL,
  type Denylist,
  type RedactionLevel,
  redactText,
} from "./redact.ts";
import type { CopilotRunner } from "./synthesis.ts";

const CATEGORIES: Category[] = ["shortcut", "lesson"];
const ARTIFACT_TYPES: ArtifactType[] = [
  "skill",
  "snippet",
  "git_alias",
  "keybind",
  "workflow",
  "agent",
  "note",
  "none",
];

const MAX_EVENTS = 120; // bound the prompt; a busy week rarely needs more
const MAX_PROMPT_CHARS = 300; // per-event excerpt cap before redaction

const EXPLORE_PROMPT = [
  "You are a senior engineer mining a colleague's WEEK of AI-assisted work for PATTERNS worth acting on.",
  "Below is a redacted, numbered activity log (lines tagged [e0], [e1], …).",
  "Find recurring behaviours, struggles, workflow gaps, and effective habits — especially ones a fixed,",
  "rule-based detector would MISS. Identifiers may be opaque tokens (repo:7f3a); treat them as labels.",
  "Return ONLY a JSON array (no prose, no markdown fences). Each element must be an object with keys:",
  "headline (string), what_happened (string), suggestion (string),",
  'category ("shortcut" or "lesson"),',
  "artifact_type (one of: skill, snippet, git_alias, keybind, workflow, agent, note, none),",
  "confidence (0..1), evidence (array of the [e#] index numbers you based it on).",
  "Give 3–8 findings, most important first. Be specific and grounded in the log; do not invent activity.",
  "Do not use any tools.",
].join(" ");

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Build the redacted, numbered activity log. Index i ↔ events[i]. */
export function buildActivityLog(
  events: Event[],
  denylist: Denylist,
  salt: string,
  level: RedactionLevel,
): string {
  const clean = (s: string): string => {
    const out = redactText(s, denylist, salt, level);
    assertClean(out, denylist, level); // fail-closed even at raw (secrets)
    return out;
  };
  return events
    .map((e, i) => {
      const where = e.ticket ?? e.project ?? "?";
      if (e.kind === "ai_interaction") {
        const canceled = e.payload.isCanceled ? " [canceled]" : "";
        const prompt = clean(truncate(String(e.payload.prompt ?? ""), MAX_PROMPT_CHARS));
        return `[e${i}] ${where} AI${canceled}: ${prompt}`;
      }
      if (e.kind === "commit") {
        const subject = clean(truncate(String(e.payload.subject ?? ""), 200));
        return `[e${i}] ${where} commit: ${subject}`;
      }
      return `[e${i}] ${where} ${e.kind}`;
    })
    .join("\n");
}

export function buildExplorePrompt(activityLog: string): string {
  return `${EXPLORE_PROMPT}\n\nACTIVITY LOG:\n${activityLog}`;
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clamp01(x: unknown, fallback: number): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Strip an accidental ```json fence and isolate the JSON array. */
function extractJsonArray(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * Parse the model's JSON findings into {@link Candidate}s, mapping cited [e#]
 * indices back to event ids. Lenient and never throws — bad output yields []
 * (the deterministic detectors still carry the digest).
 */
export function parseExploreCandidates(raw: string, events: Event[]): Candidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Candidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const headline = str(f.headline);
    if (!headline) continue;

    const indices = Array.isArray(f.evidence) ? f.evidence : [];
    const evidence = indices
      .map((n) => (typeof n === "number" ? events[n] : undefined))
      .filter((e): e is Event => !!e)
      .map((e) => e.eventId);

    out.push({
      detector: "explore",
      signature: `explore:${slug(headline)}`,
      headline,
      whatHappened: str(f.what_happened) || headline,
      suggestion: str(f.suggestion) || "Consider whether this is worth a saved artifact.",
      category: pick(f.category, CATEGORIES, "lesson"),
      artifactType: pick(f.artifact_type, ARTIFACT_TYPES, "none"),
      evidence,
      // Cap model-claimed confidence below a maxed-out deterministic hit so the
      // verified backbone outranks an unverified open-ended guess at a tie.
      confidence: Math.min(0.85, clamp01(f.confidence, 0.6)),
    });
  }
  return out;
}

/**
 * Run the open-ended detector remotely over a week of events. Returns extra
 * candidates to fold into the digest. On any remote/parse failure it returns []
 * so the digest degrades to the deterministic detectors rather than breaking.
 */
export async function exploreCandidates(
  events: Event[],
  runner: CopilotRunner,
  opts: {
    denylist: Denylist;
    salt: string;
    level?: RedactionLevel;
    model?: string;
    maxEvents?: number;
  },
): Promise<Candidate[]> {
  const level = opts.level ?? DEFAULT_LEVEL;
  const slice = events.slice(0, opts.maxEvents ?? MAX_EVENTS);
  if (slice.length === 0) return [];
  const log = buildActivityLog(slice, opts.denylist, opts.salt, level);
  const prompt = buildExplorePrompt(log);
  try {
    const raw = await runner(prompt, opts.model ?? "auto");
    return parseExploreCandidates(raw, slice);
  } catch {
    return [];
  }
}
