/**
 * Local dashboard over the event store (design §9 — pull-based, always
 * queryable). Server-rendered HTML, no client JS, no build step. It reads the
 * store fresh on each request and renders: a summary, today's recap, the
 * AI-usage read, detector findings, and recent work sessions.
 *
 * This is a *view* — read-only. It never writes events or calls a model.
 */

import type { Candidate } from "./detectors.ts";
import { detectAll } from "./detectors.ts";
import type { Event } from "./events.ts";
import { type DailyRecap, dailyRecap } from "./recap.ts";
import { type Session, sessionize } from "./sessionizer.ts";
import { EventStore } from "./store.ts";

interface Model {
  events: Event[];
  sessions: Session[];
  candidates: Candidate[];
  recap: DailyRecap | null;
}

export function buildModel(store: EventStore): Model {
  const events = store.query();
  const sessions = sessionize(events);
  const candidates = detectAll({ events, sessions });
  return { events, sessions, candidates, recap: dailyRecap(events) };
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

function dateRange(events: Event[]): string {
  const first = events.at(0);
  const last = events.at(-1);
  if (!first || !last) return "—";
  const a = new Date(first.ts).toISOString().slice(0, 10);
  const b = new Date(last.ts).toISOString().slice(0, 10);
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

// ---- rendering ------------------------------------------------------------

function card(label: string, value: string, sub = ""): string {
  return `<div class="card"><div class="card-value">${value}</div><div class="card-label">${esc(label)}</div>${
    sub ? `<div class="card-sub">${esc(sub)}</div>` : ""
  }</div>`;
}

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

function renderAiUsage(m: Model): string {
  const ai = m.events.filter((e) => e.kind === "ai_interaction");
  if (ai.length === 0) return "";
  const byModel = tally(ai, (e) => (e.payload.model as string) ?? null);
  const byProject = tally(ai, (e) => e.project);
  const agent = ai.filter((e) => e.payload.agentMode === "agent").length;
  const ask = ai.length - agent;
  const list = (rows: [string, number][]) =>
    rows
      .slice(0, 6)
      .map(([k, n]) => `<li><span>${esc(k)}</span><span class="muted">${num(n)}</span></li>`)
      .join("");
  return `<section class="panel">
    <h2>AI usage</h2>
    <div class="two-col">
      <div><h3>By model</h3><ul class="kv">${list(byModel)}</ul></div>
      <div><h3>By project</h3><ul class="kv">${list(byProject)}</ul></div>
      <div><h3>Mode</h3><ul class="kv">
        <li><span>ask</span><span class="muted">${num(ask)}</span></li>
        <li><span>agent</span><span class="muted">${num(agent)}</span></li>
      </ul></div>
    </div>
  </section>`;
}

function renderFindings(m: Model): string {
  if (m.candidates.length === 0) {
    return `<section class="panel"><h2>Findings</h2><p class="muted">No patterns surfaced yet — capture more activity.</p></section>`;
  }
  const items = m.candidates
    .slice(0, 12)
    .map(
      (c) => `<li class="finding">
        <div class="finding-head">
          <span class="badge ${c.category}">${esc(c.category)}</span>
          <span class="finding-title">${esc(c.headline)}</span>
          <span class="conf" title="confidence">${(c.confidence * 100).toFixed(0)}%</span>
        </div>
        <div class="finding-what muted">${esc(c.whatHappened)}</div>
        <div class="finding-sug">→ ${esc(c.suggestion)}</div>
      </li>`,
    )
    .join("");
  return `<section class="panel"><h2>Findings</h2><ul class="findings">${items}</ul></section>`;
}

function renderSessions(m: Model): string {
  if (m.sessions.length === 0) return "";
  const rows = [...m.sessions]
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, 15)
    .map((s) => {
      const kinds = Object.entries(s.kinds)
        .map(([k, n]) => `${k.replace("_", " ")}: ${n}`)
        .join(", ");
      return `<tr>
        <td>${esc(s.key)}</td>
        <td class="muted">${esc(new Date(s.startTs).toISOString().slice(0, 16).replace("T", " "))}</td>
        <td>${duration(s.durationMs)}</td>
        <td>${num(s.eventCount)}</td>
        <td class="muted">${esc(kinds)}</td>
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
    --line: #e5e7eb; --accent: #2563eb; --add: #16a34a; --del: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --ink: #e6e8eb; --muted: #9aa3af;
      --line: #272b33; --accent: #6ea8fe; --add: #4ade80; --del: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 2rem clamp(1rem, 4vw, 3rem);
  }
  header.top { display: flex; align-items: baseline; gap: .75rem; margin-block-end: 1.5rem; }
  header.top h1 { margin: 0; font-size: 1.4rem; letter-spacing: -0.01em; }
  .muted { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-block-end: 1.5rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
  .card-value { font-size: 1.7rem; font-weight: 650; letter-spacing: -0.02em; }
  .card-label { color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  .card-sub { color: var(--muted); font-size: .82rem; margin-block-start: .25rem; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem 1.4rem; margin-block-end: 1.25rem; }
  .panel h2 { margin: 0 0 .9rem; font-size: 1.05rem; }
  .panel h3 { margin: 0 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .recap { margin: 0; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.25rem; }
  ul.kv { list-style: none; margin: 0; padding: 0; }
  ul.kv li { display: flex; justify-content: space-between; gap: 1rem; padding: .2rem 0; border-block-end: 1px solid var(--line); }
  ul.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: .9rem; }
  .finding { border: 1px solid var(--line); border-radius: 10px; padding: .8rem .9rem; }
  .finding-head { display: flex; align-items: center; gap: .6rem; }
  .finding-title { font-weight: 600; flex: 1 1 auto; min-inline-size: 0; }
  .finding-what { margin-block: .35rem; font-size: .9rem; }
  .finding-sug { font-size: .9rem; }
  .conf { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; }
  .badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; padding: .15rem .45rem; border-radius: 999px; font-weight: 700; }
  .badge.shortcut { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .badge.lesson { background: color-mix(in srgb, var(--add) 20%, transparent); color: var(--add); }
  .tag { display: inline-block; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); padding: .05rem .4rem; border-radius: 6px; font-size: .85rem; }
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
  ${renderFindings(m)}
  ${renderAiUsage(m)}
  ${renderSessions(m)}
  <footer>Read-only view · raw activity never leaves this machine · reload to refresh after a capture.</footer>
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
