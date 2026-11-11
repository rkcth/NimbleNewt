// Card Y02 (QA checkpoint 2: isolation, stop and recovery): the automated part, and the gate that judges the whole checkpoint.
//   node scripts/y02-checkpoint.mjs run    --out DIR                         run the scenario set here, write DIR/y02-scenarios-<platform>.json
//   node scripts/y02-checkpoint.mjs digest --dir DIR --platform P            print the evidence digest an owner's sign-off must quote
//   node scripts/y02-checkpoint.mjs gate   --dir DIR --commit SHA [--now ISO] [--out FILE]
//                                                                           judge DIR, print every blocker, write a deterministic verdict file
// The gate reads, per platform (linux, darwin, win32): containment-<p>.json (card G05), y02-scenarios-<p>.json (`run`),
// qa-evidence-<p>.json (scripts/qa.mjs), plus ci-runs.json (CI run ids) and y02-signoff.json (the owner's real-hardware sign-off or
// recorded waiver). Exit 0: complete; 1: something blocks; 2: bad usage. It uses no network, no secrets, and changes nothing but the
// verdict file the caller names. Everything it reads is data: size-bounded, strictly parsed (duplicate keys, control and direction
// characters refused), bound to the commit under judgement, fresh, and from a clean tree.
// What it cannot prove is listed in every verdict under `notVerified`: a file is self-attested, so the gate proves consistency, not that
// a run happened.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLATFORMS = ["linux", "darwin", "win32"];
export const SCENARIO_SCHEMA = "nimblenewt.y02-scenarios/1";
export const VERDICT_SCHEMA = "nimblenewt.y02-verdict/1";
export const CI_SCHEMA = "nimblenewt.y02-ci-runs/1";
export const SIGNOFF_SCHEMA = "nimblenewt.y02-signoff/1";
export const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const FUTURE_SLACK_MS = 5 * 60 * 1000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_QA_BYTES = 4 * 1024 * 1024;
export const MIN_QA_RUNS = 5;
/** The workflows whose success per platform the gate wants a run id for. */
export const REQUIRED_CI_WORKFLOWS = ["exhaustive", "qa"];
const OS_TYPE = { linux: "Linux", darwin: "Darwin", win32: "Windows_NT" };
const COMMIT = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Control, format (direction overrides, zero-width), line and paragraph separators and lone surrogates: none may reach a terminal or a log line. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const SCENARIO_FILE = /^[a-z][a-z-]*\/[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;
const SCENARIO_ID = /^[a-z][a-z0-9-]{0,63}$/;

// ----------------------------------------------------------------------------------------------------------------------------------
// Strict reading

/** A short, safe rendering of any text for a message: escaped, bounded. */
export function show(text, max = 80) {
  const s = String(text);
  let out = "";
  for (const ch of s) {
    out += UNPRINTABLE.test(ch) ? `\\u{${ch.codePointAt(0).toString(16)}}` : ch;
    if (out.length >= max) return `${out.slice(0, max)}...`;
  }
  return out;
}

/** JSON.parse silently keeps the last of two equal keys and accepts a leading BOM through some readers; this parser refuses both, and `__proto__`. Throws Error with a plain message. */
export function parseStrictJson(text, { maxDepth = 12, maxNodes = 50_000 } = {}) {
  if (typeof text !== "string") throw new Error("not text");
  if (text.charCodeAt(0) === 0xfeff) throw new Error("a byte-order mark is not allowed");
  let i = 0;
  let nodes = 0;
  const fail = (why) => { throw new Error(`${why} at position ${i}`); };
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const string = () => {
    if (text[i] !== '"') fail("a string was expected");
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("an unterminated string");
      const c = text[i];
      const code = text.charCodeAt(i);
      if (c === '"') { i++; return out; }
      if (code < 0x20) fail("a raw control character in a string");
      if (c === "\\") {
        const e = text[i + 1];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
        if (simple !== undefined) { out += simple; i += 2; continue; }
        if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
        fail("a bad escape");
      }
      out += c;
      i++;
    }
  };
  const value = (depth) => {
    if (depth > maxDepth) fail("nested too deeply");
    if (++nodes > maxNodes) fail("too many values");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        ws();
        const key = string();
        if (key === "__proto__") fail("the key __proto__ is not allowed");
        if (seen.has(key)) fail(`the key "${show(key, 30)}" appears twice`);
        seen.add(key);
        ws();
        if (text[i] !== ":") fail("a colon was expected");
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return obj; }
        fail("a comma or } was expected");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      ws();
      if (text[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("a comma or ] was expected");
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]]) if (text.startsWith(word, i)) { i += word.length; return v; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (m === null) fail("a value was expected");
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail("a number out of range");
    return n;
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail("text after the value");
  return result;
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const printable = (v, max = 200) => typeof v === "string" && v.length <= max && !UNPRINTABLE.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
const sameKeys = (o, keys) => isObject(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** An ISO 8601 instant with a real calendar date; returns milliseconds or NaN. `Date.parse` alone rolls 31 February over to March. */
export function isoMillis(s) {
  if (typeof s !== "string" || s.length > 40) return NaN;
  const m = ISO_TIME.exec(s);
  if (m === null) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > dim || hour > 23 || minute > 59 || second > 59) return NaN;
  if (m[8] !== "Z" && (Number(m[8].slice(1, 3)) > 23 || Number(m[8].slice(4, 6)) > 59)) return NaN;
  return Date.parse(s);
}

/** Why a time is not acceptable evidence at `now`, or undefined when it is. */
export function staleness(iso, now, what) {
  const t = isoMillis(iso);
  if (!Number.isFinite(t)) return `${what}: not a valid ISO time`;
  const age = now - t;
  if (age < -FUTURE_SLACK_MS) return `${what}: dated in the future`;
  if (age > MAX_EVIDENCE_AGE_MS) return `${what}: more than 30 days old`;
  return undefined;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// ----------------------------------------------------------------------------------------------------------------------------------
// The scenario map

/** Reads the map as data and refuses anything vacuous or malformed. Returns { map, digest } or { error }. */
export function parseScenarioMap(raw) {
  let v;
  try { v = parseStrictJson(raw); } catch (e) { return { error: `the scenario map is not strict JSON: ${show(e.message)}` }; }
  if (!sameKeys(v, ["schema", "note", "scenarios"]) || v.schema !== SCENARIO_SCHEMA || !printable(v.note, 2000)) return { error: "the scenario map: schema, note, scenarios" };
  if (!Array.isArray(v.scenarios) || v.scenarios.length === 0 || v.scenarios.length > 64) return { error: "the scenario map needs between 1 and 64 scenarios (an empty set proves nothing)" };
  const ids = new Set();
  for (const s of v.scenarios) {
    if (!sameKeys(s, ["id", "title", "clause", "platforms", "files", "platformFiles", "minTests"])) return { error: "a scenario needs id, title, clause, platforms, files, platformFiles, minTests" };
    if (typeof s.id !== "string" || !SCENARIO_ID.test(s.id) || ids.has(s.id)) return { error: `scenario id ${show(s.id, 30)}: lower-case words, unique` };
    ids.add(s.id);
    if (!printable(s.title) || !printable(s.clause)) return { error: `scenario ${s.id}: title and clause must be short printable text` };
    if (!Array.isArray(s.platforms) || s.platforms.length === 0 || new Set(s.platforms).size !== s.platforms.length || !s.platforms.every((p) => PLATFORMS.includes(p))) return { error: `scenario ${s.id}: platforms must be a non-empty list of linux, darwin, win32` };
    if (!Array.isArray(s.files) || s.files.length === 0 || !isObject(s.platformFiles)) return { error: `scenario ${s.id}: files must be a non-empty list` };
    if (!Number.isSafeInteger(s.minTests) || s.minTests < 1 || s.minTests > 100_000) return { error: `scenario ${s.id}: minTests must be at least 1` };
    const all = [...s.files];
    for (const [p, list] of Object.entries(s.platformFiles)) {
      if (!PLATFORMS.includes(p) || !Array.isArray(list) || list.length === 0) return { error: `scenario ${s.id}: platformFiles keys are platforms with non-empty lists` };
      all.push(...list);
    }
    for (const f of all) if (typeof f !== "string" || !SCENARIO_FILE.test(f) || f.includes("..") || f.includes("//")) return { error: `scenario ${s.id}: file ${show(f, 60)} is not a package/path name` };
    if (new Set(all).size !== all.length) return { error: `scenario ${s.id}: a file is listed twice` };
  }
  return { map: v, digest: sha256(raw) };
}

/** The compiled test files a scenario needs on one platform, in a fixed order, or undefined when it does not apply there. */
export function filesFor(scenario, platform) {
  if (!scenario.platforms.includes(platform)) return undefined;
  return [...scenario.files, ...(scenario.platformFiles[platform] ?? [])];
}

/** Scenario ids and file lists a report for `platform` must contain, in map order. */
export function expectedScenarios(map, platform) {
  return map.scenarios.flatMap((s) => { const files = filesFor(s, platform); return files === undefined ? [] : [{ id: s.id, files, minTests: s.minTests }]; });
}

// ----------------------------------------------------------------------------------------------------------------------------------
// Running the scenarios (the producing side)

/** Reads the summary the TAP reporter prints last. Exactly one summary block, in order, as the final lines; anything else is refused (a test printing a fake summary cannot add to the real one). */
export function parseTapSummary(output) {
  const lines = output.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const names = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
  const tail = lines.slice(-8);
  const totals = {};
  for (let k = 0; k < names.length; k++) {
    const m = new RegExp(`^# ${names[k]} (\\d{1,9})$`).exec(tail[k] ?? "");
    if (m === null) return { error: "the test runner's summary was not found at the end of its output" };
    totals[names[k]] = Number(m[1]);
  }
  if (!/^# duration_ms \d+(\.\d+)?$/.test(tail[7] ?? "")) return { error: "the test runner's summary was not found at the end of its output" };
  for (const n of names) if (lines.filter((l) => l.startsWith(`# ${n} `) && /^# [a-z]+ \d+$/.test(l)).length !== 1) return { error: `the output holds more than one "# ${n}" line` };
  return { totals };
}

/** Whether counted totals satisfy a scenario's floor and have no failure, cancellation, skip or todo. */
export function judgeTotals(t, minTests) {
  const problems = [];
  if (t.tests < minTests) problems.push(`${t.tests} tests ran, at least ${minTests} are required`);
  if (t.pass !== t.tests) problems.push(`${t.pass} of ${t.tests} tests passed`);
  if (t.fail !== 0) problems.push(`${t.fail} failed`);
  if (t.cancelled !== 0) problems.push(`${t.cancelled} cancelled`);
  if (t.skipped !== 0) problems.push(`${t.skipped} skipped (a skipped test is not evidence)`);
  if (t.todo !== 0) problems.push(`${t.todo} marked todo`);
  return problems;
}

const git = (args, cwd) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : ""; };

/** Runs every applicable scenario with the real test runner under the offline guard and a required sandbox. `exec(cwd, files, env)` is injectable for tests. */
export function runScenarios({ root, map, mapDigest, platform, now, exec = defaultExec, getHead = () => git(["rev-parse", "HEAD"], root), getStatus = () => git(["status", "--porcelain"], root), log = () => {} }) {
  const commit = getHead();
  const dirtyBefore = getStatus() !== "";
  const scenarios = [];
  for (const s of expectedScenarios(map, platform)) {
    const totals = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
    const problems = [];
    const byPackage = new Map();
    for (const f of s.files) { const [pkg, ...rest] = f.split("/"); byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), `dist/${rest.join("/")}.test.js`]); }
    for (const [pkg, files] of byPackage) {
      const cwd = join(root, "packages", pkg);
      const missing = files.filter((f) => !isRegularFile(join(cwd, f)));
      if (missing.length > 0) { problems.push(`${pkg}: compiled test file missing: ${missing.map((m) => show(m, 60)).join(", ")}`); continue; }
      const r = exec(cwd, files);
      if (r.status !== 0) problems.push(`${pkg}: the test run exited with ${r.status ?? "a signal"}`);
      const parsed = parseTapSummary(r.output);
      if ("error" in parsed) { problems.push(`${pkg}: ${parsed.error}`); continue; }
      for (const k of Object.keys(totals)) totals[k] += parsed.totals[k];
    }
    problems.push(...judgeTotals(totals, s.minTests));
    log(`${s.id}: ${problems.length === 0 ? "pass" : `FAIL (${problems.join("; ")})`} (${totals.pass}/${totals.tests})`);
    scenarios.push({ id: s.id, files: s.files, status: problems.length === 0 ? "pass" : "fail", tests: totals.tests, pass: totals.pass, fail: totals.fail, cancelled: totals.cancelled, skipped: totals.skipped, todo: totals.todo });
  }
  // The tests must not have changed the checkout they are evidence about.
  const dirty = dirtyBefore || getStatus() !== "" || getHead() !== commit;
  return { schema: SCENARIO_SCHEMA, platform, osType: os.type(), arch: os.arch(), node: process.version, commit, dirty, generatedAt: new Date(now).toISOString(), requireSandbox: true, mapDigest, scenarios };
}

function isRegularFile(p) { try { return lstatSync(p).isFile(); } catch { return false; } }

function defaultExec(cwd, files) {
  const guard = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;
  const r = spawnSync(process.execPath, ["--import", guard, "--test", "--test-reporter=tap", "--test-timeout=600000", ...files], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NIMBLENEWT_REQUIRE_SANDBOX: "1" } });
  return { status: r.status, output: r.stdout ?? "" };
}

