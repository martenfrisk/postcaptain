/**
 * Weekly synthesis (design §8/§9) — the one *remote* call in the system. It
 * takes the week's local, characterized insights, runs them through the
 * redaction gate (§8), then asks GitHub Copilot CLI (non-interactive) to
 * synthesize the weekly digest: top insights, a dedicated AI-usage read, and
 * one experiment to try.
 *
 * Data flow (§8): `sensitive raw → local LLM → abstracted insight → redact →
 * Copilot CLI synthesis`. Only redacted, abstracted conclusions ever reach the
 * remote model — the powerful model sees conclusions, never the codebase.
 *
 * Privacy posture: the remote call is opt-in. Callers build a preview first
 * (`buildDigestInput` → `previewText`) and only invoke the runner on explicit
 * confirmation. Redaction is fail-closed — any leak throws and aborts the send.
 */

import { tmpdir } from "node:os";
import { characterizeAll, type Insight } from "./characterizer.ts";
import { type Candidate, detectAll } from "./detectors.ts";
import type { Event } from "./events.ts";
import type { LlmClient } from "./llm.ts";
import {
  assertClean,
  DEFAULT_LEVEL,
  type Denylist,
  type RedactedInsight,
  type RedactionLevel,
  redactInsights,
  redactText,
} from "./redact.ts";
import { sessionize } from "./sessionizer.ts";
import { makeRecord, recordUsage } from "./usage.ts";

/** The remote model is invoked through this seam so tests can inject a fake. */
export type CopilotRunner = (prompt: string, model: string) => Promise<string>;

const DEFAULT_MODEL = "auto"; // let Copilot pick; no premium model required

/**
 * Real Copilot CLI runner: `copilot -p <prompt> --model <m>` in non-interactive
 * mode. Runs in a temp dir (not the repo) so the agent can't touch project
 * files, and reads only stdout (the answer; the credits/token footer is stderr).
 *
 * Every call is metered: the stderr footer is parsed for credits and the call's
 * sizes are appended to the local usage log under `purpose` (no content stored).
 */
export function copilotRunner(purpose = "digest"): CopilotRunner {
  return async (prompt, model) => {
    const proc = Bun.spawn(
      ["copilot", "-p", prompt, "--model", model, "--allow-all-tools", "--no-color"],
      { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`copilot exited ${code}: ${stderr.trim().slice(0, 300)}`);
    }
    const response = stdout.trim();
    try {
      recordUsage(makeRecord({ purpose, model, prompt, response, stderr }));
    } catch {
      // metering must never break the actual call
    }
    return response;
  };
}

// --- week selection ----------------------------------------------------------

export interface WeekRange {
  startTs: number;
  endTs: number;
  label: string; // e.g. "2026-06-08 — 2026-06-14"
}

function ymd(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The Mon–Sun week (UTC) containing `day` (default: now). */
export function weekRange(day: Date = new Date()): WeekRange {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const start = d.getTime() - dow * 86_400_000;
  const end = start + 7 * 86_400_000;
  return { startTs: start, endTs: end, label: `${ymd(start)} — ${ymd(end - 86_400_000)}` };
}

// --- digest assembly ---------------------------------------------------------

/** Per-project week aggregates — quantitative grounding for the AI-usage read. */
export interface WeekStats {
  aiInteractions: number;
  canceled: number;
  commits: number;
  promptTokensEst: number;
  responseTokensEst: number;
  projects: number;
  tickets: number;
}

/**
 * A flat, longitudinal lesson summary (§7) for the digest. The theme layer owns
 * the lifecycle; synthesis only needs these strings, so it stays decoupled from
 * `themes.ts` (which depends on this module for the week helpers).
 */
export interface DigestLesson {
  headline: string;
  trend: string; // e.g. "5 → 3 → 1 ↓ improving"
  status: string;
  suggestion: string;
}

export interface DigestInput {
  week: WeekRange;
  level: RedactionLevel;
  stats: WeekStats;
  insights: Insight[]; // local, pre-redaction (for the operator's own view)
  redacted: RedactedInsight[]; // exactly what would be sent remote
  lessons: DigestLesson[]; // materially-changed lessons, local view
  redactedLessons: DigestLesson[]; // the same, redacted — what would be sent
}

function weekStats(events: Event[]): WeekStats {
  const ai = events.filter((e) => e.kind === "ai_interaction");
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    aiInteractions: ai.length,
    canceled: ai.filter((e) => Boolean(e.payload.isCanceled)).length,
    commits: events.filter((e) => e.kind === "commit").length,
    promptTokensEst: ai.reduce((s, e) => s + num(e.payload.promptTokensEst), 0),
    responseTokensEst: ai.reduce((s, e) => s + num(e.payload.responseTokensEst), 0),
    projects: new Set(events.map((e) => e.project).filter(Boolean)).size,
    tickets: new Set(events.map((e) => e.ticket).filter(Boolean)).size,
  };
}

