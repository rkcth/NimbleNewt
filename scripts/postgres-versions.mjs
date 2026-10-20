// Runs the PostgreSQL suites of the controller storage against one embedded PostgreSQL major version and writes an evidence record
// (card F04g): `node scripts/postgres-versions.mjs <14|15|16|17|18> [--out=<dir>]`, after `npm run build`.
//
// Each major version has its own pinned install (scripts/postgres-versions/<major>/package.json and package-lock.json, exact versions with
// integrity hashes, installed with `npm ci --ignore-scripts` into that folder only). The suites use the server it provides through
// NIMBLENEWT_TEST_POSTGRES_DIR. Supported versions (17 and above, the owner's decision of 2026-10-20) must pass or the script exits 1.
// Older majors are run with the adapter's version floor lowered (postgres/testing/older-servers.ts) and their results are reported,
// never counted as support: the script exits 0 for them whatever the outcome.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTotals } from "./qa.mjs";

export const MAJORS = [14, 15, 16, 17, 18];
export const SUPPORTED_FROM = 17;
const TESTS = [
  "storage/postgres/postgres.test.js", "storage/postgres/qualification.test.js", "storage/postgres/migration.test.js", "storage/postgres/fixtures.test.js",
  "storage/parity.test.js", "storage/workload.test.js",
];

/** Names of failing tests in Node's spec output (`✖ name (12ms)`) or TAP output (`not ok 3 - name`), each once, at most 20. */
export function failingNames(log) {
  const spec = [...log.matchAll(/^\s*✖ (.+?) \(\d[\d.]*ms\)\s*$/gm)].map((m) => m[1]);
  const tap = [...log.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((m) => m[1]);
  return [...spec, ...tap].filter((name, i, all) => all.indexOf(name) === i).slice(0, 20);
}

/** The major version in a server version string such as "17.10", or undefined. */
export const majorOf = (serverVersion) => { const m = /^(\d+)\./.exec(String(serverVersion).trim()); return m === null ? undefined : Number(m[1]); };

/** Why a probe result cannot be trusted as evidence for the requested major, or undefined when it can. */
export function probeProblem(major, serverVersion) {
  const found = majorOf(serverVersion);
  if (found === undefined) return `could not read the version of the server under test (${String(serverVersion).slice(0, 200)})`;
  return found === major ? undefined : `the server under test is PostgreSQL ${found}, not the requested ${major}`;
}

/** The line of the evidence table for one major version. */
export function verdict(major, totals, exitCode) {
  const passed = exitCode === 0 && totals.tests > 0 && totals.fail === 0 && totals.cancelled === 0;
  return { passed, supported: major >= SUPPORTED_FROM, label: passed ? "passed" : "FAILED" };
}

function run(command, args, options) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

export async function main(argv) {
  const major = Number(argv.find((a) => /^\d+$/.test(a)));
  if (!MAJORS.includes(major)) { console.error(`usage: node scripts/postgres-versions.mjs <${MAJORS.join("|")}> [--out=<dir>]`); return 2; }
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outFlag = argv.find((a) => a.startsWith("--out="));
  const outDir = resolve(outFlag === undefined ? join(root, "pg-versions-output") : outFlag.slice("--out=".length));
  mkdirSync(outDir, { recursive: true });
  const installDir = join(root, "scripts", "postgres-versions", String(major));

  const install = run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installDir, shell: true });
  if (install.status !== 0) { console.error(`npm ci failed for PostgreSQL ${major}:\n${install.stdout}\n${install.stderr}`); return 2; }

  const controller = join(root, "packages", "controller");
  // Never let an externally supplied server stand in for the pinned one: the evidence must come from the install for this major.
  const { NIMBLENEWT_TEST_POSTGRES_URL: _external, ...inherited } = process.env;
  const env = {
    ...inherited,
    NIMBLENEWT_TEST_POSTGRES_DIR: installDir,
    ...(major < SUPPORTED_FROM ? { NIMBLENEWT_QUALIFY_PG_FLOOR: "140000" } : {}),
  };
  // The server version actually under test, read from a running server rather than from the package name.
  const probe = run(process.execPath, ["--input-type=module", "-e",
    `const { startTestServer } = await import(${JSON.stringify(pathToFileURL(join(controller, "dist/storage/postgres/testing/server.js")).href)});` +
    "const s = await startTestServer(); console.log(await s.version()); await s.stop();"], { env, cwd: controller });
  const serverVersion = probe.status === 0 ? probe.stdout.trim().split("\n").pop() : `unknown (${(probe.stderr || "").slice(0, 200)})`;
  const untrusted = probeProblem(major, serverVersion);
  if (untrusted !== undefined) {
    // No suites are run and no evidence file claims a result: a run against the wrong server proves nothing about this major.
    console.error(`PostgreSQL ${major}: ${untrusted}; nothing was run`);
    return 2;
  }

  const guard = pathToFileURL(join(root, "scripts", "offline-guard.mjs")).href;
  const older = pathToFileURL(join(controller, "dist/storage/postgres/testing/older-servers.js")).href;
  const started = Date.now();
  const result = run(process.execPath, ["--import", guard, "--import", older, "--test", "--test-timeout=300000", ...TESTS.map((t) => join("dist", t))], { env, cwd: controller });
  const log = `${result.stdout}\n${result.stderr}`;
  writeFileSync(join(outDir, `pg${major}.log`), log);
  const totals = parseTotals(log);
  const v = verdict(major, totals, result.status ?? -1);
  const failing = failingNames(log);
  const record = {
    major, serverVersion, supported: v.supported, result: v.label, totals, seconds: Math.round((Date.now() - started) / 100) / 10,
    failing, machine: { os: `${os.type()} ${os.release()}`, arch: process.arch, node: process.version }, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim(),
    note: v.supported ? "supported major version: must pass" : "older major version: verified and reported only, not supported",
  };
  writeFileSync(join(outDir, `pg${major}-evidence.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(outDir, `pg${major}-summary.md`), [
    `### PostgreSQL ${major} (${serverVersion}) on ${record.machine.os} ${record.machine.arch}, Node ${record.machine.node}`, "",
    `**${v.label}** (${v.supported ? "supported major" : "older major: reported only, not supported"}): ${totals.pass} of ${totals.tests} tests passed, ${totals.fail} failed, ${totals.cancelled} cancelled, in ${record.seconds} s.`,
    ...(failing.length === 0 ? [] : ["", "Failing:", ...failing.map((f) => `- ${f}`)]), "",
  ].join("\n"));
  console.log(`PostgreSQL ${major} (${serverVersion}): ${v.label} - ${totals.pass}/${totals.tests} passed, ${totals.fail} failed${failing.length ? `\n  ${failing.join("\n  ")}` : ""}`);
  return v.supported && !v.passed ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
