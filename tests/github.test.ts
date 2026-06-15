/**
 * Tests for the local-git collector against a real temp repository.
 *
 * Spinning up an actual git repo (rather than mocking) exercises the real
 * `git log --numstat` output the parser must handle.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { collect, collectRepo, discoverRepos, parseGitLog } from "../src/collectors/github.ts";

let repo: string;

async function commit(
  file: string,
  contents: string,
  message: string,
  email: string,
): Promise<void> {
  writeFileSync(join(repo, file), contents);
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} -c user.name=Tester -c user.email=${email} commit -m ${message}`.quiet();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "postcaptain-git-"));
  await $`git -C ${repo} init -q -b ABC-123-feature`.quiet();
  await $`git -C ${repo} config user.email me@example.com`.quiet();
  await $`git -C ${repo} config user.name Me`.quiet();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("emits one commit event per commit with diff stats", async () => {
  await commit("a.txt", "one\ntwo\nthree\n", "ABC-123 add a", "me@example.com");
  await commit("b.txt", "x\n", "tidy b", "me@example.com");

  const events = await collectRepo(repo);
  expect(events).toHaveLength(2);

  const first = events.find((e) => (e.payload.subject as string).startsWith("ABC-123"))!;
  expect(first.kind).toBe("commit");
  expect(first.source).toBe("github");
  expect(first.sensitivity).toBe("sensitive");
  expect(first.ticket).toBe("ABC-123"); // from the commit subject
  expect(first.payload.insertions).toBe(3);
  expect(first.payload.filesChanged).toBe(1);
  expect(first.payload.branch).toBe("ABC-123-feature");
});

test("ticket falls back to the branch name when the subject lacks one", async () => {
  await commit("c.txt", "hi\n", "no key in this message", "me@example.com");
  const events = await collectRepo(repo);
  expect(events[0]!.ticket).toBe("ABC-123"); // from branch ABC-123-feature
});

test("onlyMine filters to the repo's configured user.email", async () => {
  await commit("a.txt", "a\n", "mine", "me@example.com");
  await commit("b.txt", "b\n", "theirs", "someone@else.com");

  expect(await collectRepo(repo)).toHaveLength(1); // default onlyMine
  expect(await collectRepo(repo, { onlyMine: false })).toHaveLength(2);
});

test("event ids are stable and idempotent across runs", async () => {
  await commit("a.txt", "a\n", "ABC-1 first", "me@example.com");
  const ids1 = (await collectRepo(repo)).map((e) => e.eventId);
  const ids2 = (await collectRepo(repo)).map((e) => e.eventId);
  expect(ids1).toEqual(ids2);
  expect(ids1[0]!.startsWith("github:")).toBe(true);
});

test("discoverRepos finds a repo by its .git dir; collect reads it", async () => {
  expect(discoverRepos([repo])).toContain(repo);
  await commit("a.txt", "a\n", "ABC-9 x", "me@example.com");
  const events = await collect({ repos: [repo] });
  expect(events).toHaveLength(1);
});

test("a non-git directory is a no-op", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "postcaptain-notgit-"));
  try {
    expect(await collectRepo(notRepo)).toEqual([]);
  } finally {
    rmSync(notRepo, { recursive: true, force: true });
  }
});

test("parseGitLog handles binary-file dashes without NaN", () => {
  const sep1 = "\x1f";
  const sep0 = "\x1e";
  const rec = `${sep0}abc123${sep1}2024-01-01T00:00:00Z${sep1}Me${sep1}me@x.com${sep1}ABC-1 bin\n-\t-\timage.png\n5\t2\tcode.ts`;
  const [c] = parseGitLog(rec);
  expect(c!.insertions).toBe(5);
  expect(c!.deletions).toBe(2);
  expect(c!.filesChanged).toBe(2);
});
