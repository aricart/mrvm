import { test } from "node:test";
import assert from "node:assert/strict";
import { bump, check, fix, ls, suggestCmd } from "../src/commands.ts";
import {
  capture,
  commit,
  git,
  json,
  natsLike,
  put,
  read,
  repo,
  workspace,
} from "./helpers.ts";

const offline = { offline: true, quiet: true };

test("check - a consistent workspace passes", () => {
  const root = workspace(natsLike());
  const io = capture();
  assert.equal(check(root, {}, io), 0);
  assert.match(io.stdout, /ok: 2 modules, 4 pins, all consistent/);
});

test("check - reports own versions, version.ts and pins out of step", () => {
  const files = natsLike();
  (files["core/package.json"] as any).version = "1.1.0";
  files["core/src/version.ts"] = `export const version = "0.9.0";\n`;
  const root = workspace(files);
  const io = capture();
  assert.equal(check(root, {}, io), 1);
  assert.match(io.stdout, /^\d+ inconsistencies \(fix would make these edits\)/);
  for (
    const re of [
      /core\/deno\.json\s+version\s+1\.0\.0 → 1\.1\.0/,
      /core\/src\/version\.ts\s+version\s+0\.9\.0 → 1\.1\.0/,
      /kv\/import_map\.json\s+imports\[@x\/core\/internal\]\s+jsr:@x\/core@1\.0\.0\/internal → jsr:@x\/core@1\.1\.0\/internal/,
      /kv\/package\.json\s+dependencies\[@x\/core\]\s+1\.0\.0 → 1\.1\.0/,
    ]
  ) {
    assert.match(io.stdout, re);
  }
});

test("check - finds no modules", () => {
  const root = workspace({ "README.md": "hi" });
  const io = capture();
  assert.equal(check(root, {}, io), 1);
  assert.match(io.stderr, /no modules found/);
});

test("fix - raises versions and pins, keeping prefixes, subpaths and formatting", () => {
  const files = natsLike();
  (files["core/package.json"] as any).version = "1.1.0";
  (files as Record<string, unknown>)["kv/deno.json"] = `{
  // jsonc with a comment
  "name": "@x/kv",
  "version": "1.0.0",
  "imports": { "@x/core": "jsr:@x/core@^1.0.0" }
}
`;
  const root = workspace(files);
  const io = capture();
  assert.equal(fix(root, {}, io), 0);
  assert.equal(json(root, "core/deno.json").version, "1.1.0");
  assert.match(read(root, "core/src/version.ts"), /"1.1.0"/);
  assert.equal(
    json(root, "kv/import_map.json").imports["@x/core/internal"],
    "jsr:@x/core@1.1.0/internal",
  );
  assert.equal(
    read(root, "kv/deno.json"),
    `{
  // jsonc with a comment
  "name": "@x/kv",
  "version": "1.0.0",
  "imports": { "@x/core": "jsr:@x/core@^1.1.0" }
}
`,
  );
  // unrelated pins are left alone
  assert.equal(
    json(root, "kv/import_map.json").imports["@std/assert"],
    "jsr:@std/assert@1.0.19",
  );
  assert.equal(check(root, {}, capture()), 0);
});

test("fix - a package.json that's behind is fixed too", () => {
  const files = natsLike();
  (files["core/deno.json"] as any).version = "1.2.0";
  const root = workspace(files);
  assert.equal(fix(root, {}, capture()), 0);
  assert.equal(json(root, "core/package.json").version, "1.2.0");
});

test("fix - --dry-run writes nothing", () => {
  const files = natsLike();
  (files["core/package.json"] as any).version = "1.1.0";
  const root = workspace(files);
  const before = read(root, "core/deno.json");
  const io = capture();
  assert.equal(fix(root, { dryRun: true }, io), 0);
  assert.match(io.stdout, /dry run: .* nothing written/);
  assert.equal(read(root, "core/deno.json"), before);
});

test("fix - refuses files with uncommitted changes", () => {
  const files = natsLike();
  const root = repo(workspace(files));
  const pkg = json(root, "core/package.json");
  pkg.version = "1.1.0";
  put(root, "core/package.json", pkg);
  // core/deno.json would be edited; make it dirty too
  put(root, "core/deno.json", { ...json(root, "core/deno.json"), x: 1 });
  const io = capture();
  assert.equal(fix(root, {}, io), 1);
  assert.match(io.stderr, /uncommitted changes in .*core\/deno.json/);
  assert.equal(json(root, "core/deno.json").version, "1.0.0");
  assert.equal(fix(root, { allowDirty: true }, capture()), 0);
  assert.equal(json(root, "core/deno.json").version, "1.1.0");
});

