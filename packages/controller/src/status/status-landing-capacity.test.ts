import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { CapacityAnswer } from "../landing/integrator-capacity.js";
import type { Principal } from "../security/principals.js";
import { StatusService } from "./index.js";

after(stopServer);

// Card P10b (fourth clause): in the owner's landing_queue view, who lands the queue now, or why its approved work waits when no capacity is left. Owner only (it counts integrators and their holds on other projects),
// read-only, only for the landing branch's queue with approved work first; the view's other lines are unchanged.
const item = (position: number) => ({ position, seq: position, submissionId: `sbm-${"a".repeat(20)}`, taskId: `tsk-${"b".repeat(20)}`, base: "c".repeat(40), tree: "d".repeat(40), author: "agent:ann", queuedAt: "2026-10-23T09:00:00.000Z", queuedBy: "controller" });
const queueOf = (over: Record<string, unknown> = {}) => ({ branch: "main", landingBranch: "main", items: [item(1)], reservations: [], returns: [], others: [], front: { taskId: `tsk-${"b".repeat(20)}`, since: "2026-10-23T09:00:00.000Z", waitingForApproval: false, holdMs: 4 * 3_600_000, releaseMs: 12 * 3_600_000, deferMs: 24 * 3_600_000 }, ...over });

for (const backend of backends) {
  test(`${backend.name}: the landing_queue view tells the owner who lands the queue or why approved work waits with no capacity left; nobody else sees it (card P10b)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const options = { clock: w.clock.now, pause: async () => undefined };
      let answer: CapacityAnswer | (() => never) = { state: "nobody", partial: false };
      let q: Record<string, unknown> = queueOf();
      const calls: [string, string][] = [];
      const deps = (withCapacity: boolean) => ({
        landingQueue: { list: async () => q },
        ...(withCapacity ? { landingCapacity: async (projectId: string, branch: string) => { calls.push([projectId, branch]); return typeof answer === "function" ? answer() : answer; } } : {}),
      });
      const status = StatusService.withEpoch(w.storage, w.epoch, deps(true) as never, options);
      const read = async (by: Principal = w.owner, s = status): Promise<string> => (await s.landingQueueLines(by, w.project))!.lines.map((l) => l.text).join("\n");
      const capacityLine = async (by: Principal = w.owner): Promise<string | undefined> => (await read(by)).split("\n").find((t) => /integrator lease of this branch|this branch.s lease now|capacity|land this queue/.test(t));

      assert.equal(await capacityLine(), "No capacity is left to land this queue: no active agent has the right integration.lease on this project, so the approved work waits until an agent is given that right.");
      assert.deepEqual(calls, [[w.project, "main"]]);
      answer = { state: "nobody", partial: true };
      assert.match((await capacityLine())!, /that right \(not every agent record was read, so there may be more integrators than counted\)\.$/);
      answer = { state: "busy", busy: 1, partial: false };
      assert.equal(await capacityLine(), "No capacity is left to land this queue: the one integrator that may land on this project already holds an integrator lease (one project at a time), so the approved work waits until one releases its lease or the lease runs out; giving another agent the right integration.lease on this project adds capacity.");
      answer = { state: "busy", busy: 3, partial: true };
      assert.match((await capacityLine())!, /^No capacity is left to land this queue: all 3 integrators that may land on this project already hold an integrator lease .* adds capacity \(not every agent record was read/);
      answer = { state: "free", free: 1, busy: 0, partial: false };
      assert.equal(await capacityLine(), "No integrator holds this branch's lease now; 1 integrator that may land on this project holds no lease, so one of them takes this queue when it asks the pool (integrator.pool.next), which gives the queue whose first place has waited longest first.");
      answer = { state: "free", free: 2, busy: 2, partial: false };
      assert.match((await capacityLine())!, /; 2 integrators that may land on this project hold no lease, .* first; 2 others are busy with a lease already\.$/);
      answer = { state: "free", free: 2, busy: 1, partial: false };
      assert.match((await capacityLine())!, /; 1 other is busy with a lease already\.$/);
      answer = { state: "held", holder: "ivy", expiresAt: "2026-10-23T09:10:00.000Z", lands: true };
      assert.equal(await capacityLine(), "Integrator ivy holds the integrator lease of this branch until 2026-10-23T09:10:00.000Z and lands its queue.");
      answer = { state: "held", holder: "ivy", expiresAt: "2026-10-23T09:10:00.000Z", lands: false };
      assert.equal(await capacityLine(), "Agent ivy holds the integrator lease of this branch until 2026-10-23T09:10:00.000Z but no longer has the right integration.lease on this project, so it can neither land under it nor renew it, and the pool gives this branch to nobody else: the approved work waits until the lease runs out, or until you end it sooner with integrator.lease.release (by project and branch).");
      // A hostile holder name is shown on one line and bounded.
      answer = { state: "held", holder: `x\ny\u202e${"z".repeat(300)}`, expiresAt: "2026-10-23T09:10:00.000Z", lands: true };
      const hostile = (await capacityLine())!;
      assert.ok(!hostile.includes("\n") && !hostile.includes("\u202e") && hostile.length < 260, hostile);
      answer = { state: "unknown", reason: "the integrator leases could not all be read" };
      assert.equal(await capacityLine(), "Who can land this queue is not known now: the integrator leases could not all be read; no integrator is assumed free.");
      // A refused read is said as not known; anything else is not hidden.
      answer = () => { throw new DomainError("unavailable", "secret store text"); };
      const refused = (await capacityLine())!;
      assert.equal(refused, "Who can land this queue is not known now: it could not be read; no integrator is assumed free.");
      answer = () => { throw new TypeError("broken"); };
      await assert.rejects(() => read(), TypeError);

      // Not shown: to an integrator of the project (the queue door lets it read the queue; holds on other projects are not its business), to a task credential of the owner, off the landing branch, with an empty
      // queue, with a reserved first place waiting for work, and without the dependency.
      answer = { state: "nobody", partial: false };
      calls.length = 0;
      const ivy = { id: "agent:ivy", kind: "agent", name: "ivy", grants: [{ action: "integration.lease", project: w.project }], asOf: "2026-10-23T09:00:00.000Z" } as unknown as Principal;
      assert.equal(await capacityLine(ivy), undefined);
      for (const kind of ["host", "client", "service"]) assert.equal(await capacityLine({ ...ivy, id: `${kind}:x`, kind } as unknown as Principal), undefined, kind);
      assert.equal(await capacityLine({ ...w.owner, taskScope: { taskId: `tsk-${"b".repeat(20)}`, projectId: w.project } } as Principal), undefined);
      q = queueOf({ branch: "old", landingBranch: "main" });
      assert.equal(await capacityLine(), undefined);
      q = queueOf({ branch: "", landingBranch: "" });
      assert.equal(await capacityLine(), undefined);
      q = queueOf({ items: [] });
      assert.equal(await capacityLine(), undefined);
      q = queueOf({ items: [], reservations: [{ taskId: `tsk-${"e".repeat(20)}`, seq: 0, since: "2026-10-23T08:00:00.000Z", round: 3, cap: 3 }], front: undefined });
      assert.equal(await capacityLine(), undefined, "a reservation alone, with no front mark: no approved work, no line");
      q = queueOf({ reservations: [{ taskId: `tsk-${"e".repeat(20)}`, seq: 0, since: "2026-10-23T08:00:00.000Z", round: 3, cap: 3 }], front: { taskId: `tsk-${"e".repeat(20)}`, since: "2026-10-23T08:00:00.000Z", waitingForApproval: true, idleSince: "2026-10-23T08:00:00.000Z", holdMs: 1, releaseMs: 1, deferMs: 1 } });
      assert.equal(await capacityLine(), undefined);
      assert.deepEqual(calls, [], "nothing was asked where nothing is shown");
      // A record without a front mark, with approved work: shown.
      q = queueOf({ front: undefined });
      assert.ok(await capacityLine());
      q = queueOf();
      const without = StatusService.withEpoch(w.storage, w.epoch, deps(false) as never, options);
      assert.doesNotMatch(await read(w.owner, without), /capacity|lands its queue|integrator.pool.next/);
      // The line comes right after the queue's first line, before the entries.
      const lines = (await read()).split("\n");
      assert.match(lines[0]!, /^The landing queue of branch "main" \(the project's landing branch\) holds 1 approved submission/);
      assert.match(lines[1]!, /^No capacity is left to land this queue/);
      assert.match(lines[2]!, /^1\. Task /);
    } finally { await store.close(); }
  });
}
