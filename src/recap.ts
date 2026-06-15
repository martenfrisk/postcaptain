/**
 * Daily recap — a lightweight, no-LLM summary of one day's activity (design §9).
 *
 * Pure aggregation over events: time shape, AI-usage read, commit output, and
 * the tickets touched. The weekly digest (a later phase) is the LLM/Copilot-CLI
 * synthesis; this stays deterministic and cheap.
 */

import type { Event } from "./events.ts";
import { sessionize } from "./sessionizer.ts";

export interface DailyRecap {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  eventCount: number;
  ai: {
    interactions: number;
    tokensEst: number;
    ask: number;
    agent: number;
    canceled: number;
    topModel: string | null;
  };
  commits: {
    count: number;
    insertions: number;
    deletions: number;
  };
  sessions: {
    count: number;
    /** Sum of session durations — a focused-time proxy. */
    focusedMs: number;
  };
  tickets: string[];
  projects: string[];
}

/** UTC day string for an epoch-ms timestamp. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Distinct UTC days present in the events, most recent first. */
export function availableDays(events: Event[]): string[] {
  return [...new Set(events.map((e) => dayOf(e.ts)))].sort().reverse();
}

function topKey(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * Build the recap for one day. Defaults to the most recent day present.
 * Returns null if there are no events on that day.
 */
export function dailyRecap(events: Event[], day?: string): DailyRecap | null {
  const date = day ?? availableDays(events)[0];
  if (!date) return null;
  const dayEvents = events.filter((e) => dayOf(e.ts) === date);
  if (dayEvents.length === 0) return null;

  const ai = dayEvents.filter((e) => e.kind === "ai_interaction");
  const commits = dayEvents.filter((e) => e.kind === "commit");
  const models = new Map<string, number>();
  let tokensEst = 0;
  let ask = 0;
  let agent = 0;
  let canceled = 0;
  for (const e of ai) {
    tokensEst += Number(e.payload.tokensEst ?? 0);
    if (e.payload.agentMode === "agent") agent++;
    else ask++;
    if (e.payload.isCanceled) canceled++;
    const model = e.payload.model;
    if (typeof model === "string") models.set(model, (models.get(model) ?? 0) + 1);
  }

  let insertions = 0;
  let deletions = 0;
  for (const e of commits) {
    insertions += Number(e.payload.insertions ?? 0);
    deletions += Number(e.payload.deletions ?? 0);
  }

  const sessions = sessionize(dayEvents);
  const tickets = [
    ...new Set(dayEvents.map((e) => e.ticket).filter((t): t is string => !!t)),
  ].sort();
  const projects = [
    ...new Set(dayEvents.map((e) => e.project).filter((p): p is string => !!p)),
  ].sort();

  return {
    date,
    eventCount: dayEvents.length,
    ai: { interactions: ai.length, tokensEst, ask, agent, canceled, topModel: topKey(models) },
    commits: { count: commits.length, insertions, deletions },
    sessions: { count: sessions.length, focusedMs: sessions.reduce((a, s) => a + s.durationMs, 0) },
    tickets,
    projects,
  };
}
