# postcaptain

> A **local-first, privacy-gated AI work mentor**.

postcaptain passively captures how a workday is actually spent — code written, AI
tools used, tickets, PRs, docs read, meetings, context-switching — into one local
event store, then runs a disciplined insight layer over it: a daily recap, a
weekly digest, and an ad-hoc query interface, delivered like a senior developer
who sits nearby. The strategic focus is **how AI is used, and how to use it
better**, as development goes AI-first.

It is explicitly **not** a dashboard or a data lake. What leaves the machine is
governed by a configurable **redaction tier** (default: identifiers readable,
code stripped) — and **secrets are masked at every tier**, fail-closed, so a
credential never goes remote no matter the setting.

See [`work-mentor-design.md`](work-mentor-design.md) for the full design.

## Status

The pipeline is working end-to-end:
**capture → sessionize → detect → characterize → recap → dashboard**, plus
**interactive `ask`** and the **weekly `digest`**. Remote calls go through GitHub
Copilot CLI behind a tiered redaction gate (§8): the **weekly synthesis** and an
**open-ended detector** (`--explore`) that hands a redacted week to a strong
model to surface patterns the fixed detector catalog misses. The local layers
run on Ollama; the remote stages run on whatever model your Copilot plan exposes
(`auto` by default). Every remote call is **metered** (`stats` + dashboard).
Still pending: themes/lessons (phase 4) and deeper longitudinal synthesis
(phase 5).

### Done so far

- **Event model** (`src/events.ts`) — the `Event` shape, `kind` / `source` /
  `sensitivity` types, Jira-ticket extraction, deterministic event ids.
- **Store** (`src/store.ts`, `bun:sqlite`) — one `events` table, idempotent
  inserts, filtered queries.
- **Collectors** — Copilot chat (`collectors/copilot.ts`, from VS Code's
  `state.vscdb` + `chatSessions/*.json`) and local git commits
  (`collectors/github.ts`).
- **Sessionizer** (`src/sessionizer.ts`) — events → ticket-keyed work sessions.
- **Detectors** (`src/detectors.ts`) — no-LLM seed catalog (repetition, struggle,
  follow-up habit, AI-cancel) → candidates with evidence + confidence.
- **Daily recap** (`src/recap.ts`) — no-LLM day summary.
- **Characterizer** (`src/characterizer.ts` + `src/llm.ts`) — local Ollama model
  enriches a candidate into a structured insight and drafts a concrete artifact;
  degrades to the deterministic candidate if Ollama is down.
- **Dashboard** (`src/dashboard.ts`) — local web view: summary, recap, activity
  chart, expandable findings (with evidence), AI-usage read, recent sessions.
- **Redaction gate** (`src/redact.ts`) — the deterministic, local, ordered §8
  pipeline (strip code → mask secrets → HMAC-pseudonymize identifiers → drop
  residual paths), now **tiered** (`strict` / `identifiers` / `raw`, set in
  `redaction.toml` or `--redact`). Secret masking + a fail-closed secret-shape
  self-check run at every tier.
- **Weekly digest** (`src/synthesis.ts`) — a fully-local rendered digest plus
  per-week aggregates; on `--send`, synthesized by GitHub Copilot CLI from the
  redacted insights + stats.
- **Open-ended detector** (`src/explore.ts`, `digest --explore`) — hands a
  redacted, numbered week to a strong remote model to surface patterns beyond
  the hardcoded detectors; results merge into the same characterize → rank →
  digest pipeline. The deterministic detectors stay the reliable backbone.
- **Remote-call metering** (`src/usage.ts`) — every Copilot call is logged
  locally (sizes, purpose, reported credits) and shown in `stats` + the
  dashboard. No payload content is stored.

## Quickstart