test("fix - aligns third party pins when configured", () => {
  const root = workspace({
    "deno.json": { mrvm: { align: ["@x/nuid"] } },
    "a/deno.json": {
      name: "@x/a",
      version: "1.0.0",
      imports: { "@x/nuid": "jsr:@x/nuid@2.0.0" },
    },
    "b/package.json": {
      name: "@x/b",
      version: "1.0.0",
      dependencies: { "@x/nuid": "^2.1.0" },
    },
  });
  assert.equal(check(root, {}, capture()), 1);
  assert.equal(fix(root, {}, capture()), 0);
  assert.equal(json(root, "a/deno.json").imports["@x/nuid"], "jsr:@x/nuid@2.1.0");
  assert.equal(json(root, "b/package.json").dependencies["@x/nuid"], "^2.1.0");
});

test("validate - refuses invalid versions, duplicates and cycles", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ "a/deno.json": { name: "@x/a", version: "1.0" } }, /not valid semver/],
    [
      {
        "a/deno.json": { name: "@x/a", version: "1.0.0" },
        "b/deno.json": { name: "@x/a", version: "1.0.0" },
      },
      /defined twice/,
    ],
    [
      {
        "a/deno.json": {
          name: "@x/a",
          version: "1.0.0",
          imports: { "@x/b": "jsr:@x/b@1.0.0" },
        },
        "b/deno.json": {
          name: "@x/b",
          version: "1.0.0",
          imports: { "@x/a": "jsr:@x/a@1.0.0" },
        },
      },
      /dependency cycle/,
    ],
  ];
  for (const [files, re] of cases) {
    const io = capture();
    assert.equal(fix(workspace(files), {}, io), 1);
    assert.match(io.stderr, re);
  }
});

test("bump - lockstep moves every module and pin", async () => {
  const root = workspace(natsLike("1.0.0"));
  const io = capture();
  assert.equal(await bump(root, { type: "minor", ...offline }, io), 0);
  assert.match(io.stdout, /lockstep/);
  assert.equal(json(root, "core/deno.json").version, "1.1.0");
  assert.equal(json(root, "kv/package.json").dependencies["@x/core"], "1.1.0");
  assert.match(read(root, "core/src/version.ts"), /"1.1.0"/);
  assert.equal(check(root, {}, capture()), 0);
});

test("bump - lockstep refuses module names", async () => {
  const io = capture();
  assert.equal(
    await bump(workspace(natsLike()), { type: "patch", only: ["kv"], ...offline }, io),
    1,
  );
  assert.match(io.stderr, /lockstep/);
});

test("bump - prerelease with preid, then release", async () => {
  const root = workspace(natsLike("1.0.0"));
  await bump(root, { type: "preminor", preid: "rc", ...offline }, capture());
  assert.equal(json(root, "kv/deno.json").version, "1.1.0-rc.0");
  await bump(root, { type: "prerelease", preid: "rc", ...offline }, capture());
  assert.equal(json(root, "kv/deno.json").version, "1.1.0-rc.1");
  await bump(root, { type: "release", ...offline }, capture());
  assert.equal(json(root, "kv/deno.json").version, "1.1.0");
  assert.equal(json(root, "kv/package.json").dependencies["@x/core"], "1.1.0");
});

test("bump - independent moves the named module and its dependents", async () => {
  const files = natsLike("1.0.0");
  (files["kv/deno.json"] as any).version = "0.5.0";
  (files["kv/package.json"] as any).version = "0.5.0";
  files["other/deno.json"] = { name: "@x/other", version: "2.0.0" };
  const root = workspace(files);
  const io = capture();
  assert.equal(await bump(root, { type: "minor", only: ["core"], ...offline }, io), 0);
  assert.match(io.stdout, /independent/);
  assert.equal(json(root, "core/deno.json").version, "1.1.0");
  assert.equal(json(root, "kv/deno.json").version, "0.5.1");
  assert.match(io.stdout, /depends on @x\/core/);
  assert.equal(json(root, "other/deno.json").version, "2.0.0");
});

test("bump - refuses an inconsistent workspace", async () => {
  const files = natsLike();
  (files["core/package.json"] as any).version = "1.1.0";
  const io = capture();
  assert.equal(await bump(workspace(files), { type: "patch", ...offline }, io), 1);
  assert.match(io.stderr, /run fix first/);
});

