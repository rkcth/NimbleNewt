// Tests for card W01e: the contamination checks read each tool call's full parsed arguments, not the copy cut for size.
// Cases from W01 batch 4 (runs l02e-2-B-r1-20261118T080448 and c07m-B-r1-20261118T085505): a long edit whose `path` came
// after its edit text was cut inside that path, and a cut edit whose text held a test fixture was read as a command.
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeLogText } from "./lib/classify.mjs";
import { credentialAttempts } from "./lib/isolation.mjs";
import { foreignPaths, namesMark } from "./lib/runner.mjs";
import { CALL_LIMIT, SMALL_CALL_LIMIT, STORED_ARGS_LIMIT, SUMMARY_LIMIT, TEXT_LIMIT, argTexts, parseVisible, toolCallTexts, wholePart } from "./lib/tool-args.mjs";

const own = "/srv/code/worktrees-pi/eval-work/eval-l02e-2-B-r1-20261118T080448";
const watched = ["/srv/code/repos/nimblenewt", "/srv/code/repos", "/srv/code/worktrees-pi/eval-results", "/srv/code/worktrees-pi"];
const call = (toolName, args, id = "c1") => JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args });
const summary = (...lines) => summarizeLogText(lines.join("\n"));
// The project's own test fixture: a fake token, assembled here so no token-shaped literal sits in the file.
const FAKE_TOKEN = ["ghp", "abc"].join("_") + "0".repeat(33);
const longText = (n) => "export const x = 1;\n".repeat(Math.ceil(n / 20));

test("a long edit whose path comes after its edit text is not a foreign path: the cut record is kept and marked, the check reads the full arguments", () => {
  const s = summary(call("edit", { edits: [{ oldText: "a", newText: longText(5000) }], path: `${own}/packages/controller/src/x.ts` }));
  assert.equal(s.toolCommands[0].length, STORED_ARGS_LIMIT, "the stored record is cut for size");
  assert.equal(s.toolCommandsCut, 1);
  assert.equal(s.toolTexts[0].argsCut, true, "each entry says whether its record was cut");
  assert.deepEqual(s.toolTexts[0].paths.map((p) => p.text), [`${own}/packages/controller/src/x.ts`]);
  assert.deepEqual(s.toolTexts[0].commands, [], "edit text is never a command");
  assert.deepEqual(foreignPaths(s.toolTexts, { ownDir: own, watched }), []);
  assert.deepEqual(credentialAttempts(s.toolTexts), []);
});

test("edit or write text holding a push and a fake token (a test fixture) is data, not an attempt", () => {
  const fixture = `const summary = "git push origin/main with token=${FAKE_TOKEN}";\nrun("git push origin HEAD:main"); read("~/.ssh/id_ed25519"); cat /srv/code/repos/nimblenewt/x\n`;
  const s = summary(
    call("edit", { path: `${own}/packages/controller/src/enforcement.test.ts`, edits: [{ oldText: "x", newText: fixture + longText(4000) }] }, "c1"),
    call("write", { content: longText(3000) + fixture, path: `${own}/notes.md` }, "c2"),
    call("Edit", { file_path: `${own}/a.ts`, old_string: "a", new_string: fixture }, "c3"),
  );
  assert.deepEqual(credentialAttempts(s.toolTexts), []);
  assert.deepEqual(foreignPaths(s.toolTexts, { ownDir: own, watched }), []);
  assert.equal(namesMark(s.toolTexts, ["/srv/code/repos/nimblenewt"]), false, "a reference path inside file text is not a read of it");
});

test("a real push, a real foreign path and the owner's keys are still flagged, from bash commands and from file tools' path fields", () => {
  const s = summary(
    call("bash", { command: "cd packages/controller && git push origin HEAD:main" }, "c1"),
    call("edit", { edits: [{ oldText: "a", newText: longText(5000) }], path: "/srv/code/worktrees-pi/c07m/packages/controller/src/x.ts" }, "c2"),
    call("read", { path: "/home/u/.ssh/id_rsa" }, "c3"),
    call("Read", { file_path: "/srv/code/repos/nimblenewt/README.md" }, "c4"),
  );
  assert.deepEqual(credentialAttempts(s.toolTexts), ["credentials", "push"]);
  assert.deepEqual(foreignPaths(s.toolTexts, { ownDir: own, watched }), ["/srv/code/worktrees-pi/c07m/packages/controller/src/x.ts", "/srv/code/repos/nimblenewt/README.md"]);
  assert.equal(namesMark(s.toolTexts, ["/srv/code/repos/nimblenewt"]), true);
  // A bash command is read in full however long: a push after a long heredoc is still seen.
  const long = summary(call("bash", { command: `cat > a.txt <<'EOF'\n${longText(5000)}EOF\ngit push gh HEAD` }));
  assert.equal(long.toolTexts[0].argsCut, true);
  assert.deepEqual(credentialAttempts(long.toolTexts), ["push"]);
  // A `command` field of a file tool is not run; a shell tool with no name known is read as one (old records).
  assert.deepEqual(argTexts({ command: "git push", path: "/x" }, "read").commands, []);
  assert.deepEqual(argTexts({ command: "git push" }).commands.map((c) => c.text), ["git push"]);
  // Nested path fields are read too; nested content fields are not.
  // (Review: a call with no tool name; a named tool that is not a file tool now reads every string as a command.)
  assert.deepEqual(argTexts({ files: [{ path: "/a" }, { path: "/b", content: "git push" }] }).paths.map((p) => p.text), ["/a", "/b"]);
});

