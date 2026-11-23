import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";

after(stopServer);

// Card Q02 second review: an approval carried over from an earlier submission of the same CLAIMED patch is proved only by the landing gate's `review` check (the host computes the earlier submission's own patch).
// A project that lands without that check (the `autonomous` profile requires only `tests`) would otherwise queue and land code nobody reviewed on the submitter's word that its patch is unchanged. The queue counts
// a carried approval only where the landing gate checks the review, reads that at every use (adding, the controller's own queueing, and the landing), and fails closed when it cannot tell.
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;

for (const backend of backends) {
  test(`${backend.name}: a carried approval is queued and landed only where the landing gate checks the review; an own approval as before (card Q02 second review)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const options = { clock: w.clock.now, pause: async () => undefined };
      const approvals = new Map<string, QueueApproval>();
      let checked: "yes" | "no" | "throws" | "absent" = "no";
      const asked: string[] = [];
      const ops = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, options), {
        approvalOf: async (id) => approvals.get(id),
        landingBranch: async () => "main",
        projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
        reviewChecked: async (projectId, taskId) => { asked.push(`${projectId}/${taskId}`); if (checked === "throws") throw new Error("settings unreadable"); if (checked === "absent") return undefined as unknown as boolean; return checked === "yes"; },
      });
      const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
      const [t1, t2] = [await task("carried"), await task("own")];
      approvals.set(sbm(1), { taskId: t1, projectId: w.project, base: BASE, tree: tree(1), submittedBy: "agent:ann", approved: true, carriedFrom: sbm(9) });
      approvals.set(sbm(2), { taskId: t2, projectId: w.project, base: BASE, tree: tree(2), submittedBy: "agent:ann", approved: true });
      const refused = async (run: () => Promise<unknown>): Promise<void> => {
        await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, "review_invalid", e.message); assert.match(e.message, /no review of its own/); assert.match(e.message, new RegExp(sbm(9))); return true; });
      };

      // The landing gate does not check the review (no `review` check), cannot be read, or answers nothing usable: the carried approval is not an approval here.
      for (const c of ["no", "throws", "absent"] as const) {
        checked = c;
        await refused(() => ops.add(w.owner, { commandId: `add-${c}`, submissionId: sbm(1) }));
        assert.equal(await ops.queueApproved(sbm(1), `cause-${c}`), false, `${c}: the controller's own queueing does not take it either`);
      }
      assert.ok(asked.every((a) => a === `${w.project}/${t1}`), "asked for the carried submission's own project and task");
      // An own approval is not affected (and the landing gate's policy is not even asked for it).
      const before = asked.length;
      assert.equal((await ops.add(w.owner, { commandId: "add-own", submissionId: sbm(2) })).position, 1);
      assert.equal(asked.length, before, "an own approval needs no proof from the landing gate");

      // The landing gate checks the review: the carried approval is queued (the gate proves it at landing).
      checked = "yes";
      assert.equal((await ops.add(w.owner, { commandId: "add-yes", submissionId: sbm(1) })).position, 2);
      await ops.remove(w.owner, { commandId: "rm-own", branch: "main", taskId: t2, reason: "out of the way" });
      // The owner then drops the review check before the landing: it is read again there and the landing is refused (nothing reaches the host).
      checked = "no";
      await refused(() => ops.checkLanding(w.owner, { taskId: t1, projectId: w.project, submissionId: sbm(1) }));
      checked = "yes";
      const landing = await ops.checkLanding(w.owner, { taskId: t1, projectId: w.project, submissionId: sbm(1) });
      assert.deepEqual(landing && { s: landing.submissionId, t: landing.tree }, { s: sbm(1), t: tree(1) });
    } finally { await store.close(); }
  });
}

/** The same rule without the option composed: a carried approval never counts (fails closed). */
test("without reviewChecked a carried approval is never queued (card Q02 second review)", async () => {
  const backend = backends[0]!;
  const store = await backend.open();
  try {
    const w = await buildWorld(store.storage);
    const t = (await w.projects.createTask({ commandId: "task-x", actor: w.owner.id, projectId: w.project, title: "x" })).id;
    const ops = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, { clock: w.clock.now, pause: async () => undefined }), {
      approvalOf: async () => ({ taskId: t, projectId: w.project, base: BASE, tree: tree(3), submittedBy: "agent:ann", approved: true, carriedFrom: sbm(9) }),
      landingBranch: async () => "main",
      projectOfTask: async () => w.project,
    });
    await assert.rejects(() => ops.add(w.owner, { commandId: "a", submissionId: sbm(3) }), /no review of its own/);
  } finally { await store.close(); }
});
