// discovers the modules of a workspace from its manifests, and the places
// where versions and pins on those modules are written.

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { findString, type StringSpan, stringSpans } from "./jsonedit.ts";
import { compare, format, max, parse, type SemVer } from "./semver.ts";

/**
 * Optional settings, read from an `"mrvm"` section in the root `deno.json` or
 * `package.json`. Everything is discovered without them.
 */
export interface Config {
  /**
   * `lockstep`: every module has the same version and is bumped together.
   * `independent`: each module has its own version. Without it, `check` treats
   * the workspace as independent, and `bump` uses lockstep when all versions
   * are equal.
   */
  mode?: "lockstep" | "independent";
  /** directories to leave out, relative to the root */
  ignore?: string[];
  /**
   * dependencies outside the workspace whose pins must agree everywhere,
   * e.g. `["@nats-io/nuid"]`; `fix` raises them to the highest pin
   */
  align?: string[];
}

export type FileKind = "deno" | "package" | "import_map" | "version_ts";

/**
 * A file mrvm reads and may edit.
 */
export interface WorkspaceFile {
  /** relative to the root, with forward slashes */
  path: string;
  kind: FileKind;
  text: string;
  /** string values by path, for the json files */
  spans: StringSpan[];
}

/**
 * Where a module's own version is written.
 */
export interface VersionSite {
  file: string;
  /** the json path, or ["version"] for a version.ts */
  path: string[];
  value: string;
}

/**
 * A module: a directory whose `deno.json` or `package.json` has a name and a
 * version.
 */
export interface Module {
  /** directory relative to the root; "" for the root itself */
  dir: string;
  /** the name used for display: the deno.json name, else package.json's */
  name: string;
  /** every name it is published under (jsr and npm may differ) */
  names: string[];
  /** the jsr name, if it has a deno.json with a name */
  jsr?: string;
  /** the npm name, if it has a package.json with a name that isn't private */
  npm?: string;
  sites: VersionSite[];
  /** the highest of its version sites */
  version: SemVer;
}

/**
 * A reference to a module or an aligned dependency, with its version.
 */
export interface Pin {
  file: string;
  path: string[];
  /** the dependency's name */
  dep: string;
  /** the full value, e.g. `jsr:@nats-io/kv@^3.5.0/internal` */
  value: string;
  /** the parts around the version: value = before + prefix + version + after */
  before: string;
  prefix: string;
  version: string;
  after: string;
}

export interface Workspace {
  root: string;
  config: Config;
  files: Map<string, WorkspaceFile>;
  modules: Module[];
  pins: Pin[];
  /** problems found while reading, e.g. an invalid version */
  problems: string[];
}

const SKIP_DIRS = new Set(["node_modules", "lib", "build", "dist", "coverage"]);
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
// jsr:@scope/name@^1.2.3/sub or npm:name@1.2.3
const IMPORT_RE = /^(jsr:|npm:)(@[^/@]+\/[^/@]+|[^/@]+)@([\^~]?)([^/]+)(\/.*)?$/;
// ^1.2.3, ~1.2.3, 1.2.3, or an alias npm:name@^1.2.3
const PKG_RE = /^(npm:(@[^/@]+\/[^/@]+|[^/@]+)@)?([\^~]?)([0-9][^\s]*)$/;
// export const version = "1.2.3" (or Version, VERSION, with ' or ")
export const VERSION_TS_RE =
  /(export\s+const\s+(?:version|Version|VERSION)\s*(?::\s*string\s*)?=\s*)(["'])([^"']+)\2/;

function readText(root: string, path: string): string | undefined {
  const p = join(root, path);
  return existsSync(p) && statSync(p).isFile()
    ? readFileSync(p, "utf8")
    : undefined;
}

function rel(dir: string, file: string): string {
  return dir ? `${dir}/${file}` : file;
}

function clean(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

// the directories that may hold modules: workspace lists from deno.json and
// package.json (with a trailing /* expanded), plus every top-level directory
function candidateDirs(root: string, rootJson: unknown[]): string[] {
  const dirs = new Set<string>([""]);
  const add = (d: string) => {
    d = clean(d);
    if (d.endsWith("/*")) {
      const parent = d.slice(0, -2);
      const p = join(root, parent);
      if (existsSync(p)) {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) dirs.add(`${parent}/${e.name}`);
        }
      }
    } else if (d) {
      dirs.add(d);
    }
  };
  for (const j of rootJson) {
    // deno.json "workspace": [...] or { members: [...] }
    // package.json "workspaces": [...] or { packages: [...] }
    const o = j as Record<string, unknown>;
    for (const v of [o?.workspace, o?.workspaces]) {
      const list = Array.isArray(v)
        ? v
        : (v as { members?: unknown; packages?: unknown })?.members ??
          (v as { packages?: unknown })?.packages;
      if (Array.isArray(list)) list.forEach((d) => add(String(d)));
    }
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
      dirs.add(e.name);
    }
  }
  return [...dirs];
}

