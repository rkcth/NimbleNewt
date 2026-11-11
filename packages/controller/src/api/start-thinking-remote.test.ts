import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { THINKING_REPORT } from "@nimblenewt/contracts";
import { FULL_ABILITIES, wireRefuses } from "../remote/testing/suite.js";
import { world } from "./testing/remote-world.js";

// Card U09c through the composed controller: the thinking a remote host's process reports goes over the worker protocol to the same store as a local process's, with the same cleaning, redaction and bounds, only for the host's own current
// attempt, and the owner reads it through the replay as they read a local host's.
const AWS = "AKIAABCDEFGHIJKLMNOP";
const rep = (entryId: number, text: string, extra: object = {}) => ({ entryId, block: 0, provider: "llama", model: "local-m", text, opaque: false, ...extra });
const dir = (): string => mkdtempSync(join(tmpdir(), "nn-u09c-"));

async function rig(d: string) {
  const w = await world(d, {} as never, { grants: [{ action: "desk.write", project: "*" }, { action: "desk.read", project: "*" }], monitorProgressMs: 0, start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => false } } });
  const r1 = await w.host("r1");
  const r2 = await w.host("r2");
  const t = await w.task("Order seeds");
  assert.deepEqual((await w.tick()).started, [t.attemptId]);
  const offer = (await r1.client.offers())[0]!;
  const attempt = r1.client.attempt(t.attemptId, offer.placement);
  await attempt.accept();
  assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
  const token = (await w.c.services.principals.issueCredential(w.rob, w.rob.id)).token;
  const api = async (op: string, args: Record<string, unknown>, id = `c-${op}-${Math.random().toString(36).slice(2, 10)}`) => (await w.c.api.handle(token, { v: 1, op, commandId: id, args } as never)) as any;
  const look = (extra: Record<string, unknown> = {}) => api("activity.replay.thinking", { taskId: t.taskId, reason: "what was it weighing", ...extra });
  return { w, t, r1, r2, offer, attempt, api, look, close: async () => { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("a remote host's thinking is cleaned, redacted and kept once for the task's current attempt, and the owner reads it as they read a local host's (card U09c)", async () => {
  const x = await rig(dir());
  try {
    assert.equal((await x.look()).error?.code, "not_found", "nothing yet");
    const first = [rep(1, `first look: the beds need ${AWS} to water‮\u0001`), rep(2, "second look: start with the east bed")];
    assert.deepEqual(await x.attempt.thinking(first), { kept: 2 });
    // The same message again (a retry with the same key, or sent anew) keeps nothing more.
    assert.deepEqual(await x.attempt.thinking(first), { kept: 0, reason: "nothing-new" });
    assert.deepEqual(await x.r1.client.send("POST", `/worker/attempts/${x.t.attemptId}/thinking`, { body: { placement: x.offer.placement, blocks: first } as never, session: true, key: "another-key" }).then((r) => r.body), { kept: 0, reason: "nothing-new" });
    const seen = await x.look();
    assert.ok(seen.ok, JSON.stringify(seen));
    assert.deepEqual(seen.result.blocks.map((b: { text: string }) => b.text), ["first look: the beds need [redacted] to water", "second look: start with the east bed"]);
    assert.ok(!JSON.stringify(seen).includes(AWS));
    assert.match(seen.result.label, /Model output/);
    // An oversize block is cut by the store's own bound, not the route's.
    assert.deepEqual(await x.attempt.thinking([rep(3, "y".repeat(THINKING_REPORT.chars))]), { kept: 1 });
    const more = await x.look();
    assert.ok(more.ok, JSON.stringify(more));
    const cut = more.result.blocks.at(-1);
    assert.equal(cut.text.length, 4000);
    // An opaque block carries no text.
    assert.deepEqual(await x.attempt.thinking([rep(4, "hidden words", { opaque: true })]), { kept: 1 });
    assert.ok(!JSON.stringify(await x.look()).includes("hidden words"));
  } finally { await x.close(); }
});

test("another host reaches nothing; the owner's switch is obeyed; a placement whose attempt is no longer the task's current one keeps nothing (card U09c)", async () => {
  const x = await rig(dir());
  try {
    await wireRefuses("not_found", () => x.r2.client.attempt(x.t.attemptId, x.offer.placement).thinking([rep(1, "from the wrong host")]), 404);
    await wireRefuses("fenced", () => x.r1.client.attempt(x.t.attemptId, x.offer.placement + 1).thinking([rep(1, "from an old placement")]), 409);
    assert.equal((await x.look()).error?.code, "not_found", "nothing was kept");
    // The owner turns collection off: nothing new is kept; on again, it is.
    const off = await x.api("thinking.collection.set", { enabled: false });
    assert.ok(off.ok, JSON.stringify(off));
    assert.deepEqual(await x.attempt.thinking([rep(1, "while off")]), { kept: 0, reason: "off" });
    assert.ok((await x.api("thinking.collection.set", { enabled: true, expectedRevision: off.result.revision })).ok);
    assert.deepEqual(await x.attempt.thinking([rep(1, "while on")]), { kept: 1 });
    // The owner releases the task: the attempt is no longer the task's current one though the placement has not been settled yet.
    const assignment = (await x.w.c.services.assignments.getAssignment(x.t.taskId))!;
    await x.w.c.services.assignments.releaseTask({ commandId: "rel-1", actor: x.w.rob.id, taskId: x.t.taskId, expectedRevision: assignment.revision });
    assert.deepEqual(await x.attempt.thinking([rep(2, "after the release")]), { kept: 0, reason: "stale" });
    const seen = await x.look();
    assert.deepEqual(seen.result.blocks.map((b: { text: string }) => b.text), ["while on"]);
  } finally { await x.close(); }
});
