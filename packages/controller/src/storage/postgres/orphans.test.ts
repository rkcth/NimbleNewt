import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OWNER_FILE, UNRECORDED_MIN_AGE_MS, ownerRecordForThisProcess, processLiveness, sweepOrphanedServers, type OwnerRecord, type SweepEntry } from "./testing/orphans.js";

// Follow-up of card 19: the sweep of test servers left behind by killed test processes. Every folder and process here is made by this file, in a
// disposable root of its own (never the temp directory itself), so the real leftovers of other runs are never looked at.

const supported = process.platform === "linux" || process.platform === "darwin";
const quiet = (lines: string[]) => (line: string) => { lines.push(line); };
const fast = { graceMs: 2_000, immediateMs: 1_000, killMs: 2_000 };

function disposableRoot(): string {
  return mkdtempSync(join(tmpdir(), "nn-orphan-sweep-test-"));
}

/** A sleeping child process that this test owns; `ignore` makes it ignore those signals (like a server that does not shut down). */
function sleeper(ignore: readonly string[] = []): ChildProcess {
  const code = `${ignore.map((s) => `process.on(${JSON.stringify(s)}, () => {});`).join("")} setInterval(() => {}, 1000); process.stdout.write("ready\\n");`;
  return spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
}

/** Waits until the child has installed its signal handlers (a loaded machine can take seconds to start node). */
async function ready(child: ChildProcess): Promise<void> {
  let said = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => { said += chunk.toString(); if (said.includes("ready")) resolve(); });
    child.once("exit", () => reject(new Error("the child ended before it was ready")));
  });
}

async function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function goneProcessRecord(): Promise<OwnerRecord> {
  const child = sleeper();
  await ready(child);
  const record = recordFor(child.pid!);
  child.kill("SIGKILL");
  await exited(child);
  return record;
}

function recordFor(pid: number, startTime?: string): OwnerRecord {
  const alive = processLiveness(pid);
  assert.equal(alive.state, "alive", `process ${pid} is running`);
  // This process's own record (with its boot and namespaces), naming another process.
  return { ...ownerRecordForThisProcess()!, pid, startTime: startTime ?? (alive as { startTime: string }).startTime, host: hostname() };
}

function folder(root: string, name: string, owner?: OwnerRecord | string): string {
  const path = join(root, name);
  mkdirSync(join(path, "data"), { recursive: true });
  writeFileSync(join(path, "data", "PG_VERSION"), "18\n");
  if (owner !== undefined) writeFileSync(join(path, OWNER_FILE), typeof owner === "string" ? owner : JSON.stringify(owner));
  return path;
}

function pidFile(path: string, pid: number, dataDirectory = join(path, "data")): void {
  writeFileSync(join(path, "data", "postmaster.pid"), `${pid}\n${dataDirectory}\n1700000000\n5432\n\n127.0.0.1\n`);
}

const byFolder = (entries: SweepEntry[], path: string) => entries.find((e) => e.folder === path);

