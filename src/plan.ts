// turns target versions into a list of edits, applies them in memory,
// verifies the result, and only then writes.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, findString, stringSpans } from "./jsonedit.ts";
import { compare, format, max, mustParse, parse, type SemVer } from "./semver.ts";
import {
  fileDir,
  modelFrom,
  VERSION_TS_RE,
  moduleOf,
  type Module,
  type Workspace,
  type WorkspaceFile,
} from "./workspace.ts";

/**
 * One edit: a version string in a file going from one value to another.
 */
export interface Change {
  file: string;
  path: string[];
  from: string;
  to: string;
  /** the module or dependency the change is about */
  subject: string;
}

/**
 * The version every module should have. With `lockstep` all modules get the
 * highest version found.
 */
export function currentTargets(ws: Workspace): Map<Module, SemVer> {
  const targets = new Map<Module, SemVer>();
  const lockstep = ws.config.mode === "lockstep"
    ? max(ws.modules.map((m) => m.version))
    : null;
  for (const m of ws.modules) targets.set(m, lockstep ?? m.version);
  return targets;
}

/**
 * The edits that bring the workspace to the target versions: every module's
 * own version sites, every pin on a module, and every aligned dependency.
 * Pin prefixes (`^`, `~`), protocols and subpaths are kept.
 */
export function planChanges(
  ws: Workspace,
  targets: Map<Module, SemVer>,
): Change[] {
  const changes: Change[] = [];
  for (const [m, v] of targets) {
    const to = format(v);
    for (const s of m.sites) {
      if (s.value !== to) {
        changes.push({
          file: s.file,
          path: s.path,
          from: s.value,
          to,
          subject: m.name,
        });
      }
    }
  }
  // the highest pin of each aligned dependency
  const aligned = new Map<string, SemVer>();
  for (const dep of ws.config.align ?? []) {
    const v = max(
      ws.pins.filter((p) => p.dep === dep).map((p) => mustParse(p.version)),
    );
    if (v) aligned.set(dep, v);
  }
  for (const p of ws.pins) {
    const m = moduleOf(ws, p.dep);
    const want = m ? targets.get(m) : aligned.get(p.dep);
    if (!want) continue;
    const version = format(want);
    if (p.version === version) continue;
    changes.push({
      file: p.file,
      path: p.path,
      from: p.value,
      to: `${p.before}${p.prefix}${version}${p.after}`,
      subject: p.dep,
    });
  }
  return changes.sort((a, b) =>
    a.file.localeCompare(b.file) || a.path.join(".").localeCompare(b.path.join("."))
  );
}

/**
 * Applies changes to copies of the files, without touching the disk.
 */
export function applyInMemory(
  ws: Workspace,
  changes: Change[],
): Map<string, WorkspaceFile> {
  const files = new Map(ws.files);
  const byFile = new Map<string, Change[]>();
  for (const c of changes) {
    byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  }
  for (const [path, cs] of byFile) {
    const f = files.get(path);
    if (!f) throw new Error(`${path}: not part of the workspace`);
    let text: string;
    if (f.kind === "version_ts") {
      text = f.text.replace(
        VERSION_TS_RE,
        (_m, head: string, q: string) => `${head}${q}${cs[0].to}${q}`,
      );
    } else {
      text = applyEdits(
        f.text,
        cs.map((c) => {
          const span = findString(f.spans, c.path);
          if (!span || span.value !== c.from) {
            throw new Error(
              `${path}: ${c.path.join(".")} is not "${c.from}"`,
            );
          }
          return { start: span.start, end: span.end, value: c.to };
        }),
      );
    }
    files.set(path, {
      ...f,
      text,
      spans: f.kind === "version_ts" ? [] : stringSpans(text, path),
    });
  }
  return files;
}

/**
 * Problems that make a workspace unsafe to change: unreadable versions,
 * duplicate names, and dependency cycles between modules.
 */
export function validate(ws: Workspace): string[] {
  const problems = [...ws.problems];
  for (const p of ws.pins) {
    if (!parse(p.version)) {
      problems.push(`${p.file}: ${p.dep} pin "${p.value}" is not valid semver`);
    }
  }
  // cycles: a module depending, through other modules, on itself
  const deps = new Map<Module, Set<Module>>();
  for (const m of ws.modules) deps.set(m, new Set());
  for (const p of ws.pins) {
    const target = moduleOf(ws, p.dep);
    const owner = ws.modules.find((m) => m.dir === fileDir(p.file));
    if (target && owner && target !== owner) deps.get(owner)!.add(target);
  }
  const state = new Map<Module, "visiting" | "done">();
  const visit = (m: Module, trail: Module[]) => {
    if (state.get(m) === "done") return;
    if (state.get(m) === "visiting") {
      const loop = [...trail.slice(trail.indexOf(m)), m].map((x) => x.name);
      problems.push(`dependency cycle: ${loop.join(" → ")}`);
      return;
    }
    state.set(m, "visiting");
    for (const d of deps.get(m)!) visit(d, [...trail, m]);
    state.set(m, "done");
  };
  for (const m of ws.modules) visit(m, []);
  return [...new Set(problems)];
}

/**
 * The result of checking a planned change: the workspace after the edits,
 * and anything still inconsistent in it.
 */
export interface Verified {
  files: Map<string, WorkspaceFile>;
  after: Workspace;
  remaining: Change[];
}

/**
 * Applies the changes in memory and checks the result: afterwards every
 * module and pin must be at its target, and nothing else may have moved.
 */
export function verify(
  ws: Workspace,
  changes: Change[],
  targets: Map<Module, SemVer>,
): Verified {
  const files = applyInMemory(ws, changes);
  const after = modelFrom(ws.root, ws.config, files);
  const byDir = new Map(after.modules.map((m) => [m.dir, m]));
  const afterTargets = new Map<Module, SemVer>();
  for (const [m, v] of targets) {
    const a = byDir.get(m.dir);
    if (!a) throw new Error(`module ${m.name} disappeared`);
    afterTargets.set(a, v);
    if (compare(a.version, v) !== 0) {
      throw new Error(
        `${m.name} would be at ${format(a.version)}, not ${format(v)}`,
      );
    }
  }
  return { files, after, remaining: planChanges(after, afterTargets) };
}

/**
 * Writes the changed files.
 */
export function write(ws: Workspace, files: Map<string, WorkspaceFile>) {
  for (const [path, f] of files) {
    if (ws.files.get(path)?.text !== f.text) {
      writeFileSync(join(ws.root, path), f.text);
    }
  }
}

/**
 * Formats changes as aligned lines: file, field, from → to.
 */
export function formatChanges(changes: Change[]): string {
  const field = (c: Change) =>
    c.path.length === 1 ? c.path[0] : `${c.path[0]}[${c.path.slice(1).join(".")}]`;
  const rows = changes.map((c) => [c.file, field(c), `${c.from} → ${c.to}`]);
  const w0 = Math.max(0, ...rows.map((r) => r[0].length));
  const w1 = Math.max(0, ...rows.map((r) => r[1].length));
  return rows.map((r) => `  ${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}`)
    .join("\n");
}
