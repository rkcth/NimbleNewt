// After the Windows evidence steps of own-hardware.yml: releases what a run that was stopped hard (a step or job timeout, a cancelled run) left behind, through the Windows Sandbox
// backend's own release (packages/worker/src/sandbox/windows-cleanup.ts): the sandbox each leftover job recorded is stopped, its saved access lists are restored, its lock and folder
// go. Then it checks that no Windows Sandbox is still running; one that is (started by something this cannot tie to a job) is reported, never stopped.
//   node scripts/wsb-cleanup.mjs [--local DIR]
// What it prints holds counts and fixed texts only (the job log is public); with --local the reasons for anything kept are written to DIR/wsb-cleanup.txt on the machine.
// Only folders a run recorded (a record in %LOCALAPPDATA%\NimbleNewt\wsb-records, a matching marker token, the same owner) are acted on; others with the pattern's name are
// reported and left alone (not an exit 1 by themselves). How to look at and remove those by hand: docs/nimblenewt/own-hardware-runners.md. When no record can be believed at all
// (no records folder, or one whose access list names another account or cannot be read), the reason (a fixed text) is printed, and it is an exit 1 while pattern folders are left:
// then every leftover would stay for good, which must not pass unnoticed.
// Exit 0 when nothing is left, 1 when something could not be released, a sandbox is still running or the records cannot be used while folders are left, 2 on bad usage. Does nothing (exit 0) off Windows. Needs `npm run build` first.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 2 && args[0] === "--local"))) { console.error("usage: wsb-cleanup.mjs [--local DIR]"); process.exit(2); }
if (process.platform !== "win32") { console.log("not Windows: nothing to clean up"); process.exit(0); }

const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);
const host = worker.windowsRealHost();
const identity = worker.evidenceIdentity(process.env, await worker.windowsConsoleUser());
const found = await worker.searchEvidenceDirs(host);
const dirs = found.dirs;
const result = await worker.releaseLeftovers(host, dirs, identity, found.owners);
const problems = [...result.kept];
// Folders with the runs' name pattern that no record vouches for (or whose record does not match) are left alone and reported by name only (the names are random, no account names).
for (const n of found.unrecorded) problems.push(`not recorded by any run, left alone: ${n}`);
for (const n of found.distrusted) problems.push(`record not trusted, left alone: ${n}`);
worker.dropFinishedRecords(host);
const state = await worker.sandboxRunning(host, identity);
const running = state === "running";
const unusable = found.recordsProblem !== undefined && found.unrecorded.length > 0;
if (unusable) problems.push(`the records could not be used (${found.recordsProblem}), so no test folder was acted on`);
if (running) problems.push("a Windows Sandbox is still running");
if (state === "unknown") problems.push("the running sandboxes could not be listed (the client could not be verified or the list failed)");
console.log(`leftovers: ${dirs.length} control folders looked at, ${result.released} jobs released, ${result.kept.length} could not be released, ${result.removedBases} test folders removed, ${found.unrecorded.length + found.distrusted.length} not recorded or not trusted and left alone${found.recordsProblem === undefined ? "" : `; NO RECORD WAS BELIEVED: ${found.recordsProblem}`}${state === "unknown" ? "; whether a Windows Sandbox is still running could not be checked" : ""}${running ? "; a Windows Sandbox is STILL RUNNING (not stopped by this step: close it if it is not yours)" : ""}`);
if (args[0] === "--local") { mkdirSync(resolve(args[1]), { recursive: true }); writeFileSync(join(resolve(args[1]), "wsb-cleanup.txt"), `${problems.join("\n")}\n`); }
process.exit(result.kept.length > 0 || running || unusable ? 1 : 0);