// ----------------------------------------------------------------------------------------------------------------------------------
// Parsing the evidence the gate reads

/** A scenario report: exact shape, then consistency of every figure. Returns { report } or { error }. */
export function parseScenarioReport(raw) {
  let v;
  try { v = parseStrictJson(raw); } catch (e) { return { error: `not strict JSON: ${show(e.message)}` }; }
  if (!sameKeys(v, ["schema", "platform", "osType", "arch", "node", "commit", "dirty", "generatedAt", "requireSandbox", "mapDigest", "scenarios"]) || v.schema !== SCENARIO_SCHEMA) return { error: "not a Y02 scenario report (schema and keys)" };
  if (!PLATFORMS.includes(v.platform)) return { error: "platform: linux, darwin or win32" };
  if (!printable(v.osType, 40) || !printable(v.arch, 40) || !printable(v.node, 40)) return { error: "osType, arch, node: short printable text" };
  if (typeof v.commit !== "string" || !COMMIT.test(v.commit)) return { error: "commit: 40 hex digits" };
  if (typeof v.dirty !== "boolean" || typeof v.requireSandbox !== "boolean") return { error: "dirty and requireSandbox: true or false" };
  if (!Number.isFinite(isoMillis(v.generatedAt))) return { error: "generatedAt: an ISO time" };
  if (typeof v.mapDigest !== "string" || !HEX64.test(v.mapDigest)) return { error: "mapDigest: 64 hex digits" };
  if (!Array.isArray(v.scenarios) || v.scenarios.length > 64) return { error: "scenarios: a list of at most 64" };
  for (const s of v.scenarios) {
    if (!sameKeys(s, ["id", "files", "status", "tests", "pass", "fail", "cancelled", "skipped", "todo"]) || typeof s.id !== "string" || !SCENARIO_ID.test(s.id)) return { error: "a scenario entry needs id, files, status and the six counts" };
    if (!Array.isArray(s.files) || s.files.length > 64 || !s.files.every((f) => typeof f === "string" && SCENARIO_FILE.test(f))) return { error: `scenario ${s.id}: files` };
    if (s.status !== "pass" && s.status !== "fail") return { error: `scenario ${s.id}: status is pass or fail` };
    for (const k of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) if (!count(s[k])) return { error: `scenario ${s.id}: ${k} must be a whole number` };
  }
  return { report: v };
}

