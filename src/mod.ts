/**
 * mrvm: monorepo version manager. Checks, fixes and bumps the versions of a
 * deno/npm workspace, and the pins between its modules.
 *
 * Run it with `deno run -A jsr:@aricart/mrvm/cli` or `npx @aricart/mrvm`.
 * This module exposes the same operations as functions.
 *
 * @module
 */

export { bump, check, fix, type Io, ls } from "./commands.ts";
export type {
  BumpCliOptions,
  CommonOptions,
  LsOptions,
  WriteOptions,
} from "./commands.ts";
export { type BumpOptions, type BumpPlan, type Mode, modeOf, planBump } from "./bump.ts";
export {
  type Change,
  currentTargets,
  formatChanges,
  planChanges,
  validate,
  verify,
} from "./plan.ts";
export {
  type Config,
  loadWorkspace,
  type Module,
  type Pin,
  type Workspace,
} from "./workspace.ts";
export { commitLevel, type Level, suggest, type Suggestion } from "./suggest.ts";
export {
  compare,
  format,
  increment,
  parse,
  type ReleaseType,
  releaseTypes,
  type SemVer,
} from "./semver.ts";
