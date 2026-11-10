import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import { doneRefusal, type DoneVerdict } from "./dispatcher.js";
import type { DoneCheckReport, DoneCheckRequest, WorkerTurnResult } from "./ports.js";
import { STOPPED_EARLY_KIND } from "./model.js";

after(stopServer);

// Card W05: an agent's work.end done is checked against the task contract before it is taken. The dispatcher asks the attempt's host (the checkout's state, the evidence files, the contract's check commands run in the sandbox)
// and judges; the agent has no say in the verdict. What did not pass is listed in a fixed-format message (agent text and check output quoted once, redacted); a done that is not taken counts toward the task's W03 go-ons.

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const CLEAN: DoneCheckReport = { checkout: true, tree: { uncommitted: [], uncommittedCount: 0, ahead: 1, changed: 2 }, evidence: [{ path: "logs/test.txt", present: true }, { path: "shots/a.png", present: true }], checks: [{ name: "unit tests", state: "passed", exitCode: 0, ms: 1200 }, { name: "lint", state: "passed", exitCode: 0, ms: 300 }] };
const DIRTY: DoneCheckReport = {
  checkout: true,
  tree: { uncommitted: ["src/a.ts", "notes‮.md", "c", "d", "e", "f", "g"], uncommittedCount: 7, ahead: 0, changed: 7 },
  evidence: [{ path: "logs/test.txt", present: false, why: "not in the last commit" }],
  checks: [{ name: "unit tests", state: "failed", exitCode: 1, ms: 900, output: `${"x".repeat(5000)}\nFAIL parser.test.ts: expected 2, got 1 (key ${SECRET}) ‮ end\n` }, { name: "lint", state: "passed", exitCode: 0 }],
};

const LINT = { name: "lint", run: ["npm", "run", "lint"] };

async function withContract(w: DispatchWorld, taskId: string, fields: Record<string, unknown> = {}): Promise<void> {
  await w.contracts.setContract(w.owner, { commandId: `c-${taskId}`, taskId, expectedVersion: 0, requiredEvidence: ["test log", "screenshot"], checks: [{ name: "unit tests", run: ["npm", "test"] }, { name: "lint", run: ["npm", "run", "lint"], timeoutSeconds: 30 }], ...fields } as never);
}

/** Runs one turn of the attempt; `inTurn` runs while the attempt is running (as a work.end call does). The turn then ends normally. */
async function turn(w: DispatchWorld, inTurn: (attemptId: string) => Promise<void>, end: Partial<WorkerTurnResult> = {}): Promise<void> {
  w.worker.script = async ({ order }) => { await inTurn(order.attemptId); return { status: "completed", text: "turn over", endKind: "normal", ...end }; };
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
}

const countOf = async (w: DispatchWorld, taskId: string): Promise<number> => ((await w.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }))?.body as { readmits?: number } | undefined)?.readmits ?? 0;

