import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BACKEND_KINDS } from "../inference-cache/profile.js";
import { SetupProviderService } from "../setup/providers.js";
import { CHAT_OPS, SETUP_EXEMPT, acceptedArgs } from "./commands.js";
import { ModelInterpreter } from "./model-interpreter.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

// Card W07 follow-up (wiring audit): the endpoint's kind is the owner's setting on a provider, reachable in free words; an unknown kind is refused; it is stored on the provider's record, which the controller's relay reads at each call.
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const mine = (extra: Record<string, unknown> = {}) => ({ name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local"], contextTokens: 65536, ...extra });
const spare = { name: "spare", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", credentialName: "spare-key", models: ["free-model"], contextTokens: 32000 };

test("the interpreter prompt and the operation tables tell the model about a provider's kind, from the one table, and the kind is a fixed choice that need not be spelled in the owner's words (card W07 wiring)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "my local server is a vLLM one", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /kind only when the owner says what the model server is/);
  assert.match(system, /never guess it from a name or an address/);
  assert.match(system, /an unknown kind is refused/);
  for (const k of BACKEND_KINDS) assert.ok(system.includes(k), `${k} is named to the model`);
  assert.match(OPERATIONS.find((o) => o.name === "routing.provider.add")!.summary, /`kind`: llama-cpp, vllm, radiance/);
  assert.match(CHAT_OPS["routing.provider.add"]!.verb, /kind = what the model server is/);
  assert.equal(CHAT_OPS["routing.provider.add"]?.mode, "propose", "still shown first in every profile");
  assert.ok(SETUP_EXEMPT["routing.provider.add"]!.has("kind"));
  assert.ok((acceptedArgs("routing.provider.add") ?? []).includes("providers"));
});

for (const backend of backends) {
  test(`${backend.name}: the owner names a provider's server kind in chat; it is shown first, stored on the provider's record, replaced with the provider, and an unknown or malformed kind is refused with nothing changed (card W07 wiring)`, async () => {
    const script: Record<string, unknown> = {};
    let setup: SetupProviderService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { setup = SetupProviderService.withEpoch(storage, epoch, { clock: () => "2026-11-11T10:00:00.000Z", pause: async () => undefined }, {}); return { setupProviders: setup }; });
    try {
      const chat = w.chat();
      w.profile.value = "autonomous";
      const say = async (text: string, plan: unknown[]): Promise<Outcome> => { script[text] = plan; const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      let text = "Register my local vLLM server called mine at http://127.0.0.1:8002/v1 with the model big-local (65536 tokens), and a free cloud one called spare at https://free.example.invalid/v1 with the model free-model (32000 tokens), whose key is the secret spare-key.";
      const proposed = await say(text, [cmd("routing.provider.add", { providers: [mine({ kind: "vllm" }), spare] }, text)]);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(JSON.stringify(proposed), /Add or replace model providers/, "the change is shown first (its preview is cut at a fixed length, as for every provider change)");
      assert.deepEqual(await setup!.endpoints(), [], "nothing is stored before the owner agrees");
      const done = await say("Yes, do that.", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "Yes, do that.", basis: "owner" }]);
      assert.equal(done.status, "applied", JSON.stringify(done));
      const kinds = (await setup!.endpoints()).map((e) => [e.provider, e.kind]);
      assert.deepEqual(kinds, [["mine", "vllm"], ["spare", undefined]], "only the provider the owner named has a kind");
      // Replacing the provider without a kind removes it (the record is replaced whole, as its address is).
      const again = await w.api.handle(w.ownerToken, { v: 1, op: "routing.provider.add", commandId: "swap", args: { providers: [mine()] } } as never) as unknown as { ok: boolean };
      assert.ok(again.ok);
      assert.equal((await setup!.endpoints()).find((e) => e.provider === "mine")?.kind, undefined);
      // Every known kind is taken; the unknown, wrongly cased, non-string and prototype-looking ones are refused with the list, and nothing changes.
      for (const k of BACKEND_KINDS) assert.ok(((await w.api.handle(w.ownerToken, { v: 1, op: "routing.provider.add", commandId: `k-${k}`, args: { providers: [mine({ kind: k })] } } as never)) as unknown as { ok: boolean }).ok, k);
      const before = JSON.stringify(await setup!.endpoints());
      for (const bad of ["vlmm", "VLLM", " vllm", "", "__proto__", "constructor", 7, null, ["vllm"], { kind: "vllm" }]) {
        const r = await w.api.handle(w.ownerToken, { v: 1, op: "routing.provider.add", commandId: `bad-${JSON.stringify(bad)}`, args: { providers: [mine({ kind: bad })] } } as never) as unknown as { ok: boolean; error?: { code: string; message: string } };
        assert.equal(r.ok, false, JSON.stringify(bad));
        assert.match(r.error!.message, /providers\[0\]\.kind: must be one of llama-cpp, vllm, radiance/, JSON.stringify(bad));
      }
      assert.equal(JSON.stringify(await setup!.endpoints()), before, "a refused kind changes nothing");
      // The owner's chat cannot be talked into a kind it does not know: the same refusal comes back when the owner agrees.
      text = "Make the local server called mine at http://127.0.0.1:8002/v1 with the model big-local (65536 tokens) a quantum server.";
      const odd = await say(text, [cmd("routing.provider.add", { providers: [mine({ kind: "quantum" })] }, text)]);
      if (odd.status === "proposed") {
        const r = await say("Yes, do it.", [{ kind: "apply_proposal", proposalId: odd.proposalId, evidence: "Yes, do it.", basis: "owner" }]);
        assert.notEqual(r.status, "applied");
        assert.match(JSON.stringify(r), /must be one of/);
      } else assert.notEqual(odd.status, "applied");
      assert.equal(JSON.stringify(await setup!.endpoints()), before);
    } finally { await w.close(); }
  });
}
