import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProcessResult } from "./windows-host.js";
import { retryOnceOnTimeout, runBounded } from "./windows-real.js";

// CI fix (run 44242108811, Windows node 22): a PowerShell probe in the real Windows host ran out of time and was reported only as "exit null". The time limit of every program the
// real Windows host runs is now kept by runBounded, and a read-only probe gets one more try only after a timeout. These parts need no Windows: node itself stands in for the program,
// and a stand-in replaces taskkill, so they run on every operating system. That taskkill /T /F really ends a PowerShell tree can only be seen on Windows (windows-host-real.test.ts).

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

describe("runBounded: the time limit of a program the real Windows host runs", () => {
  test("a program that ends in time gives its exit code and output, and nothing is stopped", async () => {
    const stopped: number[] = [];
    const stopTree = async (pid: number): Promise<void> => { stopped.push(pid); };
    const ok = await runBounded(process.execPath, ["-e", "process.stdout.write('hello')"], { timeoutMs: 30_000 }, stopTree);
    assert.deepEqual(ok, { code: 0, stdout: "hello", stderr: "", timedOut: false });
    const bad = await runBounded(process.execPath, ["-e", "process.stderr.write('no'); process.exit(3)"], { timeoutMs: 30_000 }, stopTree);
    assert.deepEqual(bad, { code: 3, stdout: "", stderr: "no", timedOut: false });
    assert.deepEqual(stopped, []);
  });

  test("at the limit the tree is stopped while the program is still alive, then the program; a descendant holding the pipes does not hold the result back", async () => {
    // The program starts a descendant that inherits its output pipes and outlives it, says the descendant's process id, and then waits far past the limit.
    const program = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
      "process.stdout.write('descendant=' + g.pid + '\\n');",
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    const calls: { pid: number; aliveThen: boolean }[] = [];
    const stopTree = async (pid: number): Promise<void> => { calls.push({ pid, aliveThen: alive(pid) }); };
    let descendant: number | undefined;
    const started = Date.now();
    try {
      const r = await runBounded(process.execPath, ["-e", program], { timeoutMs: 1500 }, stopTree);
      const took = Date.now() - started;
      descendant = Number(/descendant=(\d+)/.exec(r.stdout)?.[1]);
      assert.equal(r.timedOut, true);
      assert.equal(r.code, null);
      assert.match(r.stderr, /timed out after 2 s and was stopped/);
      assert.ok(took < 1500 + 4_000, `the result came back ${String(took)} ms after the start, though the descendant still holds the pipes`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.aliveThen, true, "the tree is stopped from the parent while the parent still runs (taskkill /T needs it to find the descendants)");
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0, r.stdout);
      assert.equal(alive(descendant), true, "the stand-in tree stop did not end the descendant, so only the closed pipes let the result through");
    } finally {
      if (descendant !== undefined && Number.isSafeInteger(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ } }
    }
  });

  test("a tree stop that fails does not stop the program from being ended", async () => {
    const r = await runBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 500 }, async () => { throw new Error("taskkill missing"); });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
  });

  test("a tree stop that throws at once (not a rejected promise) still lets the program be ended and the result come back", async () => {
    const r = await runBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 500 }, (): Promise<void> => { throw new Error("could not start taskkill"); });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
  });

  test("review: a program that already ended while a descendant still holds its pipes is not stopped by its id (the id may belong to another program by then); the result still comes back", async () => {
    // The program starts a descendant that inherits its pipes and outlives it, says its id, and ends at once; the descendant keeps the pipes open past the limit.
    const program = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
      "process.stdout.write('descendant=' + g.pid + '\\n');",
      "g.unref();",
    ].join("\n");
    const calls: number[] = [];
    let descendant: number | undefined;
    const started = Date.now();
    try {
      const r = await runBounded(process.execPath, ["-e", program], { timeoutMs: 1500 }, async (pid) => { calls.push(pid); });
      const took = Date.now() - started;
      descendant = Number(/descendant=(\d+)/.exec(r.stdout)?.[1]);
      assert.equal(r.timedOut, true);
      assert.deepEqual(calls, [], "no tree stop for a program whose end was already seen");
      assert.ok(took < 1500 + 4_000, `the result came back ${String(took)} ms after the start`);
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0, r.stdout);
    } finally {
      if (descendant !== undefined && Number.isSafeInteger(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
});

describe("retryOnceOnTimeout: a read-only probe that ran out of time is tried once more, and only then", () => {
  const result = (r: Partial<ProcessResult>): ProcessResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });
  const scripted = (answers: ProcessResult[]): { attempt: () => Promise<ProcessResult>; calls: () => number } => {
    let n = 0;
    return { attempt: async () => answers[n++] ?? result({ stdout: "unexpected extra try" }), calls: () => n };
  };
  test("a timeout followed by an answer gives the answer after two tries", async () => {
    const s = scripted([result({ code: null, timedOut: true }), result({ stdout: "null" })]);
    assert.deepEqual(await retryOnceOnTimeout(s.attempt), result({ stdout: "null" }));
    assert.equal(s.calls(), 2);
  });
  test("a failure that is not a timeout is not retried, so a refusal stays a refusal", async () => {
    const s = scripted([result({ code: 1, stderr: "access denied" }), result({ stdout: "null" })]);
    assert.deepEqual(await retryOnceOnTimeout(s.attempt), result({ code: 1, stderr: "access denied" }));
    assert.equal(s.calls(), 1);
  });
  test("two timeouts end with the timeout; there is no third try", async () => {
    const s = scripted([result({ code: null, timedOut: true }), result({ code: null, timedOut: true, stderr: "second" }), result({ stdout: "null" })]);
    assert.deepEqual(await retryOnceOnTimeout(s.attempt), result({ code: null, timedOut: true, stderr: "second" }));
    assert.equal(s.calls(), 2);
  });
  test("an answer the first time is used as it is", async () => {
    const s = scripted([result({ stdout: "{}" })]);
    assert.deepEqual(await retryOnceOnTimeout(s.attempt), result({ stdout: "{}" }));
    assert.equal(s.calls(), 1);
  });
});