for (const backend of backends) {
  test(`${backend.name}: a done with uncommitted files, no commit ahead, missing evidence and a failing check is refused with the list, once per call, and a done that passes is taken (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("parser", ann);
      await withContract(w, taskId);
      const asked: DoneCheckRequest[] = [];
      let report = DIRTY;
      w.worker.verify = async (_id, scope, request) => { assert.equal(scope.taskId, taskId); asked.push(request); return report; };
      const verdicts: DoneVerdict[] = [];
      await turn(w, async (attemptId) => {
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "agent:ann:bridge:1", evidence: [{ item: "test log", path: "logs/test.txt" }] }));
        // The same call again (a retry, the bridge answering twice): the recorded verdict, the host is not asked and nothing is counted again.
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "agent:ann:bridge:1", evidence: [{ item: "test log", path: "logs/test.txt" }] }));
        report = CLEAN;
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "agent:ann:bridge:2", evidence: [{ item: "test log", path: "logs/test.txt" }, { item: "screenshot", path: "shots/a.png" }] }));
      });
      const [first, again, passed] = verdicts;
      assert.equal(first!.state, "failed");
      if (first!.state !== "failed") return;
      assert.equal(first!.exhausted, false);
      const lines = first!.message.split("\n");
      assert.equal(lines[0], "work.end done was not accepted: the controller checked your work against the task contract and 5 item(s) did not pass.");
      assert.match(lines[1]!, /^1\. Required evidence "screenshot" is not named: give it in work\.end evidence as \{ item, path \}/);
      assert.match(lines[2]!, /^2\. The checkout has 7 file\(s\) that are not committed: "src\/a\.ts", "notes\\u202e\.md", "c", "d", "e" and 2 more\. Commit them/);
      assert.match(lines[3]!, /^3\. There is no commit ahead of the task's base\./);
      assert.match(lines[4]!, /^4\. Required evidence "test log": "logs\/test\.txt" is not a plain, non-empty file of your checkout \("not in the last commit"\)/);
      assert.match(lines[5]!, /^5\. Check "unit tests" failed: it exited with code 1\. The end of its output \(quoted\): ".*FAIL parser\.test\.ts: expected 2, got 1 \(key \[redacted\]\) \\u202e end"\./);
      assert.match(lines[6]!, /^Fix these and call work\.end again/);
      assert.ok(!first!.message.includes(SECRET), "a secret in a check's output is never shown");
      assert.ok(!first!.message.includes("‮"), "controls in what came from elsewhere are escaped");
      assert.ok(lines[5]!.length < 800, "a check's output is bounded");
      assert.deepEqual(again, first, "the same call gets the recorded verdict");
      assert.equal(passed!.state, "passed");
      // What the host was asked: the contract's commands with their times, the evidence paths named, and a cap on the output. Twice, not three times.
      assert.equal(asked.length, 2);
      assert.deepEqual(asked[0]!.checks, [{ name: "unit tests", run: ["npm", "test"], timeoutMs: 600_000 }, { name: "lint", run: ["npm", "run", "lint"], timeoutMs: 30_000 }]);
      assert.deepEqual(asked[0]!.evidence, ["logs/test.txt"]);
      assert.equal(asked[0]!.maxOutputBytes, 64 * 1024);
      // Recorded on the attempt, the failed one counted toward the task's go-ons once.
      const d = (await w.dispatcher.get(w.owner, verdictAttempt(w)))!;
      assert.deepEqual(d.verifications?.map((v) => [v.key, v.state, v.counted, v.contract]), [["agent:ann:bridge:1", "failed", true, 1], ["agent:ann:bridge:2", "passed", false, 1]]);
      assert.deepEqual(d.verifications?.[0]?.checks.map((c) => [c.name, c.state, c.exitCode]), [["unit tests", "failed", 1], ["lint", "passed", 0]]);
      assert.ok(!JSON.stringify(d).includes(SECRET));
      assert.equal(await countOf(w, taskId), 1);
    } finally { await store.close(); }
  });
}

/** The attempt the world started last (the dispatcher records it on the scripted host). */
const verdictAttempt = (w: DispatchWorld): string => w.worker.starts[w.worker.starts.length - 1]!.attemptId;

for (const backend of backends) {
  test(`${backend.name}: a task with no contract is not checked and the host is not asked (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      await w.task("no contract", ann);
      let asked = 0;
      w.worker.verify = async () => { asked++; return CLEAN; };
      let v: DoneVerdict | undefined;
      await turn(w, async (attemptId) => { v = await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k1" }); });
      assert.deepEqual(v, { state: "skipped" });
      assert.equal(asked, 0);
      assert.equal((await w.dispatcher.get(w.owner, verdictAttempt(w)))!.verifications, undefined);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: what cannot be checked is never passed: a host that cannot check, one that fails and a check that did not run each count, and the third is the last (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("unknowns", ann);
      await withContract(w, taskId, { requiredEvidence: [] });
      const verdicts: DoneVerdict[] = [];
      await turn(w, async (attemptId) => {
        // No verify on the host.
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k1" }));
        w.worker.verify = async () => { throw new Error(`the sandbox is gone (token ${SECRET})`); };
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k2" }));
        w.worker.verify = async () => ({ ...CLEAN, evidence: [], checks: [{ name: "unit tests", state: "not-run", reason: "the attempt has no sandbox open on this host" }, { name: "lint", state: "passed", exitCode: 0 }] });
        verdicts.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "k3" }));
      });
      assert.deepEqual(verdicts.map((v) => v.state), ["unknown", "unknown", "unknown"]);
      const [none, threw, notRun] = verdicts as Extract<DoneVerdict, { state: "unknown" }>[];
      assert.match(none!.message, /^work\.end done was not accepted: the controller could not check your work against the task contract \(1 item\(s\)\)\.\n1\. The host this attempt runs on \(host:w1\) cannot check work/);
      assert.match(threw!.message, /The host could not check the work: "the sandbox is gone \(token \[redacted\]\)"/);
      assert.match(notRun!.message, /Check "unit tests" could not be run by the host: "the attempt has no sandbox open on this host"/);
      assert.deepEqual(verdicts.map((v) => (v as { exhausted: boolean }).exhausted), [false, false, true], "two go-ons, then the done ends the attempt");
      assert.match(notRun!.message, /The go-ons of this task are used up, so the attempt ends now, blocked/);
      assert.match(notRun!.summary, /^The agent's work\.end done was not accepted \(the checks could not be made\), and the task's go-ons are used up: 1\. Check "unit tests" could not be run/);
      assert.equal(await countOf(w, taskId), 3);

      // A check that could not run beside one that definitely failed: failed, not unknown.
      const second = await w.task("mixed", ann);
      await withContract(w, second.taskId, { requiredEvidence: [] });
      w.worker.verify = async () => ({ ...CLEAN, tree: { uncommitted: ["a"], uncommittedCount: 1, ahead: 1, changed: 1 }, checks: [{ name: "unit tests", state: "not-run", reason: "no sandbox" }, { name: "lint", state: "passed" }] });
      let mixed: DoneVerdict | undefined;
      await turn(w, async (attemptId) => { mixed = await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "m1" }); });
      assert.equal(mixed?.state, "failed");
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a done that was not taken counts toward the W03 go-ons: after it one early stop is let go on, the next ends the attempt (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("counted", ann);
      await withContract(w, taskId, { requiredEvidence: [], checks: [LINT], priority: 7 });
      w.worker.verify = async () => ({ checkout: true, tree: { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 0 }, evidence: [], checks: [{ name: "lint", state: "passed" }] });
      let n = 0;
      await turn(w, async (attemptId) => { const v = await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "d1" }); assert.equal(v.state, "failed"); }, { endKind: "no-work-end", checkpoint: { turn: ++n } });
      let d = (await w.dispatcher.get(w.owner, verdictAttempt(w)))!;
      assert.equal(d.state, "waiting", "the early stop after the failed done is let go on");
      assert.equal(await countOf(w, taskId), 2, "one for the done, one for the go-on");
      await turn(w, async () => undefined, { endKind: "no-work-end", checkpoint: { turn: ++n } });
      d = (await w.dispatcher.get(w.owner, verdictAttempt(w)))!;
      assert.equal(d.state, "finished");
      assert.equal(d.outcome?.status, "stopped-early", "the go-ons are used up: the done that failed was not a free one");
      assert.deepEqual(d.stoppedEarly?.map((r) => r.readmitted), [true, false]);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: with submit, uncommitted work is carried by the submission, but a checkout with no change is not; without submit it must be committed (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("submit", ann);
      await withContract(w, taskId, { requiredEvidence: [], checks: [LINT], priority: 7 });
      let tree = { uncommitted: ["src/a.ts", "src/b.ts", "test/c.ts"], uncommittedCount: 3, ahead: 0, changed: 3 };
      w.worker.verify = async () => ({ checkout: true, tree, evidence: [], checks: [{ name: "lint", state: "passed" }] });
      const v: DoneVerdict[] = [];
      await turn(w, async (attemptId) => {
        v.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "s1", submit: true }));
        v.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "s2" }));
        tree = { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 0 };
        v.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "s3", submit: true }));
      });
      assert.equal(v[0]!.state, "passed");
      assert.equal(v[1]!.state, "failed");
      assert.match((v[1] as { message: string }).message, /3 file\(s\) that are not committed[\s\S]*end with submit true[\s\S]*There is no commit ahead/);
      assert.equal(v[2]!.state, "failed");
      assert.match((v[2] as { message: string }).message, /1\. Your checkout holds no change against the task's base, so there is nothing to submit\./);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the agent cannot loosen its own checks: a contract it changed after the attempt began is not the one checked; the owner's change is (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", [...workGrants(w.project, []), { action: "task.contract.write", project: w.project }]);
      const annP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
      const { taskId } = await w.task("own checks", ann);
      await withContract(w, taskId, { requiredEvidence: [] });
      const asked: DoneCheckRequest[] = [];
      w.worker.verify = async (_id, _s, request) => { asked.push(request); return { ...CLEAN, evidence: [] }; };
      await turn(w, async (attemptId) => {
        await w.contracts.setContract(annP, { commandId: "loosen", taskId, expectedVersion: 1, checks: [] } as never);
        await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "a1" });
        await w.contracts.setContract(w.owner, { commandId: "owner-narrows", taskId, expectedVersion: 2, checks: [{ name: "lint", run: ["npm", "run", "lint"] }] } as never);
        await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "a2" });
      });
      assert.deepEqual(asked.map((r) => r.checks.map((c) => c.name)), [["unit tests", "lint"], ["lint"]]);
      const d = (await w.dispatcher.get(w.owner, verdictAttempt(w)))!;
      assert.deepEqual(d.verifications?.map((v) => v.contract), [1, 3]);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: two checks of the same call at once ask the host once, and after a restart the recorded verdict is given again without asking (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("once", ann);
      await withContract(w, taskId, { requiredEvidence: [] });
      let asked = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      w.worker.verify = async () => { asked++; await gate; return DIRTY; };
      let attempt = "";
      await turn(w, async (attemptId) => {
        attempt = attemptId;
        const both = Promise.all([w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "c1" }), w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "c1" })]);
        await new Promise((r) => setTimeout(r, 20));
        release();
        const [a, b] = await both;
        assert.deepEqual(a, b);
      }, { endKind: "no-work-end", checkpoint: { turn: 1 } });
      assert.equal(asked, 1);
      assert.equal(await countOf(w, taskId), 2, "the done once, and the early stop that followed");
      const restarted = w.restart();
      const again = await restarted.verifyDone(w.dispatcherPrincipal, attempt, { key: "c1" });
      assert.equal(again.state, "failed");
      assert.equal(asked, 1, "the recorded verdict, not a new check");
      assert.equal(await countOf(w, taskId), 2);
      const annP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
      await assert.rejects(restarted.verifyDone(annP, attempt, { key: "c2" }), /may not control/, "an agent cannot ask for a verdict itself");
    } finally { await store.close(); }
  });
}

