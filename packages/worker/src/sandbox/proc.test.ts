import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linuxProcessTree, linuxStillRunning, MAX_RUN_PROCESSES, splitRunTree, type RunProcess } from "./proc.js";

// Card L02d: a run's processes read from a /proc the test writes (the real one is used by the launcher and the integration test).
function fakeProc(rows: readonly { pid: number; parent: number; name: string; started: number; state?: string }[]): string {
  const proc = mkdtempSync(join(tmpdir(), "nn-proc-"));
  for (const r of rows) {
    mkdirSync(join(proc, String(r.pid)));
    // Fields after the name: state, ppid, pgrp, session, tty, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice, threads, itrealvalue, starttime, ...
    writeFileSync(join(proc, String(r.pid), "stat"), `${r.pid} (${r.name}) ${r.state ?? "S"} ${r.parent} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${r.started} 1000 10\n`);
  }
  mkdirSync(join(proc, "self"));
  return proc;
}

test("the process tree of a run is its root and everything below it, parents first, without zombies or unrelated processes; names are printable and may hold spaces or parentheses", () => {
  const proc = fakeProc([
    { pid: 10, parent: 1, name: "bwrap", started: 100 },
    { pid: 11, parent: 10, name: "bwrap", started: 101 },
    { pid: 12, parent: 11, name: "node", started: 102 },
    { pid: 20, parent: 12, name: "my (odd) prog", started: 110 },
    { pid: 21, parent: 20, name: "sleep\u001b[31m", started: 111 },
    { pid: 22, parent: 12, name: "dead", started: 112, state: "Z" },
    { pid: 30, parent: 1, name: "other", started: 50 },
  ]);
  try {
    const tree = linuxProcessTree(10, proc);
    assert.equal(tree.truncated, false);
    assert.deepEqual(tree.processes.map((p) => [p.pid, p.parent, p.name, p.started]), [[10, 1, "bwrap", "100"], [11, 10, "bwrap", "101"], [12, 11, "node", "102"], [20, 12, "my (odd) prog", "110"], [21, 20, "sleep?[31m", "111"]]);
    assert.deepEqual(linuxProcessTree(99, proc).processes, [], "a root that is gone has no tree");
    // The same pid with another start time is another process (the ID was reused); a zombie has ended.
    const seen: RunProcess[] = [{ pid: 12, parent: 11, name: "node", started: "102" }, { pid: 20, parent: 12, name: "x", started: "999" }, { pid: 22, parent: 12, name: "dead", started: "112" }, { pid: 77, parent: 1, name: "gone", started: "1" }];
    assert.deepEqual(linuxStillRunning(seen, proc).map((p) => p.pid), [12]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

test("a tree larger than the bound is cut and says so; an unreadable process list is an error, never an empty list", () => {
  const rows = [{ pid: 2, parent: 1, name: "root", started: 1 }];
  for (let i = 0; i < MAX_RUN_PROCESSES + 5; i++) rows.push({ pid: 1000 + i, parent: 2, name: "child", started: 2 });
  const proc = fakeProc(rows);
  try {
    const tree = linuxProcessTree(2, proc);
    assert.equal(tree.processes.length, MAX_RUN_PROCESSES);
    assert.equal(tree.truncated, true);
  } finally { rmSync(proc, { recursive: true, force: true }); }
  assert.throws(() => linuxProcessTree(2, join(tmpdir(), "nn-no-such-proc-dir")), /cannot be read/);
});

test("a run's tree splits into the confinement down to the launched program, and the work the agent started (its children, and orphans the confinement adopted)", () => {
  const p = (pid: number, parent: number, name: string, started: number): RunProcess => ({ pid, parent, name, started: String(started) });
  const tree = [p(10, 1, "bwrap", 100), p(11, 10, "bwrap", 101), p(12, 11, "node", 102), p(13, 11, "sleep", 150), p(20, 12, "sh", 110), p(21, 20, "server", 111)];
  const split = splitRunTree(tree);
  assert.deepEqual(split.own.map((x) => x.pid), [10, 11, 12]);
  assert.equal(split.program?.pid, 12);
  assert.deepEqual(split.started.map((x) => x.pid), [13, 20, 21], "the orphan under the confinement's init counts as the agent's work");
  // A confinement that has not started the program yet: everything is its own, and there is no program.
  const early = splitRunTree([p(10, 1, "bwrap", 100), p(11, 10, "bwrap", 101)]);
  assert.equal(early.program, undefined);
  assert.deepEqual(early.own.map((x) => x.pid), [10, 11]);
  assert.deepEqual(early.started, []);
  // No confinement program (a launcher with no private process list): the root is the program.
  const plain = splitRunTree([p(5, 1, "node", 1), p(6, 5, "sleep", 2)]);
  assert.equal(plain.program?.pid, 5);
  assert.deepEqual(plain.started.map((x) => x.pid), [6]);
  assert.deepEqual(splitRunTree([]), { own: [], program: undefined, started: [] });
  // Review of L02d: a name is the program's own choice. Below bubblewrap's two processes, a process that calls itself `bwrap` is the program, and what it started is still listed as the agent's work.
  const renamed = splitRunTree([p(10, 1, "bwrap", 100), p(11, 10, "bwrap", 101), p(12, 11, "bwrap", 102), p(20, 12, "bwrap", 110), p(21, 20, "server", 111)]);
  assert.equal(renamed.program?.pid, 12);
  assert.deepEqual(renamed.started.map((x) => x.pid), [20, 21]);
});
