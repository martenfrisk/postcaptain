/**
 * Interactive query — the conversational half of the one-agent-two-modes layer
 * (design §5/§9: "always queryable"). This is a retrieval-augmented Q&A: gather
 * a compact, relevant context from the local store deterministically, then ask
 * the local model to answer *grounded in that context*. Runs on Ollama, so raw
 * activity is fair game (§8).
 *
 * It is intentionally not a full tool-using agent loop yet — that's the richer
 * version of this same entry point.
 */

import type { Event } from "./events.ts";
import type { LlmClient } from "./llm.ts";
import type { Session } from "./sessionizer.ts";

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isoMinute(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/** Searchable text for an event (prompt/subject + ticket/project). */
function eventText(e: Event): string {
  const parts = [e.ticket ?? "", e.project ?? ""];
  if (e.kind === "ai_interaction") parts.push(String(e.payload.prompt ?? ""));
  if (e.kind === "commit") parts.push(String(e.payload.subject ?? ""));
  return parts.join(" ").toLowerCase();
}

function oneLine(e: Event): string {
  const where = e.ticket ?? e.project ?? "?";
  const when = isoMinute(e.ts);
  if (e.kind === "ai_interaction") {
    return `${when} [${where}] AI: "${truncate(String(e.payload.prompt ?? ""), 120)}"`;
  }
  if (e.kind === "commit") {
    return `${when} [${where}] commit: "${truncate(String(e.payload.subject ?? ""), 120)}"`;
  }
  return `${when} [${where}] ${e.kind}`;
}

/**
 * Build a compact context for the question: aggregate stats, recent sessions,
 * and the events most relevant to the question's keywords (falling back to the
 * most recent events when nothing matches).
 */
export function buildContext(
  question: string,
  events: Event[],
  sessions: Session[],
  limit = 25,
): string {
  const ai = events.filter((e) => e.kind === "ai_interaction");
  const commits = events.filter((e) => e.kind === "commit");
  const projects = [...new Set(events.map((e) => e.project).filter(Boolean))];
  const tickets = [...new Set(events.map((e) => e.ticket).filter(Boolean))];

  // Keyword overlap with the question (words of 3+ chars).
  const terms = question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const scored = events
    .map((e) => {
      const text = eventText(e);
      const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.ts - a.e.ts);

  const chosen = (
    scored.length ? scored.map((x) => x.e) : [...events].sort((a, b) => b.ts - a.ts)
  ).slice(0, limit);

  const recentSessions = [...sessions]
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, 8)
    .map(
      (s) =>
        `- ${s.key}: ${isoMinute(s.startTs)}, ${Math.round(s.durationMs / 60000)}m, ${s.eventCount} events`,
    );

  return [
    "ACTIVITY SUMMARY",
    `events: ${events.length} (${ai.length} AI interactions, ${commits.length} commits)`,
    `projects: ${projects.join(", ") || "—"}`,
    `tickets: ${tickets.join(", ") || "—"}`,
    "",
    "RECENT SESSIONS",
    ...recentSessions,
    "",
    `RELEVANT EVENTS (${chosen.length})`,
    ...chosen.map(oneLine),
  ].join("\n");
}

const SYSTEM = [
  "You are a work-activity assistant answering questions about the user's own captured workday.",
  "Answer ONLY from the provided activity context. Be concise and specific (cite dates/tickets/projects).",
  "If the context doesn't contain the answer, say so plainly — do not invent activity.",
].join(" ");

/** Answer a question grounded in the store. Never throws. */
export async function answer(
  question: string,
  events: Event[],
  sessions: Session[],
  client: LlmClient,
): Promise<string> {
  if (events.length === 0) return "No activity captured yet — run `capture` first.";
  const context = buildContext(question, events, sessions);
  try {
    const out = await client.generate(`${context}\n\nQUESTION: ${question}`, {
      system: SYSTEM,
      temperature: 0,
    });
    return out.trim() || "(no answer)";
  } catch (err) {
    return `Could not reach the local model (${err instanceof Error ? err.message : "error"}). Is Ollama running?`;
  }
}
