#!/usr/bin/env node
// A control agent for the bench (card W01, README "A control run"): one non-interactive Claude Code run in the
// checkout, its stream converted to the Pi JSON event log the runner and classifier read.
// Usage: node agents/claude-agent.mjs <checkout> <prompt-file> <log-file>
//   CLAUDE_AGENT_BIN    the Claude Code CLI (default `claude` on PATH); a .mjs/.js file is run with this Node
//   CLAUDE_AGENT_MODEL  optional --model
// It runs `claude -p --output-format stream-json --verbose` with the prompt on stdin, edits accepted, only the
// local tools (Bash, Read, Edit, Write, Glob, Grep), no web tools and no MCP servers. Claude's own stdout is
// never copied into the log as is: each stream line is converted (session, agent_start, turn_start/message_end/
// turn_end per assistant message, tool_execution_start/end, agent_end, agent_settled). Claude's stderr goes to
// claude-stderr.log beside the log. Nothing here reads, sets or prints a credential; Claude uses its own login.
// The bench's tests run it only against a fake CLI (agents/fake-claude.mjs); a real run uses the account's quota.
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";

/** The CLI arguments (the prompt goes on stdin, so no variadic option can swallow it). */
export function claudeArgs(model = "") {
  return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_TOOLS, "--disallowedTools", "WebFetch,WebSearch", "--strict-mcp-config", ...(model ? ["--model", model] : [])];
}

const STOP = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", refusal: "stop", pause_turn: "stop" };
const textOfResult = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => String(b.text ?? "")).join("") : "");

/** A converter from Claude Code stream-json events to Pi events. `push(line)` returns the Pi events for one stream line; `end()` closes a stream that had no result. */
export function claudeToPi({ cwd = "", now = () => Date.now() } = {}) {
  let started = false, ended = false;
  const toolNames = new Map();
  const start = (id) => (started ? [] : (started = true, [{ type: "session", version: 3, id: id ?? `claude-${process.pid}`, timestamp: new Date(now()).toISOString(), cwd }, { type: "agent_start" }]));
  const reply = (content, stopReason, usage = {}, extra = {}) => ({
    type: "message_end",
    message: { role: "assistant", content, api: "claude-code", provider: "anthropic", model: extra.model ?? "claude", usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, reasoning: 0, totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }, stopReason, timestamp: now(), ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}) },
  });
  const finish = (aborted) => (ended ? [] : (ended = true, [{ type: "agent_end", messages: [] }, { type: "agent_settled", aborted }]));
  return {
    push(line) {
      let e;
      try { e = JSON.parse(line); } catch { return []; }
      if (e === null || typeof e !== "object" || ended) return [];
      if (e.type === "system") return e.subtype === "init" ? start(e.session_id) : [];
      const out = start(e.session_id);
      if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
        const content = [];
        const calls = [];
        for (const b of e.message.content) {
          if (b?.type === "text") content.push({ type: "text", text: String(b.text ?? "") });
          else if (b?.type === "thinking") content.push({ type: "thinking", thinking: String(b.thinking ?? "") });
          else if (b?.type === "tool_use") {
            content.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} });
            calls.push(b);
            toolNames.set(b.id, b.name);
          }
        }
        const stopReason = calls.length > 0 ? "toolUse" : (STOP[e.message.stop_reason] ?? "stop");
        const m = reply(content, stopReason, e.message.usage, { model: e.message.model });
        out.push({ type: "turn_start" }, m);
        for (const b of calls) out.push({ type: "tool_execution_start", toolCallId: b.id, toolName: b.name, args: b.input ?? {} });
        out.push({ type: "turn_end", message: m.message, toolResults: [] });
      } else if (e.type === "user" && e.message && Array.isArray(e.message.content)) {
        for (const b of e.message.content) {
          if (b?.type !== "tool_result") continue;
          out.push({ type: "tool_execution_end", toolCallId: b.tool_use_id, toolName: toolNames.get(b.tool_use_id) ?? "", result: { content: [{ type: "text", text: textOfResult(b.content) }] }, isError: b.is_error === true });
        }
      } else if (e.type === "result") {
        // A run Claude itself ended in error (turn limit, execution error) ends on an error reply, as a Pi error would.
        if (e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")) out.push(reply([], "error", {}, { errorMessage: String(e.subtype ?? "error") }));
        out.push(...finish(false));
      }
      return out;
    },
    /** The stream ended without a result: the run did not finish (no agent_end, so the classifier sees a stop). */
    end() { return start(undefined); },
  };
}

async function main() {
  const [dir, promptFile, logFile] = process.argv.slice(2);
  if (!dir || !promptFile || !logFile) {
    process.stderr.write("usage: claude-agent.mjs <checkout> <prompt-file> <log-file>\n");
    process.exit(2);
  }
  const bin = process.env.CLAUDE_AGENT_BIN || "claude";
  const argv = claudeArgs(process.env.CLAUDE_AGENT_MODEL || "");
  const [cmd, args] = /\.m?js$/.test(bin) ? [process.execPath, [bin, ...argv]] : [bin, argv];
  const env = { ...process.env };
  delete env.CLAUDECODE; // started from inside a Claude Code session, the child is its own session
  const errLog = openSync(join(dirname(logFile), "claude-stderr.log"), "w");
  const child = spawn(cmd, args, { cwd: dir, stdio: ["pipe", "pipe", errLog], env });
  closeSync(errLog);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  child.on("error", (e) => { process.stderr.write(`claude-agent: ${e.message}\n`); process.exit(127); });
  child.stdin.on("error", () => { /* the CLI may exit before reading */ });
  child.stdin.end(readFileSync(promptFile, "utf8"));
  const log = createWriteStream(logFile);
  const conv = claudeToPi({ cwd: dir });
  const write = (events) => { for (const ev of events) log.write(`${JSON.stringify(ev)}\n`); };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => { if (line.trim() !== "") write(conv.push(line)); });
  const [code, signal] = await new Promise((res) => child.on("close", (c, s) => res([c, s])));
  write(conv.end());
  await new Promise((res) => log.end(res));
  process.exit(code ?? (signal ? 128 : 1));
}

const invoked = (() => { try { return realpathSync(process.argv[1]); } catch { return ""; } })();
if (fileURLToPath(import.meta.url) === invoked) await main();
