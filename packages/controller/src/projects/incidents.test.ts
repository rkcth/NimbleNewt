import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { IncidentService } from "./incidents.js";
import { ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: { owner: Principal; project: string; duties: ResponsibilityService; inc: IncidentService; again(): IncidentService; setNow(iso: string): void; make(extra?: Record<string, unknown>): Promise<string>; agent(grants: { action: string; project: string }[]): Promise<Principal> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = "2026-10-22T10:00:00.000Z";
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const inc = IncidentService.withEpoch(world.storage, projects.epoch, duties, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        await body({
          owner, project, duties, inc,
          again: () => IncidentService.withEpoch(world.storage, projects.epoch, ResponsibilityService.withEpoch(world.storage, projects.epoch, options), options),
          setNow: (iso) => { now = iso; },
          make: async (extra = {}) => (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, escalation: { to: "owner", afterMinutes: 30 }, ...extra } as never)).id,
          agent: async (grants) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `a${n++}`, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:a${n - 1}`)).token); },
        });
      } finally { await world.close(); }
    });

  suite("repeated alerts with one signature are one open incident that counts them and keeps the worst; another signature is another incident; a resolved one opens afresh", async ({ owner, project, duties, inc, setNow, make }) => {
    const r = await make();
    const report = (signature: string, outcome: "attention" | "failed", summary: string) => inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature, summary, outcome });
    await report("disk-full:web-1", "attention", "85% full");
    setNow("2026-10-22T10:05:00.000Z");
    await report("disk-full:web-1", "failed", "100% full");
    await report("disk-full:web-1", "attention", "99% full");
    await report("cert-expiring", "attention", "3 days left");
    const open = (await inc.list(owner, project, { open: true }))!;
    assert.equal(open.length, 2);
    const disk = open.find((i) => i.signature === "disk-full:web-1")!;
    assert.deepEqual([disk.count, disk.worst, disk.lastSummary, disk.firstAt, disk.lastAt], [3, "failed", "99% full", "2026-10-22T10:00:00.000Z", "2026-10-22T10:05:00.000Z"]);
    // The same command again counts once.
    const id = cid("same");
    await inc.report(owner, { commandId: id, responsibilityId: r, signature: "cert-expiring", summary: "2 days left", outcome: "attention" });
    await inc.report(owner, { commandId: id, responsibilityId: r, signature: "cert-expiring", summary: "2 days left", outcome: "attention" });
    assert.equal((await inc.list(owner, project, { open: true }))!.find((i) => i.signature === "cert-expiring")!.count, 2);
    await inc.resolve(owner, { commandId: cid("v"), incidentId: disk.id, evidence: "disk cleaned, 40% used" });
    await assert.rejects(inc.resolve(owner, { commandId: cid("v"), incidentId: disk.id, evidence: "again" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    await report("disk-full:web-1", "attention", "85% full again");
    const after = (await inc.list(owner, project))!;
    assert.deepEqual(after.filter((i) => i.signature === "disk-full:web-1").map((i) => [i.state, i.count]).sort(), [["open", 1], ["resolved", 3]], "the new alert is a new incident, the old one stays as it was");
    void duties;
  });

  suite("an incident still open at the responsibility's escalation time is escalated once, whichever instance looks, and a resolved one never is", async ({ owner, project, inc, again, setNow, make }) => {
    const r = await make();
    await inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature: "a", summary: "x", outcome: "failed" });
    await inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature: "b", summary: "y", outcome: "attention" });
    const b = (await inc.list(owner, project))!.find((i) => i.signature === "b")!;
    await inc.resolve(owner, { commandId: cid("v"), incidentId: b.id, evidence: "fine" });
    setNow("2026-10-22T10:20:00.000Z");
    assert.deepEqual(await inc.escalate(owner, project), [], "not yet");
    setNow("2026-10-22T10:31:00.000Z");
    const first = await inc.escalate(owner, project);
    assert.deepEqual(first.map((i) => [i.signature, i.escalatedTo, i.escalatedAt]), [["a", "owner", "2026-10-22T10:31:00.000Z"]]);
    assert.deepEqual(await inc.escalate(owner, project), []);
    assert.deepEqual(await again().escalate(owner, project), [], "nor after a restart");
    // The notice is separate from the escalation: it stays to be told until it is marked as told.
    assert.deepEqual((await inc.untold(owner, project)).map((i) => i.signature), ["a"]);
    await inc.markNotified(owner, first[0]!.id);
    await inc.markNotified(owner, first[0]!.id);
    assert.deepEqual(await again().untold(owner, project), []);
  });

  suite("an incident that alerts as often as the owner set is escalated at once, with no wait for the time, and a rule the owner did not set applies to nothing (card P04c)", async ({ owner, project, inc, make }) => {
    const often = await make({ escalation: { to: "owner", afterAlerts: 3 } });
    const timeOnly = await make({ title: "Another duty" });
    const alert = (r: string, n: number) => inc.report(owner, { commandId: cid(`i${n}`), responsibilityId: r, signature: "s", summary: `again ${n}`, outcome: "failed" });
    await alert(often, 1); await alert(often, 2);
    assert.deepEqual(await inc.escalate(owner, project), [], "two alerts are not enough");
    await alert(often, 3);
    assert.deepEqual((await inc.escalate(owner, project)).map((i) => [i.responsibilityId, i.count]), [[often, 3]], "the third escalates at once");
    assert.deepEqual(await inc.escalate(owner, project), [], "once");
    for (let n = 1; n <= 5; n++) await alert(timeOnly, n);
    assert.deepEqual(await inc.escalate(owner, project), [], "a duty with only the time rule is not escalated by count");
    await assert.rejects(() => make({ escalation: { to: "owner", afterAlerts: 1 } }), /afterAlerts/);
  });

  suite("the observed state is unknown without a recent check and never healthy by default; open incidents show as attention or failed", async ({ owner, duties, inc, setNow, make }) => {
    const r = await make();
    assert.deepEqual((await inc.observed(owner, r))!.observed, "unknown", "never checked");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: r, kind: "check", summary: "all well", outcome: "ok" });
    assert.equal((await inc.observed(owner, r))!.observed, "ok");
    assert.equal((await inc.observed(owner, r))!.intended, "");
    setNow("2026-10-22T12:30:00.000Z");
    assert.equal((await inc.observed(owner, r))!.observed, "unknown", "the last check is older than two periods");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: r, kind: "check", summary: "all well", outcome: "ok" });
    await inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature: "s", summary: "slow", outcome: "attention" });
    assert.deepEqual([(await inc.observed(owner, r))!.observed, (await inc.observed(owner, r))!.openIncidents], ["attention", 1]);
    await inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature: "s", summary: "down", outcome: "failed" });
    assert.equal((await inc.observed(owner, r))!.observed, "failed");
  });

  suite("who may report, resolve, escalate and read incidents: the owner, the responsible agent or a holder of responsibility.write; others are refused", async ({ owner, project, inc, make, agent }) => {
    const r = await make();
    const stranger = await agent([{ action: "task.read", project }]);
    await assert.rejects(inc.report(stranger, { commandId: cid("i"), responsibilityId: r, signature: "s", summary: "x", outcome: "failed" }), (e: unknown) => e instanceof DomainError);
    assert.equal(await inc.list(stranger, project), undefined);
    await assert.rejects(inc.escalate(stranger, project), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    const writer = await agent([{ action: "responsibility.write", project }, { action: "responsibility.read", project }]);
    assert.equal((await inc.report(writer, { commandId: cid("i"), responsibilityId: r, signature: "s", summary: "x", outcome: "failed" })).replayed, false);
  });

  suite("soft archive (card K06): old resolved incidents are archived up to the limit once, hidden from list unless asked; young, open and escalated-untold ones stay; only owner or service may", async ({ owner, project, inc, setNow, make, agent }) => {
    const r = await make();
    const rep = (sig: string) => inc.report(owner, { commandId: cid("i"), responsibilityId: r, signature: sig, summary: "x", outcome: "attention" });
    const res = async (sig: string) => { const i = (await inc.list(owner, project, { open: true }))!.find((x) => x.signature === sig)!; await inc.resolve(owner, { commandId: cid("v"), incidentId: i.id, evidence: "ok" }); return i.id; };
    await rep("old1"); await rep("old2"); await rep("old3"); await rep("untold"); await rep("stays-open");
    await res("old1"); await res("old2"); await res("old3");
    setNow("2026-10-22T10:40:00.000Z");
    await inc.escalate(owner, project);
    await res("untold");
    setNow("2027-03-30T10:00:00.000Z");
    await rep("young"); await res("young");
    const stranger = await agent([{ action: "responsibility.write", project }]);
    await assert.rejects(inc.archive(stranger), (e: unknown) => e instanceof DomainError);
    await assert.rejects(inc.archive(owner, { olderThanDays: 3 }), (e: unknown) => e instanceof DomainError);
    assert.equal(await inc.archive(owner, { limit: 2 }), 2, "the limit is respected");
    assert.equal(await inc.archive(owner), 1, "the rest of the old ones");
    assert.equal(await inc.archive(owner), 0, "a repeat archives nothing more");
    const visible = (await inc.list(owner, project))!.map((i) => i.signature).sort();
    assert.deepEqual(visible, ["stays-open", "untold", "young"].sort());
    assert.equal((await inc.list(owner, project, { includeArchived: true }))!.length, 6);
  });
}
