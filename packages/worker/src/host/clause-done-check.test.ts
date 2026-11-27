import assert from "node:assert/strict";
import { test } from "node:test";
import { doneVerifier } from "./local.js";

// Card W09 second slice: the host's done check of a contract check with `changedTests`: the change's test files are listed after the checks before it ran, run from their built files, and listed again; a pass counts only with the
// same files before and after. Fakes for the checkout and the sandbox: nothing real runs here (the git side is in workspace/clause-tests.test.ts).
type Tests = { count: number; files: { path: string; built: string | null; titles: string[] }[]; plan: { text: string } | { why: string } };
const scope = { taskId: "t", projectId: "p" };
const state = { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 2, agentCommits: false, evidence: [] };

function rig(lists: (Tests | Error | undefined)[], answer: (run: readonly string[]) => { state: "passed" | "failed"; exitCode: number } = () => ({ state: "passed", exitCode: 0 })) {
  const ran: (readonly string[])[] = [];
  const order: string[] = [];
  let i = 0;
  const workspaces = {
    doneState: async () => { order.push("state"); return state; },
    changedTests: async () => { order.push("list"); const x = lists[Math.min(i++, lists.length - 1)]; if (x instanceof Error) throw x; return x; },
  };
  const checks = { run: async (_a: string, c: { run: readonly string[] }) => { order.push(`run:${c.run[0]}`); ran.push(c.run); return answer(c.run); } };
  return { verify: doneVerifier({ workspaces, checks }), ran, order };
}
const one: Tests = { count: 1, files: [{ path: "src/x.test.ts", built: "dist/x.test.js", titles: ["x"] }], plan: { text: "- [x] C1: src/x.test.ts \"x\"" } };
const ask = { checks: [{ name: "build", run: ["tsc"], timeoutMs: 1000 }, { name: "tests", run: ["node", "--test"], timeoutMs: 1000, changedTests: true }], evidence: [], maxOutputBytes: 100 };

test("the changed tests are listed after the build, run from their built files appended to the command, listed again, and reported", async () => {
  const r = rig([one, one]);
  const got = await r.verify("a", scope, ask);
  assert.deepEqual(r.order, ["state", "run:tsc", "list", "run:node", "list", "state"], "the build first, then the list, the run, the second list and the second look at the checkout");
  assert.deepEqual(r.ran[1], ["node", "--test", "dist/x.test.js"]);
  assert.deepEqual(got.checks.map((c) => [c.name, c.state]), [["build", "passed"], ["tests", "passed"]]);
  assert.deepEqual(got.changedTests, one);
});

test("nothing to run, too many, or one not built: the check is not run and the list is reported for the controller to judge", async () => {
  for (const tests of [{ ...one, count: 0, files: [] }, { ...one, count: 60 }, { ...one, files: [{ ...one.files[0]!, built: null }] }]) {
    const r = rig([tests]);
    const got = await r.verify("a", scope, ask);
    assert.equal(r.ran.length, 1, "only the build ran");
    assert.equal(got.checks[1]!.state, "not-run");
    assert.deepEqual(got.changedTests, tests);
  }
});

test("a pass is not taken when the files differ after the run or cannot be listed again; a failure stays a failure", async () => {
  const other: Tests = { ...one, files: [{ ...one.files[0]!, path: "src/y.test.ts" }] };
  let r = rig([one, other]);
  let got = await r.verify("a", scope, ask);
  assert.equal(got.checks[1]!.state, "not-run");
  assert.match(got.checks[1]!.reason ?? "", /different after they ran/);
  assert.deepEqual(got.changedTests, other, "what is there now is what is reported");
  r = rig([one, new Error("gone")]);
  got = await r.verify("a", scope, ask);
  assert.equal(got.checks[1]!.state, "not-run");
  assert.match(got.checks[1]!.reason ?? "", /could not be listed again/);
  r = rig([one, other], (run) => (run[0] === "node" ? { state: "failed", exitCode: 1 } : { state: "passed", exitCode: 0 }));
  got = await r.verify("a", scope, ask);
  assert.equal(got.checks[1]!.state, "failed");
});

test("a host that cannot list the tests, a list that throws or no checkout: not run, never passed, and nothing is run as a bare command", async () => {
  const bare = doneVerifier({ workspaces: { doneState: async () => state }, checks: { run: async () => { throw new Error("must not run"); } } });
  const got = await bare("a", scope, { ...ask, checks: [ask.checks[1]!] });
  assert.deepEqual([got.checks[0]!.state, got.checks[0]!.reason], ["not-run", "this host cannot list the test files of a change"]);
  assert.equal(got.changedTests, undefined);
  for (const [list, why] of [[new Error("boom"), /could not be listed: boom/], [undefined, /no checkout/]] as const) {
    const r = rig([list as never]);
    const g = await r.verify("a", scope, ask);
    assert.equal(r.ran.length, 1);
    assert.equal(g.checks[1]!.state, "not-run");
    assert.match(g.checks[1]!.reason ?? "", why);
  }
});

test("a request without changedTests is answered as before (no list, no extra look)", async () => {
  const r = rig([one]);
  const got = await r.verify("a", scope, { ...ask, checks: [ask.checks[0]!] });
  assert.deepEqual(r.order, ["state", "run:tsc", "state"]);
  assert.equal("changedTests" in got, false);
});
