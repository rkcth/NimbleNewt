#!/usr/bin/env node
// A fake agent for the bench's isolation tests (card W01c): it looks for other runs' checkouts in the shared work root
// and uses its own checkout, and writes down what it saw. Local folders only; no network.
// Usage (as every bench agent): peek-agent.mjs <checkout> <prompt-file> <log-file>
// PEEK_WORK_ROOT  the shared work root (holds every run's checkout)
// PEEK_SIBLING    a sibling run's checkout in it, holding a marker file `marker.txt`
// Writes peek-report.json beside the log: each step's command, exit status and output.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [dir, , logFile] = process.argv.slice(2);
const work = process.env.PEEK_WORK_ROOT ?? "/nonexistent";
const sibling = process.env.PEEK_SIBLING ?? "/nonexistent";
const steps = {};
const sh = (name, command) => {
  const r = spawnSync("/bin/sh", ["-c", command], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  steps[name] = { command, status: r.status, stdout: r.stdout, stderr: r.stderr };
};
sh("listWork", `ls -A "${work}"`);
sh("findWork", `find "${work}" -maxdepth 2`);
sh("listSibling", `ls -A "${sibling}"`);
sh("readSibling", `cat "${sibling}/marker.txt"`);
sh("ownList", `ls -A "${dir}"`);
sh("ownWrite", `echo own-work > "${dir}/peek-own.txt" && cat "${dir}/peek-own.txt"`);
sh("ownGit", "git status --porcelain");

const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 11 };
const message = { role: "assistant", content: [{ type: "text", text: "Done." }], api: "x", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
const lines = [
  { type: "session", version: 3, id: `peek-${process.pid}`, timestamp: new Date().toISOString(), cwd: dir },
  { type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message }, { type: "turn_end", message, toolResults: [] },
  { type: "agent_end", messages: [] }, { type: "agent_settled", aborted: false },
].map((e) => JSON.stringify(e));
writeFileSync(logFile, `${lines.join("\n")}\n`);
writeFileSync(join(dirname(logFile), "peek-report.json"), JSON.stringify({ steps }, null, 2));
