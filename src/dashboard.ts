/**
 * Local dashboard over the event store (design §9 — pull-based, always
 * queryable). Server-rendered HTML, no client JS, no build step. It reads the
 * store fresh on each request and renders: a summary, today's recap, the
 * AI-usage read, an activity chart, detector findings (each expandable to the
 * evidence behind it), and recent work sessions.
 *
 * This is a *view* — read-only. It never writes events or calls a model.
 */

import type { Candidate } from "./detectors.ts";
import { detectAll } from "./detectors.ts";
import type { Event } from "./events.ts";
import { type DailyRecap, dailyRecap } from "./recap.ts";
import { type Session, sessionize } from "./sessionizer.ts";
import { EventStore } from "./store.ts";
import { readUsage, summarizeUsage } from "./usage.ts";

interface Model {
  events: Event[];
  sessions: Session[];
  candidates: Candidate[];
  recap: DailyRecap | null;
  byId: Map<string, Event>;
}

export function buildModel(store: EventStore): Model {
  const events = store.query();
  const sessions = sessionize(events);
  const candidates = detectAll({ events, sessions });
  const byId = new Map(events.map((e) => [e.eventId, e]));
  return { events, sessions, candidates, recap: dailyRecap(events), byId };
}

// ---- formatting & escaping -----------------------------------------------

