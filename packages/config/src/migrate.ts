import { CURRENT_CONFIG_VERSION } from "./config.js";
import { MAX_DEPTH, tooDeep, type ConfigError } from "./schema.js";

/** One step from layout `from` to layout `to` (always `from + 1`). Must be pure: it returns a new document and never edits its input. */
export interface ConfigMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (document: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The migrations from older layouts to the current one. There are none yet: the current layout is the first. A future
 * layout change adds a step here, with a fixture of a real document in the old layout.
 */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [];

export type MigrationResult =
  | { readonly ok: true; readonly document: Record<string, unknown>; readonly fromVersion: number; readonly steps: number }
  | { readonly ok: false; readonly errors: ConfigError[] };

/**
 * Brings a document up to the current layout one step at a time. Pure: the input is never modified, so a document that
 * cannot be migrated, or whose migration throws, is left exactly as it was. A layout newer than this build understands is
 * refused rather than guessed at.
 */
export function migrateConfig(input: unknown, migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS, current = CURRENT_CONFIG_VERSION): MigrationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: [{ path: "", message: "the configuration must be an object" }] };
  if (tooDeep(input)) return { ok: false, errors: [{ path: "", message: `the configuration is nested more than ${MAX_DEPTH} levels deep and is refused` }] };
  const version = (input as Record<string, unknown>).configVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, errors: [{ path: "configVersion", message: `missing or invalid; expected a whole number from 1 to ${current}, found ${typeof version === "number" ? String(version) : `a ${typeof version}`}` }] };
  }
  if (version > current) {
    return { ok: false, errors: [{ path: "configVersion", message: `is ${version}, newer than this version of NimbleNewt understands (${current}); upgrade NimbleNewt or use a configuration written for this version` }] };
  }
  let document = structuredClone(input) as Record<string, unknown>;
  let at = version;
  let steps = 0;
  while (at < current) {
    const step = migrations.find((m) => m.from === at);
    if (step === undefined) return { ok: false, errors: [{ path: "configVersion", message: `no migration from configuration version ${at} to ${at + 1} exists, so version ${version} cannot be upgraded` }] };
    try {
      document = { ...step.migrate(structuredClone(document)), configVersion: step.to };
    } catch (error) {
      return { ok: false, errors: [{ path: "configVersion", message: `the migration from version ${at} to ${step.to} failed (${error instanceof Error ? error.message : String(error)}); the original document was not changed` }] };
    }
    at = step.to;
    steps += 1;
  }
  return { ok: true, document, fromVersion: version, steps };
}