/** A copy of scripts/qa.mjs's qa-evidence.json, reduced to what the gate relies on. Extra fields (log tails with terminal colours) are neither read nor printed. */
export function parseQaEvidence(raw) {
  let v;
  try { v = parseStrictJson(raw, { maxNodes: 200_000, maxDepth: 12 }); } catch (e) { return { error: `not strict JSON: ${show(e.message)}` }; }
  if (!isObject(v) || typeof v.commit !== "string" || !COMMIT.test(v.commit)) return { error: "commit: 40 hex digits" };
  if (typeof v.passed !== "boolean" || !Number.isFinite(isoMillis(v.startedAt)) || !Number.isSafeInteger(v.requestedRuns)) return { error: "passed, startedAt and requestedRuns" };
  const env = v.environment;
  if (!isObject(env) || !PLATFORMS.includes(env.platform) || !printable(env.os, 100) || !printable(env.node, 40) || typeof env.workingTreeClean !== "boolean") return { error: "environment: platform, os, node, workingTreeClean" };
  if (!Array.isArray(v.crossRunProblems) || !Array.isArray(v.runs) || v.runs.length > 50) return { error: "runs and crossRunProblems: lists" };
  const runs = [];
  for (const r of v.runs) {
    if (!isObject(r) || typeof r.passed !== "boolean" || !isObject(r.totals) || !Array.isArray(r.problems)) return { error: "a run needs passed, totals and problems" };
    for (const k of ["tests", "pass", "fail", "cancelled", "blocks"]) if (!count(r.totals[k])) return { error: `a run's totals.${k} must be a whole number` };
    runs.push({ passed: r.passed, problems: r.problems.length, tests: r.totals.tests, pass: r.totals.pass, fail: r.totals.fail, cancelled: r.totals.cancelled, blocks: r.totals.blocks });
  }
  return { qa: { commit: v.commit, passed: v.passed, startedAt: v.startedAt, requestedRuns: v.requestedRuns, platform: env.platform, os: env.os, node: env.node, workingTreeClean: env.workingTreeClean, crossRunProblems: v.crossRunProblems.length, runs } };
}

