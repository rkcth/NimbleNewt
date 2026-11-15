import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { defaultReply } from "../meetings/floor-suite.js";
import type { TurnRequest } from "../meetings/floor-types.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

// The running controller (cards M05 and M06 together): the facilitated run is the procedure's members and chair, the scheduled loop drives a meeting and reminds an idle inquiry by itself, the owner is told when an inquiry
// opens and when it is idle, and an open inquiry is on the Needs-you list, where one word ends it.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("one service runs a motion in the running controller: the scheduled loop finishes it with nobody calling advance, an inquiry is told to the owner and listed on Needs-you, and one word there ends it (cards M05, M06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mfloor-"));
  let clock = Date.now();
  const asked: TurnRequest[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000, clock: () => new Date(clock).toISOString() },
    notifications: { clock: () => new Date(clock).toISOString() },
    meetingFloor: { runner: { turn: async (r) => { asked.push(r); return defaultReply(r); } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = (await c.services.principals.authenticate(boot.token))!;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tokens = new Map<string, string>();
    for (const name of ["ann", "bob", "cat"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants: [{ action: "task.read", project }, { action: "meeting.attend", project }] });
      tokens.set(name, (await c.services.principals.issueCredential(rob, `agent:${name}`)).token);
    }
    const meeting = async (title: string, n: number): Promise<string> => {
      const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title, reason: "frost tonight", roster: ["agent:ann", "agent:bob", "agent:cat"], durationMinutes: 180 }, `mu${n}`);
      const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:cat" }, `mo${n}`)).result.id as string;
      for (const [name, token] of tokens) assert.ok((await call(token, "meeting.record.join", { recordId: rec }, `j${n}${name}`)).ok, name);
      return rec;
    };
    const motionState = async (id: string): Promise<string> => (await call(boot.token, "meeting.record.motion", { motionId: id })).result.item.state as string;

    // 1. The floor is started and nobody calls advance: the controller's own loop does it.
    const first = await meeting("Beds", 1);
    const started = await call(boot.token, "meeting.floor.start", { recordId: first, motion: { text: "Cover the beds tonight." } }, "fs1");
    assert.ok(started.ok, JSON.stringify(started));
    const motion = started.result.motionId as string;
    assert.equal(asked.length, 0, "starting asks nobody");
    let named = false;
    for (let i = 0; i < 60 && (await motionState(motion)) !== "adopted"; i += 1) {
      clock += 1000;
      const t = await c.dispatch!.dispatcher.tick();
      named = named || t.loops.some((l) => l.name === "meetings.drive" && l.ok);
    }
    assert.ok(named, "the controller's loop has a meeting turn");
    assert.equal(await motionState(motion), "adopted", "the loop ran the motion to its decision");
    assert.ok(asked.some((r) => r.kind === "blind-statement") && asked.some((r) => r.kind === "ballot"), "the floor's turns were the procedure's members");
    assert.equal((await call(boot.token, "meeting.proc.status", { motionId: motion })).result.item.stage, "concluded", "the procedure, not the floor, kept the motion's stages");

    // 2. An inquiry is told to the owner, is on the Needs-you list, and a reminder follows the idle time.
    const second = await meeting("Frost", 2);
    assert.ok((await call(boot.token, "meeting.floor.start", { recordId: second }, "fs2")).ok);
    assert.ok((await call(boot.token, "meeting.floor.inquiry-open", { recordId: second }, "iq2")).ok);
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() });
    const inbox = async (): Promise<string[]> => (await notifications.inbox(rob)).items.filter((i) => i.state !== "answered" && i.state !== "settled").map((i) => i.label);
    assert.ok((await inbox()).some((l) => l.includes("meeting-inquiry-open") && l.includes(second)), JSON.stringify(await inbox()));
    const needs = async () => ((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.items as { kind: string; id: string; answer: { kind: string; choices?: string[] } }[]).filter((i) => i.kind === "meeting-inquiry");
    assert.deepEqual((await needs()).map((i) => [i.id, i.answer]), [[second, { kind: "choice", choices: ["done"] }]]);
    clock += 31 * 60_000;
    for (let i = 0; i < 3; i += 1) await c.dispatch!.dispatcher.tick();
    assert.ok((await inbox()).some((l) => l.includes("meeting-inquiry-idle") && l.includes(second)), "the idle inquiry was reminded by the loop");
    // one word on the list ends it; the notices are closed with it
    const ended = await call(boot.token, "needs-you.answer", { kind: "meeting-inquiry", id: second, answer: "done" }, "ny1");
    assert.ok(ended.ok, JSON.stringify(ended));
    assert.deepEqual(await needs(), []);
    assert.ok(!(await inbox()).some((l) => l.includes(second)), JSON.stringify(await inbox()));
    assert.equal((await call(tokens.get("ann")!, "needs-you.answer", { kind: "meeting-inquiry", id: second, answer: "done" }, "ny2")).ok, false, "only the owner answers there");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
