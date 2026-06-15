/**
 * Remote-call accounting. The mentor makes premium model calls (Copilot CLI) on
 * the user's behalf, so it should account for its own footprint — a tool about
 * using AI well shouldn't be a black box about its own usage.
 *
 * Each remote call appends one record to a local JSONL log (next to the DB).
 * `stats`, the `digest`/`explore` output, and the dashboard read it back. No
 * payload content is stored — only sizes, the (best-effort) credits Copilot
 * reported, and the purpose.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface UsageRecord {
  ts: number;
  purpose: string; // "digest" | "explore" | …
  model: string;
  promptChars: number;
  responseChars: number;
  promptTokensEst: number; // chars ÷ 4 heuristic (same as the capture layer)
  responseTokensEst: number;
  credits?: number; // parsed from Copilot's footer when present
}

export const DEFAULT_USAGE_LOG = "./.postcaptain-usage.jsonl";

/**
 * Best-effort parse of the AI-credits figure from Copilot CLI's stderr footer.
 * Tolerant of wording ("0.8 AI Credits", "Total credits used: 1.2") since the
 * exact phrasing isn't contractual; returns undefined if nothing matches.
 */
export function parseCredits(stderr: string): number | undefined {
  const m = stderr.match(/([\d]+(?:\.[\d]+)?)\s*(?:AI\s+)?credits?/i);
  return m?.[1] ? Number(m[1]) : undefined;
}

const est = (chars: number): number => Math.round(chars / 4);

/** Build a record from raw call inputs/outputs (no content retained). */
export function makeRecord(args: {
  purpose: string;
  model: string;
  prompt: string;
  response: string;
  stderr?: string;
}): UsageRecord {
  return {
    ts: Date.now(),
    purpose: args.purpose,
    model: args.model,
    promptChars: args.prompt.length,
    responseChars: args.response.length,
    promptTokensEst: est(args.prompt.length),
    responseTokensEst: est(args.response.length),
    credits: args.stderr ? parseCredits(args.stderr) : undefined,
  };
}

/** Append one usage record to the JSONL log. */
export function recordUsage(record: UsageRecord, path = DEFAULT_USAGE_LOG): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** Read all usage records back (skips malformed lines). */
export function readUsage(path = DEFAULT_USAGE_LOG): UsageRecord[] {
  if (!existsSync(path)) return [];
  const out: UsageRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as UsageRecord);
    } catch {
      // ignore a partial/corrupt line rather than fail the whole read
    }
  }
  return out;
}

export interface UsageSummary {
  calls: number;
  promptTokensEst: number;
  responseTokensEst: number;
  credits: number; // sum of the records that reported credits
  creditsKnown: number; // how many records actually had a credits figure
  byPurpose: Record<string, number>; // call count per purpose
}

/** Aggregate usage records (optionally only those since `sinceTs`). */
export function summarizeUsage(records: UsageRecord[], sinceTs = 0): UsageSummary {
  const inRange = records.filter((r) => r.ts >= sinceTs);
  const summary: UsageSummary = {
    calls: inRange.length,
    promptTokensEst: 0,
    responseTokensEst: 0,
    credits: 0,
    creditsKnown: 0,
    byPurpose: {},
  };
  for (const r of inRange) {
    summary.promptTokensEst += r.promptTokensEst;
    summary.responseTokensEst += r.responseTokensEst;
    if (typeof r.credits === "number") {
      summary.credits += r.credits;
      summary.creditsKnown += 1;
    }
    summary.byPurpose[r.purpose] = (summary.byPurpose[r.purpose] ?? 0) + 1;
  }
  return summary;
}
