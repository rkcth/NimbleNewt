import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatTurnFollowUps } from "../chat/index.js";
import { CommandRunner } from "../domain/runner.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { outcomeLine } from "../standups/index.js";
import { MeetingService } from "../meetings/index.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a stand-up outcome reaches the owner's chat turn exactly once through the running controller, across a repeat, a crash before the mark and a restart (card M03f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-out-"));
  const options = (): StartOptions => ({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } } as StartOptions);
  const turnOf = async (c: Awaited<ReturnType<typeof startController>>) => ((await c.storage.getAggregate({ kind: "chat-turn", id: "turn-1" }))!.body as unknown as { followUps?: { key: string; text: string }[] }).followUps ?? [];
  let c = await startController(options());
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (c2: typeof c, op: string, args: Record<string, unknown>, commandId?: string) => (await c2.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(c, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const ref = { kind: "chat-turn", id: "turn-1" };
    await new CommandRunner(c.storage, c.epoch, {}).command("test.turn", { commandId: "mk", actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { ownerId: "owner:rob", messageId: "m1", text: "Should we drop the old API?", quotedCount: 0, status: "done", plan: [], createdAt: "2026-10-30T00:00:00.000Z", projectId: project } }], detail: {} }) }) as never);
    // The topic names the owner's turn as its source, so the owner is the one asking and the turn is where the answer goes.
    const made = await call(c, "agenda.capture", { projectId: project, topic: "Drop the old API?", question: "Should we drop the old API?", urgency: "normal", intent: "discussion", sourceTurnId: "turn-1" }, "ag1");
    assert.ok(made.ok, JSON.stringify(made));
    const itemId = made.result.id as string;
    const meetings = MeetingService.withEpoch(c.storage, c.epoch, { inquiries: c.services.inquiries }, { availability: async () => "available" });
    await meetings.setAgendaState(rob, { commandId: "st1", itemId, expectedRevision: made.result.revision, to: "resolved", outcomeNote: "Yes, drop it after the next release." });

    // A crash after the turn was written but before the item was marked: the follow-up is already there under the key the delivery will use, and the delivery marks the item without writing a second one.
    const queued = (await meetings.agendaItem(rob, itemId))!;
    assert.equal(await chatTurnFollowUps(c.storage, c.epoch).add("turn-1", { key: `ago:${itemId}:${queued.revision}`, text: outcomeLine(queued) }), true);
    const first = await call(c, "standup.deliver", { projectId: project }, "d1");
    assert.deepEqual(first.result.delivered, [itemId], JSON.stringify(first));
    const told = await turnOf(c);
    assert.equal(told.length, 1);
    assert.match(told[0]!.text, /Yes, drop it after the next release\./);
    assert.deepEqual((await call(c, "standup.deliver", { projectId: project }, "d2")).result.delivered, [], "a second delivery tells nothing again");
    assert.equal((await turnOf(c)).length, 1);
    // The same command again is a replay: still one follow-up.
    assert.ok((await call(c, "standup.deliver", { projectId: project }, "d1")).ok);
    assert.equal((await turnOf(c)).length, 1);
    await c.close();

    // A restart keeps the follow-up and the mark: nothing is told again.
    c = await startController(options());
    assert.equal((await turnOf(c)).length, 1);
    assert.deepEqual((await call(c, "standup.deliver", { projectId: project }, "d3")).result.delivered, []);
    assert.equal((await turnOf(c)).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
