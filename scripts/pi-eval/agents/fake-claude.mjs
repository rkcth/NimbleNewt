#!/usr/bin/env node
// A stand-in for the Claude Code CLI, used only by claude-agent.test.mjs: it records its arguments, working directory
// and stdin to FAKE_CLAUDE_RECORD and prints a short stream-json run. FAKE_CLAUDE_MODE:
//   solve      (default) reads a file, edits it, runs the tests and reports done
//   no-result  a tool call and then the stream ends without a result (a killed or crashed CLI)
//   max-turns  ends on a result with subtype error_max_turns
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE || "solve";
const stdin = readFileSync(0, "utf8");
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, claudecode: process.env.CLAUDECODE ?? null }));
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 };
const assistant = (content, stop_reason) => out({ type: "assistant", session_id: "fake-1", message: { id: "m", model: "fake-model", role: "assistant", content, stop_reason, usage } });
const result = (id, text, isError = false) => out({ type: "user", session_id: "fake-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });

out({ type: "system", subtype: "init", session_id: "fake-1", cwd: process.cwd(), tools: ["Bash"] });
process.stdout.write("not json\n");
assistant([{ type: "thinking", thinking: "Look first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }], "tool_use");
result("t1", [{ type: "text", text: "old" }]);
if (mode === "no-result") process.exit(1);
if (mode === "max-turns") { out({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "fake-1" }); process.exit(1); }
writeFileSync(join(process.cwd(), "a.txt"), "new\n");
assistant([{ type: "text", text: "Now the tests." }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test dist/x.test.js" } }], "tool_use");
result("t2", "# tests 3\n# pass 3\n# fail 0\n");
assistant([{ type: "text", text: "Done. I changed a.txt and all 3 tests pass." }], "end_turn");
out({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "fake-1" });