/**
 * Splits a pin value into its parts, or returns null when it isn't a plain
 * version (a range like `>=1`, a path, a url, `workspace:*`).
 */
export function parsePin(
  value: string,
  kind: "import" | "package",
  key: string,
): Omit<Pin, "file" | "path"> | null {
  if (kind === "import") {
    const m = IMPORT_RE.exec(value);
    if (!m || !parse(m[4])) return null;
    return {
      dep: m[2],
      value,
      before: `${m[1]}${m[2]}@`,
      prefix: m[3],
      version: m[4],
      after: m[5] ?? "",
    };
  }
  const m = PKG_RE.exec(value);
  if (!m || !parse(m[4])) return null;
  return {
    dep: m[2] ?? key,
    value,
    before: m[1] ?? "",
    prefix: m[3],
    version: m[4],
    after: "",
  };
}

function loadFile(
  root: string,
  path: string,
  kind: FileKind,
): WorkspaceFile | undefined {
  const text = readText(root, path);
  if (text === undefined) return undefined;
  return {
    path,
    kind,
    text,
    spans: kind === "version_ts" ? [] : stringSpans(text, path),
  };
}

/**
 * Reads the config from the root manifests.
 */
function readConfig(files: WorkspaceFile[]): Config {
  for (const f of files) {
    try {
      // deno.json may be jsonc; strip comments the simple way through spans
      const j = JSON.parse(stripComments(f.text));
      if (j?.mrvm) return j.mrvm as Config;
    } catch {
      // not plain json: no config
    }
  }
  return {};
}

function stripComments(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m, s) => (s ? m : ""),
  ).replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Builds the workspace model from files already in memory, so a plan can be
 * checked before anything is written.
 */
