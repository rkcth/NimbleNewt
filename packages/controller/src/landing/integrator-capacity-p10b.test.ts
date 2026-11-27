import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Grant, Principal } from "../security/principals.js";
import { CAPACITY_LIMITS, IntegratorCapacity, IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, LandingQueueService, activeAgentIds, type IntegratorLease } from "./index.js";

after(stopServer);

// Card P10b (fourth clause, "when no capacity is left, work waits with a visible reason"): who can land a project's landing branch now, read-only and by the pool's own rule. An active agent holding the branch's live
// lease lands it (`held`); otherwise the integrators of the project (active agents with the exact right integration.lease there) are free or busy (a live lease on a project they serve), and with none free no capacity
// is left (`busy`), with none at all none exists (`nobody`); leases that cannot all be read say nothing about who is free (`unknown`).
const MIN = 60_000;
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const activeAgent = async (id: string) => (await w.principals.current(`agent:${id}`)) !== undefined;
    const landingBranch = async (): Promise<string> => "main";
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, options);
    const leaseOps = new IntegratorLeaseOps(leases, { landingBranch, activeAgent });
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const pool = new IntegratorPool(leases, leaseOps, queue, { landingBranch, activeAgent });
    const capacity = new IntegratorCapacity(leases, { agents: () => activeAgentIds(w.storage), principal: (id) => w.principals.current(id) });
    const project = async (name: string): Promise<string> => (await w.projects.createProject({ commandId: `p-${name}`, actor: w.owner.id, name })).id;
    const person = async (name: string, grants: Grant[], kind: "agent" | "client" = "agent"): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind, name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `${kind}:${name}`)).token);
    };
    let n = 0;
    const queued = async (projectId: string): Promise<string> => {
      n++;
      const taskId = (await w.projects.createTask({ commandId: `t-${n}`, actor: w.owner.id, projectId, title: `work-${n}` })).id;
      await queue.enqueue({ commandId: `q-${n}`, actor: "controller", projectId, branch: "main", submissionId: sbm(n), taskId, base: BASE, tree: tree(n), author: "agent:writer" });
      w.clock.advance(MIN);
      return taskId;
    };
    const regrant = async (id: string, grants: Grant[]) => w.principals.setGrants(w.owner, { commandId: `g-${id}-${grants.length}-${n++}`, principalId: id, expectedRevision: (await w.principals.get(id))!.revision, grants });
    return { store, w, leases, leaseOps, queue, pool, capacity, project, person, queued, regrant, close: () => store.close() };
  };
  const lands = (projects: string[]): Grant[] => projects.map((project) => ({ action: "integration.lease", project }));

  test(`${backend.name}: who can land a queue: nobody, free, held, busy, a retired holder, an expired hold, a right taken away, a grant for every project (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b, c] = [await r.project("Apple"), await r.project("Birch"), await r.project("Cedar")];
      await r.queued(a); await r.queued(b);
      // No agent has the right on a: no capacity exists. Agents with other rights and an agent with the right on another project are not integrators of a.
      await r.person("eve", [{ action: "workspace.manage", project: a }, { action: "task.read", project: "*" }]);
      await r.person("cyd", lands([c]));
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "nobody", partial: false });
      // One integrator of a and b, holding nothing: free for both.
      const ivy = await r.person("ivy", lands([a, b]));
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "free", free: 1, busy: 0, partial: false });
      // She takes a (the oldest) from the pool: a is held by her, until her lease's end; b has no free integrator left.
      const took = await r.pool.next(ivy, { commandId: "i1", ttlMs: 10 * MIN });
      assert.equal(took.outcome === "taken" ? took.projectId : took.outcome, a);
      const lease = took.outcome === "taken" ? took.lease : (undefined as never as IntegratorLease);
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "held", holder: "ivy", expiresAt: lease.expiresAt });
      assert.deepEqual(await r.capacity.of(b, "main"), { state: "busy", busy: 1, partial: false });
      // Another branch of a is its own: ivy's hold of a's main does not make a's "old" held, and she is busy there.
      assert.deepEqual(await r.capacity.of(a, "old"), { state: "busy", busy: 1, partial: false });
      // A second integrator of b adds capacity; one for every project counts for every project.
      const max = await r.person("max", lands([b]));
      assert.deepEqual(await r.capacity.of(b, "main"), { state: "free", free: 1, busy: 1, partial: false });
      await r.person("sue", [{ action: "integration.lease", project: "*" }]);
      assert.deepEqual(await r.capacity.of(b, "main"), { state: "free", free: 2, busy: 1, partial: false });
      assert.deepEqual(await r.capacity.of(c, "main"), { state: "free", free: 2, busy: 0, partial: false }, "cyd and sue serve c; nobody holds c");
      // max takes b: b is held, and nothing is said about who else is free there.
      const maxs = await r.pool.next(max, { commandId: "m1", ttlMs: 10 * MIN });
      assert.equal(maxs.outcome === "taken" ? maxs.projectId : maxs.outcome, b);
      assert.deepEqual((await r.capacity.of(b, "main")).state, "held");
      // The right on a taken from ivy while she holds a: her hold no longer makes her busy (the pool judges the same), and a's live hold is still hers (held: the pool passes it over too).
      await r.regrant("agent:ivy", lands([b]));
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "held", holder: "ivy", expiresAt: lease.expiresAt });
      assert.deepEqual(await r.capacity.of(b, "old"), { state: "free", free: 2, busy: 1, partial: false }, "ivy (her hold is on a, where she has no right now) and sue are free for b; max holds b");
      assert.deepEqual((await r.pool.next(await r.w.principals.authenticate((await r.w.principals.issueCredential(r.w.owner, "agent:ivy")).token), { commandId: "i2", ttlMs: 10 * MIN })).outcome, "none", "ivy is free for the pool too, and b is held");
      // ivy disabled while her hold on a is live: it is not capacity in use (the lease door ends it at the next take); sue (every project) is free for a.
      await r.w.principals.disable(r.w.owner, { commandId: "d-ivy", principalId: "agent:ivy", expectedRevision: (await r.w.principals.get("agent:ivy"))!.revision });
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "free", free: 1, busy: 0, partial: false });
      // sue disabled too: nobody may land a.
      await r.w.principals.disable(r.w.owner, { commandId: "d-sue", principalId: "agent:sue", expectedRevision: (await r.w.principals.get("agent:sue"))!.revision });
      assert.deepEqual(await r.capacity.of(a, "main"), { state: "nobody", partial: false });
      // max's hold on b runs out: b is no longer held, and max is free again.
      r.w.clock.advance(11 * MIN);
      assert.deepEqual(await r.capacity.of(b, "main"), { state: "free", free: 1, busy: 0, partial: false });
      // Another branch of the project is its own: max's lease of b's main says nothing of b's "old".
      assert.equal((await r.capacity.of(b, "old")).state, "free");
      // Read-only: nothing was written by the reads above (the lease records are the two the pool took).
      assert.deepEqual((await r.leases.forProject(a)).length + (await r.leases.forProject(b)).length, 2);
    } finally { await r.close(); }
  });

  test(`${backend.name}: bounded and failing closed: the agent walk stops at its bounds (partial), unreadable leases say nothing is free, a principal answer for another ID is not counted (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      await r.queued(a);
      for (const name of ["ann", "bob", "cal"]) await r.person(name, lands([a]));
      // Bounds of the walk: at most `limit` active agents, at most `pages` pages; either says partial.
      assert.deepEqual(await activeAgentIds(r.w.storage), { ids: ["agent:ann", "agent:bob", "agent:cal"], partial: false });
      assert.deepEqual(await activeAgentIds(r.w.storage, 10, 2), { ids: ["agent:ann", "agent:bob"], partial: true });
      assert.deepEqual(await activeAgentIds(r.w.storage, 10, 3), { ids: ["agent:ann", "agent:bob", "agent:cal"], partial: false });
      let pages = 0;
      const endless = { listAggregates: async (_kind: string, page: { afterId?: string }) => { pages++; return Array.from({ length: 200 }, (_, i) => ({ id: `agent:z${pages}-${String(i).padStart(3, "0")}`, body: { state: i === 0 ? "active" : "disabled" } })); } };
      const walked = await activeAgentIds(endless as never);
      assert.deepEqual([walked.ids.length, walked.partial, pages], [CAPACITY_LIMITS.principalPages, true, CAPACITY_LIMITS.principalPages]);
      pages = 0;
      const many = await activeAgentIds({ listAggregates: async () => { pages++; return Array.from({ length: 200 }, (_, i) => ({ id: `agent:y${pages}-${String(i).padStart(3, "0")}`, body: { state: "active" } })); } } as never);
      assert.deepEqual([many.ids.length, many.partial, pages], [CAPACITY_LIMITS.agents, true, 3]);
      // Records that are not active agents are not counted: a host, a disabled agent, a body without a state.
      assert.deepEqual(await activeAgentIds({ listAggregates: async () => [{ id: "host:w9", body: { state: "active" } }, { id: "agent:off", body: { state: "disabled" } }, { id: "agent:odd", body: {} }, { id: "agent:", body: { state: "active" } }] } as never), { ids: ["agent:"], partial: false });

      // A partial agent walk is said with the counts of those read.
      const partly = new IntegratorCapacity(r.leases, { agents: async () => ({ ids: ["agent:ann"], partial: true }), principal: (id) => r.w.principals.current(id) });
      assert.deepEqual(await partly.of(a, "main"), { state: "free", free: 1, busy: 0, partial: true });
      const nobodyPartly = new IntegratorCapacity(r.leases, { agents: async () => ({ ids: [], partial: true }), principal: (id) => r.w.principals.current(id) });
      assert.deepEqual(await nobodyPartly.of(a, "main"), { state: "nobody", partial: true });
      // Leases that cannot all be read: nothing is said to be free or busy, and no agent is read.
      let asked = 0;
      const blind = new IntegratorCapacity({ liveLeases: async () => ({ leases: [], partial: true }), get: async () => undefined }, { agents: async () => { asked++; return { ids: ["agent:ann"], partial: false }; }, principal: (id) => r.w.principals.current(id) });
      assert.deepEqual(await blind.of(a, "main"), { state: "unknown", reason: "the integrator leases could not all be read" });
      assert.equal(asked, 0);
      // A principal answer that is not the agent asked about (another ID, another kind) is not counted; a malformed agent ID is skipped without a read.
      const reads: string[] = [];
      const ann = (await r.w.principals.current("agent:ann"))!;
      const odd = new IntegratorCapacity(r.leases, {
        agents: async () => ({ ids: ["agent:bob", "agent:cal", "agent:", "host:w1"], partial: false }),
        principal: async (id) => { reads.push(id); return id === "agent:bob" ? ann : id === "agent:cal" ? ({ ...(await r.w.principals.current(id))!, kind: "client" } as Principal) : r.w.principals.current(id); },
      });
      assert.deepEqual(await odd.of(a, "main"), { state: "nobody", partial: false });
      assert.deepEqual(reads, ["agent:bob", "agent:cal"]);
      // A task-scoped answer does not serve (the pool's rule: only an agent's own credential).
      const scoped = new IntegratorCapacity(r.leases, { agents: async () => ({ ids: ["agent:ann"], partial: false }), principal: async (id) => ({ ...(await r.w.principals.current(id))!, taskScope: { taskId: "t", projectId: a } } as Principal) });
      assert.deepEqual(await scoped.of(a, "main"), { state: "nobody", partial: false });
      // A failing read is not answered as a guess: it is thrown to the view (which says not known).
      const failing = new IntegratorCapacity({ liveLeases: async () => { throw new DomainError("unavailable", "store down"); }, get: async () => undefined }, { agents: async () => ({ ids: [], partial: false }), principal: async () => undefined });
      await assert.rejects(() => failing.of(a, "main"), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
      // A live hold of this branch by a holder name whose principal is missing is not capacity in use.
      const ghost = { holder: "ghost", projectId: a, branch: "main", live: true, expiresAt: "2030-01-01T00:00:00.000Z" } as unknown as IntegratorLease;
      const ghosts = new IntegratorCapacity({ liveLeases: async () => ({ leases: [ghost], partial: false }), get: async () => undefined }, { agents: () => activeAgentIds(r.w.storage), principal: (id) => r.w.principals.current(id) });
      assert.deepEqual(await ghosts.of(a, "main"), { state: "free", free: 3, busy: 0, partial: false });
      // A live hold of another project by an integrator that serves this one makes it busy (one project at a time), whatever branch.
      const elsewhere = { ...ghost, holder: "ann", projectId: "prj-elsewhere" } as IntegratorLease;
      const wide = new IntegratorCapacity({ liveLeases: async () => ({ leases: [elsewhere], partial: false }), get: async () => undefined }, { agents: () => activeAgentIds(r.w.storage), principal: async (id) => { const p = (await r.w.principals.current(id))!; return id === "agent:ann" ? { ...p, grants: [...p.grants, { action: "integration.lease", project: "prj-elsewhere" }] } as Principal : p; } });
      assert.deepEqual(await wide.of(a, "main"), { state: "free", free: 2, busy: 1, partial: false });
    } finally { await r.close(); }
  });

  test(`${backend.name}: liveLeases reads every live lease once, of every holder and project, and stops at its page bound (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      await r.queued(a); await r.queued(b);
      const ivy = await r.person("ivy", lands([a, b])), max = await r.person("max", lands([a, b]));
      await r.pool.next(ivy, { commandId: "i1", ttlMs: 10 * MIN });
      await r.pool.next(max, { commandId: "m1", ttlMs: 30 * MIN });
      const all = await r.leases.liveLeases();
      assert.deepEqual([all.partial, all.leases.map((l) => [l.holder, l.projectId]).sort()], [false, [["ivy", a], ["max", b]]]);
      r.w.clock.advance(11 * MIN);
      assert.deepEqual((await r.leases.liveLeases()).leases.map((l) => l.holder), ["max"], "an expired hold is not live");
      assert.deepEqual(await r.leases.liveLeases(0), { leases: [], partial: true }, "no page read is partial");
    } finally { await r.close(); }
  });
}
