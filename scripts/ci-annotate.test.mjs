import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { annotations, escapeData, escapeProperty, failures, specFailures, tapFailures, timeline } from "./ci-annotate.mjs";

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
  assert.equal(specFailures(manySpec.split("\n")).length, 20, "parsing finds all of them");
  assert.equal(failures(manySpec.split("\n")).length, 8, "annotating is capped");
});

test("tests cancelled because a file's process ended are collapsed into one line after the real failures", () => {
  const cancelled = (name) => `not ok 1 - ${name}\n  ---\n  failureType: 'cancelledByParent'\n  error: 'Promise resolution is still pending but the event loop has already resolved'\n  ...`;
  const real = "not ok 9 - the one that matters\n  ---\n  failureType: 'testCodeFailure'\n  error: 'boom'\n  ...";
  const log = [...Array.from({ length: 30 }, (_, i) => cancelled(`victim ${i}`)), real].join("\n");
  const found = failures(log.split("\n"));
  assert.equal(found.length, 2);
  assert.equal(found[0].name, "the one that matters");
  assert.match(found[1].name, /^30 test\(s\) cancelled because their test file's process ended early/);
  assert.match(found[1].text, /first: victim 0/);
  assert.equal(failures(Array.from({ length: 30 }, (_, i) => cancelled(`v${i}`)).join("\n").split("\n")).length, 1, "only symptoms: one line");
});

test("the embedded PostgreSQL startup timeline is surfaced as its own annotation, without colons or commas in the title", () => {
  const log = "noise\n[embedded-postgres] +0 ms initdb: begin\n[embedded-postgres] +4200 ms initdb: done\nmore noise";
  assert.deepEqual(timeline(log.split("\n")), ["[embedded-postgres] +0 ms initdb: begin", "[embedded-postgres] +4200 ms initdb: done"]);
  const lines = annotations(log);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error title=Embedded PostgreSQL startup timeline::\[embedded-postgres\] \+0 ms initdb: begin%0A/);
  assert.equal(annotations("nothing relevant").length, 1);
});

test("the total number of annotations never exceeds GitHub's limit of 10 per step, and the timeline and tail always survive", () => {
  const real = (i) => `not ok ${i} - real failure ${i}\n  ---\n  failureType: 'testCodeFailure'\n  error: 'x'\n  ...`;
  const cancelled = "not ok 99 - victim\n  ---\n  failureType: 'cancelledByParent'\n  error: 'Promise resolution is still pending but the event loop has already resolved'\n  ...";
  for (const withTimeline of [false, true]) {
    for (const withSymptoms of [false, true]) {
      const log = [...Array.from({ length: 40 }, (_, i) => real(i + 1)), ...(withSymptoms ? [cancelled] : []), ...(withTimeline ? ["[embedded-postgres] +1 ms step: begin"] : [])].join("\n");
      const lines = annotations(log);
      assert.ok(lines.length <= 10, `${lines.length} annotations (timeline ${withTimeline}, symptoms ${withSymptoms})`);
      assert.match(lines[lines.length - 1], /Test output \(last 80 lines\)/);
      assert.equal(lines.some((l) => /Embedded PostgreSQL startup timeline/.test(l)), withTimeline);
      assert.equal(lines.some((l) => /cancelled because their test file's process ended early/.test(l)), withSymptoms);
    }
  }
});
