import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the stand-up agenda lists the owner's real pending items for the owner only, and an unreadable inbox is said so, through the running controller (card M03f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-own-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  const original = NotificationService.prototype.inbox;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [{ action: "meeting.manage", project }, { action: "meeting.read", project }] });
    const host = (await c.services.principals.issueCredential(rob, "host:h1")).token;
    // A real pending item for the owner in this project, through the notification service the controller runs on.
    await NotificationService.withEpoch(c.storage, c.epoch).emitFromController({ commandId: "n1", kind: "maintenance", ref: { kind: "project", id: project }, projectId: project, detail: "The deploy key expires tomorrow." });
    const meet = async (key: string): Promise<string> => { const m = await call(boot.token, "meeting.call-urgent", { projectId: project, title: `Sync ${key}`, reason: "check", roster: [`agent:${a}`] }, `u-${key}`); assert.ok(m.ok, JSON.stringify(m)); return m.result.id as string; };
    const occ = await meet("1");
    const prep = await call(boot.token, "standup.prepare", { occurrenceId: occ }, "pp1");
    assert.ok(prep.ok, JSON.stringify(prep));
    const ownerSees = (await call(boot.token, "standup.agenda", { occurrenceId: occ })).result.item.needsOwner as { text: string; cites: { kind: string }[] }[];
    assert.equal(ownerSees.length, 1);
    assert.equal(ownerSees[0]!.cites[0]!.kind, "notification-item");
    const hostView = await call(host, "standup.agenda", { occurrenceId: occ });
    assert.equal(hostView.result?.item?.needsOwner, undefined, "a host does not receive the owner's list");
    assert.equal((await call(host, "standup.prepared", { occurrenceId: occ })).result?.item?.needsOwner, undefined);

    // A failing inbox read is said to the owner, not hidden.
    NotificationService.prototype.inbox = async () => { throw new Error("inbox down"); };
    const occ2 = await meet("2");
    assert.ok((await call(boot.token, "standup.prepare", { occurrenceId: occ2 }, "pp2")).ok);
    const broken = (await call(boot.token, "standup.agenda", { occurrenceId: occ2 })).result.item.needsOwner as { text: string }[];
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.text, "The list of what needs you could not be read just now; it is in your inbox.");
  } finally { NotificationService.prototype.inbox = original; await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner's stand-up opens with Needs-you and Urgent items (urgent first), notices appear only as one count line, owner only, and a notice does not rewrite the preparation", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-lvl-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [{ action: "meeting.manage", project }, { action: "meeting.read", project }] });
    const host = (await c.services.principals.issueCredential(rob, "host:h1")).token;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const emit = (commandId: string, kind: string, detail: string, extra: Record<string, unknown> = {}) => notifications.emitFromController({ commandId, kind, ref: { kind: "project", id: (extra.refId as string | undefined) ?? project }, projectId: project, detail, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "refId")) } as never);
    await emit("n1", "maintenance", "Needs you item.");
    await emit("n2", "safety-stop", "Urgent item.", { refId: "urg" });
    await emit("n3", "presence", "A notice about someone being away.");
    await emit("n4", "presence", "Another notice.", { refId: "other" });
    const m = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Sync", reason: "check", roster: [`agent:${a}`] }, "u1");
    const occ = m.result.id as string;
    assert.ok((await call(boot.token, "standup.prepare", { occurrenceId: occ }, "pp1")).ok);
    const agenda = async (token: string) => (await call(token, "standup.agenda", { occurrenceId: occ })).result?.item;
    const first = await agenda(boot.token);
    assert.equal(first.needsOwner.length, 2);
    assert.match(first.needsOwner[0].text, /^Urgent: /);
    assert.doesNotMatch(first.needsOwner[1].text, /^Urgent: /);
    assert.ok(first.needsOwner.every((l: { text: string }) => !/notice/i.test(l.text)), "notices are not lines");
    assert.equal(first.noticeLine, "2 notices in your inbox, no action needed");
    const keys = Object.keys(first);
    assert.ok(keys.indexOf("needsOwner") < keys.indexOf("items") && keys.indexOf("noticeLine") > keys.indexOf("sections"), "needs-you first, the notice line after");
    const hostView = await agenda(host);
    assert.equal(hostView?.needsOwner, undefined);
    assert.equal(hostView?.noticeLine, undefined, "a host never gets the count");
    // A further notice changes the count line live but does not rewrite the preparation.
    const rev = async () => (await call(boot.token, "standup.prepared", { occurrenceId: occ })).result.item.revision;
    const before = await rev();
    await emit("n5", "presence", "Third notice.", { refId: "third" });
    assert.ok((await call(boot.token, "standup.prepare", { occurrenceId: occ }, "pp2")).ok);
    assert.equal(await rev(), before);
    assert.equal((await agenda(boot.token)).noticeLine, "3 notices in your inbox, no action needed");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