test("the refusal text is bounded as a whole: past its size the rest are counted, not shown (W05)", () => {
  const text = doneRefusal({ state: "failed", exhausted: false, failures: Array.from({ length: 12 }, (_, i) => `failure ${i} ${"w".repeat(880)}`) });
  assert.ok(text.length < 6600, String(text.length));
  assert.match(text, /\n\(6 more item\(s\) not shown\.\)\nFix these/);
});

for (const backend of backends) {
  test(`${backend.name}: a contract that names no evidence and no checks (stored for its priority, difficulty or criteria alone) is not checked and the host is not asked (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("priority only", ann);
      await withContract(w, taskId, { requiredEvidence: [], checks: [], priority: 7, acceptanceCriteria: ["it works"] });
      let asked = 0;
      w.worker.verify = async () => { asked++; return { checkout: true, tree: { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 0 }, evidence: [], checks: [] }; };
      let v: DoneVerdict | undefined;
      await turn(w, async (attemptId) => { v = await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "p1" }); });
      assert.deepEqual(v, { state: "skipped" });
      assert.equal(asked, 0);
      assert.equal(await countOf(w, taskId), 0);
      assert.equal((await w.dispatcher.get(w.owner, verdictAttempt(w)))!.verifications, undefined);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: where the agent cannot commit (the real local worker), its uncommitted change is its work: a done passes without a commit or submit, and one with no change against the base is refused (W05)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("no git", ann);
      await withContract(w, taskId, { requiredEvidence: ["test log"], checks: [LINT] });
      let tree: NonNullable<DoneCheckReport["tree"]> = { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 0, agentCommits: false };
      let present = false;
      w.worker.verify = async () => ({ checkout: true, tree, evidence: [{ path: "logs/test.txt", present, ...(present ? {} : { why: "not in the checkout (or ignored)" }) }], checks: [{ name: "lint", state: "passed" }] });
      const v: DoneVerdict[] = [];
      await turn(w, async (attemptId) => {
        v.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "g1", evidence: [{ item: "test log", path: "logs/test.txt" }] }));
        tree = { uncommitted: ["src/a.ts", "logs/test.txt"], uncommittedCount: 2, ahead: 0, changed: 2, agentCommits: false };
        present = true;
        v.push(await w.dispatcher.verifyDone(w.dispatcherPrincipal, attemptId, { key: "g2", evidence: [{ item: "test log", path: "logs/test.txt" }] }));
      });
      assert.equal(v[0]!.state, "failed");
      const message = (v[0] as { message: string }).message;
      assert.match(message, /1\. Your checkout holds no change against the task's base/);
      assert.match(message, /2\. Required evidence "test log": "logs\/test\.txt" is not a plain, non-empty file of your checkout \("not in the checkout \(or ignored\)"\)\. Write it there and name it again\./);
      assert.doesNotMatch(message, /[Cc]ommit/, "an agent that cannot commit is never told to commit");
      assert.equal(v[1]!.state, "passed", "uncommitted work, no commit ahead and no submit: the checkout as it stands is the work");
    } finally { await store.close(); }
  });
}
