// the commands, as functions the cli and the tests call. each returns an exit
// code: 0 for success, 1 for a failed check or a refused change.

import { type BumpOptions, modeOf, planBump, select } from "./bump.ts";
import { dirty, isRepo, releaseTags, remoteTags, tags } from "./git.ts";
import {
  type Change,
  currentTargets,
  formatChanges,
  planChanges,
  validate,
  verify,
  write,
} from "./plan.ts";
import { progress } from "./progress.ts";
import { pool, published, type Published } from "./registry.ts";
import { compare, format, parse } from "./semver.ts";
import { loadWorkspace, type Module, type Workspace } from "./workspace.ts";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export interface CommonOptions {
  /** machine readable output on stdout */
  json?: boolean;
  /** no progress display */
  quiet?: boolean;
}

export interface WriteOptions extends CommonOptions {
  /** show the plan, write nothing */
  dryRun?: boolean;
  /** write even if the files have uncommitted changes */
  allowDirty?: boolean;
}

function changesJson(changes: Change[]) {
  return changes.map((c) => ({
    file: c.file,
    field: c.path.join("."),
    from: c.from,
    to: c.to,
  }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function load(root: string, io: Io): Workspace | null {
  const ws = loadWorkspace(root);
  if (!ws.modules.length && ws.problems.length) {
    for (const p of ws.problems) io.err(`error: ${p}\n`);
    return null;
  }
  if (!ws.modules.length) {
    io.err(
      `no modules found in ${root}: a module is a directory with a deno.json or package.json that has a name and a version\n`,
    );
    return null;
  }
  return ws;
}

function fail(io: Io, opts: CommonOptions, problems: string[]): number {
  if (opts.json) {
    io.out(JSON.stringify({ ok: false, problems }, null, 2) + "\n");
  } else {
    for (const p of problems) io.err(`error: ${p}\n`);
  }
  return 1;
}

/**
 * Checks that every module's version agrees across its files, and that every
 * pin on a module (and every aligned dependency) is at the current version.
 */
export function check(root: string, opts: CommonOptions, io: Io): number {
  const ws = load(root, io);
  if (!ws) return 1;
  const problems = validate(ws);
  if (problems.length) return fail(io, opts, problems);
  const changes = planChanges(ws, currentTargets(ws));
  if (opts.json) {
    io.out(
      JSON.stringify(
        {
          ok: changes.length === 0,
          modules: ws.modules.map((m) => ({
            name: m.name,
            dir: m.dir || ".",
            version: format(m.version),
          })),
          inconsistencies: changesJson(changes),
        },
        null,
        2,
      ) + "\n",
    );
    return changes.length ? 1 : 0;
  }
  if (changes.length) {
    io.out(
      `${plural(changes.length, "inconsistency")} (fix would make these edits):\n${
        formatChanges(changes)
      }\n`,
    );
    return 1;
  }
  io.out(
    `ok: ${plural(ws.modules.length, "module")}, ${
      plural(ws.pins.length, "pin")
    }, all consistent\n`,
  );
  return 0;
}

// refuses to overwrite uncommitted changes
function dirtyProblems(ws: Workspace, changes: Change[], opts: WriteOptions) {
  if (opts.allowDirty) return [];
  const files = [...new Set(changes.map((c) => c.file))];
  const d = dirty(ws.root, files);
  return d.length
    ? [`uncommitted changes in ${d.join(", ")} (commit them, or pass --allow-dirty)`]
    : [];
}

/**
 * Makes versions and pins consistent: each module goes to the highest version
 * found in its files (all modules to the highest, in lockstep), and pins
 * follow.
 */
export function fix(root: string, opts: WriteOptions, io: Io): number {
  const ws = load(root, io);
  if (!ws) return 1;
  const problems = validate(ws);
  if (problems.length) return fail(io, opts, problems);
  const targets = currentTargets(ws);
  const changes = planChanges(ws, targets);
  if (!changes.length) {
    if (opts.json) io.out(JSON.stringify({ ok: true, changes: [] }) + "\n");
    else io.out("nothing to fix\n");
    return 0;
  }
  const v = verify(ws, changes, targets);
  if (v.remaining.length) {
    return fail(io, opts, [
      `the edits would still leave inconsistencies:\n${formatChanges(v.remaining)}`,
    ]);
  }
  const dp = opts.dryRun ? [] : dirtyProblems(ws, changes, opts);
  if (dp.length) return fail(io, opts, dp);
  if (!opts.dryRun) write(ws, v.files);
  report(io, opts, changes, opts.dryRun);
  return 0;
}

function report(io: Io, opts: WriteOptions, changes: Change[], dry?: boolean) {
  const files = new Set(changes.map((c) => c.file)).size;
  if (opts.json) {
    io.out(
      JSON.stringify(
        { ok: true, dryRun: !!dry, changes: changesJson(changes) },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  io.out(`${formatChanges(changes)}\n`);
  io.out(
    dry
      ? `dry run: ${plural(changes.length, "edit")} in ${plural(files, "file")}, nothing written\n`
      : `wrote ${plural(changes.length, "edit")} in ${plural(files, "file")}\n`,
  );
}

export interface BumpCliOptions extends WriteOptions, BumpOptions {
  /** don't check the registries for an already published version */
  offline?: boolean;
}

/**
 * Bumps versions, by release type or from the commits (`suggest`), and
 * updates every pin on the bumped modules. Refuses when the workspace isn't
 * consistent first, when a new version is already published, or when the
 * files to edit have uncommitted changes.
 */
export async function bump(
  root: string,
  opts: BumpCliOptions,
  io: Io,
): Promise<number> {
  const ws = load(root, io);
  if (!ws) return 1;
  const problems = validate(ws);
  if (problems.length) return fail(io, opts, problems);
  const before = planChanges(ws, currentTargets(ws));
  if (before.length) {
    return fail(io, opts, [
      `the workspace isn't consistent; run fix first:\n${formatChanges(before)}`,
    ]);
  }
  if (opts.suggest && !isRepo(ws.root)) {
    return fail(io, opts, ["--suggest needs a git repository"]);
  }

  const plan = planBump(ws, opts);
  if (plan.problems.length) return fail(io, opts, plan.problems);

  const lines: string[] = [];
  for (const s of plan.suggestions ?? []) {
    lines.push(
      `${s.module.name}: ${s.level}, ${plural(s.commits.length, "commit")} since ${
        s.tag ?? "the first commit"
      }`,
    );
    for (const c of s.commits) {
      lines.push(
        `    ${c.level.padEnd(5)} ${c.commit.hash.slice(0, 8)} ${c.commit.subject}${
          c.conventional ? "" : "  (not a conventional commit)"
        }`,
      );
    }
  }
  if (!plan.targets.size) {
    if (opts.json) {
      io.out(JSON.stringify({ ok: true, mode: plan.mode, bumps: [] }) + "\n");
    } else {
      if (lines.length) io.out(lines.join("\n") + "\n");
      io.out("nothing to bump\n");
    }
    return 0;
  }

  const targets = currentTargets(ws);
  for (const [m, v] of plan.targets) targets.set(m, v);
  const changes = planChanges(ws, targets);
  const v = verify(ws, changes, targets);
  if (v.remaining.length) {
    return fail(io, opts, [
      `the edits would still leave inconsistencies:\n${formatChanges(v.remaining)}`,
    ]);
  }

  // a version that's already out can't be released again
  if (!opts.offline) {
    const p = progress(!opts.quiet && !opts.json);
    const mods = [...plan.targets.keys()];
    const results = await pool(
      mods,
      6,
      (m) => published(m),
      (m, n) => p.update("registry", n, mods.length, m.name),
    );
    p.done();
    const errs: string[] = [];
    mods.forEach((m, i) => {
      const r = results[i];
      const want = format(plan.targets.get(m)!);
      errs.push(...r.errors.map((e) => `can't check ${e} (use --offline to skip)`));
      if (r.jsr?.has(want)) errs.push(`${m.jsr}@${want} is already on jsr`);
      if (r.npm?.has(want)) errs.push(`${m.npm}@${want} is already on npm`);
    });
    if (errs.length) return fail(io, opts, errs);
  }

  const dp = opts.dryRun ? [] : dirtyProblems(ws, changes, opts);
  if (dp.length) return fail(io, opts, dp);
  if (!opts.dryRun) write(ws, v.files);

  if (opts.json) {
    io.out(
      JSON.stringify(
        {
          ok: true,
          mode: plan.mode,
          dryRun: !!opts.dryRun,
          bumps: [...plan.targets].map(([m, t]) => ({
            module: m.name,
            from: format(m.version),
            to: format(t),
            reason: plan.reasons.get(m),
          })),
          changes: changesJson(changes),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (lines.length) io.out(lines.join("\n") + "\n\n");
  const rows = [...plan.targets].map(([m, t]) => [
    m.name,
    `${format(m.version)} → ${format(t)}`,
    plan.reasons.get(m) ?? "",
  ]);
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  io.out(`${plan.mode}:\n`);
  for (const r of rows) {
    io.out(`  ${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}\n`);
  }
  io.out("\n");
  report(io, opts, changes, opts.dryRun);
  return 0;
}

export interface LsOptions extends CommonOptions {
  /** also look up jsr and npm */
  registry?: boolean;
  /** every version, not just the latest 10 */
  all?: boolean;
  only?: string[];
}

/**
 * Lists released versions from the git tags, and with `registry`, what's on
 * jsr and npm, so a tag that never got published (or a publish without a tag)
 * stands out.
 */
export async function ls(root: string, opts: LsOptions, io: Io): Promise<number> {
  const ws = load(root, io);
  if (!ws) return 1;
  const { modules: selected, problems } = select(ws, opts.only);
  if (problems.length) return fail(io, opts, problems);
  const mods = selected.length ? selected : ws.modules;
  const repo = isRepo(ws.root);
  const all = repo ? tags(ws.root) : [];
  const p = progress(!opts.quiet && !opts.json);

  const warnings: string[] = [];
  if (repo && opts.registry) {
    p.status("checking tags on origin");
    const remote = remoteTags(ws.root);
    if (remote) {
      const missing = remote.filter((t) => !all.includes(t));
      if (missing.length) {
        warnings.push(
          `${plural(missing.length, "tag")} on origin not fetched (git fetch --tags): ${
            missing.slice(0, 5).join(", ")
          }${missing.length > 5 ? ", …" : ""}`,
        );
      }
    }
  }

  let pub: Published[] = [];
  if (opts.registry) {
    pub = await pool(
      mods,
      6,
      (m) => published(m),
      (m, n) => p.update("registry", n, mods.length, m.name),
    );
  }
  p.done();

  const result = mods.map((m, i) => {
    const rts = releaseTags(all, m.dir);
    const versions = new Map<string, { tag?: string; jsr?: boolean; npm?: boolean }>();
    for (const t of rts) versions.set(format(t.version), { tag: t.name });
    const r = pub[i];
    for (const [k, set] of [["jsr", r?.jsr], ["npm", r?.npm]] as const) {
      for (const v of set ?? []) {
        versions.set(v, { ...versions.get(v), [k]: true });
      }
    }
    const sorted = [...versions.entries()].sort((a, b) =>
      compareStrings(b[0], a[0])
    );
    return {
      module: m,
      versions: opts.all ? sorted : sorted.slice(0, 10),
      registry: r,
    };
  });

  if (opts.json) {
    io.out(
      JSON.stringify(
        result.map((r) => ({
          module: r.module.name,
          version: format(r.module.version),
          releases: r.versions.map(([v, s]) => ({ version: v, ...s })),
          errors: r.registry?.errors ?? [],
        })),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  for (const w of warnings) io.err(`warning: ${w}\n`);
  for (const r of result) {
    io.out(`${r.module.name} ${format(r.module.version)} (${r.module.dir || "."})\n`);
    for (const e of r.registry?.errors ?? []) io.err(`  error: ${e}\n`);
    if (!r.versions.length) {
      io.out("  no releases\n");
      continue;
    }
    for (const [v, s] of r.versions) {
      const cols = [`  ${v.padEnd(16)}`, s.tag ? `tag ${s.tag}` : "no tag"];
      if (opts.registry) {
        if (r.registry?.jsr) cols.push(s.jsr ? "jsr" : "jsr: missing");
        if (r.registry?.npm) cols.push(s.npm ? "npm" : "npm: missing");
      }
      io.out(cols.join("  ") + "\n");
    }
  }
  return 0;
}

function compareStrings(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  return pa && pb ? compare(pa, pb) : a.localeCompare(b);
}

export { modeOf };
export type { Module };
