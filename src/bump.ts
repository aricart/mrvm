// works out the new version of each module for a bump, given a release type
// or the suggestions from the commits.

import {
  compare,
  format,
  increment,
  max,
  type ReleaseType,
  type SemVer,
} from "./semver.ts";
import { type Level, suggest, type Suggestion } from "./suggest.ts";
import { allEqual, dependents, type Module, type Workspace } from "./workspace.ts";

export type Mode = "lockstep" | "independent";

/**
 * The mode a bump uses: the configured one, else lockstep when there are
 * several modules and they all have the same version.
 */
export function modeOf(ws: Workspace): Mode {
  if (ws.config.mode) return ws.config.mode;
  return ws.modules.length > 1 && allEqual(ws) ? "lockstep" : "independent";
}

export interface BumpOptions {
  /** an explicit release type; omit with `suggest` */
  type?: ReleaseType;
  /** derive the bump from the commits since the last release */
  suggest?: boolean;
  /** prerelease identifier, e.g. `rc` */
  preid?: string;
  /** module names or directories; all modules when empty */
  only?: string[];
}

export interface BumpPlan {
  mode: Mode;
  targets: Map<Module, SemVer>;
  /** why each module changes */
  reasons: Map<Module, string>;
  suggestions?: Suggestion[];
  /** reasons the bump can't be done */
  problems: string[];
}

/**
 * Finds modules by name or directory.
 */
export function select(ws: Workspace, only: string[] = []): {
  modules: Module[];
  problems: string[];
} {
  const problems: string[] = [];
  const modules: Module[] = [];
  for (const o of only) {
    const m = ws.modules.find((m) =>
      m.names.includes(o) || m.dir === o.replace(/\/$/, "") ||
      m.name.endsWith(`/${o}`)
    );
    if (m) modules.push(m);
    else problems.push(`no module named ${o}`);
  }
  return { modules, problems };
}

// the version a suggested level leads to, or null if there's nothing to do
function levelTarget(
  released: SemVer | undefined,
  current: SemVer,
  level: Level,
  preid?: string,
): SemVer | null {
  if (level === "none") return null;
  const base = released ?? current;
  let t: SemVer;
  if (preid) {
    t = increment(base, `pre${level}` as ReleaseType, preid);
    // already on a prerelease of that version: the next prerelease
    if (
      current.prerelease.length &&
      compare({ ...current, prerelease: [] }, { ...t, prerelease: [] }) === 0 &&
      compare(current, t) >= 0
    ) {
      t = increment(current, "prerelease", preid);
    }
  } else {
    t = increment(base, level);
  }
  return compare(current, t) >= 0 && !preid ? null : t;
}

/**
 * Plans a bump. In lockstep every module moves to one version; independently,
 * each selected module moves, and every module that depends on a moved module
 * gets at least a patch (or prerelease) bump so its pins can change.
 */
export function planBump(ws: Workspace, opts: BumpOptions): BumpPlan {
  const mode = modeOf(ws);
  const targets = new Map<Module, SemVer>();
  const reasons = new Map<Module, string>();
  const { modules: selected, problems } = select(ws, opts.only);
  if (!opts.type && !opts.suggest) {
    problems.push("give a release type, or --suggest");
  }
  if (mode === "lockstep" && selected.length) {
    problems.push(
      "the workspace is versioned in lockstep, so a bump applies to every module; leave out the module names",
    );
  }
  if (problems.length) return { mode, targets, reasons, problems };

  let suggestions: Suggestion[] | undefined;
  if (mode === "lockstep") {
    const current = max(ws.modules.map((m) => m.version))!;
    let target: SemVer | null;
    let why: string;
    if (opts.suggest) {
      suggestions = suggest(ws);
      const level = suggestions.reduce<Level>(
        (l, s) => (["none", "patch", "minor", "major"].indexOf(s.level) >
            ["none", "patch", "minor", "major"].indexOf(l)
          ? s.level
          : l),
        "none",
      );
      const released = max(
        suggestions.map((s) => s.released).filter((v): v is SemVer => !!v),
      ) ?? undefined;
      target = levelTarget(released, current, level, opts.preid);
      why = `${level} from the commits since ${released ? `v${format(released)}` : "the start"}`;
    } else {
      target = increment(current, opts.type!, opts.preid);
      why = opts.type!;
    }
    if (target) {
      for (const m of ws.modules) {
        targets.set(m, target);
        reasons.set(m, why);
      }
    }
    return { mode, targets, reasons, suggestions, problems };
  }

  const chosen = selected.length ? selected : ws.modules;
  if (opts.suggest) {
    suggestions = suggest(ws, chosen);
    for (const s of suggestions) {
      const t = levelTarget(s.released, s.module.version, s.level, opts.preid);
      if (t) {
        targets.set(s.module, t);
        reasons.set(
          s.module,
          `${s.level} from ${s.commits.length} commit(s) since ${s.tag ?? "the start"}`,
        );
      }
    }
  } else {
    for (const m of chosen) {
      targets.set(m, increment(m.version, opts.type!, opts.preid));
      reasons.set(m, opts.type!);
    }
  }

  // dependents carry new pins, so they need a release too
  const queue = [...targets.keys()];
  while (queue.length) {
    const m = queue.shift()!;
    for (const d of dependents(ws, m)) {
      if (targets.has(d)) continue;
      const pre = opts.preid || opts.type?.startsWith("pre");
      targets.set(d, increment(d.version, pre ? "prerelease" : "patch", opts.preid));
      reasons.set(d, `depends on ${m.name}`);
      queue.push(d);
    }
  }
  return { mode, targets, reasons, suggestions, problems };
}
