/**
 * Deterministic detectors — the reliable, no-LLM backbone (design §5/§6).
 *
 * Each detector is a pure function `(ctx) => Candidate[]`: it finds candidate
 * patterns and attaches evidence (event ids) and a heuristic confidence. The
 * LLM characterizer (a later phase) only *narrates* and verifies a candidate;
 * detectors never call a model. This file implements the subset of the §6 seed
 * catalog that the data we already capture (AI interactions + commits) supports.
 */

import type { Event } from "./events.ts";
import type { Session } from "./sessionizer.ts";

export type Category = "shortcut" | "lesson";
export type ArtifactType =
  | "skill"
  | "snippet"
  | "git_alias"
  | "keybind"
  | "workflow"
  | "agent"
  | "note"
  | "none";

/** A detected pattern, pre-characterization (the deterministic half of §5). */
export interface Candidate {
  detector: string;
  /** Stable dedup key — anti-repetition machinery hangs off this (§6). */
  signature: string;
  headline: string;
  whatHappened: string;
  suggestion: string;
  category: Category;
  artifactType: ArtifactType;
  evidence: string[];
  /** 0..1 deterministic heuristic; the ranker applies the ≥0.6 bar (§6). */
  confidence: number;
  /**
   * Optional quantity a lesson tracks over weeks (lower = better), e.g. the
   * count of multi-follow-up sessions. The theme layer (§7) trends it; absent it
   * falls back to evidence volume. Shortcuts can leave this unset.
   */
  metric?: number;
}

export interface DetectorContext {
  events: Event[];
  sessions: Session[];
}

export type Detector = (ctx: DetectorContext) => Candidate[];

const DAY_MS = 24 * 60 * 60 * 1000;

function aiInteractions(events: Event[]): Event[] {
  return events.filter((e) => e.kind === "ai_interaction");
}

/** Normalize a prompt for repetition matching: drop code, lowercase, collapse. */
export function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Clamp a raw score into the 0..1 confidence range. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Repetition: the same normalized prompt issued repeatedly across days → a
 * saved prompt / snippet worth keeping (§6).
 */
export const repetitionDetector: Detector = ({ events }) => {
  const groups = new Map<string, { ids: string[]; days: Set<number>; sample: string }>();
  for (const e of aiInteractions(events)) {
    const prompt = String(e.payload.prompt ?? "");
    const norm = normalizePrompt(prompt);
    if (norm.length < 12) continue; // ignore trivial one-liners
    const g = groups.get(norm) ?? { ids: [], days: new Set(), sample: prompt };
    g.ids.push(e.eventId);
    g.days.add(Math.floor(e.ts / DAY_MS));
    groups.set(norm, g);
  }

  const out: Candidate[] = [];
  for (const [norm, g] of groups) {
    if (g.ids.length < 3 || g.days.size < 2) continue;
    out.push({
      detector: "repetition",
      signature: `repetition:${norm}`,
      headline: `Recurring prompt used ${g.ids.length}× across ${g.days.size} days`,
      whatHappened: `You sent a near-identical prompt ${g.ids.length} times: "${truncate(g.sample, 80)}".`,
      suggestion: "Save it as a reusable prompt/snippet or a project custom-instruction.",
      category: "shortcut",
      artifactType: "snippet",
      evidence: g.ids,
      confidence: clamp01(0.5 + 0.1 * (g.ids.length - 2)),
    });
  }
  return out;
};

/**
 * Struggle / skill-gap: a single ticket session with a long burst of AI
 * prompts (high churn) → a reusable scaffold would have helped (§6).
 */
export const struggleDetector: Detector = ({ sessions }) => {
  const out: Candidate[] = [];
  for (const s of sessions) {
    const aiCount = s.kinds.ai_interaction ?? 0;
    if (aiCount < 6) continue;
    out.push({
      detector: "struggle",
      signature: `struggle:${s.id}`,
      headline: `High AI churn on ${s.key} (${aiCount} prompts in one session)`,
      whatHappened: `One ${Math.round(s.durationMs / 60000)}-min session on ${s.key} needed ${aiCount} AI prompts to make progress.`,
      suggestion: "Capture a prompt scaffold or custom-instruction for this task shape.",
      category: "shortcut",
      artifactType: "skill",
      evidence: s.eventIds,
      confidence: clamp01(0.45 + 0.05 * (aiCount - 5)),
    });
  }
  return out;
};

/**
 * Prompting habit: if most AI sessions need several follow-ups, that's a
 * one-shot-prompting habit worth changing — a lesson, not a one-off (§6/§7).
 */
export const followupHabitDetector: Detector = ({ sessions }) => {
  const aiSessions = sessions.filter((s) => (s.kinds.ai_interaction ?? 0) > 0);
  if (aiSessions.length < 5) return [];
  const multi = aiSessions.filter((s) => (s.kinds.ai_interaction ?? 0) >= 3);
  const ratio = multi.length / aiSessions.length;
  if (ratio < 0.4) return [];
  return [
    {
      detector: "followup-habit",
      signature: "followup-habit",
      headline: `${Math.round(ratio * 100)}% of AI sessions needed 3+ follow-ups`,
      whatHappened: `${multi.length} of ${aiSessions.length} AI sessions took three or more prompts to resolve.`,
      suggestion: "Front-load context (files, constraints, examples) to cut follow-up rounds.",
      category: "lesson",
      artifactType: "none",
      evidence: multi.flatMap((s) => s.eventIds).slice(0, 20),
      confidence: clamp01(0.4 + ratio * 0.5),
      // The trend metric (§7): how many sessions needed 3+ follow-ups this week.
      metric: multi.length,
    },
  ];
};

