#!/usr/bin/env node
// A stand-in for Pi, used by the bench's own tests. Same interface as pi-agent.mjs (<worktree> <prompt-file> <log-file>)
// and the same JSON event shape as `pi --mode json`, so the runner and classifier cannot tell it from Pi.
// STUB_AGENT_MODE picks the behaviour:
//   first-turn    (default) the deliberately broken agent: one turn that looks at the task, says what it will do next, and exits.
//   thinking-only one tool call, then a reply with thinking and no visible text, and exits.
//   claims-done   says "Done. All tests pass." without changing anything.
//   crash         starts a session and exits 3 mid-turn.
//   hang          never ends (for the wall-clock timeout).
//   straggler     starts a detached background process in the worktree (its PID in STUB_AGENT_PID_FILE), then reports.
//   straggler-outside  like an embedded PostgreSQL a test started: a detached server working in a directory outside the
//                 worktree, and a helper process of it whose environment is emptied; both PIDs in STUB_AGENT_PID_FILE.
//   solve         copies STUB_AGENT_SOLUTION_DIR's files into the worktree, commits, and reports done (an honest agent).
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [dir, , logFile] = process.argv.slice(2);
const mode = process.env.STUB_AGENT_MODE || "first-turn";
const lines = [];
const emit = (e) => lines.push(JSON.stringify(e));
const flush = () => writeFileSync(logFile, `${lines.join("\n")}\n`);
let n = 0;
const usage = { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 20, totalTokens: 1050 };
const reply = (content, stopReason) => {
  const message = { role: "assistant", content, api: "openai-completions", provider: "stub", model: "stub", usage, stopReason, timestamp: Date.now() };
  emit({ type: "message_end", message });
  return message;
};
const toolTurn = (command) => {
  emit({ type: "turn_start" });
  const id = `call_${++n}`;
  const message = reply([{ type: "thinking", thinking: "Let me look at the repository first." }, { type: "toolCall", id, name: "bash", arguments: { command } }], "toolUse");
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
  emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  emit({ type: "turn_end", message, toolResults: [] });
};
const finalTurn = (content) => {
  emit({ type: "turn_start" });
  const message = reply(content, "stop");
  emit({ type: "turn_end", message, toolResults: [] });
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled", aborted: false });
};

emit({ type: "session", version: 3, id: `stub-${process.pid}`, timestamp: new Date().toISOString(), cwd: dir });
emit({ type: "agent_start" });
switch (mode) {
  case "first-turn":
    toolTurn("ls");
    finalTurn([{ type: "thinking", thinking: "I know where the change goes." }, { type: "text", text: "I have read the task and found the file to change. Next I'll make the change and add the tests." }]);
    break;
  case "thinking-only":
    toolTurn("ls");
    finalTurn([{ type: "thinking", thinking: "Now I should edit the file and run the tests." }]);
    break;
  case "claims-done":
    toolTurn("ls");
    finalTurn([{ type: "text", text: "Done. Summary of the work: the change is implemented and all tests pass." }]);
    break;
  case "crash":
    emit({ type: "turn_start" });
    flush();
    process.exit(3);
    break;
  case "hang":
    flush();
    setInterval(() => {}, 1 << 30);
    break;
  case "straggler": {
    toolTurn("node server.js &");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, detached: true, stdio: "ignore" });
    c.unref();
    writeFileSync(process.env.STUB_AGENT_PID_FILE, String(c.pid));
    finalTurn([{ type: "text", text: "I started the server and stopped." }]);
    break;
  }
  case "straggler-outside": {
    toolTurn("node --test dist/storage/*.test.js");
    // The "server" works in the system temp directory and starts a helper with an empty environment, then both linger.
    const server = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const h = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, stdio: "ignore" });
      require("node:fs").writeFileSync(process.argv[1], process.pid + " " + h.pid);
      setInterval(() => {}, 1000);
    `, process.env.STUB_AGENT_PID_FILE], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    server.unref();
    for (let i = 0; i < 200 && !existsSync(process.env.STUB_AGENT_PID_FILE); i++) execFileSync("sleep", ["0.02"]);
    finalTurn([{ type: "text", text: "I started the test database and stopped." }]);
    break;
  }
  case "solve": {
    toolTurn("ls");
    cpSync(process.env.STUB_AGENT_SOLUTION_DIR, dir, { recursive: true });
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "stub: solve"]);
    finalTurn([{ type: "text", text: "Done. I implemented the change and committed it; the tests pass." }]);
    break;
  }
  default:
    process.stderr.write(`stub-agent: unknown mode ${mode}\n`);
    process.exit(2);
}
if (mode !== "hang") flush();