Built on [Bun](https://bun.sh) — TypeScript runs directly, no build step.

```bash
bun install                  # dev deps (types + tooling; runtime has zero deps)

# capture local Copilot chat history + git commits into a SQLite store (idempotent)
bun run src/cli.ts capture --db ./postcaptain.db
bun run src/cli.ts stats   --db ./postcaptain.db

# characterize findings into insights + drafted artifacts (needs a local Ollama)
bun run src/cli.ts insights --db ./postcaptain.db --model llama3.2:latest

# ask a question about your own activity (retrieval-augmented, local model)
bun run src/cli.ts ask "when did I work on the proxy config?" --db ./postcaptain.db

# weekly digest — fully-local render + a preview of exactly what would go remote
cp redaction.toml.example redaction.toml   # set `level` + denylist for your env
bun run src/cli.ts digest --db ./postcaptain.db
# widen findings with the remote open-ended detector, then synthesize remotely
bun run src/cli.ts digest --db ./postcaptain.db --explore --send
# override the tier for one run (strict | identifiers | raw)
bun run src/cli.ts digest --db ./postcaptain.db --redact strict

# open the dashboard
bun run src/cli.ts serve   --db ./postcaptain.db    # → http://localhost:4317
```

Convenient script shortcuts (see `package.json`):

```bash
bun run capture            # bun run src/cli.ts capture
bun run insights           # local-LLM findings + drafted artifacts
bun run digest             # local digest + preview (no remote call)
bun run digest:explore     # + remote open-ended detector (1 remote call)
bun run digest:send        # explore + remote synthesis (the full path)
bun run serve              # open the dashboard
bun run seed --db ./postcaptain-synthetic.db   # realistic synthetic week
bun run check              # format + typecheck + test in one shot

bun test                   # run the suite
bun run typecheck          # tsc --noEmit
bun run lint               # biome check (lint + format + import order)
bun run format             # biome check --write (apply fixes)
```

Captured data is local and git-ignored (`*.db`). The redaction denylist
(`redaction.toml`) and the pseudonym salt (`.postcaptain.salt`) are local-only
and never committed.

### Trying it without your own data

The captured store is sparse week-to-week, so detectors may not fire on a single
real week yet. To exercise the whole flow (detect → characterize → redact →
remote digest) on a realistic week:

```bash
bun run seed --db ./postcaptain-synthetic.db    # fires all four detectors
bun run src/cli.ts digest --db ./postcaptain-synthetic.db                    # local + preview
bun run src/cli.ts digest --db ./postcaptain-synthetic.db --explore --send   # full remote path
```

## Tooling

- **[Biome](https://biomejs.dev)** — lint + format + import organization in one
  fast pass. Config in `biome.json` (double quotes, 2-space, 100-col). Run
  `bun run lint` to check, `bun run format` to apply fixes.
- **TypeScript** — `bun run typecheck` (strict, including `noUncheckedIndexedAccess`).

## Layout

```
src/
  events.ts            # the normalized Event model + domain keys
  store.ts             # SQLite event store (bun:sqlite)
  collectors/
    copilot.ts         # VS Code / GitHub Copilot chat collector
    github.ts          # local git commit collector
  sessionizer.ts       # events → ticket-keyed work sessions
  detectors.ts         # no-LLM pattern detectors → candidates (the backbone)
  explore.ts           # remote open-ended detector → extra candidates
  characterizer.ts     # local-LLM candidate → insight (+ drafted artifact)
  query.ts             # interactive retrieval-augmented Q&A over the store
  llm.ts               # Ollama client (generate + embeddings) + cosine distance
  recap.ts             # daily recap aggregation
  redact.ts            # tiered §8 redaction gate (secrets always masked)
  synthesis.ts         # weekly digest: local render + remote Copilot synthesis
  usage.ts             # remote-call metering (sizes, purpose, credits)
  dashboard.ts         # local web dashboard (Bun.serve, server-rendered)
  cli.ts               # capture / stats / insights / ask / digest / serve
tests/                 # *.test.ts tests (synthetic fixtures + a temp git repo)
```
