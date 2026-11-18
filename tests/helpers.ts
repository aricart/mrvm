// builds throwaway workspaces (and git repositories) for the tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Io } from "../src/commands.ts";

export function workspace(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "mrvm-test-"));
  for (const [path, content] of Object.entries(files)) {
    const p = join(root, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
    );
  }
  return root;
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

export function json(root: string, path: string): any {
  return JSON.parse(read(root, path));
}

export function put(root: string, path: string, content: unknown) {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
  );
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

export function repo(root: string): string {
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: initial");
  return root;
}

export function commit(root: string, subject: string, files: Record<string, unknown>) {
  for (const [p, c] of Object.entries(files)) put(root, p, c);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", subject);
}

export function capture(): Io & { stdout: string; stderr: string } {
  const c = {
    stdout: "",
    stderr: "",
    out(s: string) {
      c.stdout += s;
    },
    err(s: string) {
      c.stderr += s;
    },
  };
  return c;
}

// a lockstep workspace shaped like nats.js: core, and kv depending on it
export function natsLike(version = "1.0.0"): Record<string, any> {
  return {
    "deno.json": { workspace: ["./core", "./kv"] },
    "core/deno.json": { name: "@x/core", version },
    "core/package.json": { name: "@x/core", version },
    "core/src/version.ts": `// This file is generated - do not edit\nexport const version = "${version}";\n`,
    "kv/deno.json": {
      name: "@x/kv",
      version,
      imports: { "@x/core": `jsr:@x/core@${version}` },
    },
    "kv/import_map.json": {
      imports: {
        "@x/core": `jsr:@x/core@${version}`,
        "@x/core/internal": `jsr:@x/core@${version}/internal`,
        "@std/assert": "jsr:@std/assert@1.0.19",
      },
    },
    "kv/package.json": {
      name: "@x/kv",
      version,
      dependencies: { "@x/core": version },
    },
  };
}