/**
 * Assemble the week's redacted insights locally: filter events to the week, run
 * the deterministic detectors, characterize them on the LOCAL model, then
 * redact at the configured tier. No remote call happens here — this is the
 * reviewable, fail-closed preparation step. Extra `candidates` (e.g. from the
 * remote open-ended detector) can be folded in alongside the deterministic ones.
 */
export async function buildDigestInput(
  events: Event[],
  client: LlmClient,
  denylist: Denylist,
  salt: string,
  opts: {
    day?: Date;
    minConfidence?: number;
    level?: RedactionLevel;
    extraCandidates?: Candidate[];
    lessons?: DigestLesson[];
  } = {},
): Promise<DigestInput> {
  const level = opts.level ?? DEFAULT_LEVEL;
  const week = weekRange(opts.day);
  const inWeek = events.filter((e) => e.ts >= week.startTs && e.ts < week.endTs);
  const candidates = [
    ...detectAll({ events: inWeek, sessions: sessionize(inWeek) }),
    ...(opts.extraCandidates ?? []),
  ].sort((a, b) => b.confidence - a.confidence);
  const byId = new Map(inWeek.map((e) => [e.eventId, e]));
  const insights = await characterizeAll(candidates, byId, client, {
    minConfidence: opts.minConfidence ?? 0.6,
  });
  const redacted = redactInsights(insights, denylist, salt, level);
  const lessons = opts.lessons ?? [];
  const redactedLessons = lessons.map((l) => redactLesson(l, denylist, salt, level));
  return { week, level, stats: weekStats(inWeek), insights, redacted, lessons, redactedLessons };
}

/** Redact a lesson's text fields at the active tier (fail-closed, §8). */
function redactLesson(
  lesson: DigestLesson,
  denylist: Denylist,
  salt: string,
  level: RedactionLevel,
): DigestLesson {
  const clean = (s: string): string => {
    const out = redactText(s, denylist, salt, level);
    assertClean(out, denylist, level);
    return out;
  };
  // The trend line is just numbers/arrows — no identifiers — but route it through
  // the gate anyway so nothing bypasses the self-check.
  return {
    headline: clean(lesson.headline),
    trend: clean(lesson.trend),
    status: lesson.status,
    suggestion: clean(lesson.suggestion),
  };
}

const SYNTHESIS_PROMPT = [
  "You are a senior engineer writing a developer's WEEKLY work digest.",
  "Below is the week's STATS (quantitative grounding) and a JSON array of",
  "already-redacted, abstracted insights. Identifiers may be pseudonymized tokens",
  "like repo:7f3a — treat any such token as an opaque label.",
  "Write a concise digest in Markdown with exactly these sections:",
  "1. **Top insights** — the 3–5 most worthwhile, each: one-line why + the concrete next action.",
  "2. **AI-usage read** — read the stats: where AI clearly helped vs. cost time, and ONE habit to change.",
  "3. **Lessons** — for each tracked LESSON below, one line acknowledging the trend",
  "(e.g. improving/regressed) like a mentor would; omit this section if none are provided.",
  "4. **One experiment** — a single concrete thing to try next week.",
  "Be specific and brief. Ground every claim in the provided stats/insights/lessons — do not invent activity.",
  "Output only the Markdown digest. Do not use any tools.",
].join(" ");