test("the sweep removes only the folders whose recorded owner is gone, and keeps live, unknown, young and foreign ones (card 19 follow-up)", { skip: !supported }, async () => {
  const root = disposableRoot();
  const live = sleeper();
  try {
    await ready(live);
    const gone = await goneProcessRecord();
    const orphan = folder(root, "nn-test-pg-Orphan", gone);
    const owned = folder(root, "nn-test-pg-LiveOw", recordFor(live.pid!));
    // The pid of a live process with another start time: the pid was reused, the real owner is gone.
    const reused = folder(root, "nn-test-pg-Reused", recordFor(process.pid, "1"));
    const otherHost = folder(root, "nn-test-pg-OtherH", { ...gone, host: `${hostname()}-elsewhere` });
    const unrecordedYoung = folder(root, "nn-test-pg-NoRecY");
    const malformedYoung = folder(root, "nn-test-pg-BadRec", "{not json");
    // Names that are not exactly mkdtemp's: never looked at, even with a gone owner.
    const shortName = folder(root, "nn-test-pg-abc", gone);
    const longName = folder(root, "nn-test-pg-ABCDEFG", gone);
    const otherName = folder(root, "nn-other-ABCDEF", gone);
    const file = join(root, "nn-test-pg-AFile0");
    writeFileSync(file, JSON.stringify(gone));
    const lines: string[] = [];
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: quiet(lines), steps: fast });
    assert.equal(byFolder(entries, orphan)?.action, "removed");
    assert.match(byFolder(entries, orphan)!.reason, new RegExp(`owner process ${gone.pid} .* is gone`));
    assert.equal(existsSync(orphan), false);
    assert.equal(byFolder(entries, reused)?.action, "removed");
    assert.equal(existsSync(reused), false);
    for (const kept of [owned, otherHost, unrecordedYoung, malformedYoung, shortName, longName, otherName, file]) {
      assert.equal(existsSync(kept), true, `${kept} is kept`);
      assert.equal(byFolder(entries, kept), undefined, `${kept} is not even reported`);
    }
    assert.ok(lines.some((l) => l.startsWith(`removed orphaned test server folder ${orphan}`)), lines.join("\n"));
    // An owner that cannot be checked keeps its folder.
    const unknown = folder(root, "nn-test-pg-Unknwn", gone);
    const unknownEntries = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, liveness: () => ({ state: "unknown" }) });
    assert.equal(byFolder(unknownEntries, unknown), undefined);
    assert.equal(existsSync(unknown), true);
    // Once the live owner ends, its folder goes too.
    live.kill("SIGKILL");
    await exited(live);
    const later = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined });
    assert.equal(byFolder(later, owned)?.action, "removed");
    assert.equal(existsSync(owned), false);
  } finally {
    live.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder without an owner record is removed only once nothing in it changed for a day, and report mode changes nothing (card 19 follow-up)", { skip: !supported }, async () => {
  const root = disposableRoot();
  try {
    const unrecorded = folder(root, "nn-test-pg-NoRec1");
    const malformed = folder(root, "nn-test-pg-BadRc1", JSON.stringify({ version: 1, pid: "x" }));
    const justUnder = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, now: Date.now() + UNRECORDED_MIN_AGE_MS - 60_000 });
    assert.deepEqual(justUnder, []);
    const report = await sweepOrphanedServers({ root, mode: "report", log: () => undefined, now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.deepEqual(report.map((e) => e.action).sort(), ["would-remove", "would-remove"]);
    assert.equal(existsSync(unrecorded), true);
    assert.equal(existsSync(malformed), true);
    const old = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.equal(byFolder(old, unrecorded)?.action, "removed");
    assert.match(byFolder(old, unrecorded)!.reason, /no owner record/);
    assert.equal(byFolder(old, malformed)?.action, "removed");
    assert.equal(existsSync(unrecorded), false);
    // "off" looks at nothing.
    const gone = await goneProcessRecord();
    const orphan = folder(root, "nn-test-pg-Orphn2", gone);
    assert.deepEqual(await sweepOrphanedServers({ root, mode: "off" }), []);
    assert.equal(existsSync(orphan), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sweep never follows a symlink and never works outside the system temp directory (card 19 follow-up)", { skip: !supported }, async () => {
  const root = disposableRoot();
  const elsewhere = disposableRoot();
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const outside = mkdtempSync(join(packageDir, ".nn-orphan-outside-"));
  try {
    const gone = await goneProcessRecord();
    // A link with the right name, to a folder whose owner is gone: neither the link nor its target is touched.
    const target = folder(elsewhere, "target", gone);
    symlinkSync(target, join(root, "nn-test-pg-LinkTo"));
    // An owner record that is a link to a record of a gone owner counts as no record (young: kept).
    writeFileSync(join(elsewhere, "record.json"), JSON.stringify(gone));
    const linkedRecord = folder(root, "nn-test-pg-LnkRec");
    symlinkSync(join(elsewhere, "record.json"), join(linkedRecord, OWNER_FILE));
    // An owner record that is a folder or a FIFO is no record either (young: kept), and reading it neither throws nor blocks.
    const recordFolder = folder(root, "nn-test-pg-DirRec");
    mkdirSync(join(recordFolder, OWNER_FILE));
    const recordFifo = folder(root, "nn-test-pg-FifRec");
    execFileSync("mkfifo", [join(recordFifo, OWNER_FILE)]);
    // A real orphan whose data folder holds a link out: removing the orphan unlinks the link, the target survives.
    const orphan = folder(root, "nn-test-pg-WithLn", gone);
    const precious = join(elsewhere, "precious.txt");
    writeFileSync(precious, "keep me");
    symlinkSync(elsewhere, join(orphan, "data", "out"));
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined });
    assert.deepEqual(entries.map((e) => [e.folder, e.action]), [[orphan, "removed"]]);
    assert.equal(existsSync(join(root, "nn-test-pg-LinkTo")), true);
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(join(linkedRecord, OWNER_FILE)), true);
    assert.equal(existsSync(join(recordFolder, OWNER_FILE)), true);
    assert.equal(existsSync(join(recordFifo, OWNER_FILE)), true);
    // Once old, the folder-shaped record reads as no record and the folder goes; the sweep did not stop at the FIFO.
    const aged = await sweepOrphanedServers({ root, mode: "report", log: () => undefined, now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.equal(byFolder(aged, recordFolder)?.action, "would-remove");
    assert.equal(byFolder(aged, recordFifo)?.action, "would-remove");
    assert.equal(readFileSync(precious, "utf8"), "keep me");
    // Outside the temp directory nothing is looked at, even an obvious orphan.
    const outsideOrphan = folder(outside, "nn-test-pg-Outsid", gone);
    assert.deepEqual(await sweepOrphanedServers({ root: outside, mode: "remove", log: () => undefined }), []);
    assert.equal(existsSync(outsideOrphan), true);
  } finally {
    for (const path of [root, elsewhere, outside]) rmSync(path, { recursive: true, force: true });
  }
});

