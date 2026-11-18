// suggests version bumps from the conventional commits since each module's
// last release tag.

import { commitsSince, releaseTags, tags, type Commit } from "./git.ts";
import { max, type SemVer } from "./semver.ts";
import type { Module, Workspace } from "./workspace.ts";

export type Level = "major" | "minor" | "patch" | "none";

const ORDER: Level[] = ["none", "patch", "minor", "major"];

export function higher(a: Level, b: Level): Level {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

// types that never need a release
const NO_RELEASE = new Set([
  "chore",
  "docs",
  "test",
  "tests",
  "ci",
  "build",
  "style",
  "release",
]);

// files that don't change what's published
const IGNORED = [
  /(^|\/)(tests?|docs|examples|unsafe_tests|benchmarks?)\//,
  /(^|\/)\.github\//,
  /\.md$/,
  /(^|\/)(deno\.lock|package-lock\.json)$/,
];

/**
 * What a commit means for a release.
 */
export interface CommitLevel {
  commit: Commit;
  level: Level;
  /** false when the subject isn't a conventional commit */
  conventional: boolean;
}

/**
 * The bump a commit asks for: a breaking change (`feat!:` or a
 * `BREAKING CHANGE:` footer) is major, `feat` minor, `fix` and `perf` patch,
 * and chores, docs, tests and ci none. A commit that isn't conventional but
 * changes published files counts as a patch, so it isn't silently dropped.
 */
export function commitLevel(commit: Commit): CommitLevel {
  const m = /^(\w+)(?:\([^)]*\))?(!)?:\s/.exec(commit.subject);
  const breaking = /^BREAKING[ -]CHANGE:/m.test(commit.body);
  if (!m) {
    return { commit, level: breaking ? "major" : "patch", conventional: false };
  }
  const type = m[1].toLowerCase();
  if (m[2] || breaking) return { commit, level: "major", conventional: true };
  if (type === "feat") return { commit, level: "minor", conventional: true };
  if (NO_RELEASE.has(type)) return { commit, level: "none", conventional: true };
  return { commit, level: "patch", conventional: true };
}

/**
 * Below 1.0, a breaking change bumps the minor version and anything else the
 * patch.
 */
export function adjustForZero(level: Level, v: SemVer): Level {
  if (v.major !== 0) return level;
  if (level === "major") return "minor";
  if (level === "minor") return "patch";
  return level;
}

/**
 * The files of a commit that belong to a module and change what it
 * publishes: inside its directory (the root module gets files no other
 * module owns), and not tests, docs, examples or markdown.
 */
export function moduleFiles(
  ws: Workspace,
  m: Module,
  files: string[],
): string[] {
  const others = ws.modules.filter((o) => o !== m && o.dir);
  return files.filter((f) => {
    if (IGNORED.some((re) => re.test(f))) return false;
    if (m.dir) return f.startsWith(`${m.dir}/`);
    return !others.some((o) => f.startsWith(`${o.dir}/`));
  });
}

/**
 * A suggestion for one module.
 */
export interface Suggestion {
  module: Module;
  /** the last release tag, if there is one */
  tag?: string;
  /** the version in that tag */
  released?: SemVer;
  level: Level;
  commits: CommitLevel[];
}

/**
 * Suggests a bump for each module (or the named ones) from the commits since
 * its last release tag.
 */
export function suggest(ws: Workspace, only?: Module[]): Suggestion[] {
  const all = tags(ws.root);
  const out: Suggestion[] = [];
  const cache = new Map<string, Commit[]>();
  for (const m of only ?? ws.modules) {
    const rts = releaseTags(all, m.dir);
    const last = max(rts.map((t) => t.version));
    const tag = last ? rts.find((t) => t.version === last)!.name : undefined;
    const key = tag ?? "";
    if (!cache.has(key)) cache.set(key, commitsSince(ws.root, tag));
    const commits: CommitLevel[] = [];
    let level: Level = "none";
    for (const c of cache.get(key)!) {
      if (!moduleFiles(ws, m, c.files).length) continue;
      const cl = commitLevel(c);
      if (cl.level === "none") continue;
      commits.push(cl);
      level = higher(level, cl.level);
    }
    out.push({
      module: m,
      tag,
      released: last ?? undefined,
      level: adjustForZero(level, last ?? m.version),
      commits,
    });
  }
  return out;
}
