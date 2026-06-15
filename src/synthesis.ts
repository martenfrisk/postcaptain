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
import { detectAll } from "./detectors.ts";
import type { Event } from "./events.ts";
import type { LlmClient } from "./llm.ts";
import { type Denylist, type RedactedInsight, redactInsights } from "./redact.ts";
import { sessionize } from "./sessionizer.ts";

/** The remote model is invoked through this seam so tests can inject a fake. */
export type CopilotRunner = (prompt: string, model: string) => Promise<string>;

const DEFAULT_MODEL = "auto"; // let Copilot pick; no premium model required

/**
 * Real Copilot CLI runner: `copilot -p <prompt> --model <m>` in non-interactive
 * mode. Runs in a temp dir (not the repo) so the agent can't touch project
 * files, and reads only stdout (the answer; the credits/token footer is stderr).
 */
export function copilotRunner(): CopilotRunner {
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
    return stdout.trim();
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

export interface DigestInput {
  week: WeekRange;
  insights: Insight[]; // local, pre-redaction (for the operator's own view)
  redacted: RedactedInsight[]; // exactly what would be sent remote
}

/**
 * Assemble the week's redacted insights locally: filter events to the week, run
 * the deterministic detectors, characterize them on the LOCAL model, then
 * redact. No remote call happens here — this is the reviewable, fail-closed
 * preparation step.
 */
export async function buildDigestInput(
  events: Event[],
  client: LlmClient,
  denylist: Denylist,
  salt: string,
  opts: { day?: Date; minConfidence?: number } = {},
): Promise<DigestInput> {
  const week = weekRange(opts.day);
  const inWeek = events.filter((e) => e.ts >= week.startTs && e.ts < week.endTs);
  const candidates = detectAll({ events: inWeek, sessions: sessionize(inWeek) });
  const byId = new Map(inWeek.map((e) => [e.eventId, e]));
  const insights = await characterizeAll(candidates, byId, client, {
    minConfidence: opts.minConfidence ?? 0.6,
  });
  const redacted = redactInsights(insights, denylist, salt);
  return { week, insights, redacted };
}

const SYNTHESIS_PROMPT = [
  "You are a senior engineer writing a developer's WEEKLY work digest.",
  "Below is a JSON array of already-redacted, abstracted insights from their week",
  "(identifiers are pseudonymized tokens like repo:7f3a — treat them as opaque labels).",
  "Write a concise digest in Markdown with exactly these sections:",
  "1. **Top insights** — the 3–5 most worthwhile, each: one-line why + the concrete next action.",
  "2. **AI-usage read** — where AI clearly helped vs. cost time, and ONE habit to change.",
  "3. **One experiment** — a single concrete thing to try next week.",
  "Be specific and brief. Ground every claim in the provided insights — do not invent activity.",
  "Output only the Markdown digest. Do not use any tools.",
].join(" ");

/** The exact prompt+payload that would be sent to the remote model. */
export function buildSynthesisPrompt(redacted: RedactedInsight[]): string {
  return `${SYNTHESIS_PROMPT}\n\nINSIGHTS:\n${JSON.stringify(redacted, null, 2)}`;
}

/** Human-readable "this is what would be sent" preview (§8 visible + opt-in). */
export function previewText(input: DigestInput): string {
  const lines = [
    `Week: ${input.week.label}`,
    `Insights characterized locally: ${input.insights.length}`,
    "",
    "── This is exactly what would be sent to Copilot CLI (redacted) ──",
    "",
    buildSynthesisPrompt(input.redacted),
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
  const digest = await runner(buildSynthesisPrompt(input.redacted), model);
  return { week: input.week, sent: true, digest, redacted: input.redacted };
}
