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

test("W09 third slice, second review: the forms the first review listed, as a table: what runs and what is refused; decimal arguments that add up to 60 s exactly are not refused", () => {
  const runs = [
    "sleep 1", "sleep 0.5", "sleep 60", "sleep 60.0", "sleep 60s", "sleep 1m", "sleep 2 && npm test", "sleepy-tool", "./bin/sleep 300", "/opt/sleep 300", "sleep 1e3", "sleep 0x10", "sleep -- 100", "sleep 1h30m", "SLEEP 300",
    "FOO=1 sleep 300", "time sleep 300", "exec sleep 300", "sleep 61 >/dev/null", "sleep 61 2>&1", "sleep 61 & wait", "sleep 61|true", "sleep 1234567890123", "sleep 00000000000061", "sleep -61", "sleep +61", "sleep 1m1",
    "sleep 61\\\nx", "sleep 0.1 52.2 7.7", "sleep 20.1 20.1 19.8", "sleep 0.7 0.7 58.6",
  ];
  for (const command of runs) assert.equal(waitRefusal(command), undefined, JSON.stringify(command));
  const refused: [string, string][] = [
    ["sleep 61", "61 s"], ["sleep 60.5", "61 s"], ["sleep 1.01m", "61 s"], ["sleep 0.02h", "72 s"], ["sleep 61s", "61 s"], ["sleep 000000000061", "61 s"], ["sleep 61 ;", "61 s"], ["sleep 61 #x", "61 s"], ["sleep 61\t&& x", "61 s"],
    ["sleep 8 8 8 8 8 8 8 8", "64 s"], ["\r\nsleep 61", "61 s"], ["sleep 61\r", "61 s"], ["sleep 0.1 52.2 7.8", "61 s"], ["sleep 1.1m 0.06m", "70 s"],
  ];
  for (const [command, named] of refused) assert.ok(waitRefusal(command)?.startsWith(`a command that waits ${named} `), JSON.stringify(command));
  // Every split of 60.0 s into three arguments of tenths runs (one of them is enough to pin the rounding; this sweeps a slice).
  for (let a = 0; a <= 600; a += 7) for (let b = 0; a + b <= 600; b += 3) {
    const command = `sleep ${(a / 10).toFixed(1)} ${(b / 10).toFixed(1)} ${((600 - a - b) / 10).toFixed(1)}`;
    assert.equal(waitRefusal(command), undefined, command);
  }
});