test("bump - --dry-run writes nothing", async () => {
  const root = workspace(natsLike());
  const before = read(root, "kv/package.json");
  const io = capture();
  assert.equal(await bump(root, { type: "major", dryRun: true, ...offline }, io), 0);
  assert.match(io.stdout, /nothing written/);
  assert.equal(read(root, "kv/package.json"), before);
});

test("bump --suggest - lockstep, from the commits since the tag", async () => {
  const root = repo(workspace(natsLike("1.0.0")));
  git(root, "tag", "v1.0.0");
  commit(root, "docs: readme", { "kv/README.md": "x" });
  commit(root, "fix(kv): a bug", { "kv/src/kv.ts": "1" });
  let io = capture();
  assert.equal(await bump(root, { suggest: true, dryRun: true, ...offline }, io), 0);
  assert.match(io.stdout, /1\.0\.0 → 1\.0\.1/);
  commit(root, "feat(core): a feature", { "core/src/a.ts": "1" });
  // tests only don't count
  commit(root, "feat(kv)!: a breaking test change", { "kv/tests/a.ts": "1" });
  io = capture();
  assert.equal(await bump(root, { suggest: true, ...offline }, io), 0);
  assert.equal(json(root, "kv/deno.json").version, "1.1.0");
  assert.equal(json(root, "core/deno.json").version, "1.1.0");
});

test("bump --suggest - a single module repo, below 1.0", async () => {
  const root = repo(workspace({
    "deno.json": { name: "@x/one", version: "0.3.0" },
    "package.json": { name: "@x/one", version: "0.3.0" },
  }));
  git(root, "tag", "v0.3.0");
  commit(root, "feat!: breaking", { "src/a.ts": "1" });
  const io = capture();
  assert.equal(await bump(root, { suggest: true, ...offline }, io), 0);
  assert.equal(json(root, "deno.json").version, "0.4.0");
  assert.equal(json(root, "package.json").version, "0.4.0");
});

test("bump --suggest - independent, per module tags", async () => {
  const root = repo(workspace({
    "a/deno.json": { name: "@x/a", version: "1.0.0" },
    "b/deno.json": { name: "@x/b", version: "2.3.0" },
  }));
  git(root, "tag", "a/v1.0.0");
  git(root, "tag", "b/v2.3.0");
  commit(root, "fix(b): x", { "b/src/x.ts": "1" });
  commit(root, "not conventional", { "a/src/x.ts": "1" });
  const io = capture();
  assert.equal(await bump(root, { suggest: true, ...offline }, io), 0);
  assert.equal(json(root, "b/deno.json").version, "2.3.1");
  assert.equal(json(root, "a/deno.json").version, "1.0.1");
  assert.match(io.stdout, /not a conventional commit/);
});

test("bump --suggest - nothing to bump", async () => {
  const root = repo(workspace(natsLike()));
  git(root, "tag", "v1.0.0");
  commit(root, "chore: tidy", { "core/src/a.ts": "1" });
  const io = capture();
  assert.equal(await bump(root, { suggest: true, ...offline }, io), 0);
  assert.match(io.stdout, /nothing to bump/);
});

test("ls - versions from tags", async () => {
  const root = repo(workspace(natsLike()));
  git(root, "tag", "v0.9.0");
  git(root, "tag", "v1.0.0");
  const io = capture();
  assert.equal(await ls(root, { quiet: true }, io), 0);
  assert.match(io.stdout, /1\.0\.0\s+tag v1\.0\.0[\s\S]*0\.9\.0\s+tag v0\.9\.0/);
});

test("fix - version.ts spelled Version, with a type and single quotes", () => {
  const root = workspace({
    "deno.json": { name: "@x/jwt", version: "0.2.0" },
    "src/version.ts": `// generated\nexport const Version: string = '0.1.0';\n`,
  });
  const io = capture();
  assert.equal(check(root, {}, io), 1);
  assert.match(io.stdout, /src\/version\.ts\s+version\s+0\.1\.0 → 0\.2\.0/);
  assert.equal(fix(root, {}, capture()), 0);
  assert.equal(read(root, "src/version.ts"), `// generated\nexport const Version: string = '0.2.0';\n`);
});

