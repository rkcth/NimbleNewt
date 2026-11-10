// Tests for the Claude control agent (agents/claude-agent.mjs), run only against the fake CLI (agents/fake-claude.mjs):
// never against a real `claude`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeArgs, claudeToPi } from "./agents/claude-agent.mjs";
import { classify, summarizeLogText } from "./lib/classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agent = join(here, "agents", "claude-agent.mjs");
const fake = join(here, "agents", "fake-claude.mjs");

const runAgent = (mode) => {
  const root = mkdtempSync(join(tmpdir(), "claude-agent-"));
  const checkout = join(root, "checkout");
  spawnSync("mkdir", [checkout]);
  writeFileSync(join(checkout, "a.txt"), "old\n");
  writeFileSync(join(root, "prompt.md"), "Change a.txt.\n--not-an-option\n");
  const record = join(root, "record.json");
  const r = spawnSync(process.execPath, [agent, checkout, join(root, "prompt.md"), join(root, "log.jsonl")], {
    env: { ...process.env, CLAUDE_AGENT_BIN: fake, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record, CLAUDECODE: "1" }, encoding: "utf8",
  });
  const out = { status: r.status, root, checkout, log: readFileSync(join(root, "log.jsonl"), "utf8"), record: JSON.parse(readFileSync(record, "utf8")), edited: readFileSync(join(checkout, "a.txt"), "utf8") };
  rmSync(root, { recursive: true, force: true });
  return out;
};

test("the CLI is called in the checkout with the prompt on stdin, local tools only, no web tools and no MCP servers", () => {
  const r = runAgent("solve");
  assert.equal(r.status, 0);
  assert.equal(r.record.cwd, r.checkout);
  assert.equal(r.record.stdin, "Change a.txt.\n--not-an-option\n", "the prompt is passed whole on stdin");
  assert.deepEqual(r.record.argv, claudeArgs(""));
  assert.ok(r.record.argv.includes("--strict-mcp-config"));
  assert.equal(r.record.argv[r.record.argv.indexOf("--allowedTools") + 1], "Bash,Read,Edit,Write,Glob,Grep");
  assert.equal(r.record.argv[r.record.argv.indexOf("--disallowedTools") + 1], "WebFetch,WebSearch");
  assert.equal(r.record.claudecode, null, "a nested start is its own session");
  assert.deepEqual(claudeArgs("opus").slice(-2), ["--model", "opus"]);
});

test("a finished Claude run becomes a Pi log the classifier reads as a finish: its report, tool calls and own test counts", () => {
  const r = runAgent("solve");
  assert.equal(r.edited, "new\n");
  const s = summarizeLogText(r.log);
  assert.equal(s.parseErrors, 0, "Claude's own non-JSON lines are not copied");
  assert.deepEqual([s.sawSession, s.sessionId, s.agentStart, s.agentEnd, s.settled], [true, "fake-1", true, true, true]);
  assert.equal(s.assistantMessages, 3);
  assert.equal(s.turns, 3);
  assert.equal(s.toolCalls, 2);
  assert.deepEqual(s.lastSelfTest, { tests: 3, pass: 3, fail: 0 });
  assert.equal(s.last.stopReason, "stop");
  assert.match(s.last.visibleHead, /^Done\./);
  assert.deepEqual(s.tokens, { input: 300, output: 60, cacheRead: 15, reasoning: 0 });
  assert.equal(classify({ summary: s, hidden: { ran: true, passed: true }, changed: true }).outcome, "verified-finish");
  assert.equal(classify({ summary: s, hidden: { ran: true, passed: false }, changed: true }).outcome, "wrong");
});

test("a stream cut before its result is not a finished run, and a turn limit is an error", () => {
  const cut = runAgent("no-result");
  assert.equal(cut.status, 1);
  const s = summarizeLogText(cut.log);
  assert.equal(s.agentEnd, false);
  assert.equal(classify({ summary: s, hidden: { ran: true, passed: false }, changed: false, exitCode: 1 }).outcome, "error");
  const limit = summarizeLogText(runAgent("max-turns").log);
  assert.equal(limit.last.stopReason, "error");
  assert.match(limit.last.errorMessage, /error_max_turns/);
  assert.equal(classify({ summary: limit, hidden: { ran: true, passed: false }, changed: false, exitCode: 1 }).outcome, "error");
});

test("the converter: a session is opened once, a tool result is matched to its call, and nothing follows the end", () => {
  const c = claudeToPi({ cwd: "/w", now: () => 0 });
  assert.deepEqual(c.push("garbage"), []);
  const first = c.push(JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }));
  assert.deepEqual(first.map((e) => e.type), ["session", "agent_start", "turn_start", "message_end", "tool_execution_start", "turn_end"]);
  assert.equal(first[0].id, "s");
  const res = c.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "out", is_error: true }] } }));
  assert.deepEqual(res, [{ type: "tool_execution_end", toolCallId: "x", toolName: "Bash", result: { content: [{ type: "text", text: "out" }] }, isError: true }]);
  const len = c.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" } }));
  assert.equal(len[1].message.stopReason, "length");
  assert.deepEqual(c.push(JSON.stringify({ type: "result", subtype: "success" })).map((e) => e.type), ["agent_end", "agent_settled"]);
  assert.deepEqual(c.push(JSON.stringify({ type: "assistant", message: { content: [] } })), []);
  assert.deepEqual(c.end(), []);
});
