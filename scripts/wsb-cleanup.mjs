// After the Windows evidence steps of own-hardware.yml: releases what a run that was stopped hard (a step or job timeout, a cancelled run) left behind, through the Windows Sandbox
// backend's own release (packages/worker/src/sandbox/windows-cleanup.ts): the sandbox each leftover job recorded is stopped, its saved access lists are restored, its lock and folder
// go. Then it checks that no Windows Sandbox is still running; one that is (started by something this cannot tie to a job) is reported, never stopped.
//   node scripts/wsb-cleanup.mjs [--local DIR]
// What it prints holds counts and fixed texts only (the job log is public); with --local the reasons for anything kept are written to DIR/wsb-cleanup.txt on the machine.
// Only folders a run recorded (record plus matching marker token) are acted on; others with the pattern's name are reported and left alone (not an exit 1 by themselves).
// Exit 0 when nothing is left, 1 when something could not be released or a sandbox is still running, 2 on bad usage. Does nothing (exit 0) off Windows. Needs `npm run build` first.
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
const found = worker.searchEvidenceDirs(host);
const dirs = found.dirs;
const result = await worker.releaseLeftovers(host, dirs, identity);
const problems = [...result.kept];
// Folders with the runs' name pattern that no record vouches for (or whose record does not match) are left alone and reported by name only (the names are random, no account names).
for (const n of found.unrecorded) problems.push(`not recorded by any run, left alone: ${n}`);
for (const n of found.distrusted) problems.push(`record not trusted, left alone: ${n}`);
worker.dropFinishedRecords(host);
const state = await worker.sandboxRunning(host, identity);
const running = state === "running";
if (running) problems.push("a Windows Sandbox is still running");
if (state === "unknown") problems.push("the running sandboxes could not be listed (the client could not be verified or the list failed)");
console.log(`leftovers: ${dirs.length} control folders looked at, ${result.released} jobs released, ${result.kept.length} could not be released, ${result.removedBases} test folders removed, ${found.unrecorded.length + found.distrusted.length} not recorded or not trusted and left alone${state === "unknown" ? "; whether a Windows Sandbox is still running could not be checked" : ""}${running ? "; a Windows Sandbox is STILL RUNNING (not stopped by this step: close it if it is not yours)" : ""}`);
if (args[0] === "--local") { mkdirSync(resolve(args[1]), { recursive: true }); writeFileSync(join(resolve(args[1]), "wsb-cleanup.txt"), `${problems.join("\n")}\n`); }
process.exit(result.kept.length > 0 || running ? 1 : 0);