export function modelFrom(
  root: string,
  config: Config,
  files: Map<string, WorkspaceFile>,
): Workspace {
  const problems: string[] = [];
  const modules: Module[] = [];
  const dirs = new Set<string>();
  for (const f of files.values()) {
    dirs.add(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "");
  }
  // version.ts lives in <dir>/src; its module is <dir>
  const moduleDirs = [...dirs].filter((d) => !d.endsWith("/src") && d !== "src");

  for (const dir of moduleDirs.sort()) {
    const deno = files.get(rel(dir, "deno.json")) ??
      files.get(rel(dir, "deno.jsonc"));
    const pkg = files.get(rel(dir, "package.json"));
    const vts = files.get(rel(dir, "src/version.ts"));
    const sites: VersionSite[] = [];
    const names: string[] = [];
    let jsr: string | undefined;
    let npm: string | undefined;
    for (const f of [deno, pkg]) {
      if (!f) continue;
      const name = findString(f.spans, ["name"]);
      const version = findString(f.spans, ["version"]);
      if (!name || !version) continue;
      if (!names.includes(name.value)) names.push(name.value);
      if (f.kind === "deno") jsr = name.value;
      if (f.kind === "package" && !/"private"\s*:\s*true/.test(f.text)) {
        npm = name.value;
      }
      sites.push({ file: f.path, path: ["version"], value: version.value });
    }
    if (!sites.length) continue;
    if (vts) {
      const m = VERSION_TS_RE.exec(vts.text);
      if (m) sites.push({ file: vts.path, path: ["version"], value: m[3] });
      else problems.push(`${vts.path}: no "export const version = ..." found`);
    }
    const versions: SemVer[] = [];
    for (const s of sites) {
      const v = parse(s.value);
      if (!v) {
        problems.push(`${s.file}: version "${s.value}" is not valid semver`);
      } else {
        versions.push(v);
      }
    }
    if (!versions.length) continue;
    modules.push({
      dir,
      name: jsr ?? names[0],
      names,
      jsr,
      npm,
      sites,
      version: max(versions)!,
    });
  }

  // two modules with the same name is ambiguous
  const owner = new Map<string, Module>();
  for (const m of modules) {
    for (const n of m.names) {
      const o = owner.get(n);
      if (o) {
        problems.push(
          `${n} is defined twice: in ${o.dir || "."} and ${m.dir || "."}`,
        );
      }
      owner.set(n, m);
    }
  }

  const pins: Pin[] = [];
  for (const f of files.values()) {
    if (f.kind === "version_ts") continue;
    for (const s of f.spans) {
      let p: Omit<Pin, "file" | "path"> | null = null;
      if (
        (f.kind === "deno" || f.kind === "import_map") &&
        s.path.length === 2 && s.path[0] === "imports"
      ) {
        p = parsePin(s.value, "import", s.path[1]);
      } else if (
        f.kind === "package" && s.path.length === 2 &&
        DEP_SECTIONS.includes(s.path[0])
      ) {
        p = parsePin(s.value, "package", s.path[1]);
      }
      if (p && (owner.has(p.dep) || config.align?.includes(p.dep))) {
        pins.push({ file: f.path, path: s.path, ...p });
      }
    }
  }

  return { root, config, files, modules, pins, problems };
}

/**
 * Reads a workspace from disk.
 */
export function loadWorkspace(root: string): Workspace {
  const rootFiles = ["deno.json", "deno.jsonc", "package.json"]
    .map((p) => loadFile(root, p, p === "package.json" ? "package" : "deno"))
    .filter((f): f is WorkspaceFile => f !== undefined);
  const config = readConfig(rootFiles);
  const rootJson = rootFiles.map((f) => {
    try {
      return JSON.parse(stripComments(f.text));
    } catch {
      return {};
    }
  });
  const ignore = new Set((config.ignore ?? []).map(clean));
  const files = new Map<string, WorkspaceFile>();
  for (const dir of candidateDirs(root, rootJson)) {
    if (ignore.has(dir)) continue;
    const kinds: [string, FileKind][] = [
      ["deno.json", "deno"],
      ["deno.jsonc", "deno"],
      ["package.json", "package"],
      ["import_map.json", "import_map"],
      ["src/version.ts", "version_ts"],
    ];
    for (const [name, kind] of kinds) {
      const f = loadFile(root, rel(dir, name), kind);
      if (f) files.set(f.path, f);
    }
  }
  return modelFrom(root, config, files);
}

/**
 * The module a pin refers to, if any.
 */
export function moduleOf(ws: Workspace, dep: string): Module | undefined {
  return ws.modules.find((m) => m.names.includes(dep));
}

/**
 * Whether every module has the same version.
 */
export function allEqual(ws: Workspace): boolean {
  return ws.modules.every((m) => compare(m.version, ws.modules[0].version) === 0);
}

/**
 * The modules that depend on a module, directly, through pins in their own
 * manifests.
 */
export function dependents(ws: Workspace, m: Module): Module[] {
  return ws.modules.filter((o) =>
    o !== m &&
    ws.pins.some((p) =>
      m.names.includes(p.dep) && fileDir(p.file) === o.dir
    )
  );
}

/**
 * The directory of a file, for matching it to a module.
 */
export function fileDir(file: string): string {
  const d = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  return d.endsWith("/src") ? d.slice(0, -4) : d === "src" ? "" : d;
}

export function versionString(v: SemVer): string {
  return format(v);
}