function statsBlock(week: WeekRange, stats: WeekStats): string {
  const cancelPct = stats.aiInteractions
    ? Math.round((stats.canceled / stats.aiInteractions) * 100)
    : 0;
  return JSON.stringify(
    {
      week: week.label,
      aiInteractions: stats.aiInteractions,
      canceled: stats.canceled,
      canceledPct: cancelPct,
      commits: stats.commits,
      promptTokensEst: stats.promptTokensEst,
      responseTokensEst: stats.responseTokensEst,
      projects: stats.projects,
      tickets: stats.tickets,
    },
    null,
    2,
  );
}

/** The exact prompt+payload that would be sent to the remote model. */
export function buildSynthesisPrompt(input: DigestInput): string {
  const parts = [
    SYNTHESIS_PROMPT,
    "",
    `STATS:\n${statsBlock(input.week, input.stats)}`,
    "",
    `INSIGHTS:\n${JSON.stringify(input.redacted, null, 2)}`,
  ];
  if (input.redactedLessons.length > 0) {
    parts.push("", `LESSONS:\n${JSON.stringify(input.redactedLessons, null, 2)}`);
  }
  return parts.join("\n");
}

/**
 * A deterministic, fully-local digest — no remote call. Lets `digest` (without
 * `--send`) produce something readable, and serves as the always-available
 * fallback. The remote synthesis is then a clear *upgrade*, not the only path.
 */
export function localDigest(input: DigestInput): string {
  const { stats } = input;
  const cancelPct = stats.aiInteractions
    ? Math.round((stats.canceled / stats.aiInteractions) * 100)
    : 0;
  const lines = [
    `# Weekly digest — ${input.week.label}`,
    "",
    `**Activity:** ${stats.aiInteractions} AI interactions (${cancelPct}% canceled), ` +
      `${stats.commits} commits across ${stats.projects} projects / ${stats.tickets} tickets. ` +
      `~${stats.promptTokensEst + stats.responseTokensEst} est. tokens.`,
    "",
    "## Findings",
  ];
  if (input.insights.length === 0) {
    lines.push("", "_No findings above the confidence bar this week._");
  }
  for (const i of input.insights) {
    lines.push(
      "",
      `### ${i.headline}  _(${i.category} · ${(i.confidence * 100).toFixed(0)}%)_`,
      i.whatHappened,
      `→ **${i.suggestion}**`,
    );
    if (i.artifactDraft) {
      lines.push("", `_${i.artifactType}:_`, "```", i.artifactDraft, "```");
    }
  }
  // Lessons render regardless of findings — a lesson often *improves* precisely
  // because activity dropped, which is the no-findings case.
  if (input.lessons.length > 0) {
    lines.push("", "## Lessons");
    for (const l of input.lessons) {
      lines.push("", `### ${l.headline}  _(${l.status})_`, `${l.trend}`, `→ **${l.suggestion}**`);
    }
  }
  return lines.join("\n");
}

/** Human-readable "this is what would be sent" preview (§8 visible + opt-in). */
export function previewText(input: DigestInput): string {
  const lines = [
    `Week: ${input.week.label}`,
    `Redaction tier: ${input.level}${input.level !== "strict" ? "  (identifiers NOT pseudonymized; secrets still masked)" : ""}`,
    `Insights characterized locally: ${input.insights.length}`,
    "",
    "── This is exactly what would be sent to Copilot CLI ──",
    "",
    buildSynthesisPrompt(input),
  ];
  return lines.join("\n");
}

export interface DigestResult {
  week: WeekRange;
  sent: boolean;
  digest?: string; // present only when sent
  redacted: RedactedInsight[];
}

/**
 * Perform the remote synthesis. The caller is responsible for having shown the
 * preview and obtained opt-in; this function makes the actual remote call.
 */
export async function synthesize(
  input: DigestInput,
  runner: CopilotRunner,
  model: string = DEFAULT_MODEL,
): Promise<DigestResult> {
  if (input.redacted.length === 0) {
    return { week: input.week, sent: false, redacted: [] };
  }
  const digest = await runner(buildSynthesisPrompt(input), model);
  return { week: input.week, sent: true, digest, redacted: input.redacted };
}
