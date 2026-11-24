#!/usr/bin/env node
// The agent the bench runs by default: one Pi CLI run in a worktree, its JSON event log written to a file.
// Usage: node pi-agent.mjs <worktree> <prompt-file> <log-file>
// The provider and model are pinned on the command line (from PI_EVAL_PROVIDER / PI_EVAL_MODEL, which the runner sets
// from taskset.json), so no default or plugin can send the work to another provider. Same flags as
// ~/.local/pi-cli/runcard.sh. PI_EVAL_SESSION_ID (variant D, once W04 exists) keeps a session instead of --no-session.
// The Pi binary is PI_EVAL_PI_BIN, else ~/.local/pi-cli/node_modules/.bin/pi. It is started with this Node, not a
// shell, so the launcher is the same on every platform. Nothing here reads or prints a credential. The bench starts this
// script isolated (lib/isolation.mjs): HOME is a fresh per-run folder, so the bench passes PI_EVAL_PI_BIN, resolved from
// the real home, and Pi finds only the per-run configuration that reaches the model through the bench's key proxy.
// Card W01b: Pi is started with the bench's extension arg-clean-extension.mjs (next to this file, so it is readable in the
// sandbox like this script), which keeps lone surrogates out of the tool-call arguments Pi re-sends; it writes its counts
// to arg-clean.json beside the log, which the runner copies into the run record. Card W04 (variant C): see below.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_KIND, checkConfig, commandLineConfig } from "./continuation-extension.mjs";

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

const extension = fileURLToPath(new URL("./arg-clean-extension.mjs", import.meta.url));
// Card W04, variant C: with a continuation config (the runner's PI_EVAL_CONTINUATION_CONFIG) Pi also loads the bench's
// continuation extension, which is the worker's bounded onYield hook at Pi's last boundary (continuation-extension.mjs).
// The nudge fix: the worker's nudge names nimblenewt__work-end, which this command-line agent does not have, so the extension
// gets the bench's command-line wording (commandLineConfig: a final report whose first line states the result); the words
// that ran are written to continuation-used.json beside the log. And the run's settings reach the extension on a descriptor
// (an unlinked file as Pi's descriptor 3), not in Pi's environment: the agent's tools, children of Pi, list no bench path.
const configFile = process.env.PI_EVAL_CONTINUATION_CONFIG || "";
const countsFile = process.env.PI_EVAL_CONTINUATION_FILE || "";
const continuation = configFile ? ["-e", fileURLToPath(new URL("./continuation-extension.mjs", import.meta.url))] : [];
let channelFd = null, winEnv = {};
if (configFile) {
  let used;
  try {
    used = commandLineConfig(checkConfig(JSON.parse(readFileSync(configFile, "utf8"))));
    const usedFile = join(dirname(logFile), "continuation-used.json");
    writeFileSync(`${usedFile}.tmp`, `${JSON.stringify({ wording: used.wording, max: used.max, mark: used.mark, nudge: used.nudge, lengthNudge: used.lengthNudge })}\n`);
    renameSync(`${usedFile}.tmp`, usedFile);
    if (process.platform === "win32") {
      // No unlinked-file descriptor to a child here: the words used are read from their file, named in the environment.
      winEnv = { PI_EVAL_CONTINUATION_CONFIG: usedFile, PI_EVAL_CONTINUATION_FILE: countsFile };
    } else {
    const blob = join(dirname(logFile), `.channel-${process.pid}`);
    writeFileSync(blob, `${JSON.stringify({ kind: CHANNEL_KIND, config: used, file: countsFile || null })}\n`, { mode: 0o600 });
    channelFd = openSync(blob, "r");
    rmSync(blob, { force: true });
    }
  } catch (e) {
    process.stderr.write(`pi-agent: the continuation settings could not be prepared (${e?.message ?? e}); nothing was started\n`);
    process.exit(2);
  }
}
const childEnv = { ...process.env, PI_OFFLINE: "1", PI_EVAL_ARG_CLEAN_FILE: join(dirname(logFile), "arg-clean.json") };
// What the agent's own tools could list of the bench: none of these reach Pi (nor its children).
for (const k of ["PI_EVAL_CONTINUATION_CONFIG", "PI_EVAL_CONTINUATION_FILE"]) delete childEnv[k];
Object.assign(childEnv, winEnv);
const args = [bin, "-p", "-e", extension, ...continuation, ...(sessionId ? ["--session-id", sessionId] : ["--no-session"]), "--no-approve", "--provider", provider, "--model", model, "--thinking", thinking, "--mode", "json", prompt];
// stdout only in the JSON log: a warning on stderr written into it could split or swallow an event line.
const log = openSync(logFile, "w");
const errLog = openSync(join(dirname(logFile), "pi-stderr.log"), "w");
const child = spawn(process.execPath, args, { cwd: dir, stdio: ["ignore", log, errLog, ...(channelFd !== null ? [channelFd] : [])], env: childEnv });
if (channelFd !== null) closeSync(channelFd);
closeSync(log);
closeSync(errLog);
// The runner stops the agent by signalling this process; pass it on so Pi is not left running.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
child.on("error", (e) => { process.stderr.write(`pi-agent: ${e.message}\n`); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
