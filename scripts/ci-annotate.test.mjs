import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { annotations, escapeData, escapeProperty, failures, specFailures, tapFailures } from "./ci-annotate.mjs";

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8").split(/\r?\n/);
const spec = fixture("node24-spec-failures.log"); // a real Node 24 run, output piped to a file
const tap = fixture("node-tap-failures.log"); // a real run with --test-reporter=tap

test("the spec format printed by Node 24 on a pipe yields each failing leaf once, with its error", () => {
  const found = specFailures(spec);
  assert.deepEqual(found.map((f) => f.name), ["leaf a::b, c: d", "another failing one"]);
  assert.match(found[0].text, /expected one but got two/);
  assert.match(found[1].text, /boom: 100%/);
  assert.ok(!found.some((f) => /^test at /m.test(f.text)), "a block must not run into the next failure");
});

test("the TAP format yields the same failures, not the suite that merely contains one, and stops at the end of the YAML block", () => {
  const found = tapFailures(tap);
  assert.deepEqual(found.map((f) => f.name), ["leaf a::b, c: d", "another failing one"]);
  assert.match(found[0].text, /expected one but got two/);
  assert.ok(!found.some((f) => /^# (tests|pass|fail)|^1\.\.\d/m.test(f.text)), "the end-of-file summary must not leak into a block");
});

test("failures() picks whichever format the log is in", () => {
  assert.equal(failures(spec).length, 2);
  assert.equal(failures(tap).length, 2);
  assert.deepEqual(failures("all good\nok 1 - fine".split("\n")), []);
});

test("annotation titles escape colon and comma, messages escape newlines and percent, so a hostile name cannot add properties", () => {
  assert.equal(escapeProperty("a::b, c: d%\n"), "a%3A%3Ab%2C c%3A d%25%0A");
  assert.equal(escapeData("a::b, c: d%\r\n"), "a::b, c: d%25%0D%0A");
  for (const log of [spec.join("\n"), tap.join("\n")]) {
    const lines = annotations(log);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.ok(!line.includes("\n"));
      const afterCommand = line.slice("::error ".length);
      const title = afterCommand.slice(0, afterCommand.indexOf("::"));
      assert.match(title, /^title=[^:,]*$/, `title must contain no raw colon or comma: ${title}`);
    }
    assert.match(lines[0], /^::error title=Failed - leaf a%3A%3Ab%2C c%3A d::/);
    assert.match(lines[2], /^::error title=Test output \(last 80 lines\)::/);
  }
});

test("a log with no failures still yields the tail, and many failures are capped", () => {
  assert.equal(annotations("all good").length, 1);
  const many = Array.from({ length: 20 }, (_, i) => `not ok ${i + 1} - t${i}\n  ---\n  error: 'x'\n  ...`).join("\n");
  assert.equal(failures(many.split("\n")).length, 8);
  const manySpec = ["✖ failing tests:", "", ...Array.from({ length: 20 }, (_, i) => `test at f.mjs:${i}:1\n✖ t${i} (1ms)\n  Error: x\n`)].join("\n");
  assert.equal(specFailures(manySpec.split("\n")).length, 8);
});
