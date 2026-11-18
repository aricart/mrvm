// a small semver: parse, compare and increment, matching npm's `semver.inc`.
// mrvm has no dependencies besides cobra, so it doesn't pull in @std/semver.

/**
 * A parsed version: `major.minor.patch[-prerelease][+build]`.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** the dot separated prerelease identifiers, numbers as numbers */
  prerelease: (string | number)[];
  /** build metadata, ignored when comparing */
  build: string[];
}

/**
 * The kinds of version bump, as npm names them.
 */
export type ReleaseType =
  | "major"
  | "minor"
  | "patch"
  | "premajor"
  | "preminor"
  | "prepatch"
  | "prerelease"
  | "release";

export const releaseTypes: ReleaseType[] = [
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
  "release",
];

const NUM = "0|[1-9]\\d*";
const ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_RE = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})` +
    `(?:-(${ID}(?:\\.${ID})*))?` +
    `(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

/**
 * Parses a version, or returns null if it isn't valid semver. A leading `v` is
 * accepted (`v1.2.3`), so tag names parse too.
 */
export function parse(s: string): SemVer | null {
  const m = SEMVER_RE.exec(s.startsWith("v") ? s.slice(1) : s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]
      ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [],
    build: m[5] ? m[5].split(".") : [],
  };
}

/**
 * Like `parse`, but throws on an invalid version.
 */
export function mustParse(s: string): SemVer {
  const v = parse(s);
  if (!v) throw new Error(`"${s}" is not a valid semver version`);
  return v;
}

/**
 * Formats a version, without build metadata.
 */
export function format(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join(".")}` : core;
}

function compareIds(a: string | number, b: string | number): number {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return (a as number) - (b as number);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares by semver precedence: negative if a < b, 0 if equal, positive if
 * a > b. A prerelease is lower than its release (`1.0.0-0 < 1.0.0`).
 */
export function compare(a: SemVer, b: SemVer): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (!ap.length && !bp.length) return 0;
  if (!ap.length) return 1;
  if (!bp.length) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const c = compareIds(ap[i], bp[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * The highest of the versions, or null for none.
 */
export function max(versions: SemVer[]): SemVer | null {
  let m: SemVer | null = null;
  for (const v of versions) {
    if (!m || compare(v, m) > 0) m = v;
  }
  return m;
}

function pre(preid?: string): (string | number)[] {
  return preid ? [preid, 0] : [0];
}

/**
 * Increments a version the way npm's `semver.inc` does:
 *
 * - `major`, `minor`, `patch` release the next version; from a prerelease of
 *   that version they just drop the prerelease (`2.0.0-1` major → `2.0.0`).
 * - `premajor`, `preminor`, `prepatch` start a prerelease of the next version
 *   (`1.2.3` preminor → `1.3.0-0`, or `1.3.0-rc.0` with preid `rc`).
 * - `prerelease` increments the prerelease (`1.3.0-rc.0` → `1.3.0-rc.1`), or
 *   starts one on the next patch.
 * - `release` drops the prerelease.
 */
export function increment(
  v: SemVer,
  type: ReleaseType,
  preid?: string,
): SemVer {
  const n: SemVer = { ...v, prerelease: [...v.prerelease], build: [] };
  const isPre = v.prerelease.length > 0;
  switch (type) {
    case "major":
      if (!(isPre && v.minor === 0 && v.patch === 0)) n.major++;
      n.minor = 0;
      n.patch = 0;
      n.prerelease = [];
      return n;
    case "minor":
      if (!(isPre && v.patch === 0)) n.minor++;
      n.patch = 0;
      n.prerelease = [];
      return n;
    case "patch":
      if (!isPre) n.patch++;
      n.prerelease = [];
      return n;
    case "premajor":
      return { ...increment({ ...v, prerelease: [] }, "major"), prerelease: pre(preid) };
    case "preminor":
      return { ...increment({ ...v, prerelease: [] }, "minor"), prerelease: pre(preid) };
    case "prepatch":
      return { ...increment({ ...v, prerelease: [] }, "patch"), prerelease: pre(preid) };
    case "prerelease": {
      if (!isPre) return increment(v, "prepatch", preid);
      if (preid && n.prerelease[0] !== preid) {
        n.prerelease = [preid, 0];
        return n;
      }
      const last = n.prerelease.length - 1;
      if (typeof n.prerelease[last] === "number") {
        (n.prerelease[last] as number)++;
      } else {
        n.prerelease.push(0);
      }
      return n;
    }
    case "release":
      n.prerelease = [];
      return n;
  }
}