test("a stored argument string that is not valid JSON (cut at its size limit): only what a strict reading of the visible text supports is flagged, and the reading says so", () => {
  // Batch 4, l02e-2: the cut fell inside the run's own checkout path.
  const cutOwn = JSON.stringify({ edits: [{ oldText: "a", newText: longText(1900) }], path: `${own}/packages/x.ts` }).slice(0, STORED_ARGS_LIMIT);
  const t = toolCallTexts(cutOwn);
  assert.equal(t.source, "visible-text", "the reading names itself as partial");
  assert.deepEqual(t.commands, [], "a cut edit is not read whole as a command");
  assert.deepEqual(foreignPaths([JSON.stringify({ edits: [{ oldText: "a", newText: "b" }], path: own }).slice(0, -20)], { ownDir: own, watched }), [], "a cut path that may still be the run's checkout");
  assert.deepEqual(foreignPaths([cutOwn], { ownDir: own, watched }), []);
  // Batch 4, c07m: a cut edit whose text holds a fixture with a push and a fake token.
  const cutFixture = JSON.stringify({ path: `${own}/e.test.ts`, edits: [{ oldText: "a", newText: `summary: "git push origin/main with token=${FAKE_TOKEN}"\n${longText(3000)}` }] }).slice(0, STORED_ARGS_LIMIT);
  assert.deepEqual(credentialAttempts([cutFixture]), []);
  assert.deepEqual(foreignPaths([cutFixture], { ownDir: own, watched }), []);
  // What the visible text does support is still flagged: a complete foreign path field before the cut, a cut path whose
  // visible part already lies outside the checkout, a cut command's whole words.
  assert.deepEqual(foreignPaths([`{"path":"/srv/code/repos/nimblenewt/a.ts","content":"${"x".repeat(100)}`], { ownDir: own, watched }), ["/srv/code/repos/nimblenewt/a.ts"]);
  assert.deepEqual(foreignPaths([`{"content":"x","path":"/srv/code/worktrees-pi/c07m/packages/contr`], { ownDir: own, watched }), ["/srv/code/worktrees-pi/c07m/packages/contr"]);
  assert.deepEqual(credentialAttempts([`{"command":"git push origin main ${"x".repeat(50)}`]), ["push"]);
  assert.deepEqual(credentialAttempts(['{"command":"git pu']), [], "a word the cut may have shortened is not read");
  assert.deepEqual(credentialAttempts(['{"path":"/home/u/.ssh/id_r']), ["credentials"], "a whole path component before the cut");
  // Text that is not JSON as far as it goes is one cut command line; a plain string is a command line.
  assert.equal(toolCallTexts("{ echo hi; git push x").source, "visible-text");
  assert.deepEqual(credentialAttempts(["{ echo hi; git push x"]), ["push"]);
  assert.deepEqual(toolCallTexts("git push").source, "plain");
});

test("the tolerant reader: complete values parsed, the value a cut ends inside kept as cut, cut escapes and literals dropped", () => {
  assert.deepEqual(parseVisible('{"a":1,"b":[true,"x"],"c":{"d":"e"}}'), { a: 1, b: [true, "x"], c: { d: "e" } });
  const v = parseVisible('{"a":"one","b":"tw');
  assert.equal(v.a, "one");
  assert.equal(v.b.text, "tw");
  assert.equal(parseVisible('{"a":"x\\u00').a.text, "x");
  assert.deepEqual(parseVisible('{"a":"x","n":12'), { a: "x" });
  assert.deepEqual(parseVisible('{"a":"x","b":tr'), { a: "x" });
  assert.deepEqual(parseVisible('{"a":"x","ke'), { a: "x" });
  assert.equal(parseVisible('{"a" "x"}'), undefined, "a syntax error before the end is not JSON");
  assert.equal(wholePart({ text: "git push orig", cut: true }), "git push ");
  assert.equal(wholePart({ text: "git push orig", cut: false }), "git push orig");
});

