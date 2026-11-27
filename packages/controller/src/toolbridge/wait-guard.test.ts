import assert from "node:assert/strict";
import { test } from "node:test";
import { WAIT_GUARD, leadingSleepSeconds, waitRefusal } from "./wait-guard.js";

// Card W09 third slice: the checkout tool's run refuses a command that only waits (the bench's timeouts spent up to 29 minutes in `sleep 240` to `sleep 420` polls).

test("W09 third slice: a leading plain sleep is read with its units, alone or before ;, &&, ||, a line break or a comment", () => {
  const cases: [string, number][] = [
    ["sleep 240", 240], ["sleep 420", 420], ["  sleep 61  ", 61], ["\n\tsleep 90", 90], ["sleep 4m", 240], ["sleep 1.5h", 5400], ["sleep 2d", 172_800], ["sleep 0.5", 0.5], ["sleep .5", 0.5], ["sleep 240.", 240], ["sleep 30s", 30],
    ["sleep 30 31", 61], ["sleep 1m 1", 61], ["sleep 240; tail -n 50 out.log", 240], ["sleep 240;tail out.log", 240], ["sleep 240 && cat x", 240], ["sleep 240&&cat x", 240], ["sleep 240 || true", 240], ["sleep 240\nnpm test", 240], ["sleep 240\r\nx", 240],
    ["sleep 240 # wait for the run", 240], ["/bin/sleep 300", 300], ["/usr/bin/sleep 300", 300], ["sleep\t240", 240],
  ];
  for (const [command, seconds] of cases) assert.equal(leadingSleepSeconds(command), seconds, JSON.stringify(command));
  assert.equal(leadingSleepSeconds("sleep infinity"), Number.POSITIVE_INFINITY);
  assert.equal(leadingSleepSeconds("sleep inf"), Number.POSITIVE_INFINITY);
});

test("W09 third slice: anything the reading is not certain of is left alone (never refused)", () => {
  const left = [
    "", "sleep", "sleep ", "sleep;", "sleep # x", "sleep240", "sleep#240", "sleep 240#x", "sleep 2#40", "sleep $T", "sleep \"240\"", "sleep '240'", "sleep ${T}", "sleep $((240))", "sleep -- 240", "sleep --help", "sleep 240x", "sleep 4w", "sleep 1e3",
    "sleep 240 &", "sleep 240&", "sleep 240 | cat", "sleep 240|cat", "(sleep 240)", "{ sleep 240; }", "nohup sleep 240", "timeout 300 npm test", "npm test; sleep 300", "echo sleep 240", "SLEEP 240", "Sleep 240", "sleepy 240", "./sleep 240", "\\sleep 240",
    "while true; do sleep 300; done", "for i in 1 2; do sleep 240; done", "sleep 1.2.3", "sleep ..5", "sleep 1234567890123", `sleep ${"1 ".repeat(WAIT_GUARD.args + 1)}`.trim(),
  ];
  for (const command of left) assert.equal(leadingSleepSeconds(command), undefined, JSON.stringify(command));
  // A command longer than the scan is not judged at all, even when it starts with a long sleep.
  assert.equal(leadingSleepSeconds(`sleep 240; ${"x".repeat(WAIT_GUARD.scan)}`), undefined);
  assert.equal(leadingSleepSeconds(`sleep 240;${"x".repeat(WAIT_GUARD.scan - 10)}`), 240, "at the bound it is judged");
  assert.equal(leadingSleepSeconds(`sleep 240;${"x".repeat(WAIT_GUARD.scan - 9)}`), undefined, "one over the bound it is not");
  // The most arguments one sleep may have are read; one more is not.
  assert.equal(leadingSleepSeconds(`sleep ${"10 ".repeat(WAIT_GUARD.args)}`.trim()), 10 * WAIT_GUARD.args);
});

test("W09 third slice: only a wait of more than 60 s is refused, and the refusal names the wait and the way on", () => {
  assert.equal(WAIT_GUARD.maxSleepSeconds, 60);
  for (const ok of ["sleep 60", "sleep 59.9", "sleep 1m", "sleep 30 30", "sleep 0", "npm test", "node --test dist/a.test.js"]) assert.equal(waitRefusal(ok), undefined, ok);
  assert.equal(waitRefusal("sleep 60.5"), "a command that waits 61 s (more than 60 s) is not run: run the test files you named directly (for example node --test followed by the file) and read their result; once the build and those tests pass, end with work-end");
  assert.match(waitRefusal("sleep 61")!, /^a command that waits 61 s /);
  // First review: a wait just over the limit is named rounded up, never as the limit itself.
  assert.match(waitRefusal("sleep 60.4")!, /^a command that waits 61 s /);
  assert.match(waitRefusal("sleep 60.0001")!, /^a command that waits 61 s /);
  assert.equal(waitRefusal("sleep 60.0"), undefined);
  assert.match(waitRefusal("sleep 1m 1")!, /waits 61 s/);
  assert.match(waitRefusal("sleep 420 && npm test")!, /waits 420 s/);
  assert.match(waitRefusal("sleep infinity")!, /waits without end/);
  assert.ok(waitRefusal("sleep 99999999999")!.length < 300, "bounded");
});

test("W09 third slice: hostile commands are read in linear time and never throw", () => {
  const hostile = [" ".repeat(8000), "sleep " + " ".repeat(8000), "sleep " + "1".repeat(8000), "sleep " + "1 ".repeat(4000), "sleep 1" + ";".repeat(8000), "\n".repeat(8000) + "sleep 240", "sleep " + ".".repeat(8000), "sleep\u0000240", "sleep\u00a0240", "sleep 2\u0664\u0660"];
  const started = performance.now();
  for (const command of hostile) { assert.doesNotThrow(() => waitRefusal(command)); }
  assert.ok(performance.now() - started < 200, "bounded scan");
  // Non-ASCII digits and spaces are not the shell's: left alone.
  assert.equal(leadingSleepSeconds("sleep\u00a0240"), undefined);
  assert.equal(leadingSleepSeconds("sleep 2\u0664\u0660"), undefined);
  assert.equal(leadingSleepSeconds("sleep\u0000240"), undefined);
});
