#!/usr/bin/env node
// The agent the bench runs by default: one Pi CLI run in a worktree, its JSON event log written to a file.
// Usage: node pi-agent.mjs <worktree> <prompt-file> <log-file>
// The provider and model are pinned on the command line (from PI_EVAL_PROVIDER / PI_EVAL_MODEL, which the runner sets
// from taskset.json), so no default or plugin can send the work to another provider. Same flags as
// ~/.local/pi-cli/runcard.sh. PI_EVAL_SESSION_ID (variant D, once W04 exists) keeps a session instead of --no-session.
// The Pi binary is PI_EVAL_PI_BIN, else ~/.local/pi-cli/node_modules/.bin/pi. It is started with this Node, not a
// shell, so the launcher is the same on every platform. Nothing here reads or prints a credential.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [dir, promptFile, logFile] = process.argv.slice(2);
if (!dir || !promptFile || !logFile) {
  process.stderr.write("usage: pi-agent.mjs <worktree> <prompt-file> <log-file>\n");
  process.exit(2);
}
const provider = process.env.PI_EVAL_PROVIDER || "radiance";
const model = process.env.PI_EVAL_MODEL || "qwen3.8-flash-next-iq4r";
const thinking = process.env.PI_EVAL_THINKING || "medium";
const sessionId = process.env.PI_EVAL_SESSION_ID || "";
const bin = realpathSync(process.env.PI_EVAL_PI_BIN || join(homedir(), ".local", "pi-cli", "node_modules", ".bin", "pi"));
const prompt = readFileSync(promptFile, "utf8");

const args = [bin, "-p", ...(sessionId ? ["--session-id", sessionId] : ["--no-session"]), "--no-approve", "--provider", provider, "--model", model, "--thinking", thinking, "--mode", "json", prompt];
// stdout only in the JSON log: a warning on stderr written into it could split or swallow an event line.
const log = openSync(logFile, "w");
const errLog = openSync(join(dirname(logFile), "pi-stderr.log"), "w");
const child = spawn(process.execPath, args, { cwd: dir, stdio: ["ignore", log, errLog], env: { ...process.env, PI_OFFLINE: "1" } });
closeSync(log);
closeSync(errLog);
// The runner stops the agent by signalling this process; pass it on so Pi is not left running.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
child.on("error", (e) => { process.stderr.write(`pi-agent: ${e.message}\n`); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