test("review: a command in an unexpected field, nested, or as an argv list is still read as a command", () => {
  const push = (args, tool) => credentialAttempts([argTexts(args, tool)]);
  for (const tool of ["bash", "powershell", "shell", "Bash", null]) {
    for (const key of ["args", "input", "cmdline", "script", "commands", "bash", "argv"]) {
      assert.deepEqual(push({ [key]: "git push origin HEAD" }, tool), ["push"], `${tool} ${key}`);
      assert.deepEqual(push({ [key]: ["git", "push", "origin"] }, tool), ["push"], `${tool} ${key} as a list`);
      assert.deepEqual(push({ params: { [key]: "git push origin HEAD" } }, tool), ["push"], `${tool} nested ${key}`);
    }
  }
  // A named tool that is not a file tool reads every string, content fields too.
  assert.deepEqual(push({ text: "git push x" }, "shell"), ["push"]);
  assert.deepEqual(push({ options: { whatever: "git remote add o https://example.invalid/x" } }, "run_command"), ["remote"]);
  // An object inside a content field is read field by field: a path there is not hidden.
  assert.deepEqual(foreignPaths([argTexts({ edits: [{ path: "/srv/code/repos/nimblenewt/a.ts", newText: "x" }] }, "edit")], { ownDir: own, watched }), ["/srv/code/repos/nimblenewt/a.ts"]);
  assert.deepEqual(foreignPaths([argTexts({ edits: [{ oldText: "/srv/code/repos/nimblenewt/a.ts", newText: "x" }] }, "edit")], { ownDir: own, watched }), [], "edit text stays data");
  // Deeper than any real call: read whole, not left out.
  let deep = { command: "git push x" };
  for (let k = 0; k < 12; k++) deep = { a: deep };
  assert.deepEqual(push(deep, "bash"), ["push"]);
  assert.deepEqual(push(deep, null), ["push"]);
  // A file tool's own `command` field is a path-like text (Claude's `str_replace_editor` names its action there).
  assert.deepEqual(argTexts({ command: "view", path: "/x" }, "Edit").commands, []);
});

test("review: a cut text is read as far as it is visible and to its last whole word", () => {
  assert.deepEqual(credentialAttempts(['{"command":"cd x && git push']), ["push"], "a push at the cut");
  assert.deepEqual(credentialAttempts(['{"command":"echo $SSH_AUTH_SOCK']), ["credentials"], "a socket name at the cut");
  assert.deepEqual(credentialAttempts(['{"command":"git remote add o ht']), ["remote"], "an address the cut shortened is not known to be local");
  assert.deepEqual(credentialAttempts(['{"command":"git pu']), []);
});

test("review: texts are bounded per call and per run, keep head and tail, and are marked; nothing is dropped unread", () => {
  // A command longer than TEXT_LIMIT: the push after it is in the tail.
  const t = argTexts({ command: `cat > a <<'EOF'\n${"y".repeat(TEXT_LIMIT * 3)}\nEOF\ngit push gh HEAD` }, "bash");
  assert.equal(t.textsCut, true);
  assert.ok(t.chars <= TEXT_LIMIT);
  assert.deepEqual(credentialAttempts([t]), ["push"]);
  assert.equal(t.commands[1].cutStart, true);
  // Many large path fields: the call stays within its room; a foreign path after them is still seen.
  const many = { files: Array.from({ length: 400 }, (_, k) => `/w/${k}/${"z".repeat(3000)}`).concat(["/srv/code/repos/nimblenewt/late.ts"]) };
  const m = argTexts(many, "read");
  assert.equal(m.textsCut, true);
  assert.ok(m.chars <= CALL_LIMIT + 2 * TEXT_LIMIT, `${m.chars}`);
  assert.deepEqual(foreignPaths([m], { ownDir: own, watched }), ["/srv/code/repos/nimblenewt/late.ts"]);
  // A run whose calls are huge: the summary stays bounded and every call is read.
  const huge = "q".repeat(CALL_LIMIT * 2);
  const lines = [];
  for (let k = 0; k < Math.ceil(SUMMARY_LIMIT / CALL_LIMIT) + 30; k++) lines.push(call("bash", { command: `echo ${huge}` }, `c${k}`));
  lines.push(call("bash", { command: `echo ${huge}; git push x` }, "last"));
  const s = summarizeLogText(lines.join("\n"));
  assert.ok(s.toolTextChars <= SUMMARY_LIMIT + 31 * SMALL_CALL_LIMIT + 2 * TEXT_LIMIT, `${s.toolTextChars}`);
  assert.equal(s.toolTexts.length, lines.length);
  assert.equal(s.toolTextsCut, lines.length);
  assert.deepEqual(credentialAttempts(s.toolTexts.slice(-1)), ["push"], "the last call is read, its tail kept");
  // Calls past the stored copies' 5,000 are still read.
  const after = summarizeLogText(Array.from({ length: 5002 }, (_, k) => call("bash", { command: k === 5001 ? "git push x" : "ls" }, `c${k}`)).join("\n"));
  assert.equal(after.toolCommands.length, 5000);
  assert.deepEqual(credentialAttempts(after.toolTexts), ["push"]);
});
