# mrvm

A monorepo version manager. `mrvm` keeps the versions of a Deno/npm workspace
consistent, and bumps them:

- each module's version agrees across its `deno.json`, `package.json` and
  `src/version.ts`;
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

## Commands

```
mrvm check                     checks versions and pins; exits 1 when inconsistent
mrvm fix [--dry-run]           makes versions and pins consistent
mrvm bump <type> [module...]   bumps by release type
mrvm bump --suggest [module...]  bumps from the commits since the last release
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

`bump --suggest` reads the commits since each module's last release tag
(`v1.2.3`, or `<dir>/v1.2.3` for modules released separately) and the files
they change:

- a breaking change (`feat!:`, `fix!:` or a `BREAKING CHANGE:` footer) is a
  major bump, `feat` minor, `fix` and `perf` patch;
- `chore`, `docs`, `test`, `ci`, `build` and `style` don't need a release;
- commits that only touch tests, docs, examples or markdown don't count;
- a commit that isn't a conventional commit but changes published files counts
  as a patch, and is marked in the output;
- below 1.0, a breaking change is a minor bump and a feature a patch.

### Configuration

Optional, in an `"mrvm"` section of the root `deno.json` or `package.json`:

| key      | meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `mode`   | `"lockstep"` or `"independent"`                                                         |
| `ignore` | directories to leave out, e.g. `["bin", "examples"]`                                    |
| `align`  | dependencies outside the workspace whose pins must agree, e.g. `["@nats-io/nuid"]`; `fix` raises them to the highest pin |

## License

Apache-2.0
