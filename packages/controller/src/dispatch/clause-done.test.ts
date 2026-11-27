import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DoneVerdict } from "./dispatcher.js";
import type { ChangedTestsReport, DoneCheckReport, DoneCheckRequest, WorkerTurnResult } from "./ports.js";

after(stopServer);

// Card W09 second slice: a contract opts in with a check that has `changedTests`; its done then needs the test files the change adds or changes, built and passing, and, with acceptance criteria, PLAN.md mapping each
// criterion to one of those tests. The host lists and runs; the dispatcher judges. A refused done goes back to the agent with what failed and is not a finish.

const CRITERIA = ["Whatever the input, a line holds no raw control", "A label is exactly quotedText(label)"];
const FILES: ChangedTestsReport["files"] = [{ path: "src/chat/commands.test.ts", built: "dist/chat/commands.test.js", titles: ["every cut offset", "a label is quoted"] }];
const PLAN_OK = "- [x] C1: src/chat/commands.test.ts \"every cut offset\"\n- [x] C2: src/chat/commands.test.ts \"a label is quoted\"\n";
const tree = { uncommitted: ["src/chat/commands.ts"], uncommittedCount: 1, ahead: 0, changed: 2, agentCommits: false };
const report = (over: Partial<DoneCheckReport> & { tests?: ChangedTestsReport | null; run?: DoneCheckReport["checks"][number] }): DoneCheckReport => ({
  checkout: true, tree, checks: [{ name: "the build", state: "passed", exitCode: 0 }, over.run ?? { name: "the tests your change adds", state: "passed", exitCode: 0 }],
  ...(over.tests === null ? {} : { changedTests: over.tests ?? { count: 1, files: FILES, plan: { text: PLAN_OK } } }),
});

async function contract(w: DispatchWorld, taskId: string, criteria: readonly string[] = CRITERIA): Promise<void> {
  await w.contracts.setContract(w.owner, { commandId: `c-${taskId}`, taskId, expectedVersion: 0, ...(criteria.length === 0 ? {} : { acceptanceCriteria: [...criteria] }), checks: [{ name: "the build", run: ["tsc"] }, { name: "the tests your change adds", run: ["node", "--test"], changedTests: true }] } as never);
}

async function turn(w: DispatchWorld, inTurn: (attemptId: string, content: string) => Promise<void>, end: Partial<WorkerTurnResult> = {}): Promise<void> {
  w.worker.script = async ({ order }) => { await inTurn(order.attemptId, order.content); return { status: "completed", text: "turn over", endKind: "normal", ...end }; };
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
}

