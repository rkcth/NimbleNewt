import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { IncidentService } from "./incidents.js";
import { MaintenanceLeaseService } from "./leases.js";
import { ProjectResourceService, ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-10T10:00:00.000Z";

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    owner: Principal; project: string; duties: ResponsibilityService; inc: IncidentService; leases: MaintenanceLeaseService; resource: string; ann: Principal; bob: Principal; carl: Principal; duty: string;
    setNow(iso: string): void; makeDuty(extra: Record<string, unknown>): Promise<{ duty: string; resource: string }>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const inc = IncidentService.withEpoch(world.storage, projects.epoch, duties, options);
        const leases = MaintenanceLeaseService.withEpoch(world.storage, projects.epoch, duties, inc, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        const agent = async (grants: { action: string; project: string }[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `a${n++}`, grants: grants as never });
          return principals.authenticate((await principals.issueCredential(owner, `agent:a${n - 1}`)).token);
        };
        const rights = [{ action: "responsibility.read", project }, { action: "responsibility.write", project }];
        const ann = await agent(rights);
        const bob = await agent(rights);
        const carl = await agent([]);
        let k = 0;
        const makeDuty = async (extra: Record<string, unknown>): Promise<{ duty: string; resource: string }> => {
          const res = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "service", label: `Web ${k++}`, locator: "https://example.test/health" } as never);
          const duty = (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, ownerId: ann.id, managed: [res.id], ...extra } as never)).id;
          return { duty, resource: res.id };
        };
        const first = await makeDuty({});
        await body({ owner, project, duties, inc, leases, resource: first.resource, duty: first.duty, ann, bob, carl, setNow: (iso) => { now = iso; }, makeDuty });
      } finally { await world.close(); }
    });

  const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

  suite("a second agent's attempt on a leased resource is blocked and recorded visibly; the holder keeps it and can renew", async ({ owner, project, leases, resource, ann, bob, setNow }) => {
    const got = await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "rotate the certificate", minutes: 30 });
    assert.deepEqual([got.status, got.lease.holderId, got.lease.status, got.lease.expiresAt], ["granted", ann.id, "held", "2026-11-10T10:30:00.000Z"]);
    setNow("2026-11-10T10:05:00.000Z");
    const blocked = await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "restart the proxy" });
    assert.equal(blocked.status, "blocked");
    assert.deepEqual([blocked.lease.holderId, blocked.lease.blockedCount], [ann.id, 1]);
    assert.deepEqual(blocked.lease.blocked.map((b) => [b.by, b.holder, b.purpose, b.at]), [[bob.id, ann.id, "restart the proxy", "2026-11-10T10:05:00.000Z"]]);
    // A replay of the blocked command still answers blocked and counts once.
    const id = cid("again");
    await leases.acquire(bob, { commandId: id, resourceId: resource, purpose: "try again" });
    const replay = await leases.acquire(bob, { commandId: id, resourceId: resource, purpose: "try again" });
    assert.deepEqual([replay.status, replay.lease.blockedCount], ["blocked", 2]);
    // The holder renews: same holding, a new end, and the blocks stay on the record.
    const renewed = await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "rotate the certificate", minutes: 60 });
    assert.deepEqual([renewed.status, renewed.lease.generation, renewed.lease.renewals, renewed.lease.expiresAt, renewed.lease.blockedCount], ["granted", 1, 1, "2026-11-10T11:05:00.000Z", 2]);
    // Everyone who can read the project sees it; the owner too.
    for (const who of [owner, bob]) {
      const seen = (await leases.list(who, project))!;
      assert.deepEqual(seen.map((l) => [l.resourceId, l.holderId, l.status, l.blockedCount]), [[resource, ann.id, "held", 2]]);
    }
    assert.equal((await leases.list(bob, project, { resourceId: "no-such" }))!.length, 0);
  });

  suite("old blocks are bounded to the last ten but are all counted", async ({ leases, resource, ann, bob }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "work" });
    for (let i = 0; i < 13; i++) await leases.acquire(bob, { commandId: cid("b"), resourceId: resource, purpose: `try ${i}` });
    const lease = (await leases.acquire(bob, { commandId: cid("b"), resourceId: resource, purpose: "last" })).lease;
    assert.equal(lease.blockedCount, 14);
    assert.equal(lease.blocked.length, 10);
    assert.equal(lease.blocked.at(-1)!.purpose, "last");
  });

  suite("an expired lease reads as expired until someone takes it", async ({ project, leases, resource, ann, bob, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "slow job", minutes: 10 });
    setNow("2026-11-10T10:11:00.000Z");
    assert.deepEqual((await leases.list(bob, project))!.map((l) => [l.holderId, l.status]), [[ann.id, "expired"]]);
    const took = await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "mine" });
    assert.deepEqual([took.status, took.lease.holderId, took.lease.generation, took.lease.tookOverFrom], ["granted", bob.id, 2, { holder: ann.id, expiredAt: "2026-11-10T10:10:00.000Z" }]);
  });

  suite("who may lease: the owner, the answerable agent and a holder of responsibility.write; not an outsider, an unmanaged resource, a paused or a retired responsibility", async ({ owner, project, duties, leases, resource, duty, ann, carl, makeDuty }) => {
    assert.equal(await code(leases.acquire(carl, { commandId: cid("a"), resourceId: resource, purpose: "x" })), "forbidden");
    assert.equal(await code(leases.acquire(owner, { commandId: cid("a"), resourceId: "unmanaged-thing", purpose: "x" })), "forbidden");
    for (const bad of [{ purpose: "" }, { purpose: "x", minutes: 0 }, { purpose: "x", minutes: 1441 }, { purpose: "x", minutes: 1.5 }, { purpose: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }]) assert.equal(await code(leases.acquire(ann, { commandId: cid("a"), resourceId: resource, ...bad } as never)), "invalid_command");
    assert.equal(await code(leases.acquire(owner, { commandId: cid("a"), resourceId: resource, purpose: "owner may" })), "ok");
    await leases.release(owner, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "fine" });
    await duties.update(owner, { commandId: cid("u"), responsibilityId: duty, expectedRevision: (await duties.get(owner, duty))!.revision, state: "paused" } as never);
    assert.equal(await code(leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "x" })), "invalid_command", "a paused responsibility starts no new maintenance");
    const other = await makeDuty({});
    await duties.update(owner, { commandId: cid("u"), responsibilityId: other.duty, expectedRevision: (await duties.get(owner, other.duty))!.revision, state: "retired" } as never);
    assert.equal(await code(leases.acquire(owner, { commandId: cid("a"), resourceId: other.resource, purpose: "x" })), "forbidden", "a retired responsibility no longer manages the resource");
    assert.equal((await leases.list(carl, project)), undefined);
  });

  suite("a passed validation frees the lease and writes an ok entry into the history; repeating the release writes nothing twice", async ({ owner, duties, leases, resource, duty, ann, bob }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "patch" });
    assert.equal(await code(leases.release(bob, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "mine now" })), "forbidden", "only the holder (or the owner) releases");
    const id = cid("rel");
    const out = await leases.release(ann, { commandId: id, resourceId: resource, validation: "passed", evidence: "health 200 for 5 minutes" });
    assert.deepEqual([out.lease.status, out.lease.holderId, out.lease.lastRelease?.validation], ["free", undefined, "passed"]);
    await leases.release(ann, { commandId: id, resourceId: resource, validation: "passed", evidence: "health 200 for 5 minutes" });
    const history = (await duties.history(owner, duty, { limit: 50 }))!.items;
    assert.deepEqual(history.map((h) => [h.kind, h.outcome]), [["intervention", "ok"]]);
    assert.match(history[0]!.summary, /validated: health 200/);
    assert.equal(await code(leases.release(ann, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "again" })), "invalid_command", "nothing is held now");
    // The next agent takes it from a free lease without a lapse on record.
    const next = await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "next" });
    assert.deepEqual([next.status, next.lease.generation, next.lease.tookOverFrom], ["granted", 2, undefined]);
  });

  suite("a failed validation is rolled back only when the responsibility permits it; otherwise it must escalate; both are recorded", async ({ owner, duties, inc, project, leases, ann, makeDuty }) => {
    const plain = await makeDuty({ permittedActions: ["desk.write"], escalation: { to: "owner" } });
    await leases.acquire(ann, { commandId: cid("a"), resourceId: plain.resource, purpose: "upgrade" });
    assert.equal(await code(leases.release(ann, { commandId: cid("r"), resourceId: plain.resource, validation: "failed", evidence: "500s", onFailure: "rollback" })), "invalid_command", "rollback is not a permitted action here");
    assert.equal(await code(leases.release(ann, { commandId: cid("r"), resourceId: plain.resource, validation: "failed", evidence: "500s" })), "invalid_command", "a failed validation needs a response");
    assert.equal((await leases.list(ann, project, { resourceId: plain.resource }))![0]!.status, "held", "a refused release leaves the lease held");
    const esc = await leases.release(ann, { commandId: cid("r"), resourceId: plain.resource, validation: "failed", evidence: "500s on /health", onFailure: "escalate" });
    assert.equal(esc.response, "escalate");
    const incident = (await inc.list(owner, project))!.find((i) => i.id === esc.incidentId)!;
    assert.deepEqual([incident.state, incident.worst, incident.escalatedTo, incident.escalatedAt !== undefined, incident.signature], ["open", "failed", "owner", true, `maintenance-validation:${plain.resource}`]);
    assert.equal((await inc.untold(owner, project)).length, 1, "the loop that tells the owner will find it");
    const h1 = (await duties.history(owner, plain.duty, { limit: 50 }))!.items.filter((h) => h.kind === "intervention");
    assert.deepEqual(h1.map((h) => h.outcome), ["failed"]);
    assert.match(h1[0]!.summary, /escalated \(incident /);

    const permitted = await makeDuty({ permittedActions: ["desk.write", "rollback"] });
    await leases.acquire(ann, { commandId: cid("a"), resourceId: permitted.resource, purpose: "upgrade" });
    const rb = await leases.release(ann, { commandId: cid("r"), resourceId: permitted.resource, validation: "failed", evidence: "restored the previous build, health 200", onFailure: "rollback" });
    assert.deepEqual([rb.response, rb.incidentId, rb.lease.status, rb.lease.lastRelease?.response], ["rollback", undefined, "free", "rollback"]);
    const h2 = (await duties.history(owner, permitted.duty, { limit: 50 }))!.items;
    assert.match(h2[0]!.summary, /rolled back under the permitted action/);
    assert.equal(h2[0]!.outcome, "failed");
  });

  suite("escalating with no escalation rule on the responsibility goes to the owner; a response without a failed validation is refused", async ({ owner, inc, project, leases, ann, makeDuty }) => {
    const bare = await makeDuty({});
    await leases.acquire(ann, { commandId: cid("a"), resourceId: bare.resource, purpose: "x" });
    assert.equal(await code(leases.release(ann, { commandId: cid("r"), resourceId: bare.resource, validation: "passed", evidence: "ok", onFailure: "escalate" })), "invalid_command");
    const out = await leases.release(ann, { commandId: cid("r"), resourceId: bare.resource, validation: "failed", evidence: "broken", onFailure: "escalate" });
    assert.equal((await inc.list(owner, project))!.find((i) => i.id === out.incidentId)!.escalatedTo, "owner");
  });

  suite("the owner releases another agent's lease by force with a reason, recorded; an agent cannot", async ({ owner, duties, duty, leases, resource, ann, bob }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "stuck job" });
    assert.equal(await code(leases.release(bob, { commandId: cid("r"), resourceId: resource, evidence: "she is gone" })), "forbidden");
    assert.equal(await code(leases.release(owner, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "pretend" })), "invalid_command", "only the holder reports a validation");
    const out = await leases.release(owner, { commandId: cid("r"), resourceId: resource, evidence: "agent stopped responding" });
    assert.deepEqual([out.lease.status, out.lease.lastRelease?.forced, out.lease.lastRelease?.by], ["free", true, owner.id]);
    const h = (await duties.history(owner, duty, { limit: 10 }))!.items;
    assert.match(h[0]!.summary, /released by force \(agent stopped responding\)/);
    assert.equal(h[0]!.outcome, undefined);
  });

  suite("the lease survives a new service instance (restart): the holder, the end and the blocks are in the store", async ({ project, leases, resource, ann, bob }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "long", minutes: 120 });
    await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "wait" });
    const seen = (await leases.list(bob, project))![0]!;
    assert.deepEqual([seen.holderId, seen.blockedCount, seen.status], [ann.id, 1, "held"]);
  });

  suite("pausing the responsibility keeps its owner, its open incident, the escalation queue and the lease as they were", async ({ owner, project, duties, inc, leases, resource, duty, ann, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "patch", minutes: 120 });
    await inc.report(ann, { commandId: cid("i"), responsibilityId: duty, signature: "disk-full", summary: "95%", outcome: "failed" });
    await duties.update(owner, { commandId: cid("u"), responsibilityId: duty, expectedRevision: (await duties.get(owner, duty))!.revision, state: "paused", escalation: { to: "owner", afterMinutes: 10 } } as never);
    setNow("2026-11-10T10:30:00.000Z");
    assert.equal((await duties.get(owner, duty))!.ownerId, ann.id);
    assert.deepEqual((await leases.list(owner, project))!.map((l) => [l.holderId, l.status]), [[ann.id, "held"]]);
    assert.equal((await inc.list(owner, project, { open: true }))!.length, 1, "the alert is still there");
    assert.equal((await inc.escalate(owner, project)).length, 1, "and its escalation still comes due while the responsibility is paused");
    assert.equal((await inc.untold(owner, project)).length, 1, "queued until the owner is told");
  });
}
