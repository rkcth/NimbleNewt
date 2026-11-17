import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { ResponsibilityProbeService } from "../projects/index.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card P04i: the owner sets and clears a responsibility's HTTP probe in plain words; it is always shown first, the address must be the owner's own, and an agent cannot.
for (const backend of backends) {
  test(`${backend.name}: the owner sets a health address for a responsibility by chat (shown first, named by title), clears it, and an address the owner never wrote is refused; an agent cannot (card P04i)`, async () => {
    assert.equal(CHAT_OPS["responsibility.probe.set"]?.mode, "propose");
    for (const k of ["url", "expectStatus", "timeoutSeconds", "responsibilityTitle"]) assert.ok(acceptedArgs("responsibility.probe.set")!.includes(k), `the interpreter is told about ${k}`);
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, (storage: ControllerStorage, epoch: number) => ({ checkProbes: ResponsibilityProbeService.withEpoch(storage, epoch) }));
    try {
      const chat = w.chat();
      const p = await w.project("Ops");
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: p });
      const ann = await w.agent("ann", [{ action: "responsibility.read", project: "*" }, { action: "responsibility.write", project: "*" }]);
      const duty = (await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep web up", objective: "Up", everyMinutes: 60, ownerId: ann.principal.id } as never)).id;
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

      const text = "for keep web up just have nimblenewt hit https://web.example.test/health itself, 204 means fine";
      script[text] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: "https://web.example.test/health", expectStatus: [204] }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes[0]));
      assert.equal((await call(w.ownerToken, "responsibility.probe.get", { responsibilityId: duty })).result.item.probe, undefined, "nothing until the owner confirms");
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).applied, true);
      const got = (await call(w.ownerToken, "responsibility.probe.get", { responsibilityId: duty })).result.item.probe;
      assert.deepEqual([got.url, got.expectStatus], ["https://web.example.test/health", [204]]);

      // An address the owner did not write is not taken from the interpreter.
      const vague = "have nimblenewt check keep web up by itself";
      script[vague] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: "https://elsewhere.example.test/x" }, vague)];
      const bad = await chat.submit(w.ownerToken, { messageId: cid("m"), text: vague });
      assert.notEqual(bad.outcomes[0]!.status, "proposed", JSON.stringify(bad.outcomes[0]));
      assert.notEqual(bad.outcomes[0]!.status, "applied");

      const off = "stop probing keep web up, let ann look at it again";
      script[off] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: null }, off)];
      const cr = await chat.submit(w.ownerToken, { messageId: cid("m"), text: off });
      assert.equal(cr.outcomes[0]!.status, "proposed", JSON.stringify(cr.outcomes[0]));
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: cr.outcomes[0]!.proposalId! })).applied, true);
      assert.equal((await call(w.ownerToken, "responsibility.probe.get", { responsibilityId: duty })).result.item.probe, undefined);

      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
      assert.equal((await call(ann.token, "responsibility.probe.set", { responsibilityId: duty, url: "https://web.example.test/health" }, cid("x"))).error?.code, "forbidden");
    } finally { await w.close(); }
  });
}
