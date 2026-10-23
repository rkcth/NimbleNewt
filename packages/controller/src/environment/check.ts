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
  /** What is wrong: "operating system", "Node.js", "PostgreSQL", "filesystem (data directory)", "git", ... */
  readonly item: string;
  readonly found: string;
  readonly supported: string;
  /** How to run the project's own verification in this environment (F04h, F04i). Absent for a missing prerequisite, which has `howToFix` instead. */
  readonly howToTest?: string;
  /** How to install or enable what is missing (F04j). */
  readonly howToFix?: string;
  /** False for a missing hard prerequisite: no switch overrides it, because the feature cannot run without it. Absent or true: the override covers it. */
  readonly overridable?: boolean;
  /** What the override means for this problem, when it is more than "start anyway". */
  readonly overrideMeans?: string;
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

const isHard = (p: Problem): boolean => p.overridable === false;
/** One line about one problem, as printed in a refusal and in the override notice. */
export function problemLine(p: Problem): string {
  return `  - ${p.item}: found ${p.found}; ${isHard(p) ? "required" : "supported"}: ${p.supported}.${p.howToFix === undefined ? "" : ` To fix: ${p.howToFix}.`}${isHard(p) ? " This cannot be overridden, because the feature cannot run without it." : ""}`;
}

/**
 * The refusal an operator reads: what was found, what is supported, how to test their environment (or how to install what is missing), and the exact override, which every
 * problem that can be overridden is covered by. A problem that cannot be overridden says so on its own line. `host` is the one line that records the distribution, for information only.
 */
export function refusalMessage(problems: readonly Problem[], host?: string, switchGiven = false): string {
  const hard = problems.filter(isHard), soft = problems.filter((p) => !isHard(p));
  const headline = soft.length === 0 ? "something it needs is missing or unusable." : hard.length === 0 ? "this environment is not one it has been tested on." : "this environment is not one it has been tested on, and something it needs is missing or unusable.";
  const tests = [...new Set(soft.flatMap((p) => (p.howToTest === undefined ? [] : [p.howToTest])))];
  return [
    `NimbleNewt will not start: ${headline}`,
    ...problems.map(problemLine),
    ...(tests.length === 0 ? [] : ["To find out whether it works in your environment, " + tests.join(", and ") + "."]),
    ...(switchGiven && hard.length > 0 ? [`${OVERRIDE_FLAG} (or ${OVERRIDE_ENV}) was given, but it does not cover the items marked "cannot be overridden": fix those and start again.`] : []),
    ...(soft.length === 0 ? [] : [`If you have verified it and want to start anyway, pass ${OVERRIDE_FLAG} (or set ${OVERRIDE_ENV}=1)${hard.length === 0 ? "" : ` to override the problems that can be overridden (the ones marked "cannot be overridden" must be fixed first)`}. The override is recorded in the audit log and printed at every start.`]),
    ...soft.flatMap((p) => (p.overrideMeans === undefined ? [] : [`Overriding ${p.item} means: ${p.overrideMeans}.`])),
    ...(host === undefined ? [] : [host]),
  ].join("\n");
}

export class UnsupportedEnvironmentError extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[], host?: string, switchGiven = false) {
    super(refusalMessage(problems, host, switchGiven));
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
  /** The distribution line, recorded in the audit record of an override and in the notice; nothing depends on it. */
  readonly host?: string;
}

/**
 * The start-up decision. A covered environment passes silently. An uncovered one throws `UnsupportedEnvironmentError`, a hard stop (a
 * warning is easy to miss), unless the override was requested; then it passes with `overridden` set and an output notice, and
 * `recordOverride` writes the audit record. The override changes nothing else about how the controller behaves.
 */
export function startupCheck(facts: EnvironmentFacts, options: { allowUnsupported: boolean }): StartupCheck {
  return decideStartup(checkEnvironment(facts), options);
}

/**
 * The one decision over every problem found (operating system, Node.js, file systems, prerequisites; the PostgreSQL server joins later through `overriddenCheck`). A problem that cannot be
 * overridden is a refusal whatever the switch says; the rest are refused unless the switch was given.
 */
export function decideStartup(problems: readonly Problem[], options: { allowUnsupported: boolean; host?: string }): StartupCheck {
  if (problems.length === 0) return { problems, overridden: false, output: [] };
  if (problems.some(isHard) || !options.allowUnsupported) throw new UnsupportedEnvironmentError(problems, options.host, options.allowUnsupported);
  return overriddenCheck(problems, options.host);
}

/** The result of starting with the override for these problems: the loud notice, and the problems to audit. */
export function overriddenCheck(problems: readonly Problem[], host?: string): StartupCheck {
  return {
    problems, overridden: true, ...(host === undefined ? {} : { host }),
    output: [`WARNING: starting in an unsupported environment because the override was given (${OVERRIDE_FLAG} or ${OVERRIDE_ENV}):`, ...problems.map(problemLine), ...problems.flatMap((p) => (p.overrideMeans === undefined ? [] : [`Overriding ${p.item} means: ${p.overrideMeans}.`])), ...(host === undefined ? [] : [host]), "Behaviour is otherwise unchanged. This is recorded in the audit log."],
  };
}
