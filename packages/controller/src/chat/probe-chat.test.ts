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
    assert.ok(CHAT_OPS["responsibility.probe.set"]!.verb.length <= 80, "the verb is shown whole in the proposal line");
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

      // What the owner is shown before confirming names the address as it will be asked, query included.
      const withQuery = "for keep web up, have nimblenewt itself ask <https://web.example.test/health?deep=1>.";
      script[withQuery] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: "https://web.example.test/health?deep=1" }, withQuery)];
      const shown = await chat.submit(w.ownerToken, { messageId: cid("m"), text: withQuery });
      assert.equal(shown.outcomes[0]!.status, "proposed", JSON.stringify(shown.outcomes[0]));
      assert.ok(JSON.stringify(shown.outcomes[0]).includes("https://web.example.test/health?deep=1"), JSON.stringify(shown.outcomes[0]));
      // Second review: the line says what setting it means (NimbleNewt itself asks, from its own machine, any address), and a long address is shown whole, never cut.
      assert.match(JSON.stringify(shown.outcomes[0]), /NimbleNewt itself, from the machine it runs on, will request this exact address/);
      const longUrl = `https://web.example.test/${"segment/".repeat(40)}health?deep=1`;
      const long = `for keep web up, have nimblenewt itself ask ${longUrl}`;
      script[long] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: longUrl }, long)];
      const longOut = await chat.submit(w.ownerToken, { messageId: cid("m"), text: long });
      assert.equal(longOut.outcomes[0]!.status, "proposed", JSON.stringify(longOut.outcomes[0]));
      assert.ok(JSON.stringify(longOut.outcomes[0]).includes(longUrl), JSON.stringify(longOut.outcomes[0]));
      // An address the probe would refuse is refused before it is shown (here a text-direction mark that would make it read otherwise).
      const marked = "https://web.example.test/\u202ehtlaeh";
      const markedText = `for keep web up, have nimblenewt itself ask ${marked}`;
      script[markedText] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url: marked }, markedText)];
      const markedOut = await chat.submit(w.ownerToken, { messageId: cid("m"), text: markedText });
      assert.equal(markedOut.outcomes[0]!.status, "refused", JSON.stringify(markedOut.outcomes[0]));
      // Only the whole address, as written: a host cut short, a path cut off or other letter case is not the owner's address (first review).
      for (const [said, url] of [
        ["for keep web up let nimblenewt ask https://web.example.test.other.example/health itself", "https://web.example.test"],
        ["for keep web up let nimblenewt ask https://web.example.test/health/deep itself", "https://web.example.test/health"],
        ["for keep web up let nimblenewt ask https://web.example.test/Health itself", "https://web.example.test/health"],
        ["for keep web up let nimblenewt ask http://web.example.test:80801/health itself", "http://web.example.test:8080"],
      ] as const) {
        script[said] = [cmd("responsibility.probe.set", { responsibilityTitle: "keep web up", url }, said)];
        const out = await chat.submit(w.ownerToken, { messageId: cid("m"), text: said });
        assert.equal(out.outcomes[0]!.status, "refused", `${url}: ${JSON.stringify(out.outcomes[0])}`);
      }

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