export function parseCiRuns(raw) {
  let v;
  try { v = parseStrictJson(raw); } catch (e) { return { error: `not strict JSON: ${show(e.message)}` }; }
  if (!sameKeys(v, ["schema", "commit", "runs"]) || v.schema !== CI_SCHEMA || typeof v.commit !== "string" || !COMMIT.test(v.commit)) return { error: "ci runs: schema, commit (40 hex digits), runs" };
  if (!Array.isArray(v.runs) || v.runs.length > 64) return { error: "runs: a list of at most 64" };
  for (const r of v.runs) {
    if (!sameKeys(r, ["platform", "workflow", "runId", "conclusion", "commit", "completedAt"]) || !PLATFORMS.includes(r.platform)) return { error: "a CI run needs platform, workflow, runId, conclusion, commit, completedAt" };
    if (!printable(r.workflow, 40) || typeof r.runId !== "string" || !RUN_ID.test(r.runId) || !printable(r.conclusion, 40) || typeof r.commit !== "string" || !COMMIT.test(r.commit) || !Number.isFinite(isoMillis(r.completedAt))) return { error: `a CI run's workflow, runId (digits), conclusion, commit or completedAt is malformed` };
  }
  return { ci: v };
}

export function parseSignoff(raw) {
  let v;
  try { v = parseStrictJson(raw); } catch (e) { return { error: `not strict JSON: ${show(e.message)}` }; }
  if (!sameKeys(v, ["schema", "commit", "entries"]) || v.schema !== SIGNOFF_SCHEMA || typeof v.commit !== "string" || !COMMIT.test(v.commit)) return { error: "sign-off: schema, commit (40 hex digits), entries" };
  if (!Array.isArray(v.entries) || v.entries.length > 16) return { error: "entries: a list of at most 16" };
  for (const e of v.entries) {
    if (!isObject(e) || !PLATFORMS.includes(e.platform) || (e.kind !== "signed" && e.kind !== "waived")) return { error: "an entry needs a platform and kind signed or waived" };
    const keys = e.kind === "signed" ? ["platform", "kind", "by", "at", "hardware", "evidenceDigest"] : ["platform", "kind", "by", "at", "reason", "evidenceDigest"];
    if (!sameKeys(e, keys) || !printable(e.by, 100) || e.by.trim() === "" || !Number.isFinite(isoMillis(e.at)) || typeof e.evidenceDigest !== "string" || !HEX64.test(e.evidenceDigest)) return { error: `the ${e.platform} entry: ${keys.join(", ")} (by and at present, evidenceDigest 64 hex digits)` };
    const text = e.kind === "signed" ? e.hardware : e.reason;
    if (!printable(text, 400) || text.trim().length < 10) return { error: `the ${e.platform} entry: ${e.kind === "signed" ? "hardware" : "reason"} must be at least 10 printable characters` };
  }
  return { signoff: v };
}

