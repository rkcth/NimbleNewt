// Tests for card W01e: the contamination checks read each tool call's full parsed arguments, not the copy cut for size.
// Cases from W01 batch 4 (runs l02e-2-B-r1-20261118T080448 and c07m-B-r1-20261118T085505): a long edit whose `path` came
// after its edit text was cut inside that path, and a cut edit whose text held a test fixture was read as a command.
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeLogText } from "./lib/classify.mjs";
import { credentialAttempts } from "./lib/isolation.mjs";
import { foreignPaths, namesMark } from "./lib/runner.mjs";
import { STORED_ARGS_LIMIT, argTexts, parseVisible, toolCallTexts, wholePart } from "./lib/tool-args.mjs";

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
  assert.deepEqual(argTexts({ files: [{ path: "/a" }, { path: "/b", content: "git push" }] }, "multi").paths.map((p) => p.text), ["/a", "/b"]);
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
