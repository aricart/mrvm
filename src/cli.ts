#!/usr/bin/env node
// mrvm: monorepo version manager.

import { cli, type Command, type Flags } from "@aricart/cobra";
import { resolve } from "node:path";
import { bump, check, fix, type Io, ls } from "./commands.ts";
import { type ReleaseType, releaseTypes } from "./semver.ts";

function io(cmd: Command): Io {
  return { out: (s) => cmd.stdout(s), err: (s) => cmd.stderr(s) };
}

function common(flags: Flags) {
  return {
    root: resolve(flags.value<string>("dir") || "."),
    json: flags.value<boolean>("json"),
    quiet: flags.value<boolean>("quiet"),
  };
}

const root = cli({
  use: "mrvm",
  short: "monorepo version manager: check, fix and bump versions across a deno/npm workspace",
  long:
    `mrvm keeps the versions of a deno/npm workspace consistent: each module's
version across its deno.json, package.json and src/version.ts, and every pin
on a module (jsr: and npm: imports, package.json dependencies) at that
version. It also bumps versions, by release type or from the conventional
commits since the last release tag.

A module is a directory whose deno.json or package.json has a name and a
version. A repository that is a single package is one module, at the root.

Nothing is written without fix or bump, and both stop before writing when
the result wouldn't be consistent, when files have uncommitted changes, or
(bump) when a new version is already published.`,
});

root.addFlag({
  name: "dir",
  short: "C",
  type: "string",
  default: ".",
  usage: "the workspace root",
  persistent: true,
});
root.addFlag({
  name: "json",
  type: "boolean",
  usage: "machine readable output",
  persistent: true,
});
root.addFlag({
  name: "quiet",
  short: "q",
  type: "boolean",
  usage: "no progress display",
  persistent: true,
});

root.addCommand({
  use: "check",
  short: "checks versions and pins; exits 1 when something is inconsistent",
  run: (cmd, _args, flags) => {
    const c = common(flags);
    return Promise.resolve(check(c.root, c, io(cmd)));
  },
});

const fixCmd = root.addCommand({
  use: "fix",
  short: "makes versions and pins consistent",
  long:
    `Makes versions and pins consistent: each module goes to the highest version
found in its files (every module to the highest, in lockstep mode), and every
pin follows. Pin prefixes (^, ~), protocols and subpaths are kept, and nothing
else in the files changes.`,
  run: (cmd, _args, flags) => {
    const c = common(flags);
    return Promise.resolve(
      fix(c.root, {
        ...c,
        dryRun: flags.value<boolean>("dry-run"),
        allowDirty: flags.value<boolean>("allow-dirty"),
      }, io(cmd)),
    );
  },
});

const bumpCmd = root.addCommand({
  use: "bump [type] [module...]",
  short: "bumps versions and the pins on them",
  long:
    `Bumps versions by release type (${releaseTypes.join(", ")}),
or with --suggest, from the conventional commits since each module's last
release tag: a breaking change is major, feat minor, fix and perf patch (one
level lower below 1.0).

In lockstep mode (all modules on one version) every module moves together. In
independent mode the named modules move (all of them when none are named), and
every module that depends on a moved one gets a patch bump so its pins can
change.

Before writing, bump checks that the new versions aren't already on jsr or
npm (skip with --offline).`,
  run: async (cmd, args, flags) => {
    const c = common(flags);
    const suggest = flags.value<boolean>("suggest");
    let type: ReleaseType | undefined;
    let only = args;
    if (!suggest) {
      if (!args.length || !releaseTypes.includes(args[0] as ReleaseType)) {
        cmd.stderr(
          `Error: give a release type (${releaseTypes.join(", ")}) or --suggest\n`,
        );
        return 1;
      }
      type = args[0] as ReleaseType;
      only = args.slice(1);
    }
    return await bump(c.root, {
      ...c,
      type,
      suggest,
      only,
      preid: flags.value<string>("preid") || undefined,
      dryRun: flags.value<boolean>("dry-run"),
      allowDirty: flags.value<boolean>("allow-dirty"),
      offline: flags.value<boolean>("offline"),
    }, io(cmd));
  },
});

for (const c of [fixCmd, bumpCmd]) {
  c.addFlag({
    name: "dry-run",
    short: "n",
    type: "boolean",
    usage: "show the plan, write nothing",
  });
  c.addFlag({
    name: "allow-dirty",
    type: "boolean",
    usage: "write even when the files have uncommitted changes",
  });
}
bumpCmd.addFlag({
  name: "suggest",
  type: "boolean",
  usage: "bump from the conventional commits since the last release",
});
bumpCmd.addFlag({
  name: "preid",
  type: "string",
  usage: "prerelease identifier, e.g. rc for 1.2.0-rc.0",
});
bumpCmd.addFlag({
  name: "offline",
  type: "boolean",
  usage: "don't check jsr and npm for an already published version",
});

const lsCmd = root.addCommand({
  use: "ls [module...]",
  short: "lists released versions from the git tags, and jsr and npm",
  run: async (cmd, args, flags) => {
    const c = common(flags);
    return await ls(c.root, {
      ...c,
      only: args,
      registry: flags.value<boolean>("registry"),
      all: flags.value<boolean>("all"),
    }, io(cmd));
  },
});
lsCmd.addFlag({
  name: "registry",
  short: "r",
  type: "boolean",
  usage: "also look up jsr and npm",
});
lsCmd.addFlag({
  name: "all",
  short: "a",
  type: "boolean",
  usage: "every version, not just the latest 10",
});

root.exit(await root.execute());