/**
 * Abandonment signal: a notable share of AI interactions were canceled →
 * a workflow gap (the tool isn't fitting the task), not a prompt gap (§6).
 */
export const canceledDetector: Detector = ({ events }) => {
  const ai = aiInteractions(events);
  if (ai.length < 5) return [];
  const canceled = ai.filter((e) => Boolean(e.payload.isCanceled));
  const ratio = canceled.length / ai.length;
  if (canceled.length < 3 || ratio < 0.2) return [];
  return [
    {
      detector: "ai-cancels",
      signature: "ai-cancels",
      headline: `${canceled.length} AI interactions canceled (${Math.round(ratio * 100)}%)`,
      whatHappened: `${canceled.length} of ${ai.length} AI interactions were canceled mid-flight.`,
      suggestion: "Where you keep bailing out, the workflow may need an agent/command, not a chat.",
      category: "shortcut",
      artifactType: "workflow",
      evidence: canceled.map((e) => e.eventId),
      confidence: clamp01(0.4 + ratio),
    },
  ];
};

/**
 * Meeting load / maker-time: a heavy meeting day-rate eats the contiguous focus
 * blocks maker work needs (§6). Tracked as a *lesson* so the theme layer (§7)
 * can show meeting hygiene trending over weeks. All-day blocks (holidays,
 * birthdays, OOO) are ignored — only timed meetings count. The metric is the
 * window's meeting hours (lower = better), so a calmer week reads as improving.
 */
export const meetingLoadDetector: Detector = ({ events }) => {
  const meetings = events
    .filter((e) => e.kind === "meeting" && !e.payload.allDay)
    .map((e) => ({ id: e.eventId, min: Number(e.payload.durationMin ?? 0), ts: e.ts }))
    .filter((m) => m.min > 0 && m.min < 24 * 60);
  if (meetings.length < 3) return [];

  const totalMin = meetings.reduce((s, m) => s + m.min, 0);
  const days = new Set(meetings.map((m) => Math.floor(m.ts / DAY_MS))).size;
  const perDayHours = totalMin / 60 / Math.max(1, days);
  // Conservative gate (§6 dial): only a genuinely heavy day-rate is notable.
  if (perDayHours < 2.5) return [];

  const totalHours = Math.round(totalMin / 60);
  const avg = perDayHours.toFixed(1);
  return [
    {
      detector: "meeting-load",
      signature: "meeting-load",
      headline: `${totalHours}h in ${meetings.length} meetings (~${avg}h/active day)`,
      whatHappened: `Across ${days} day(s) with meetings, ~${avg}h/day went to ${meetings.length} timed meetings — squeezing maker time.`,
      suggestion: "Batch meetings into blocks and protect a recurring maker-time slot.",
      category: "lesson",
      artifactType: "none",
      evidence: meetings.map((m) => m.id).slice(0, 20),
      confidence: clamp01(0.4 + (perDayHours - 2.5) * 0.15),
      metric: totalHours,
    },
  ];
};

/**
 * Context-switching / fragmentation (§6): a high rate of short active-window
 * episodes means attention is being sliced thin — the enemy of maker time.
 * Reasons over ActivityWatch `focus` events (one per active-window change).
 * Tracked as a *lesson* (§7) with switches-per-active-hour as the trend metric
 * (lower = better), so focus discipline shows improvement over weeks.
 *
 * The threshold is an uncalibrated dial (§6) — set against documented behavior,
 * to be tuned once real ActivityWatch baselines exist.
 */
export const contextSwitchDetector: Detector = ({ events }) => {
  const focus = events
    .filter((e) => e.kind === "focus")
    .map((e) => ({ id: e.eventId, sec: Number(e.payload.durationSec ?? 0) }))
    .filter((f) => f.sec >= 0);
  if (focus.length < 20) return []; // not enough signal to judge

  const totalSec = focus.reduce((s, f) => s + f.sec, 0);
  if (totalSec <= 0) return [];
  const activeHours = totalSec / 3600;
  const episodes = focus.length;
  const switchesPerHour = episodes / activeHours;
  const shortPct = Math.round((focus.filter((f) => f.sec < 60).length / episodes) * 100);

  // Conservative gate (uncalibrated dial): ~a switch every 2 min or faster.
  if (switchesPerHour < 30) return [];

  const rate = Math.round(switchesPerHour);
  return [
    {
      detector: "context-switching",
      signature: "context-switching",
      headline: `Heavy context-switching: ~${rate} window switches/active hour`,
      whatHappened: `${episodes} focus episodes over ~${activeHours.toFixed(1)}h active; ${shortPct}% were under a minute.`,
      suggestion: "Batch similar work into time-blocks and mute notifications during a maker slot.",
      category: "lesson",
      artifactType: "none",
      evidence: focus.map((f) => f.id).slice(0, 20),
      confidence: clamp01(0.4 + (switchesPerHour - 30) / 120),
      metric: rate,
    },
  ];
};

export const DETECTORS: Detector[] = [
  repetitionDetector,
  struggleDetector,
  followupHabitDetector,
  canceledDetector,
  meetingLoadDetector,
  contextSwitchDetector,
];

/** Run every detector and return candidates, highest confidence first. */
export function detectAll(ctx: DetectorContext): Candidate[] {
  return DETECTORS.flatMap((d) => d(ctx)).sort((a, b) => b.confidence - a.confidence);
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}
