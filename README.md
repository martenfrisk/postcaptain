# postcaptain

> A **local-first, privacy-gated AI work mentor**.

postcaptain passively captures how a workday is actually spent — code written, AI
tools used, tickets, PRs, docs read, meetings, context-switching — into one local
event store, then runs a disciplined insight layer over it: a daily recap, a
weekly digest, and an ad-hoc query interface, delivered like a senior developer
who sits nearby. The strategic focus is **how AI is used, and how to use it
better**, as development goes AI-first.

It is explicitly **not** a dashboard or a data lake. Raw code, prompts, responses
and meeting content never leave the machine; only redacted, abstracted insights
are ever eligible for a remote model call.

See [`work-mentor-design.md`](work-mentor-design.md) for the full design.

## Status

The local pipeline is working end-to-end:
**capture → sessionize → detect → characterize → recap → dashboard**, plus
**interactive `ask`** — design phases 1–2 and all of phase 3 (characterizer +
interactive query). The model layers run on a local Ollama model. Still pending:
the weekly *remote* synthesis (needs Copilot CLI), themes/lessons (phase 4), and
the exploration tier (phase 5).

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

# open the dashboard
bun run src/cli.ts serve   --db ./postcaptain.db    # → http://localhost:4317

bun test                     # run the suite
bun run typecheck            # tsc --noEmit
bun run lint                 # biome check (lint + format + import order)
bun run format               # biome check --write (apply fixes)
```

Captured data is local and git-ignored (`*.db`).

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
  detectors.ts         # no-LLM pattern detectors → candidates
  characterizer.ts     # local-LLM candidate → insight (+ drafted artifact)
  query.ts             # interactive retrieval-augmented Q&A over the store
  llm.ts               # Ollama client (generate + embeddings) + cosine distance
  recap.ts             # daily recap aggregation
  dashboard.ts         # local web dashboard (Bun.serve, server-rendered)
  cli.ts               # capture / stats / insights / ask / serve
tests/                 # *.test.ts tests (synthetic fixtures + a temp git repo)
```
