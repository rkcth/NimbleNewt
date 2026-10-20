import os from "node:os";
import { OVERRIDE_ENV, OVERRIDE_FLAG, SUPPORTED_ENVIRONMENT, type PlatformSupport } from "./supported.js";

/** What the controller is running on. `postgresVersion` is the server's `server_version` string, when there is a PostgreSQL server. */
export interface EnvironmentFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `os.release()`. */
  readonly osRelease: string;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  readonly postgresVersion?: string;
}

export function detectEnvironment(extra: { postgresVersion?: string } = {}): EnvironmentFacts {
  return { platform: process.platform, arch: process.arch, osRelease: os.release(), nodeVersion: process.versions.node, ...(extra.postgresVersion === undefined ? {} : { postgresVersion: extra.postgresVersion }) };
}

export interface Problem {
  readonly item: "operating system" | "Node.js" | "PostgreSQL";
  readonly found: string;
  readonly supported: string;
  readonly howToTest: string;
}

const parts = (version: string): number[] => version.split(".").map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : 0));
/** Negative if a < b, 0 if equal, positive if a > b. Compares dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const platformList = (): string => SUPPORTED_ENVIRONMENT.platforms.map((p) => `${p.name}${p.releaseNote === undefined ? "" : ` (${p.releaseNote} or newer)`}`).join("; ");

const OS_TEST = "run `node scripts/qa.mjs --runs=5` from a checkout of this version, on this machine";
const NODE_TEST = OS_TEST;
const PG_TEST = (major: number): string => `run \`node scripts/postgres-versions.mjs ${major}\` from a checkout of this version (it starts a PostgreSQL ${major} server of its own and runs the PostgreSQL suites against it)`;

/** Everything about this environment that the supported list does not cover. Empty when it is covered. */
export function checkEnvironment(facts: EnvironmentFacts): Problem[] {
  const problems: Problem[] = [];
  const platform: PlatformSupport | undefined = SUPPORTED_ENVIRONMENT.platforms.find((p) => p.platform === facts.platform && p.arch === facts.arch);
  const release = facts.platform === "win32" ? parts(facts.osRelease)[2] ?? 0 : parts(facts.osRelease)[0] ?? 0;
  if (platform === undefined || (platform.minimumRelease !== undefined && release < platform.minimumRelease)) {
    problems.push({ item: "operating system", found: `${facts.platform} ${facts.arch}, release ${facts.osRelease}`, supported: platformList(), howToTest: OS_TEST });
  }
  if (compareVersions(facts.nodeVersion, SUPPORTED_ENVIRONMENT.node.minimum) < 0) {
    problems.push({ item: "Node.js", found: facts.nodeVersion, supported: `${SUPPORTED_ENVIRONMENT.node.minimum} or newer`, howToTest: NODE_TEST });
  }
  if (facts.postgresVersion !== undefined) {
    const major = parts(facts.postgresVersion)[0] ?? 0;
    if (major < SUPPORTED_ENVIRONMENT.postgres.minimumMajor) {
      problems.push({ item: "PostgreSQL", found: facts.postgresVersion, supported: `${SUPPORTED_ENVIRONMENT.postgres.minimumMajor} or newer`, howToTest: PG_TEST(major) });
    }
  }
  return problems;
}

/** The refusal an operator reads: what was found, what is supported, how to test their environment, and the exact override. */
export function refusalMessage(problems: readonly Problem[]): string {
  return [
    "NimbleNewt will not start: this environment is not one it has been tested on.",
    ...problems.map((p) => `  - ${p.item}: found ${p.found}; supported: ${p.supported}.`),
    "To find out whether it works in your environment, " + [...new Set(problems.map((p) => p.howToTest))].join(", and ") + ".",
    `If you have verified it and want to start anyway, pass ${OVERRIDE_FLAG} (or set ${OVERRIDE_ENV}=1). The override is recorded in the audit log and printed at every start.`,
  ].join("\n");
}

export class UnsupportedEnvironmentError extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(refusalMessage(problems));
    this.name = "UnsupportedEnvironmentError";
    this.problems = problems;
  }
}

/** True if the operator asked for the override, by the command-line flag or the environment variable. */
export function overrideRequested(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[OVERRIDE_ENV];
  return argv.includes(OVERRIDE_FLAG) || value === "1" || value?.toLowerCase() === "true";
}

export interface StartupCheck {
  readonly problems: readonly Problem[];
  readonly overridden: boolean;
  /** What to print at start: nothing when supported, a loud notice when overridden. */
  readonly output: readonly string[];
}

/**
 * The start-up decision. A covered environment passes silently. An uncovered one throws `UnsupportedEnvironmentError`, a hard stop (a
 * warning is easy to miss), unless the override was requested; then it passes with `overridden` set and an output notice, and
 * `recordOverride` writes the audit record. The override changes nothing else about how the controller behaves.
 */
export function startupCheck(facts: EnvironmentFacts, options: { allowUnsupported: boolean }): StartupCheck {
  const problems = checkEnvironment(facts);
  if (problems.length === 0) return { problems, overridden: false, output: [] };
  if (!options.allowUnsupported) throw new UnsupportedEnvironmentError(problems);
  return {
    problems, overridden: true,
    output: [`WARNING: starting in an unsupported environment because the override was given (${OVERRIDE_FLAG} or ${OVERRIDE_ENV}):`, ...problems.map((p) => `  - ${p.item}: found ${p.found}; supported: ${p.supported}.`), "Behaviour is otherwise unchanged. This is recorded in the audit log."],
  };
}