for (const backend of backends) {
  test(`${backend.name}: the contract's clauses and its changed-tests check are told at the start; each gap refuses the done with its own line; a done that maps every clause to a passing test of the change is taken (W09 second slice)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("quote lines", ann);
      await contract(w, taskId);
      const asked: DoneCheckRequest[] = [];
      const answers: DoneCheckReport[] = [
        report({ tests: { count: 0, files: [], plan: { text: PLAN_OK } }, run: { name: "the tests your change adds", state: "not-run", reason: "the change's test files cannot be run as they are" } }),
        report({ tests: { count: 1, files: [{ ...FILES[0]!, built: null }], plan: { text: PLAN_OK } }, run: { name: "the tests your change adds", state: "not-run", reason: "x" } }),
        report({ run: { name: "the tests your change adds", state: "failed", exitCode: 1, output: "not ok 1 - every cut offset\n# fail 1\n" } }),
        report({ tests: { count: 1, files: FILES, plan: { text: "- [x] C1: src/chat/commands.test.ts \"every cut offset\"\n- [ ] C2: later\n" } } }),
        report({}),
      ];
      w.worker.verify = async (_id, _scope, request) => { asked.push(request); return answers[asked.length - 1]!; };
      const verdicts: DoneVerdict[] = [];
      let content = "";
      await turn(w, async (attemptId, c) => {
        content = c;
        for (let i = 0; i < answers.length; i++) verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: `agent:ann:bridge:${i}` }));
      });
      // The start: which files the check runs, the clauses in order and the form of a step.
      assert.ok(content.includes('The check "the tests your change adds" runs the test files your change adds or changes (named *.test.* or *.spec.*; a TypeScript one from its built file, src/ becoming dist/)'), content);
      assert.ok(content.includes('The contract has 2 clause(s), in this order: C1 "Whatever the input, a line holds no raw control"; C2 "A label is exactly quotedText(label)".'), content);
      assert.ok(content.includes('- [x] C1: ... path/to/x.test.ts "its test name".'), content);
      // The host was asked for the check with its flag, after the build.
      assert.deepEqual(asked[0]!.checks, [{ name: "the build", run: ["tsc"], timeoutMs: 600_000 }, { name: "the tests your change adds", run: ["node", "--test"], timeoutMs: 600_000, changedTests: true }]);
      const messages = verdicts.map((v) => (v.state === "failed" || v.state === "unknown" ? v.message : v.state));
      assert.equal(verdicts[0]!.state, "failed");
      assert.match(messages[0]!, /1\. Check "the tests your change adds" runs the test files your change adds or changes, and it adds or changes none \(a file named \*\.test\.\* or \*\.spec\.\*\): write tests for what the task asks and end again\./);
      assert.match(messages[0]!, /2\. The contract has 2 clause\(s\) \(C1 to C2\) and your change adds or changes no test file/);
      assert.match(messages[1]!, /1\. Check "the tests your change adds" runs the built test files of your change, and 1 had no built file it can run after the checks before it ran \(a TypeScript test under src\/ runs from dist\/; a path that starts with - or holds any of .{15,30} is not run\): "src\/chat\/commands\.test\.ts"\./);
      assert.match(messages[2]!, /1\. Check "the tests your change adds" failed: it exited with code 1\. The end of its output \(quoted\): "not ok 1 - every cut offset # fail 1"\./, "the failing output goes back to the agent, bounded");
      assert.match(messages[3]!, /1\. PLAN\.md does not map 1 of the contract's 2 clause\(s\) to a test of your change: C2 \("A label is exactly quotedText\(label\)"\): its step is not ticked\./);
      // Each refusal counts toward the task's go-ons (W03, two): the first two say what to do, from the third the go-ons are used up (the attempt then ends blocked, never succeeded).
      assert.ok(messages.slice(0, 2).every((m) => /Fix these and call work\.end again/.test(m!)), "a refusal says what to do");
      assert.ok(verdicts.slice(2, 4).every((v) => v.state === "failed" && v.exhausted && /The go-ons of this task are used up/.test(v.message)), "and then that the go-ons are used up");
      assert.equal(verdicts[4]!.state, "passed", "the complete one passes the check itself");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a host that does not list the changed tests (an older or a remote one) leaves the check unmade, never passed; a contract without clauses checks only the tests (W09 second slice)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("no list", ann);
      await contract(w, taskId);
      let next: DoneCheckReport = report({ tests: null });
      w.worker.verify = async () => next;
      const verdicts: DoneVerdict[] = [];
      await turn(w, async (attemptId) => {
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k1" }));
        next = { ...report({}), changedTests: { count: 1, files: [{ path: "", built: null, titles: [] }], plan: { text: "" } } };
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k2" }));
      });
      for (const v of verdicts) {
        assert.equal(v.state, "unknown");
        if (v.state === "unknown") assert.match(v.message, /Check "the tests your change adds" runs the test files your change adds or changes, and the host did not list them, so it could not be made\./);
      }
      const { taskId: plain } = await w.task("no clauses", ann);
      await contract(w, plain, []);
      next = report({ tests: { count: 1, files: FILES, plan: { why: "there is no PLAN.md at the top of your checkout" } } });
      let content = "";
      const more: DoneVerdict[] = [];
      await turn(w, async (attemptId, c) => { content = c; more.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k3" })); });
      assert.equal(more[0]!.state, "passed", "no clauses: the plan is not judged (the old behaviour), only the tests");
      assert.ok(content.includes("runs the test files your change adds or changes") && !content.includes("clause(s)"), content);
    } finally { await store.close(); }
  });
}

test("first review: a change with more test files than one check runs is refused as failed (not unknown), and the start note lists every clause up to 50", async () => {
  const store = await backends[0]!.open();
  try {
    const w = await buildWorld(store.storage);
    const ann = await w.agent("ann", workGrants(w.project, []));
    const { taskId } = await w.task("many", ann);
    const fifty = Array.from({ length: 50 }, (_, i) => `clause number ${i + 1}`);
    await contract(w, taskId, fifty);
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `src/t${String(i).padStart(2, "0")}.test.ts`, built: `dist/t${String(i).padStart(2, "0")}.test.js`, titles: ["x"] }));
    w.worker.verify = async () => report({ tests: { count: 51, files, plan: { text: "" } }, run: { name: "the tests your change adds", state: "not-run", reason: "the change's test files cannot be run as they are" } });
    let content = "";
    const verdicts: DoneVerdict[] = [];
    await turn(w, async (attemptId, c) => { content = c; verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k1" })); });
    assert.equal(verdicts[0]!.state, "failed");
    if (verdicts[0]!.state === "failed") assert.match(verdicts[0]!.message, /1\. Check "the tests your change adds" runs the test files your change adds or changes, and it has 51 of them, more than the 50 one check runs\./);
    assert.ok(content.includes('C50 "clause number 50".') && content.includes("The contract has 50 clause(s)"), content.slice(-600));
  } finally { await store.close(); }
});

test("the contract takes changedTests as true on one check at most; false, another value or a second one is refused; a landing's checks keep it", async () => {
  const store = await backends[0]!.open();
  try {
    const w = await buildWorld(store.storage);
    const ann = await w.agent("ann", workGrants(w.project, []));
    const { taskId } = await w.task("contract", ann);
    const set = (checks: unknown[]) => w.contracts.setContract(w.owner, { commandId: `c-${Math.random()}`, taskId, expectedVersion: 0, checks } as never);
    await assert.rejects(set([{ name: "a", run: ["x"], changedTests: false }]), /changedTests: must be true or left out/);
    await assert.rejects(set([{ name: "a", run: ["x"], changedTests: "yes" }]), /changedTests: must be true or left out/);
    await assert.rejects(set([{ name: "a", run: ["x"], changedTests: true }, { name: "b", run: ["y"], changedTests: true }]), /checks\[1\]\.changedTests: is already set on another check/);
    await assert.rejects(set([{ name: "a", run: ["x"], changedTest: true }]), /is not a check field \(name, run, timeoutSeconds, changedTests\)/);
    await set([{ name: "a", run: ["x"] }, { name: "b", run: ["y"], changedTests: true, timeoutSeconds: 30 }]);
    const c = await w.contracts.get(w.owner, taskId);
    assert.deepEqual((c as unknown as { checks: unknown[] }).checks, [{ name: "a", run: ["x"] }, { name: "b", run: ["y"], timeoutSeconds: 30, changedTests: true }]);
  } finally { await store.close(); }
});
