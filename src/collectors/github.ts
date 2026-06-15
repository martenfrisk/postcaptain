/**
 * Git / GitHub collector — code-work + ticket linkage (design §4).
 *
 * Slice 1 (this file): **local git**, fully offline, no auth. Reads commit
 * history from local repositories and emits one `commit` event per commit. This
 * is where the Jira ticket key lives (branch names `ABC-123-...` and commit
 * subjects), so it feeds the backbone ticket join (§5/§12).
 *
 * PRs / review activity / diff stats from the GitHub side need the API (gh CLI
 * or the GitHub MCP) and an auth decision — that's a separate `pr_review` slice.
 *
 * Work repos are `sensitive` (§8). This is a personal tool, so by default we
 * keep only commits authored by the repo's configured `user.email`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";
import { type Event, extractTicket, makeEvent, stableEventId } from "../events.ts";

/** Work-repo commits contain proprietary context → sensitive (§8). */
const SENSITIVITY = "sensitive" as const;

/** ASCII unit/record separators — safe field delimiters inside `git log`. */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/** Default lookback — matches the 12-month normalized-events retention (§11). */
const DEFAULT_SINCE = "12 months ago";

/** Base directories scanned for repos when none are given explicitly. */
const DEFAULT_BASE_DIRS = ["Web", "Documents/Web", "code", "src", "projects", "dev"];

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Existing default base dirs under the user's home. */
export function defaultBaseDirs(): string[] {
  const home = homedir();
  return DEFAULT_BASE_DIRS.map((d) => join(home, d)).filter(isDir);
}

/**
 * Find git repositories: each base dir's immediate children that contain a
 * `.git`, plus the base dir itself if it is a repo.
 */
export function discoverRepos(baseDirs: string[]): string[] {
  const repos = new Set<string>();
  for (const base of baseDirs) {
    if (!isDir(base)) continue;
    if (existsSync(join(base, ".git"))) repos.add(base);
    for (const entry of readdirSync(base)) {
      const child = join(base, entry);
      if (isDir(child) && existsSync(join(child, ".git"))) repos.add(child);
    }
  }
  return [...repos].sort();
}

async function git(repo: string, args: string[]): Promise<string | null> {
  const res = await $`git -C ${repo} ${args}`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString() : null;
}

interface ParsedCommit {
  sha: string;
  authorDateMs: number;
  authorName: string;
  authorEmail: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Parse `git log --numstat` output produced with our separators. */
export function parseGitLog(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const header = lines[0] ?? "";
    const [sha, dateIso, authorName, authorEmail, subject] = header.split(FIELD_SEP);
    if (!sha) continue;

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [added, deleted] = line.split("\t");
      filesChanged += 1;
      // Binary files report "-" for added/deleted; treat as 0.
      insertions += added === "-" ? 0 : Number(added) || 0;
      deletions += deleted === "-" ? 0 : Number(deleted) || 0;
    }

    commits.push({
      sha,
      authorDateMs: dateIso ? Date.parse(dateIso) : 0,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      subject: subject ?? "",
      filesChanged,
      insertions,
      deletions,
    });
  }
  return commits;
}

export interface CollectOpts {
  /** Repos to read; defaults to `discoverRepos(defaultBaseDirs())`. */
  repos?: string[];
  /** Git `--since` window; defaults to 12 months ago. */
  since?: string;
  /**
   * If true (default), only keep commits authored by each repo's configured
   * `user.email`. Set false to capture every author.
   */
  onlyMine?: boolean;
}

/** Collect `commit` events from one local git repository. */
export async function collectRepo(repo: string, opts: CollectOpts = {}): Promise<Event[]> {
  const since = opts.since ?? DEFAULT_SINCE;
  const onlyMine = opts.onlyMine ?? true;
  const project = basename(repo);

  const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || null;
  const mine = onlyMine ? (await git(repo, ["config", "user.email"]))?.trim() : undefined;

  const format = `${RECORD_SEP}%H${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%s`;
  const args = ["log", `--since=${since}`, "--numstat", `--format=${format}`, "--no-merges"];
  if (mine) args.push(`--author=${mine}`);

  const stdout = await git(repo, args);
  if (stdout === null) return []; // not a repo / git failure

  return parseGitLog(stdout).map((c) =>
    makeEvent({
      eventId: stableEventId("github", c.sha),
      kind: "commit",
      source: "github",
      ts: c.authorDateMs,
      sensitivity: SENSITIVITY,
      project,
      ticket: extractTicket(branch, c.subject),
      payload: {
        tool: "git",
        repo: project,
        sha: c.sha,
        shortSha: c.sha.slice(0, 8),
        subject: c.subject,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        branch,
        filesChanged: c.filesChanged,
        insertions: c.insertions,
        deletions: c.deletions,
      },
    }),
  );
}

/**
 * Collect `commit` events from all discovered (or supplied) local git repos.
 */
export async function collect(opts: CollectOpts = {}): Promise<Event[]> {
  const repos = opts.repos ?? discoverRepos(defaultBaseDirs());
  const events: Event[] = [];
  for (const repo of repos) {
    events.push(...(await collectRepo(repo, opts)));
  }
  return events;
}
