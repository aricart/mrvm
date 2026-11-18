// the git information mrvm uses: release tags, commits since a tag and the
// files they changed, and whether files have uncommitted changes. git runs
// through node:child_process, which Deno, Node.js and Bun all provide.

import { execFileSync } from "node:child_process";
import { parse, type SemVer } from "./semver.ts";

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Whether the root is inside a git work tree.
 */
export function isRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The files among `paths` with uncommitted changes (staged, unstaged or
 * untracked).
 */
export function dirty(root: string, paths: string[]): string[] {
  if (!paths.length || !isRepo(root)) return [];
  const out = git(root, ["status", "--porcelain", "--", ...paths]);
  return out.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
}

/**
 * A release tag: its name and the version in it.
 */
export interface Tag {
  name: string;
  version: SemVer;
}

/**
 * All tags in the repository.
 */
export function tags(root: string): string[] {
  return git(root, ["tag", "--list"]).split("\n").filter((t) => t);
}

/**
 * The release tags of a module: its own (`<dir>/v1.2.3` or `<dir>/1.2.3`) and
 * the repository's (`v1.2.3` or `1.2.3`). A repository may have changed style
 * over time, so both count; the newest version is the last release.
 */
export function releaseTags(all: string[], dir: string): Tag[] {
  const pick = (prefix: string) =>
    all.filter((t) => t.startsWith(prefix))
      .map((t) => ({ name: t, version: parse(t.slice(prefix.length)) }))
      .filter((t): t is Tag => t.version !== null);
  return [...(dir ? pick(`${dir}/`) : []), ...pick("")];
}

/**
 * A commit, with the files it changed.
 */
export interface Commit {
  hash: string;
  subject: string;
  body: string;
  files: string[];
}

/**
 * Commits after `since` (a tag or commit), newest first, without merges. With
 * no `since`, the whole history.
 */
export function commitsSince(root: string, since?: string): Commit[] {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  const out = git(root, [
    "log",
    ...range,
    "--no-merges",
    "--format=%x1e%H%x1f%s%x1f%b%x1f",
    "--name-only",
  ]);
  return out.split("\x1e").filter((r) => r.trim()).map((r) => {
    const [hash, subject, body, files] = r.split("\x1f");
    return {
      hash,
      subject,
      body: body.trim(),
      files: files.split("\n").map((f) => f.trim()).filter((f) => f),
    };
  });
}

/**
 * Tags on the remote, without fetching them; null if there's no remote or it
 * can't be reached.
 */
export function remoteTags(root: string, remote = "origin"): string[] | null {
  try {
    return git(root, ["ls-remote", "--tags", "--refs", remote])
      .split("\n").filter((l) => l)
      .map((l) => l.split("\t")[1].replace("refs/tags/", ""));
  } catch {
    return null;
  }
}

/**
 * The paths among `paths` that git ignores; empty outside a repository.
 */
export function ignored(root: string, paths: string[]): Set<string> {
  if (!paths.length || !isRepo(root)) return new Set();
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      input: paths.join("\n"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Set(out.split("\n").filter((l) => l));
  } catch (err) {
    // exit status 1: none of the paths are ignored
    if ((err as { status?: number }).status === 1) return new Set();
    throw err;
  }
}