function esc(s: unknown): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function duration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function isoMinute(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function dateRange(events: Event[]): string {
  const first = events.at(0);
  const last = events.at(-1);
  if (!first || !last) return "—";
  const a = isoDay(first.ts);
  const b = isoDay(last.ts);
  return a === b ? a : `${a} → ${b}`;
}

function tally<T>(items: T[], key: (t: T) => string | null): [string, number][] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- rendering: small pieces ---------------------------------------------

function card(label: string, value: string, sub = ""): string {
  return `<div class="card"><div class="card-value">${value}</div><div class="card-label">${esc(label)}</div>${
    sub ? `<div class="card-sub">${esc(sub)}</div>` : ""
  }</div>`;
}

/** A proportional horizontal bar row (label · fill · count). */
function barRow(label: string, n: number, max: number, kind: "ai" | "commit" | "neutral"): string {
  const pct = max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0;
  return `<li class="bar-row">
    <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
    <span class="bar"><span class="bar-fill ${kind}" style="inline-size:${pct}%"></span></span>
    <span class="bar-num">${num(n)}</span>
  </li>`;
}

// ---- rendering: sections --------------------------------------------------

function renderSummary(m: Model): string {
  const ai = m.events.filter((e) => e.kind === "ai_interaction");
  const commits = m.events.filter((e) => e.kind === "commit");
  const tokens = ai.reduce((s, e) => s + Number(e.payload.tokensEst ?? 0), 0);
  const focusedMs = m.sessions.reduce((s, x) => s + x.durationMs, 0);
  const tickets = new Set(m.events.map((e) => e.ticket).filter(Boolean)).size;
  return `<section class="grid">
    ${card("events", num(m.events.length), dateRange(m.events))}
    ${card("AI interactions", num(ai.length), `~${num(tokens)} est. tokens`)}
    ${card("commits", num(commits.length))}
    ${card("work sessions", num(m.sessions.length), duration(focusedMs))}
    ${card("tickets touched", num(tickets))}
    ${card("findings", num(m.candidates.length))}
  </section>`;
}

function renderRecap(r: DailyRecap | null): string {
  if (!r) return "";
  return `<section class="panel">
    <h2>Today's recap <span class="muted">${esc(r.date)}</span></h2>
    <p class="recap">
      <strong>${num(r.ai.interactions)}</strong> AI interactions
      (${num(r.ai.ask)} ask / ${num(r.ai.agent)} agent${r.ai.canceled ? `, ${num(r.ai.canceled)} canceled` : ""}),
      <strong>~${num(r.ai.tokensEst)}</strong> est. tokens${r.ai.topModel ? ` · mostly ${esc(r.ai.topModel)}` : ""}.
      <strong>${num(r.commits.count)}</strong> commits
      (<span class="add">+${num(r.commits.insertions)}</span> / <span class="del">−${num(r.commits.deletions)}</span>).
      <strong>${duration(r.sessions.focusedMs)}</strong> across ${num(r.sessions.count)} sessions.
      ${r.tickets.length ? `Tickets: ${r.tickets.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}.` : ""}
    </p>
  </section>`;
}

interface Bin {
  label: string;
  ai: number;
  commit: number;
}

type BinUnit = "day" | "week" | "month";

/**
 * Activity bins covering the *full* captured range, with granularity chosen to
 * keep the bar count readable: per-day for short spans, per-week for a few
 * months, per-month for long histories. Empty bins are included so gaps in the
 * activity are honest rather than hidden.
 */
export function activityBins(events: Event[]): { bins: Bin[]; unit: BinUnit } {
  const firstEvent = events.at(0);
  const lastEvent = events.at(-1);
  if (!firstEvent || !lastEvent) return { bins: [], unit: "day" };
  const spanDays = (lastEvent.ts - firstEvent.ts) / DAY_MS;
  const unit: BinUnit = spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month";

  // Map a timestamp to its bin key + build the ordered, gap-filled key list.
  const monthKey = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const utcMidnight = (ts: number) => Date.parse(`${isoDay(ts)}T00:00:00Z`);
  const start = utcMidnight(firstEvent.ts);

  const bins: Bin[] = [];
  const byKey = new Map<string, Bin>();
  const addBin = (key: string, label: string) => {
    const b: Bin = { label, ai: 0, commit: 0 };
    bins.push(b);
    byKey.set(key, b);
  };

  let keyOf: (ts: number) => string;
  if (unit === "month") {
    keyOf = (ts) => monthKey(new Date(ts));
    const d = new Date(
      Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1),
    );
    const end = new Date(lastEvent.ts);
    while (d <= end) {
      addBin(monthKey(d), d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  } else {
    const step = unit === "day" ? DAY_MS : 7 * DAY_MS;
    keyOf = (ts) => String(start + Math.floor((utcMidnight(ts) - start) / step) * step);
    for (let t = start; t <= lastEvent.ts; t += step) addBin(String(t), isoDay(t).slice(5));
  }

  for (const e of events) {
    const b = byKey.get(keyOf(e.ts));
    if (!b) continue;
    if (e.kind === "ai_interaction") b.ai++;
    else if (e.kind === "commit") b.commit++;
  }
  return { bins, unit };
}

function renderActivity(m: Model): string {
  const { bins, unit } = activityBins(m.events);
  if (bins.length < 2) return "";
  const max = Math.max(1, ...bins.map((b) => b.ai + b.commit));
  const H = 120;
  const cols = bins
    .map((b) => {
      const aiH = Math.round((b.ai / max) * H);
      const commitH = Math.round((b.commit / max) * H);
      const title = `${b.label}: ${b.ai} AI, ${b.commit} commits`;
      return `<div class="col" title="${esc(title)}">
        <div class="stack" style="block-size:${H}px">
          <span class="seg ai" style="block-size:${aiH}px"></span>
          <span class="seg commit" style="block-size:${commitH}px"></span>
        </div>
        <div class="col-label">${esc(b.label)}</div>
      </div>`;
    })
    .join("");
  return `<section class="panel">
    <h2>Activity <span class="muted">by ${unit}</span></h2>
    <div class="chart">${cols}</div>
    <div class="legend">
      <span><i class="dot ai"></i> AI interactions</span>
      <span><i class="dot commit"></i> commits</span>
    </div>
  </section>`;
}

function renderAiUsage(m: Model): string {
  const ai = m.events.filter((e) => e.kind === "ai_interaction");
  if (ai.length === 0) return "";
  const byModel = tally(ai, (e) => (e.payload.model as string) ?? null);
  const byProject = tally(ai, (e) => e.project);
  const agent = ai.filter((e) => e.payload.agentMode === "agent").length;
  const ask = ai.length - agent;

  const modelMax = Math.max(1, ...byModel.map(([, n]) => n));
  const projMax = Math.max(1, ...byProject.map(([, n]) => n));
  const modeMax = Math.max(1, ask, agent);

  return `<section class="panel">
    <h2>AI usage</h2>
    <div class="two-col">
      <div><h3>By model</h3><ul class="bars">${byModel
        .slice(0, 6)
        .map(([k, n]) => barRow(k, n, modelMax, "ai"))
        .join("")}</ul></div>
      <div><h3>By project</h3><ul class="bars">${byProject
        .slice(0, 6)
        .map(([k, n]) => barRow(k, n, projMax, "ai"))
        .join("")}</ul></div>
      <div><h3>Mode</h3><ul class="bars">
        ${barRow("ask", ask, modeMax, "neutral")}
        ${barRow("agent", agent, modeMax, "neutral")}
      </ul></div>
    </div>
  </section>`;
}

/**
 * The mentor's own remote footprint (premium Copilot calls it made on the
 * user's behalf). Read from the local usage log; absent until the first call.
 */
function renderRemoteUsage(): string {
  const u = summarizeUsage(readUsage());
  if (u.calls === 0) return "";
  const credits =
    u.creditsKnown > 0
      ? `~${u.credits.toFixed(1)} (${u.creditsKnown}/${u.calls} reported)`
      : "not reported";
  const purposes =
    Object.entries(u.byPurpose)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<span class="tag">${esc(k)} ${num(n)}</span>`)
      .join(" ") || "—";
  return `<section class="panel">
    <h2>Remote usage <span class="muted">this tool's premium calls</span></h2>
    <section class="grid">
      ${card("remote calls", num(u.calls), purposes)}
      ${card("est. tokens", `~${num(u.promptTokensEst + u.responseTokensEst)}`, `${num(u.promptTokensEst)} in / ${num(u.responseTokensEst)} out`)}
      ${card("AI credits", credits)}
    </section>
  </section>`;
}

/** One evidence event, rendered for a finding's expanded detail. */
function evidenceRow(e: Event): string {
  const when = isoMinute(e.ts);
  const where = e.ticket ?? e.project ?? "";
  let detail: string;
  if (e.kind === "ai_interaction") {
    const model = (e.payload.model as string) ?? "?";
    const tokens = Number(e.payload.tokensEst ?? 0);
    const prompt = truncate(String(e.payload.prompt ?? ""), 100);
    detail = `<span class="ev-meta">${esc(model)} · ~${num(tokens)} tok</span> ${esc(prompt)}`;
  } else if (e.kind === "commit") {
    const ins = Number(e.payload.insertions ?? 0);
    const del = Number(e.payload.deletions ?? 0);
    detail = `<span class="ev-meta"><span class="add">+${ins}</span>/<span class="del">−${del}</span></span> ${esc(truncate(String(e.payload.subject ?? ""), 100))}`;
  } else {
    detail = esc(e.kind);
  }
  return `<tr>
    <td class="muted ev-when">${esc(when)}</td>
    <td class="ev-where">${where ? `<span class="tag">${esc(where)}</span>` : ""}</td>
    <td class="ev-detail">${detail}</td>
  </tr>`;
}

function renderFindings(m: Model): string {
  if (m.candidates.length === 0) {
    return `<section class="panel"><h2>Findings</h2><p class="muted">No patterns surfaced yet — capture more activity.</p></section>`;
  }
  const items = m.candidates
    .slice(0, 12)
    .map((c) => {
      const evidence = c.evidence
        .map((id) => m.byId.get(id))
        .filter((e): e is Event => !!e)
        .slice(0, 15);
      const evTable = evidence.length
        ? `<table class="evidence"><tbody>${evidence.map(evidenceRow).join("")}</tbody></table>`
        : "";
      const more =
        c.evidence.length > evidence.length
          ? `<div class="muted ev-more">+${c.evidence.length - evidence.length} more</div>`
          : "";
      return `<details class="finding ${c.category}">
        <summary>
          <span class="badge ${c.category}">${esc(c.category)}</span>
          <span class="finding-title">${esc(c.headline)}</span>
          <span class="conf" title="confidence">${(c.confidence * 100).toFixed(0)}%</span>
        </summary>
        <div class="finding-body">
          <div class="finding-what muted">${esc(c.whatHappened)}</div>
          <div class="finding-sug">→ ${esc(c.suggestion)}</div>
          ${evTable}${more}
        </div>
      </details>`;
    })
    .join("");
  return `<section class="panel"><h2>Findings <span class="muted">click to expand</span></h2><div class="findings">${items}</div></section>`;
}

function renderSessions(m: Model): string {
  if (m.sessions.length === 0) return "";
  const rows = [...m.sessions]
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, 15)
    .map((s) => {
      const kinds = Object.entries(s.kinds)
        .map(([k, n]) => `<span class="kind-chip ${k}">${k.replace("_", " ")} ${n}</span>`)
        .join(" ");
      return `<tr>
        <td>${esc(s.key)}</td>
        <td class="muted">${esc(isoMinute(s.startTs))}</td>
        <td>${duration(s.durationMs)}</td>
        <td>${num(s.eventCount)}</td>
        <td>${kinds}</td>
      </tr>`;
    })
    .join("");
  return `<section class="panel">
    <h2>Recent sessions</h2>
    <table>
      <thead><tr><th>key</th><th>start (UTC)</th><th>duration</th><th>events</th><th>kinds</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function renderPage(m: Model): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>postcaptain</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --ink: #1a1d21; --muted: #6b7280;
    --line: #e8eaed; --accent: #2563eb;
    --c-ai: #6366f1; --c-commit: #10b981;
    --add: #16a34a; --del: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --ink: #e6e8eb; --muted: #9aa3af;
      --line: #272b33; --accent: #6ea8fe;
      --c-ai: #818cf8; --c-commit: #34d399;
      --add: #4ade80; --del: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 2rem clamp(1rem, 4vw, 3rem); max-inline-size: 1100px; margin-inline: auto;
  }
  header.top { display: flex; align-items: baseline; gap: .75rem; margin-block-end: 1.5rem; }
  header.top h1 {
    margin: 0; font-size: 1.4rem; letter-spacing: -0.01em;
    background: linear-gradient(95deg, var(--c-ai), var(--c-commit));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .muted { color: var(--muted); font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-block-end: 1.5rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
  .card-value { font-size: 1.7rem; font-weight: 650; letter-spacing: -0.02em; }
  .card-label { color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  .card-sub { color: var(--muted); font-size: .82rem; margin-block-start: .25rem; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem 1.4rem; margin-block-end: 1.25rem; }
  .panel h2 { margin: 0 0 .9rem; font-size: 1.05rem; }
  .panel h3 { margin: 0 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .recap { margin: 0; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; }

  /* proportional bars */
  ul.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
  .bar-row { display: grid; grid-template-columns: minmax(0, 9rem) 1fr auto; align-items: center; gap: .6rem; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9rem; }
  .bar { background: color-mix(in srgb, var(--ink) 7%, transparent); border-radius: 999px; block-size: .55rem; overflow: hidden; }
  .bar-fill { display: block; block-size: 100%; border-radius: 999px; }
  .bar-fill.ai { background: var(--c-ai); }
  .bar-fill.commit { background: var(--c-commit); }
  .bar-fill.neutral { background: color-mix(in srgb, var(--accent) 65%, var(--muted)); }
  .bar-num { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; }

  /* activity chart */
  .chart { display: flex; align-items: flex-end; gap: .35rem; min-block-size: 130px; overflow-x: auto; padding-block-end: .25rem; }
  .col { display: flex; flex-direction: column; align-items: center; gap: .3rem; flex: 1 0 28px; }
  .stack { display: flex; flex-direction: column-reverse; justify-content: flex-start; inline-size: 60%; min-inline-size: 14px; }
  .seg { display: block; inline-size: 100%; }
  .seg.ai { background: var(--c-ai); }
  .seg.commit { background: var(--c-commit); border-radius: 0 0 3px 3px; }
  .stack .seg:last-child { border-radius: 3px 3px 0 0; }
  .col-label { font-size: .65rem; color: var(--muted); white-space: nowrap; }
  .legend { display: flex; gap: 1.2rem; margin-block-start: .8rem; font-size: .82rem; color: var(--muted); }
  .dot { display: inline-block; inline-size: .7rem; block-size: .7rem; border-radius: 3px; vertical-align: -1px; }
  .dot.ai { background: var(--c-ai); } .dot.commit { background: var(--c-commit); }

  /* findings */
  .findings { display: grid; gap: .7rem; }
  .finding { border: 1px solid var(--line); border-radius: 10px; border-inline-start: 3px solid var(--muted); overflow: hidden; }
  .finding.shortcut { border-inline-start-color: var(--c-ai); }
  .finding.lesson { border-inline-start-color: var(--c-commit); }
  .finding summary { display: flex; align-items: center; gap: .6rem; padding: .7rem .9rem; cursor: pointer; list-style: none; }
  .finding summary::-webkit-details-marker { display: none; }
  .finding summary::after { content: "▸"; color: var(--muted); margin-inline-start: auto; transition: transform .15s; }
  .finding[open] summary::after { transform: rotate(90deg); }
  .finding-title { font-weight: 600; flex: 1 1 auto; min-inline-size: 0; }
  .conf { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; }
  .finding-body { padding: 0 .9rem .9rem; }
  .finding-what { margin-block: .2rem .4rem; font-size: .9rem; }
  .finding-sug { font-size: .9rem; margin-block-end: .6rem; }
  .badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; padding: .15rem .45rem; border-radius: 999px; font-weight: 700; }
  .badge.shortcut { background: color-mix(in srgb, var(--c-ai) 18%, transparent); color: var(--c-ai); }
  .badge.lesson { background: color-mix(in srgb, var(--c-commit) 20%, transparent); color: var(--c-commit); }

  /* evidence */
  table.evidence { inline-size: 100%; border-collapse: collapse; font-size: .85rem; background: color-mix(in srgb, var(--ink) 3%, transparent); border-radius: 8px; }
  table.evidence td { padding: .3rem .5rem; border-block-end: 1px solid var(--line); vertical-align: top; }
  table.evidence tr:last-child td { border-block-end: none; }
  .ev-when { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ev-meta { color: var(--muted); margin-inline-end: .3rem; }
  .ev-more { font-size: .8rem; margin-block-start: .4rem; }

  .tag { display: inline-block; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); padding: .05rem .4rem; border-radius: 6px; font-size: .82rem; }
  .kind-chip { display: inline-block; font-size: .72rem; padding: .05rem .4rem; border-radius: 6px; color: var(--muted); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .kind-chip.ai_interaction { color: var(--c-ai); background: color-mix(in srgb, var(--c-ai) 14%, transparent); }
  .kind-chip.commit { color: var(--c-commit); background: color-mix(in srgb, var(--c-commit) 14%, transparent); }
  .add { color: var(--add); } .del { color: var(--del); }
  table { inline-size: 100%; border-collapse: collapse; font-size: .9rem; }
  th { text-align: start; color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
  th, td { padding: .4rem .5rem; border-block-end: 1px solid var(--line); }
  footer { color: var(--muted); font-size: .8rem; margin-block-start: 1rem; }
</style>
</head>
<body>
  <header class="top">
    <h1>postcaptain</h1>
    <span class="muted">local work-mentor dashboard</span>
  </header>
  ${renderSummary(m)}
  ${renderRecap(m.recap)}
  ${renderActivity(m)}
  ${renderFindings(m)}
  ${renderAiUsage(m)}
  ${renderRemoteUsage()}
  ${renderSessions(m)}
  <footer>Read-only view · only redacted insights go remote (tier-gated; secrets always masked) · reload to refresh after a capture.</footer>
</body>
</html>`;
}

export function startServer(dbPath: string, port: number): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    fetch() {
      // Open fresh per request so the view reflects the latest captures.
      const store = new EventStore(dbPath);
      try {
        return new Response(renderPage(buildModel(store)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } finally {
        store.close();
      }
    },
  });
  console.log(`dashboard: http://localhost:${server.port}  (db: ${dbPath})`);
  return server;
}
