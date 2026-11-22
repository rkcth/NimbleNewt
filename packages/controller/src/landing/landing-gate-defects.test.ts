import assert from "node:assert/strict";
import { test } from "node:test";
import { LandingGate, type DefectsGateView, type LandingCheckHost } from "./landing-gate.js";

// Card Q04 (fifth slice): the `defects` check. A landing passes it only while no defect reported against the task's deliverables is unfinished (open, repair-submitted or escalated); the view is the defect service's own
// (`landingDefectsGate`), read after the host's run. Defects belong to deliverable versions, not to a code tree, so the check is not bound to the patch.
const BASE = "b".repeat(40), TREE = "e".repeat(40), PATCH = "a".repeat(40);
const TASK = "task-aaaaaaaaaaaaaaaaaaaa";
const item = (n: number, state = "open", severity = "major") => ({ id: `dfc-${String(n).padStart(20, "a")}`, severity, state, finding: `finding ${n}`, deliverableTitle: "Guide" });
const clean: DefectsGateView = { taskId: TASK, checked: 0, unresolved: 0, items: [] };

const rig = (o: { view?: DefectsGateView | undefined | (() => Promise<DefectsGateView | undefined>); wired?: boolean; required?: readonly ("tests" | "defects")[] } = {}) => {
  const g = new LandingGate({
    requiredChecks: async () => o.required ?? ["defects"],
    tests: async () => undefined,
    approvalOf: async () => undefined,
    ...(o.wired === false ? {} : { defectsGate: async () => (typeof o.view === "function" ? o.view() : "view" in o ? o.view : clean) }),
    now: () => "2026-11-22T10:00:00.000Z",
  });
  const host = (): LandingCheckHost => ({ landingChecks: async () => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [] }) as never });
  const run = (h: LandingCheckHost = host()) => g.evaluate({ taskId: TASK, projectId: "proj-x", host: h });
  return { run, host };
};
const only = (r: Awaited<ReturnType<ReturnType<typeof rig>["run"]>>) => [r.results[0]!.check, r.results[0]!.result] as const;

test("no defect, or only finished ones, passes (even with no submission named); the result is bound to the integrated tree", async () => {
  const none = await rig().run();
  assert.deepEqual([none.passed, ...only(none), none.results[0]!.boundTo], [true, "defects", "pass", TREE]);
  assert.match(none.results[0]!.summary, /no defect was reported/);
  const done = await rig({ view: { taskId: TASK, checked: 3, unresolved: 0, items: [] } }).run();
  assert.equal(done.passed, true);
  assert.match(done.results[0]!.summary, /all 3 defect\(s\) of this task are resolved, withdrawn or accepted as they are by the owner/);
});

test("an unfinished defect fails the landing and names the first ones and how many more", async () => {
  const one = await rig({ view: { taskId: TASK, checked: 2, unresolved: 1, items: [item(1, "escalated", "critical")] } }).run();
  assert.deepEqual([one.passed, ...only(one)], [false, "defects", "fail"]);
  assert.equal(one.results[0]!.summary, `1 of 2 defect(s) of this task are not finished: ${item(1).id} (critical, escalated)`);
  const many = await rig({ view: { taskId: TASK, checked: 9, unresolved: 8, items: [1, 2, 3, 4, 5].map((n) => item(n)) } }).run();
  assert.equal(only(many)[1], "fail");
  assert.match(many.results[0]!.summary, /^8 of 9 defect\(s\) of this task are not finished: /);
  assert.ok(many.results[0]!.summary.length <= 300);
  assert.match(many.results[0]!.summary, /; and \d+ more$/);
  const listed = (many.results[0]!.summary.match(/dfc-/g) ?? []).length;
  assert.match(many.results[0]!.summary, new RegExp(`and ${8 - listed} more$`), "the rest are counted exactly");
});

test("a view that cannot be read, is for another task, is inconsistent, or is not wired is not run (each counts as failed)", async () => {
  for (const view of [undefined, { ...clean, taskId: "task-bbbbbbbbbbbbbbbbbbbb" }, { taskId: TASK, checked: 1, unresolved: 2, items: [] }, { taskId: TASK, checked: 1, unresolved: "1" as never, items: [] }, { taskId: TASK, checked: 0, unresolved: 0, items: "no" as never }]) {
    const out = await rig({ view }).run();
    assert.deepEqual([out.passed, ...only(out)], [false, "defects", "not_run"], JSON.stringify(view));
    assert.match(out.results[0]!.summary, /could not be read/);
  }
  const broken = await rig({ view: async () => { throw new Error("store down"); } }).run();
  assert.deepEqual(only(broken), ["defects", "not_run"]);
  assert.match(broken.results[0]!.summary, /could not be read: store down/);
  const unwired = await rig({ wired: false }).run();
  assert.deepEqual(only(unwired), ["defects", "not_run"]);
  assert.match(unwired.results[0]!.summary, /not collected at landing yet/);
});

test("the defects are read after the host's run: one reported while the checks ran refuses the landing", async () => {
  let state: DefectsGateView = clean;
  const r = rig({ view: async () => state });
  const host: LandingCheckHost = { landingChecks: async () => { state = { taskId: TASK, checked: 1, unresolved: 1, items: [item(1)] }; return { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [] } as never; } };
  assert.deepEqual(only(await r.run(host)), ["defects", "fail"]);
});

test("a landing with nothing to land is not judged by the defects, and the check sits next to others without changing them", async () => {
  const r = rig({ required: ["tests", "defects"] });
  const noChange: LandingCheckHost = { landingChecks: async () => ({ checkout: true, change: undefined, checks: [] }) as never };
  const out = await r.run(noChange);
  assert.equal(out.passed, false);
  const both = await rig({ required: ["tests", "defects"], view: { taskId: TASK, checked: 1, unresolved: 1, items: [item(1)] } }).run();
  assert.deepEqual(both.results.map((x) => x.check), ["tests", "defects"]);
  assert.equal(both.results[1]!.result, "fail");
});
