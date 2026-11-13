import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/types.js";
import { CheckRunSettingsService, CoverageGapService } from "../projects/index.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card P04f: the owner turns check tasks on or off, and bounds them, in plain words; and can have the gaps in coverage read to them through the API.
for (const backend of backends) {
  test(`${backend.name}: the owner switches check tasks off and sets how many may be open by chat, with no fixed phrase; an agent cannot (card P04f)`, async () => {
    assert.equal(CHAT_OPS["check.settings.set"]?.mode, "apply");
    assert.ok(acceptedArgs("check.settings.set")!.includes("enabled") && acceptedArgs("check.settings.set")!.includes("maxOpen"), "the interpreter is told what the command takes");
    assert.match(CHAT_OPS["check.settings.set"]!.verb, /check/i);
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, (storage: ControllerStorage, epoch: number) => ({ checkSettings: CheckRunSettingsService.withEpoch(storage, epoch), coverageGaps: CoverageGapService.withEpoch(storage, epoch) }));
    try {
      const chat = w.chat();
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
      const text = "stop giving the responsibility checks to the agents for now, I will look at them myself";
      script[text] = [cmd("check.settings.set", { enabled: false }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "applied", JSON.stringify(r.outcomes[0]));
      assert.equal((await call(w.ownerToken, "check.settings.get", {})).result.item.effective.enabled, false);
      const text2 = "turn them back on but never more than two of those check tasks open at a time in a project";
      script[text2] = [cmd("check.settings.set", { enabled: true, maxOpen: 2 }, text2)];
      assert.equal((await chat.submit(w.ownerToken, { messageId: cid("m"), text: text2 })).outcomes[0]!.status, "applied");
      assert.deepEqual((await call(w.ownerToken, "check.settings.get", {})).result.item.effective, { enabled: true, maxOpen: 2 });
      const text3 = "allow up to a hundred";
      script[text3] = [cmd("check.settings.set", { maxOpen: 100 }, text3)];
      const bad = await chat.submit(w.ownerToken, { messageId: cid("m"), text: text3 });
      assert.notEqual(bad.outcomes[0]!.status, "applied", "a number outside the limits is not applied");
      assert.equal((await call(w.ownerToken, "check.settings.get", {})).result.item.effective.maxOpen, 2);
      const ann = await w.agent("ann", [{ action: "responsibility.read", project: "*" }]);
      assert.equal((await call(ann.token, "check.settings.set", { enabled: false }, cid("x"))).error?.code, "forbidden");
      const p = await w.project("Ops");
      assert.equal((await call(ann.token, "responsibility.gaps", { projectId: p })).ok, true, "an agent who may read the project's responsibilities sees its gaps");
      assert.equal((await call(ann.token, "responsibility.gaps", { projectId: p, extra: 1 })).error?.code, "invalid_command");
    } finally { await w.close(); }
  });
}
