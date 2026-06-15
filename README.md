# postcaptain

> Codename TBD. A **local-first, privacy-gated AI work mentor**.

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

**Phase 1 — capture spike** (design §11). Building the foundation: a normalized
event store and the first collector (GitHub Copilot chat history). GitHub,
ActivityWatch and calendar collectors follow, then detectors and the digest.

### Done so far

- Normalized event model (`src/events.ts`) — the `Event` shape, the `kind` /
  `source` / `sensitivity` types, Jira-ticket extraction, deterministic event ids.
- SQLite event store (`src/store.ts`, `bun:sqlite`) — one `events` table,
  idempotent inserts, filtered queries.
- Copilot collector (`src/collectors/copilot.ts`) — parses VS Code's
  `state.vscdb` session manifest + `chatSessions/*.json` into `ai_interaction`
  events.

## Quickstart

Built on [Bun](https://bun.sh) — TypeScript runs directly, no build step.

```bash
bun install                  # dev deps (types + tooling; runtime has zero deps)

# parse local VS Code Copilot history into a SQLite store (idempotent)
bun run src/cli.ts capture --db ./postcaptain.db
bun run src/cli.ts stats   --db ./postcaptain.db

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
  cli.ts               # capture / stats spike runner
tests/                 # *.test.ts synthetic-fixture tests (no machine data needed)
```
