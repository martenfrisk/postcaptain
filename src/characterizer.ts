/**
 * Characterizer — the local-LLM stage that turns one deterministic candidate
 * into a structured, actionable insight (design §5). It runs on Ollama, so it
 * may see raw evidence (nothing leaves the machine). Its job over the detector's
 * output is to verify the pattern, sharpen the narration, and — crucially —
 * **draft a concrete artifact** you can accept or reject (principle §3).
 *
 * One candidate at a time, bounded input, JSON-only output, low temperature.
 * If the model is unavailable or returns junk, it degrades gracefully to the
 * candidate's deterministic fields so the pipeline never breaks.
 */

import type { ArtifactType, Candidate, Category } from "./detectors.ts";
import type { Event } from "./events.ts";
import type { LlmClient } from "./llm.ts";

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

/** The characterized insight — the §5 candidate→insight contract. */
export interface Insight {
  detector: string;
  signature: string;
  headline: string;
  whatHappened: string;
  suggestion: string;
  category: Category;
  artifactType: ArtifactType;
  /** The drafted artifact text (the thing you accept/reject). */
  artifactDraft: string;
  evidence: string[];
  confidence: number;
  /** Whether the LLM produced this, or we fell back to the candidate. */
  characterized: boolean;
}

const SYSTEM = [
  "You are a senior engineer reviewing one detected pattern in a colleague's workday.",
  "Verify the pattern, then write a tight, concrete insight and DRAFT THE ARTIFACT that resolves it",
  "(e.g. the actual prompt scaffold, code snippet, git alias, or workflow steps).",
  "Output ONLY a JSON object with keys: headline, what_happened, suggestion, category",
  "('shortcut' or 'lesson'), artifact_type (one of: skill, snippet, git_alias, keybind, workflow, agent, note, none),",
  "artifact_draft (the ready-to-use artifact as a string; empty if artifact_type is none),",
  "confidence (0..1, your verified confidence). Be specific and brief. No prose outside the JSON.",
].join(" ");

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Render bounded evidence for the prompt. Local model → raw text is fine. */
function evidenceLines(evidence: Event[]): string {
  return evidence
    .slice(0, 12)
    .map((e) => {
      const where = e.ticket ?? e.project ?? "?";
      if (e.kind === "ai_interaction") {
        const model = (e.payload.model as string) ?? "?";
        return `- [${where}] AI(${model}): "${truncate(String(e.payload.prompt ?? ""), 160)}"`;
      }
      if (e.kind === "commit") {
        return `- [${where}] commit: "${truncate(String(e.payload.subject ?? ""), 160)}"`;
      }
      return `- [${where}] ${e.kind}`;
    })
    .join("\n");
}

export function buildPrompt(candidate: Candidate, evidence: Event[]): string {
  return [
    `Detector: ${candidate.detector}`,
    `Provisional headline: ${candidate.headline}`,
    `What the detector saw: ${candidate.whatHappened}`,
    `Provisional suggestion: ${candidate.suggestion}`,
    "",
    `Evidence (${evidence.length} events):`,
    evidenceLines(evidence),
  ].join("\n");
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function clamp01(x: unknown, fallback: number): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** Build the deterministic fallback insight from a candidate. */
function fallbackInsight(candidate: Candidate): Insight {
  return {
    detector: candidate.detector,
    signature: candidate.signature,
    headline: candidate.headline,
    whatHappened: candidate.whatHappened,
    suggestion: candidate.suggestion,
    category: candidate.category,
    artifactType: candidate.artifactType,
    artifactDraft: "",
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    characterized: false,
  };
}

/**
 * Characterize one candidate into an insight using the local model. Evidence is
 * the candidate's events (looked up by the caller). Never throws — on any error
 * it returns the deterministic fallback.
 */
export async function characterize(
  candidate: Candidate,
  evidence: Event[],
  client: LlmClient,
): Promise<Insight> {
  try {
    const raw = await client.generate(buildPrompt(candidate, evidence), {
      system: SYSTEM,
      json: true,
      temperature: 0,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      detector: candidate.detector,
      signature: candidate.signature,
      headline: str(parsed.headline, candidate.headline),
      whatHappened: str(parsed.what_happened, candidate.whatHappened),
      suggestion: str(parsed.suggestion, candidate.suggestion),
      category: pick(parsed.category, CATEGORIES, candidate.category),
      artifactType: pick(parsed.artifact_type, ARTIFACT_TYPES, candidate.artifactType),
      artifactDraft: str(parsed.artifact_draft, ""),
      evidence: candidate.evidence,
      confidence: clamp01(parsed.confidence, candidate.confidence),
      characterized: true,
    };
  } catch {
    return fallbackInsight(candidate);
  }
}

/**
 * Characterize many candidates. Evidence is resolved from `byId`. Optionally
 * pre-filtered by the surfacing confidence bar (§6, default 0.6).
 */
export async function characterizeAll(
  candidates: Candidate[],
  byId: Map<string, Event>,
  client: LlmClient,
  opts: { minConfidence?: number } = {},
): Promise<Insight[]> {
  const min = opts.minConfidence ?? 0;
  const insights: Insight[] = [];
  for (const c of candidates) {
    if (c.confidence < min) continue;
    const evidence = c.evidence.map((id) => byId.get(id)).filter((e): e is Event => !!e);
    insights.push(await characterize(c, evidence, client));
  }
  return insights;
}