test("check - a version.ts without a version is reported", () => {
  const root = workspace({
    "deno.json": { name: "@x/a", version: "1.0.0" },
    "src/version.ts": `export const v = 1;\n`,
  });
  const io = capture();
  assert.equal(check(root, {}, io), 1);
  assert.match(io.stderr, /src\/version\.ts: no "export const version/);
});

test("suggest - shows the bump and writes nothing", () => {
  const root = repo(workspace(natsLike("1.0.0")));
  git(root, "tag", "v1.0.0");
  commit(root, "feat(kv): a feature", { "kv/src/kv.ts": "1" });
  const before = read(root, "kv/deno.json");
  const io = capture();
  assert.equal(suggestCmd(root, {}, io), 0);
  assert.match(io.stdout, /@x\/kv 1\.0\.0: minor, 1 commit since v1\.0\.0/);
  assert.match(io.stdout, /lockstep, mrvm bump --suggest would make:[\s\S]*1\.0\.0 → 1\.1\.0/);
  assert.equal(read(root, "kv/deno.json"), before);
});

// npm keeps the package's version in package-lock.json too; a bump that
// leaves it behind makes `npm ci`/`npm install` rewrite it in ci
function lockFor(name: string, version: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name, version, license: "MIT" },
      "node_modules/left-pad": { version: "1.3.0" },
      ...extra,
    },
  };
}

test("bump - updates the versions in package-lock.json", async () => {
  const root = workspace({
    "package.json": { name: "@x/one", version: "0.1.0-0" },
    "deno.json": { name: "@x/one", version: "0.1.0-0" },
    "package-lock.json": lockFor("@x/one", "0.1.0-0"),
  });
  const io = capture();
  assert.equal(await bump(root, { type: "prerelease", ...offline }, io), 0);
  const lock = json(root, "package-lock.json");
  assert.equal(lock.version, "0.1.0-1");
  assert.equal(lock.packages[""].version, "0.1.0-1");
  // other packages in the lock are left alone
  assert.equal(lock.packages["node_modules/left-pad"].version, "1.3.0");
  assert.equal(check(root, {}, capture()), 0);
});

test("check - a stale package-lock.json version is reported", () => {
  const root = workspace({
    "package.json": { name: "@x/one", version: "1.0.1" },
    "package-lock.json": lockFor("@x/one", "1.0.0"),
  });
  const io = capture();
  assert.equal(check(root, {}, io), 1);
  assert.match(io.stdout, /package-lock\.json\s+version\s+1\.0\.0 → 1\.0\.1/);
  assert.match(io.stdout, /package-lock\.json\s+packages\[""\]\.version\s+1\.0\.0 → 1\.0\.1/);
});

test("fix - the lock doesn't decide the version", () => {
  const root = workspace({
    "package.json": { name: "@x/one", version: "1.0.0" },
    "package-lock.json": lockFor("@x/one", "9.9.9"),
  });
  assert.equal(fix(root, {}, capture()), 0);
  assert.equal(json(root, "package.json").version, "1.0.0");
  assert.equal(json(root, "package-lock.json").version, "1.0.0");
});

test("bump - a workspace lock's members and their pins follow", async () => {
  const root = workspace({
    "package.json": { workspaces: ["core", "kv"] },
    "core/package.json": { name: "@x/core", version: "1.0.0" },
    "kv/package.json": {
      name: "@x/kv",
      version: "1.0.0",
      dependencies: { "@x/core": "1.0.0" },
    },
    "package-lock.json": {
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["core", "kv"] },
        "core": { name: "@x/core", version: "1.0.0" },
        "kv": {
          name: "@x/kv",
          version: "1.0.0",
          dependencies: { "@x/core": "1.0.0" },
        },
        "node_modules/@x/core": { resolved: "core", link: true },
        "node_modules/@x/kv": { resolved: "kv", link: true },
      },
    },
  });
  assert.equal(check(root, {}, capture()), 0);
  assert.equal(await bump(root, { type: "minor", ...offline }, capture()), 0);
  const lock = json(root, "package-lock.json");
  assert.equal(lock.packages.core.version, "1.1.0");
  assert.equal(lock.packages.kv.version, "1.1.0");
  assert.equal(lock.packages.kv.dependencies["@x/core"], "1.1.0");
  assert.equal(check(root, {}, capture()), 0);
});

test("check - files git ignores are left out", () => {
  const root = repo(workspace({
    ".gitignore": "package-lock.json\n",
    "package.json": { name: "@x/one", version: "2.0.0" },
  }));
  // a stale lock nobody commits
  put(root, "package-lock.json", lockFor("@x/one", "1.0.0"));
  assert.equal(check(root, {}, capture()), 0);
});