test("a running server is stopped only when its pid file and command line say it is this folder's postgres (card 19 follow-up)", { skip: !supported }, async () => {
  const root = disposableRoot();
  const bystander = sleeper();
  const stubborn = sleeper(["SIGINT", "SIGQUIT", "SIGTERM"]);
  try {
    await Promise.all([ready(bystander), ready(stubborn)]);
    const gone = await goneProcessRecord();
    // The pid file names a live process that is not postgres (a reused pid): it is left running, the folder removed.
    const reusedPid = folder(root, "nn-test-pg-Reusd1", gone);
    pidFile(reusedPid, bystander.pid!);
    // The pid file names another data folder: whether this folder's server runs cannot be told, so the folder is kept.
    const otherData = folder(root, "nn-test-pg-OthrDt", gone);
    pidFile(otherData, bystander.pid!, "/somewhere/else/data");
    // A server that ignores the graceful signals is killed in the end, and only it.
    const hung = folder(root, "nn-test-pg-HungSv", gone);
    pidFile(hung, stubborn.pid!);
    const command = (pid: number): string[] | undefined => pid === stubborn.pid ? ["/opt/pg/bin/postgres", "-D", join(hung, "data"), "-p", "1"] : pid === bystander.pid ? [process.execPath, "-e", "..."] : undefined;
    const lines: string[] = [];
    // The stubborn server stands for one left by a killed test process, which init has taken over; the real child of this test would be kept (see the parent test).
    const liveness = (pid: number) => { const seen = processLiveness(pid); return pid === stubborn.pid && seen.state === "alive" ? { ...seen, ppid: 1 } : seen; };
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: quiet(lines), command, liveness, steps: { graceMs: 300, immediateMs: 300, killMs: 5_000 } });
    assert.equal(byFolder(entries, reusedPid)?.action, "removed");
    assert.equal(byFolder(entries, reusedPid)?.stoppedPid, undefined);
    assert.equal(existsSync(reusedPid), false);
    assert.equal(byFolder(entries, otherData)?.action, "kept");
    assert.equal(existsSync(otherData), true);
    assert.equal(byFolder(entries, hung)?.action, "removed");
    assert.equal(byFolder(entries, hung)?.stoppedPid, stubborn.pid);
    assert.deepEqual(await exited(stubborn), { code: null, signal: "SIGKILL" });
    assert.equal(bystander.exitCode, null, "the process whose pid was reused is still running");
    assert.equal(bystander.signalCode, null);
    assert.ok(lines.some((l) => l.includes(`stopped its postgres ${stubborn.pid}`)), lines.join("\n"));
  } finally {
    bystander.kill("SIGKILL");
    stubborn.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real embedded server left by a killed test process is stopped and its folder removed by the next start's sweep (card 19 follow-up)", { skip: !supported }, async () => {
  const root = disposableRoot();
  const serverModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "testing", "server.js")).href;
  // A test process that starts a server in the disposable root, says where, and is then killed from outside before it can stop it.
  const script = `const { startEmbeddedServer } = await import(${JSON.stringify(serverModule)}); const s = await startEmbeddedServer([], ${JSON.stringify(root)}); console.log("URL " + s.url()); setInterval(() => {}, 1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NIMBLENEWT_TEST_PG_SWEEP: "off" } });
  let said = "";
  owner.stdout!.on("data", (chunk: Buffer) => { said += chunk.toString(); });
  owner.stderr!.on("data", (chunk: Buffer) => { said += chunk.toString(); });
  let serverPid: number | undefined;
  try {
    for (const deadline = Date.now() + 240_000; !/URL postgres:/.test(said);) {
      if (owner.exitCode !== null) assert.fail(`the owner process ended: ${said}`);
      if (Date.now() > deadline) assert.fail(`the owner's server did not start: ${said.slice(-2000)}`);
      await sleep(200);
    }
    const name = /data (\S*nn-test-pg-[A-Za-z0-9]{6})/.exec(said)?.[1];
    const { readdirSync } = await import("node:fs");
    const folders = readdirSync(root).filter((n) => n.startsWith("nn-test-pg-"));
    assert.equal(folders.length, 1, `${folders.join(", ")} ${name ?? ""}`);
    const serverFolder = join(root, folders[0]!);
    const record = JSON.parse(readFileSync(join(serverFolder, OWNER_FILE), "utf8")) as OwnerRecord;
    assert.equal(record.pid, owner.pid, "the folder records the process that started the server");
    serverPid = Number(readFileSync(join(serverFolder, "data", "postmaster.pid"), "utf8").split("\n")[0]);
    assert.equal(processLiveness(serverPid).state, "alive");
    // While the owner lives, the sweep keeps its server.
    assert.deepEqual(await sweepOrphanedServers({ root, mode: "remove", log: () => undefined }), []);
    owner.kill("SIGKILL");
    await exited(owner);
    await sleep(200);
    assert.equal(processLiveness(serverPid).state, "alive", "a killed test process leaves its server running (the problem)");
    const adopter = (processLiveness(serverPid) as { ppid?: number }).ppid;
    const lines: string[] = [];
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: quiet(lines) });
    assert.equal(entries.length, 1, lines.join("\n"));
    if (adopter !== 1) {
      // A machine where a subreaper (not init) takes over orphans: the server's parent still runs, so it is kept (never stopped on the record alone).
      assert.equal(entries[0]!.action, "kept", lines.join("\n"));
      assert.match(entries[0]!.reason, /still the child of a running process/);
      return;
    }
    assert.equal(entries[0]!.action, "removed", lines.join("\n"));
    assert.equal(entries[0]!.stoppedPid, serverPid);
    assert.notEqual(processLiveness(serverPid).state, "alive", "the orphaned server is stopped");
    assert.equal(existsSync(serverFolder), false);
  } finally {
    owner.kill("SIGKILL");
    if (serverPid !== undefined && processLiveness(serverPid).state === "alive") { try { process.kill(serverPid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record from another pid or time namespace, or a Linux record without one, is never judged by its pid (card 19 follow-up review)", { skip: process.platform !== "linux" }, async () => {
  // A test run in a sandbox with its own pid namespace that shares the temp directory: its pid means nothing here (gone, or another process).
  const root = disposableRoot();
  try {
    const gone = await goneProcessRecord();
    assert.match(gone.pidNamespace ?? "", /^pid:\[\d+\]$/, "the record names the owner's pid namespace");
    const otherPidNs = folder(root, "nn-test-pg-OthPns", { ...gone, pidNamespace: "pid:[1]" });
    const otherTimeNs = folder(root, "nn-test-pg-OthTns", { ...gone, timeNamespace: "time:[1]" });
    const { pidNamespace: _p, timeNamespace: _t, ...withoutNs } = gone;
    void _p; void _t;
    const legacy = folder(root, "nn-test-pg-Legacy", withoutNs);
    const control = folder(root, "nn-test-pg-Contrl", gone);
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, steps: fast });
    assert.deepEqual(entries.map((e) => [e.folder, e.action]), [[control, "removed"]]);
    for (const kept of [otherPidNs, otherTimeNs, legacy]) assert.equal(existsSync(kept), true, `${kept} is kept`);
    // A day later the record from another namespace is still never judged; the record without namespaces counts as no record (the 24 h rule).
    const later = await sweepOrphanedServers({ root, mode: "report", log: () => undefined, now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.deepEqual(later.map((e) => [e.folder, e.action]), [[legacy, "would-remove"]]);
    assert.match(later[0]!.reason, /an unreadable owner record/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a running server whose parent process still runs is never stopped, whatever its folder's record says (card 19 follow-up review)", { skip: !supported }, async () => {
  // The server of a live test process is that process's child; one left by a killed test process has been taken over by init.
  const root = disposableRoot();
  const server = sleeper(["SIGINT", "SIGQUIT", "SIGTERM"]);
  try {
    await ready(server);
    const gone = await goneProcessRecord();
    const misjudged = folder(root, "nn-test-pg-LiveSv", gone);
    pidFile(misjudged, server.pid!);
    const unrecorded = folder(root, "nn-test-pg-OldLiv");
    pidFile(unrecorded, server.pid!);
    const command = (pid: number): string[] | undefined => pid === server.pid ? ["/opt/pg/bin/postgres", "-D", join(misjudged, "data")] : undefined;
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, command, steps: fast });
    assert.equal(byFolder(entries, misjudged)?.action, "kept");
    assert.match(byFolder(entries, misjudged)!.reason, new RegExp(`still the child of a running process \\(${process.pid}\\)`));
    assert.equal(existsSync(misjudged), true);
    // Without a record, even a day-old idle server is kept while its parent runs (an older harness's long-lived server).
    const unrecordedCommand = (pid: number): string[] | undefined => pid === server.pid ? ["/opt/pg/bin/postgres", "-D", join(unrecorded, "data")] : undefined;
    const aged = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, command: unrecordedCommand, steps: fast, now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.equal(byFolder(aged, unrecorded)?.action, "kept");
    assert.equal(existsSync(unrecorded), true);
    assert.equal(server.exitCode, null, "the server was never signalled");
    assert.equal(server.signalCode, null);
  } finally {
    server.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pid reused between the command-line check and the start-time check is not taken for the folder's server (card 19 follow-up review)", { skip: !supported }, async () => {
  const root = disposableRoot();
  const bystander = sleeper();
  try {
    await ready(bystander);
    const gone = await goneProcessRecord();
    const orphan = folder(root, "nn-test-pg-Recycl", gone);
    pidFile(orphan, bystander.pid!);
    // The first look sees a postgres that started at "100"; by the second look the pid names a process that started later.
    let looks = 0;
    const liveness = (pid: number) => pid === bystander.pid ? { state: "alive" as const, startTime: looks++ === 0 ? "100" : "200", ppid: 1 } : processLiveness(pid);
    const command = (pid: number): string[] | undefined => pid === bystander.pid ? ["/opt/pg/bin/postgres", "-D", join(orphan, "data")] : undefined;
    const entries = await sweepOrphanedServers({ root, mode: "remove", log: () => undefined, liveness, command, steps: fast });
    assert.equal(byFolder(entries, orphan)?.action, "kept");
    assert.match(byFolder(entries, orphan)!.reason, /cannot be told/);
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
  } finally {
    bystander.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a process that exists under another user is not taken for gone when /proc hides it (card 19 follow-up review)", { skip: process.platform !== "linux" }, () => {
  // pid 1 is excluded by the pid check; any live process this user may not signal answers EPERM. When /proc hides it, the answer is unknown.
  const other = execFileSync("ps", ["-e", "-o", "pid=,uid="], { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/)).find(([pid, uid]) => Number(pid) > 1 && uid !== String(process.getuid!()));
  if (other === undefined) return;
  const seen = processLiveness(Number(other[0]));
  assert.notEqual(seen.state, "gone");
});

test("a sweep logs at most ten lines and one summary, however many folders it decides about (card 19 follow-up review)", { skip: !supported }, async () => {
  const root = disposableRoot();
  try {
    for (let i = 0; i < 25; i++) folder(root, `nn-test-pg-Many${String(i).padStart(2, "0")}`);
    const lines: string[] = [];
    const entries = await sweepOrphanedServers({ root, mode: "report", log: quiet(lines), now: Date.now() + UNRECORDED_MIN_AGE_MS + 60_000 });
    assert.equal(entries.length, 25);
    assert.equal(lines.length, 11, lines.join("\n"));
    assert.match(lines[10]!, /and 15 more test server folders \(0 removed, 15 would be removed, 0 kept\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