// ----------------------------------------------------------------------------------------------------------------------------------
// The directory

const EVIDENCE_PREFIX = /^(containment-|y02-scenarios-|qa-evidence-)/;

/** Names the gate reads, per platform and shared. */
export const evidenceNames = (platform) => ({ containment: `containment-${platform}.json`, scenarios: `y02-scenarios-${platform}.json`, qa: `qa-evidence-${platform}.json` });
export const SHARED_NAMES = { ci: "ci-runs.json", signoff: "y02-signoff.json" };

/** Reads one regular file without following a link, bounded. Returns { raw } or { error }. */
export function readBounded(path, maxBytes) {
  let fd;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) return { error: "is a symbolic link" };
    if (!before.isFile()) return { error: "is not a regular file" };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || (process.platform !== "win32" && (st.ino !== before.ino || st.dev !== before.dev))) return { error: "changed while being opened" };
    if (st.size > maxBytes) return { error: `is larger than ${maxBytes} bytes` };
    const buf = Buffer.alloc(st.size + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > maxBytes) return { error: `is larger than ${maxBytes} bytes` };
    const raw = buf.subarray(0, n).toString("utf8");
    if (raw.includes("�") && !Buffer.from(raw, "utf8").equals(buf.subarray(0, n))) return { error: "is not valid UTF-8" };
    return { raw };
  } catch (e) {
    return { error: e.code === "ENOENT" ? "is missing" : `cannot be read (${e.code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads the evidence directory: every expected file (raw text or why not) plus names that look like evidence but are not expected. */
export function readEvidenceDir(dir) {
  const files = {};
  const unexpected = [];
  let listing;
  try { listing = readdirSync(dir); } catch { return { files, unexpected, error: "the evidence directory cannot be read" }; }
  const expected = new Set([SHARED_NAMES.ci, SHARED_NAMES.signoff]);
  for (const p of PLATFORMS) for (const n of Object.values(evidenceNames(p))) expected.add(n);
  for (const name of [...expected].sort()) files[name] = readBounded(join(dir, name), name.startsWith("qa-evidence-") ? MAX_QA_BYTES : MAX_FILE_BYTES);
  for (const name of listing.sort()) if (!expected.has(name) && EVIDENCE_PREFIX.test(name)) unexpected.push(name);
  return { files, unexpected };
}

/** The digest an owner's sign-off for `platform` quotes: it covers every file the verdict for that platform rests on. A changed or replaced file changes it. */
export function evidenceDigest(files, platform) {
  const names = [...Object.values(evidenceNames(platform)), SHARED_NAMES.ci];
  const lines = names.map((n) => `${n} ${files[n]?.raw === undefined ? "absent" : sha256(files[n].raw)}`);
  return sha256(`nimblenewt.y02-evidence/1\n${platform}\n${lines.join("\n")}\n`);
}

// ----------------------------------------------------------------------------------------------------------------------------------
// The gate

export const NOT_VERIFIED = [
  "evidence files are self-attested JSON (no signature): the gate proves they are consistent and bound to this commit, not that the runs happened",
  "CI run ids and conclusions are taken from ci-runs.json; the gate uses no network and does not look them up",
  "a sign-off or waiver names a person as text; the gate cannot tell who wrote it",
  "owner decisions per day and unrelated stalls (counted from the audit log) are not read by this gate",
  "macOS and Windows runs were not made on this host; their files are judged only as data",
];

/**
 * Judges one evidence directory. Pure: it reads only its arguments. `deps` carries the G05 functions (`parseReport`, `assessRelease`).
 * Returns the verdict, with every blocker named.
 */
export function assessCheckpoint({ files, unexpected = [], dirError }, { commit, now, map, mapDigest, deps }) {
  const blockers = [];
  const block = (platform, why) => blockers.push(platform === undefined ? why : `${platform}: ${why}`);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (typeof commit !== "string" || !COMMIT.test(commit)) return invalid("the release commit must be 40 hex digits");
  if (!Number.isFinite(nowMs)) return invalid("the gate's clock is not a valid time");
  if (dirError !== undefined) return invalid(dirError);
  for (const n of unexpected) block(undefined, `unexpected evidence file ${show(n, 60)} (exactly one file per platform and kind is read)`);

  const verdictPlatforms = {};
  const readNamed = (name, parser) => {
    const f = files[name];
    if (f === undefined || f.raw === undefined) return { problem: `${name} ${f?.error ?? "is missing"}` };
    const parsed = parser(f.raw);
    return "error" in parsed ? { problem: `${name}: ${parsed.error}` } : { parsed, raw: f.raw };
  };

  // Containment (G05): the existing gate, over every platform's report, by name.
  const reports = [];
  const containmentOk = {};
  for (const p of PLATFORMS) {
    const r = readNamed(evidenceNames(p).containment, (raw) => { try { parseStrictJson(raw); } catch (e) { return { error: `not strict JSON: ${show(e.message)}` }; } return deps.parseReport(raw); });
    if (r.problem !== undefined) { containmentOk[p] = false; block(p, r.problem); continue; }
    if (r.parsed.report.platform !== p) { containmentOk[p] = false; block(p, `${evidenceNames(p).containment} is a report for ${show(r.parsed.report.platform, 20)}`); continue; }
    reports.push(r.parsed.report);
    containmentOk[p] = true;
  }
  const g05 = reports.length === 0 ? { ok: false, blockers: [] } : deps.assessRelease(reports, { commit, now: new Date(nowMs), platforms: PLATFORMS.filter((p) => containmentOk[p]) });
  for (const b of g05.blockers) { block(undefined, `containment ${show(b, 300)}`); const p = PLATFORMS.find((x) => b.startsWith(`${x}:`)); if (p !== undefined) containmentOk[p] = false; }
  if (!g05.ok && g05.blockers.length === 0) for (const p of PLATFORMS) containmentOk[p] = false;

  // CI run ids and the sign-off are shared files.
  const ci = readNamed(SHARED_NAMES.ci, parseCiRuns);
  if (ci.problem !== undefined) block(undefined, ci.problem);
  else if (ci.parsed.ci.commit !== commit) block(undefined, `${SHARED_NAMES.ci} is for commit ${ci.parsed.ci.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);
  const so = readNamed(SHARED_NAMES.signoff, parseSignoff);
  if (so.problem !== undefined) block(undefined, so.problem);
  else if (so.parsed.signoff.commit !== commit) block(undefined, `${SHARED_NAMES.signoff} is for commit ${so.parsed.signoff.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);

  for (const p of PLATFORMS) {
    const status = { containment: containmentOk[p] ? "ok" : "blocked", scenarios: "blocked", qa: "blocked", ci: "blocked", hardware: "missing" };

    // Scenarios
    const sc = readNamed(evidenceNames(p).scenarios, parseScenarioReport);
    if (sc.problem !== undefined) block(p, sc.problem);
    else {
      const r = sc.parsed.report;
      const problems = [];
      if (r.platform !== p) problems.push(`the report is for ${show(r.platform, 20)}`);
      if (r.osType !== OS_TYPE[p]) problems.push(`the report was made on ${show(r.osType, 20)}, not ${OS_TYPE[p]}`);
      if (r.commit !== commit) problems.push(`the evidence is for commit ${r.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);
      if (r.dirty) problems.push("the evidence was produced from a working tree with uncommitted changes");
      if (!r.requireSandbox) problems.push("the run did not require the sandbox");
      const stale = staleness(r.generatedAt, nowMs, "the report"); if (stale !== undefined) problems.push(stale);
      if (r.mapDigest !== mapDigest) problems.push("the report was made from another version of the scenario map");
      const expected = expectedScenarios(map, p);
      const seen = new Set();
      for (const s of r.scenarios) { if (seen.has(s.id)) problems.push(`scenario ${s.id} appears twice`); seen.add(s.id); }
      for (const e of expected) {
        const s = r.scenarios.find((x) => x.id === e.id);
        if (s === undefined) { problems.push(`scenario ${e.id} is missing`); continue; }
        if (JSON.stringify(s.files) !== JSON.stringify(e.files)) problems.push(`scenario ${e.id}: ran other test files than the map names`);
        const why = judgeTotals(s, e.minTests);
        if (why.length > 0) problems.push(`scenario ${e.id}: ${why.join("; ")}`);
        if ((why.length === 0) !== (s.status === "pass")) problems.push(`scenario ${e.id}: its status contradicts its counts`);
      }
      for (const s of r.scenarios) if (!expected.some((e) => e.id === s.id)) problems.push(`scenario ${show(s.id, 40)} is not part of the set for this platform`);
      for (const w of problems) block(p, `scenarios: ${w}`);
      if (problems.length === 0) status.scenarios = "ok";
    }

    // QA evidence
    const qa = readNamed(evidenceNames(p).qa, parseQaEvidence);
    if (qa.problem !== undefined) block(p, qa.problem);
    else {
      const q = qa.parsed.qa;
      const problems = [];
      if (q.platform !== p) problems.push(`the record is for ${show(q.platform, 20)}`);
      if (!q.os.startsWith(OS_TYPE[p])) problems.push(`the record was made on ${show(q.os, 30)}, not ${OS_TYPE[p]}`);
      if (q.commit !== commit) problems.push(`the record is for commit ${q.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);
      if (!q.workingTreeClean) problems.push("the working tree was not clean when the QA run began");
      const stale = staleness(q.startedAt, nowMs, "the record"); if (stale !== undefined) problems.push(stale);
      if (q.requestedRuns < MIN_QA_RUNS) problems.push(`${q.requestedRuns} runs were requested, at least ${MIN_QA_RUNS} are required`);
      if (q.runs.length !== q.requestedRuns) problems.push(`${q.runs.length} runs are recorded for ${q.requestedRuns} requested`);
      if (q.runs.some((r) => !r.passed || r.problems > 0 || r.tests === 0 || r.pass !== r.tests || r.fail !== 0 || r.cancelled !== 0)) problems.push("a run did not pass cleanly");
      if (q.crossRunProblems > 0) problems.push("the runs were not consistent with each other");
      if (q.runs.some((r) => r.tests !== q.runs[0].tests || r.blocks !== q.runs[0].blocks)) problems.push("the runs ran different numbers of tests");
      if (!q.passed) problems.push("the record itself says it did not pass");
      for (const w of problems) block(p, `qa: ${w}`);
      if (problems.length === 0) status.qa = "ok";
    }

    // CI run ids
    if (ci.problem === undefined && ci.parsed.ci.commit === commit) {
      const problems = [];
      const mine = ci.parsed.ci.runs.filter((r) => r.platform === p);
      for (const wf of REQUIRED_CI_WORKFLOWS) {
        const ofWf = mine.filter((r) => r.workflow === wf);
        const ids = new Set();
        for (const r of ofWf) { if (ids.has(r.runId)) problems.push(`${wf} run ${r.runId} is listed twice`); ids.add(r.runId); }
        const good = ofWf.filter((r) => r.conclusion === "success" && r.commit === commit && staleness(r.completedAt, nowMs, "x") === undefined);
        if (ofWf.length === 0) problems.push(`no ${wf} run is recorded`);
        else if (ofWf.some((r) => r.commit !== commit)) problems.push(`a ${wf} run is for another commit`);
        else if (ofWf.some((r) => r.conclusion !== "success")) problems.push(`a recorded ${wf} run did not succeed (a failed run beside a good one is not hidden)`);
        else if (good.length !== ofWf.length) problems.push(`a ${wf} run is dated in the future or more than 30 days old`);
      }
      for (const w of problems) block(p, `ci: ${w}`);
      if (problems.length === 0) status.ci = "ok";
    }

    // Hardware sign-off or waiver, bound to the digest of what the signer saw.
    const digest = evidenceDigest(files, p);
    if (so.problem === undefined && so.parsed.signoff.commit === commit) {
      const mine = so.parsed.signoff.entries.filter((e) => e.platform === p);
      if (mine.length === 0) status.hardware = "missing";
      else if (mine.length > 1) { status.hardware = "blocked"; block(p, "hardware: more than one sign-off entry (exactly one is accepted)"); }
      else {
        const e = mine[0];
        const stale = staleness(e.at, nowMs, `the ${e.kind === "signed" ? "sign-off" : "waiver"}`);
        if (stale !== undefined) { status.hardware = "blocked"; block(p, `hardware: ${stale}`); }
        else if (e.evidenceDigest !== digest) { status.hardware = "blocked"; block(p, "hardware: the sign-off was made on other evidence than the files now present (its digest differs)"); }
        else status.hardware = e.kind;
      }
    }
    if (status.hardware === "missing") block(p, "hardware: no sign-off or recorded waiver by the owner");
    verdictPlatforms[p] = { ...status, evidenceDigest: digest };
  }

  const sorted = [...new Set(blockers)].sort();
  const automated = PLATFORMS.every((p) => ["containment", "scenarios", "qa", "ci"].every((k) => verdictPlatforms[p][k] === "ok"));
  const hardware = PLATFORMS.every((p) => verdictPlatforms[p].hardware === "signed" || verdictPlatforms[p].hardware === "waived");
  const complete = automated && hardware && sorted.length === 0;
  return {
    schema: VERDICT_SCHEMA, commit, evaluatedAt: new Date(nowMs).toISOString(), scenarioMapDigest: mapDigest, platforms: verdictPlatforms,
    automatedPart: automated ? "complete" : "incomplete", hardwarePart: hardware ? "complete" : "incomplete", complete, blockers: sorted, notVerified: NOT_VERIFIED,
  };

  function invalid(why) {
    return { schema: VERDICT_SCHEMA, commit: typeof commit === "string" && COMMIT.test(commit) ? commit : "invalid", evaluatedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : "invalid", scenarioMapDigest: mapDigest ?? "invalid", platforms: {}, automatedPart: "incomplete", hardwarePart: "incomplete", complete: false, blockers: [why], notVerified: NOT_VERIFIED };
  }
}

/** The verdict as the file will hold it: fixed key order, stable, one trailing newline. */
export const renderVerdict = (verdict) => `${JSON.stringify(verdict, null, 2)}\n`;

/** Writes through a temporary file and a rename, so a half-written verdict is never read as a verdict. Refuses to replace anything but a regular file. */
export function writeFileAtomic(path, text) {
  const target = resolve(path);
  try { const st = lstatSync(target); if (!st.isFile()) throw new Error(`${show(basename(target), 60)} exists and is not a regular file`); } catch (e) { if (e.code !== "ENOENT") throw e; }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, target);
}

// ----------------------------------------------------------------------------------------------------------------------------------
// The command line

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || flags.has(a) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) return undefined;
    flags.set(a, argv[++i]);
  }
  return flags;
}

export async function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);
  const usage = () => { io.err("usage: y02-checkpoint.mjs run --out DIR | digest --dir DIR --platform P | gate --dir DIR --commit SHA [--now ISO] [--out FILE]"); return 2; };
  if (flags === undefined) return usage();
  const allowed = { run: ["--out"], digest: ["--dir", "--platform"], gate: ["--dir", "--commit", "--now", "--out"] }[command];
  if (allowed === undefined || [...flags.keys()].some((k) => !allowed.includes(k))) return usage();
  const mapRaw = readBounded(join(root, "scripts", "y02-scenarios.json"), MAX_FILE_BYTES);
  if (mapRaw.raw === undefined) { io.err(`the scenario map ${mapRaw.error}`); return 2; }
  const parsedMap = parseScenarioMap(mapRaw.raw);
  if ("error" in parsedMap) { io.err(parsedMap.error); return 2; }

  if (command === "run") {
    const out = flags.get("--out");
    if (out === undefined) return usage();
    const platform = process.platform;
    if (!PLATFORMS.includes(platform)) { io.err(`${show(platform, 20)} is not a platform this checkpoint covers`); return 2; }
    try { const b = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--build"], { cwd: root, stdio: "inherit" }); if (b.status !== 0) throw new Error("build"); } catch { io.err("the build failed: no evidence is produced from code that does not compile"); return 1; }
    const report = runScenarios({ root, map: parsedMap.map, mapDigest: parsedMap.digest, platform, now: Date.now(), log: io.out });
    const file = join(resolve(out), `y02-scenarios-${platform}.json`);
    writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
    const bad = report.scenarios.filter((s) => s.status !== "pass");
    io.out(`${platform} commit ${report.commit.slice(0, 12)}${report.dirty ? " DIRTY" : ""}: ${report.scenarios.length - bad.length}/${report.scenarios.length} scenarios hold -> ${show(file, 200)}`);
    return bad.length === 0 && !report.dirty && COMMIT.test(report.commit) ? 0 : 1;
  }

  const dir = flags.get("--dir");
  if (dir === undefined) return usage();
  const dirContents = readEvidenceDir(resolve(dir));
  if (command === "digest") {
    const platform = flags.get("--platform");
    if (!PLATFORMS.includes(platform)) return usage();
    io.out(evidenceDigest(dirContents.files, platform));
    return 0;
  }
  const commit = flags.get("--commit");
  if (commit === undefined) return usage();
  let now = new Date();
  if (flags.has("--now")) { const t = isoMillis(flags.get("--now")); if (!Number.isFinite(t)) return usage(); now = new Date(t); }
  const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);
  const verdict = assessCheckpoint({ ...dirContents, dirError: dirContents.error }, { commit, now, map: parsedMap.map, mapDigest: parsedMap.digest, deps: { parseReport: worker.parseReport, assessRelease: worker.assessRelease } });
  for (const b of verdict.blockers) io.out(`blocked: ${show(b, 400)}`);
  io.out(verdict.complete ? "Y02 checkpoint evidence complete for this commit" : `Y02 checkpoint incomplete: automated part ${verdict.automatedPart}, hardware part ${verdict.hardwarePart}`);
  if (flags.has("--out")) { try { writeFileAtomic(flags.get("--out"), renderVerdict(verdict)); } catch (e) { io.err(`the verdict file could not be written: ${show(e.message, 200)}`); return 2; } }
  return verdict.complete ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
