import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";
import { dispatcherLanding, dispatcherStage } from "../work-end/ports.js";

after(stopServer);

// Card H12n: an agent's `work.end { submit: true }` is checked (stale base and overlapping files) and staged on the host that holds the attempt's checkout. The dispatcher asks the attempt's own host, as the ending's port, and
// nothing is guessed: a host that cannot say, holds no checkout, fails or is asked by anyone but staff gives no answer (the submit is then refused as unavailable) or a refusal (the ending ends plainly with release_failed).

const B = "a".repeat(40), H = "b".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: the attempt's own host says what a submit is checked against and stages it; a host that cannot, fails or is asked by an agent gives nothing (H12n)`, async () => {
    const store = await backend.open();
    try {
      const errors: unknown[] = [];
      const w = await buildWorld(store.storage, { options: { onError: (e) => { errors.push(e); } } });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("parser", ann);
      const seen: { what: string; attemptId: string; scope: { taskId: string; projectId: string } }[] = [];
      const handle = () => ({ dispatcher: w.dispatcher, principal: w.dispatcherPrincipal });
      const landing = dispatcherLanding(handle), stage = dispatcherStage(handle);
      const annP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
      let attempt = "";
      w.worker.script = async ({ order }) => {
        attempt = order.attemptId;
        const ending = { attemptId: order.attemptId, taskId, projectId: w.project, agentId: "ann", live: true, generation: 1 } as never;
        // A host that cannot say or stage: unknown, and a staging refused as unavailable.
        assert.equal(await landing(taskId, order.attemptId), undefined);
        await assert.rejects(stage(ending), (e: Error & { code?: string }) => e.code === "unavailable" && /cannot stage/.test(e.message));
        // The host says and stages, for exactly this attempt's task and project.
        w.worker.submitView = async (attemptId, scope) => { seen.push({ what: "view", attemptId, scope: { taskId: scope.taskId, projectId: scope.projectId } }); return { base: B, head: H, mine: ["src/a.ts", "src/b.ts"], landed: ["src/b.ts"] }; };
        w.worker.stage = async (attemptId, scope) => { seen.push({ what: "stage", attemptId, scope: { taskId: scope.taskId, projectId: scope.projectId } }); return { base: B, tree: "c".repeat(40), patchId: "d".repeat(40), files: ["src/a.ts"] }; };
        assert.deepEqual(await landing(taskId, order.attemptId), { base: B, head: H, mine: ["src/a.ts", "src/b.ts"], landed: ["src/b.ts"] });
        assert.deepEqual(await stage(ending), { base: B, tree: "c".repeat(40), patchId: "d".repeat(40), files: ["src/a.ts"] });
        // Only staff may ask: an agent cannot read another view of the checkout or stage through the dispatcher.
        await assert.rejects(w.dispatcher.submitView(annP, order.attemptId), /may not control/);
        await assert.rejects(w.dispatcher.stageWork(annP, order.attemptId), /may not control/);
        // A host that fails: no answer (the fault is reported), and the staging's refusal is passed on.
        w.worker.submitView = async () => { throw new Error("git is broken"); };
        w.worker.stage = async () => { throw Object.assign(new Error("nothing to submit"), { code: "invalid_path" }); };
        assert.equal(await landing(taskId, order.attemptId), undefined);
        await assert.rejects(stage(ending), /nothing to submit/);
        // A host that holds no checkout for the task.
        w.worker.submitView = async () => undefined;
        assert.equal(await landing(taskId, order.attemptId), undefined);
        return { status: "completed", text: "turn over", endKind: "normal" };
      };
      await w.heartbeatHost();
      await w.dispatcher.tick();
      await w.dispatcher.idle();
      assert.notEqual(attempt, "");
      assert.deepEqual(seen, [{ what: "view", attemptId: attempt, scope: { taskId, projectId: w.project } }, { what: "stage", attemptId: attempt, scope: { taskId, projectId: w.project } }]);
      assert.ok(errors.some((e) => /git is broken/.test(String((e as Error).message))), "a failing host is reported, not hidden");
      // A finished attempt is not a live dispatch: nothing is asked of the host.
      w.worker.submitView = async () => { throw new Error("must not be asked"); };
      assert.equal(await landing(taskId, attempt), undefined);
      await assert.rejects(stage({ attemptId: attempt, taskId, projectId: w.project, agentId: "ann", live: false, generation: 1 } as never), /not a live dispatch/);
      // Without a dispatcher at all: unknown, and unavailable.
      assert.equal(await dispatcherLanding(() => undefined)(taskId, attempt), undefined);
      await assert.rejects(dispatcherStage(() => undefined)({ attemptId: attempt } as never), (e: Error & { code?: string }) => e.code === "unavailable");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a host that does not answer within the bound gives no answer and a staging refused as unavailable; it is reported, not taken as "no overlap" (H12n first review)`, async () => {
    const store = await backend.open();
    let release!: () => void;
    const never = new Promise<void>((ok) => { release = ok; });
    try {
      const errors: unknown[] = [];
      const w = await buildWorld(store.storage, { options: { onError: (e) => { errors.push(e); }, submitHostMs: 50 } });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId } = await w.task("parser", ann);
      const handle = () => ({ dispatcher: w.dispatcher, principal: w.dispatcherPrincipal });
      const landing = dispatcherLanding(handle), stage = dispatcherStage(handle);
      let checked = false;
      w.worker.script = async ({ order }) => {
        const ending = { attemptId: order.attemptId, taskId, projectId: w.project, agentId: "ann", live: true, generation: 1 } as never;
        w.worker.submitView = async () => { await never; return { base: "a".repeat(40), head: "a".repeat(40), mine: [], landed: [] }; };
        w.worker.stage = async () => { await never; return { base: "a".repeat(40), tree: "c".repeat(40), patchId: "d".repeat(40), files: ["x"] }; };
        assert.equal(await landing(taskId, order.attemptId), undefined, "a late host is unknown, never an empty overlap");
        await assert.rejects(stage(ending), (e: Error & { code?: string }) => e.code === "unavailable" && /did not answer within/.test(e.message));
        checked = true;
        return { status: "completed", text: "turn over", endKind: "normal" };
      };
      await w.heartbeatHost();
      await w.dispatcher.tick();
      await w.dispatcher.idle();
      assert.equal(checked, true);
      assert.ok(errors.some((e) => /did not answer within/.test(String((e as Error).message))), "the late host is reported");
    } finally { release(); await store.close(); }
  });
}
