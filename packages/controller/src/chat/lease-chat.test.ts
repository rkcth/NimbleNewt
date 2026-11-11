import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { IncidentService, MaintenanceLeaseService, ResponsibilityService } from "../projects/index.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card P04: the owner reaches the maintenance leases, the responsibility switch and incident resolution in plain words, with no fixed phrase and no revision to quote.
for (const backend of backends) {
  test(`${backend.name}: the owner force-releases a lease, pauses a responsibility and resolves an incident by chat; each is shown or applied by its mode and refused for an agent`, async () => {
    assert.equal(CHAT_OPS["lease.release"]?.mode, "propose", "ending a lease by force or with a failed validation is shown first");
    assert.equal(CHAT_OPS["lease.acquire"]?.mode, "apply");
    assert.equal(CHAT_OPS["responsibility.update"]?.mode, "propose");
    assert.equal(CHAT_OPS["incident.resolve"]?.mode, "profile");
    assert.ok(acceptedArgs("responsibility.update")!.includes("responsibilityId") && acceptedArgs("responsibility.update")!.includes("expectedRevision") === true, "the revision is filled in by the chat");
    assert.ok(acceptedArgs("incident.resolve")!.includes("incidentSignature") && acceptedArgs("lease.acquire")!.includes("resourceLabel") && acceptedArgs("responsibility.update")!.includes("responsibilityTitle"), "named in words, never by ID");
    assert.ok(acceptedArgs("lease.release")!.includes("onFailure") && acceptedArgs("lease.release")!.includes("evidence"));
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, (storage: ControllerStorage, epoch: number) => {
      const duties = ResponsibilityService.withEpoch(storage, epoch);
      const incidents = IncidentService.withEpoch(storage, epoch, duties);
      return { incidents, leases: MaintenanceLeaseService.withEpoch(storage, epoch, duties, incidents) };
    });
    try {
      const chat = w.chat();
      const p = await w.project("Ops");
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: p });
      const ann = await w.agent("ann", [{ action: "responsibility.read", project: "*" }, { action: "responsibility.write", project: "*" }]);
      const res = await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Web", locator: "https://example.test" } as never);
      const duty = (await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep web up", objective: "Up", everyMinutes: 60, ownerId: ann.principal.id, managed: [res.id] } as never)).id;
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

      // An agent takes the lease through the API; a rival is blocked and the block is visible to the owner.
      assert.equal((await call(ann.token, "lease.acquire", { resourceId: res.id, purpose: "patch the proxy" }, cid("a"))).result.status, "granted");
      const bob = await w.agent("bob", [{ action: "responsibility.read", project: "*" }, { action: "responsibility.write", project: "*" }]);
      const rival = await call(bob.token, "lease.acquire", { resourceId: res.id, purpose: "restart it" }, cid("a"));
      assert.equal(rival.result.status, "blocked");
      assert.equal((await call(w.ownerToken, "lease.list", { projectId: p })).result.items[0].blockedCount, 1);

      // Force-release by chat: shown first, applied once on the owner's word.
      const text = "ann has been stuck on the web server for hours, take the maintenance lease away from her";
      script[text] = [cmd("lease.release", { resourceLabel: "Web", evidence: "stuck on the web server for hours" }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes[0]));
      assert.equal((await call(w.ownerToken, "lease.list", { projectId: p })).result.items[0].status, "held", "nothing happens until the owner confirms");
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).applied, true);
      assert.equal((await call(w.ownerToken, "lease.list", { projectId: p })).result.items[0].status, "free");
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).replayed, true);

      // Pausing the responsibility: the revision is read for the owner.
      const pause = "pause keep web up for now";
      script[pause] = [cmd("responsibility.update", { responsibilityTitle: "Keep web up", state: "paused" }, pause)];
      const pr = await chat.submit(w.ownerToken, { messageId: cid("m"), text: pause });
      assert.equal(pr.outcomes[0]!.status, "proposed");
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: pr.outcomes[0]!.proposalId! })).applied, true);
      assert.equal((await w.responsibilities.get(w.owner, duty))!.state, "paused");
      assert.equal((await call(ann.token, "lease.acquire", { resourceId: res.id, purpose: "again" }, cid("a"))).error?.code, "invalid_command", "a paused responsibility starts no new maintenance");

      // Resolving an incident.
      const inc = await call(ann.token, "incident.report", { responsibilityId: duty, signature: "disk-full", summary: "95%", outcome: "attention" }, cid("i"));
      const done = "the disk-full alert on keep web up is fixed, it is at 40% now";
      script[done] = [cmd("incident.resolve", { responsibilityTitle: "Keep web up", incidentSignature: "disk-full", evidence: "it is at 40% now" }, done)];
      const rr = await chat.submit(w.ownerToken, { messageId: cid("m"), text: done });
      assert.ok(["applied", "proposed"].includes(rr.outcomes[0]!.status), JSON.stringify(rr.outcomes[0]) + `an explicit order follows the profile: ${rr.outcomes[0]!.status}`);
      if (rr.outcomes[0]!.status === "proposed") await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: rr.outcomes[0]!.proposalId! });
      assert.equal((await call(w.ownerToken, "responsibility.incidents", { projectId: p, open: true })).result.items.length, 0);

      for (const t of [text, pause, done]) await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text: t }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });
}
