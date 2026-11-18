# mrvm

A monorepo version manager. `mrvm` keeps the versions of a Deno/npm workspace
consistent, and bumps them:

- each module's version agrees across its `deno.json`, `package.json`,
  `src/version.ts` and `package-lock.json`;
- every pin on a module (`jsr:` and `npm:` imports in `deno.json` and
  `import_map.json`, and `package.json` dependencies) is at that version;
- bumps by release type, or suggested from the conventional commits since the
  last release tag.

It works without configuration: a module is a directory whose `deno.json` or
`package.json` has a `name` and a `version`, and a repository that is a single
package is one module at the root.

## Running it

`mrvm` is an npm package with a command-line tool. It runs on Node.js (22 or
newer), Deno and Bun, and manages Deno, npm and mixed workspaces the same way.

```sh
# node
npx @aricart/mrvm check
npm install --global @aricart/mrvm && mrvm check

# deno
deno run -A npm:@aricart/mrvm check

# bun
bunx @aricart/mrvm check
```

It needs `git` on the PATH for `bump --suggest` and `ls`, and network access
to check jsr and npm (which `--offline` skips).

Deno won't install npm versions published in the last 24 hours (its
minimum dependency age). To run a release as soon as it's out, exclude mrvm in
the `deno.json` of the directory you run it from:

```json
{
  "minimumDependencyAge": { "exclude": ["npm:@aricart/*"] }
}
```

or pass `--minimum-dependency-age=0` to `deno run`.

## Commands

```
mrvm check                     checks versions and pins; exits 1 when inconsistent
mrvm fix [--dry-run]           makes versions and pins consistent
mrvm bump <type> [module...]   bumps by release type
mrvm suggest [module...]       shows the bumps the commits call for; writes nothing
mrvm bump --suggest [module...]  applies them
mrvm ls [module...] [-r]       released versions: git tags, and jsr/npm with -r
```

Release types are `major`, `minor`, `patch`, `premajor`, `preminor`,
`prepatch`, `prerelease` and `release`, as in `npm version`. `--preid rc`
makes prereleases like `1.3.0-rc.0`.

Global flags: `-C, --dir` (the workspace root), `--json` (machine readable
output) and `-q, --quiet` (no progress display).

### It doesn't do the wrong thing

- `check` and `ls` never write.
- `fix` and `bump` print every edit (file, field, old and new value) and, with
  `--dry-run`, stop there.
- Before writing they apply the edits in memory and check the result; if
  anything would still be inconsistent, nothing is written.
- They refuse to overwrite files with uncommitted changes (`--allow-dirty`
  overrides), and refuse to start on an invalid version, a module defined
  twice, or a dependency cycle.
- `bump` refuses when the workspace isn't consistent first (run `fix`), and
  when a new version is already published on jsr or npm.
- Edits only replace version strings: `^`/`~` prefixes, `jsr:`/`npm:`
  protocols, subpaths like `/internal`, formatting, comments and trailing
  newlines are kept.

### Lockstep and independent versions

In lockstep mode every module has the same version and moves together. In
independent mode each module has its own version; `bump` moves the named
modules (all of them when none are named), and every module that depends on a
moved one gets a patch bump so its pins can change.

`bump` uses lockstep when the workspace has several modules with the same
version, and independent otherwise. Set the mode to be explicit:

```json
{
  "mrvm": { "mode": "lockstep" }
}
```

### Suggested bumps

`mrvm suggest` shows, and `bump --suggest` applies, a bump worked out from the
commits since each module's last release tag
(`v1.2.3`, or `<dir>/v1.2.3` for modules released separately) and the files
they change:

- a breaking change (`feat!:`, `fix!:` or a `BREAKING CHANGE:` footer) is a
  major bump, `feat` minor, `fix` and `perf` patch;
- `chore`, `docs`, `test`, `ci`, `build` and `style` don't need a release;
- commits that only touch tests, docs, examples or markdown don't count;
- a commit that isn't a conventional commit but changes published files counts
  as a patch, and is marked in the output;
- below 1.0, a breaking change is a minor bump and a feature a patch.

### package-lock.json

npm keeps a copy of the package's version in `package-lock.json` (at
`version` and `packages[""]`, or `packages["<dir>"]` for each member of a
workspace), and of each package's dependency ranges. mrvm checks and updates
those copies with the manifests, so `npm ci` and `npm install` don't rewrite
the lock after a bump. They never decide a module's version: `fix` brings the
lock to the manifests, not the other way around.

Files git ignores (a lock that isn't committed, say) aren't part of the
workspace.

### version.ts

Code can't reliably read its own `package.json` or `deno.json` once it's
published (a JSR package has no package.json, a bundle has neither), so
libraries that need their version at runtime, for example to report it to a
server, keep it in a source file. mrvm treats `src/version.ts` in a module's
directory (or at the root, for a single-package repository) as one more place
the module's version is written:

```ts
// This file is generated - do not edit
export const version = "1.2.3";
```

- `check` reports it when it doesn't match the module's `deno.json` and
  `package.json`, and `fix` and `bump` update it with them.
- The name can be `version`, `Version` or `VERSION`, with an optional
  `: string` type and either quote style; only the version string is replaced.
- mrvm doesn't create the file. If a module has a `src/version.ts` without a
  version in it, that's reported as a problem rather than skipped.

### Configuration

Optional, in an `"mrvm"` section of the root `deno.json` or `package.json`:

| key      | meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `mode`   | `"lockstep"` or `"independent"`                                                         |
| `ignore` | directories to leave out, e.g. `["bin", "examples"]`                                    |
| `align`  | dependencies outside the workspace whose pins must agree, e.g. `["@nats-io/nuid"]`; `fix` raises them to the highest pin |

## License

Apache-2.0
