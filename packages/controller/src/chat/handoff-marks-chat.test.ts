import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HandoffService, PauseService, StopService, type StopPorts } from "../lifecycle/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card C07j: what a task's hand-offs keep when a section is cut is the owner's to set, in their own words, by chat; no fixed phrase.
test("the interpreter is told how a hand-off section is cut and how the owner marks what it keeps", async () => {
  assert.equal(CHAT_OPS["handoff.marks.change"]?.mode, "apply", "marks only choose what stays in view; the rest stays in the archive, so the change applies at once");
  for (const k of ["taskId", "taskTitle", "add", "remove"]) assert.ok(acceptedArgs("handoff.marks.change")!.includes(k), k);
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] } as never);
  assert.match(system, /handoff\.marks\.change\([^)]*add[^)]*remove[^)]*\) - Keep entries in the hand-off packages of task/);
  assert.match(system, /begins with \[cut: N of M entries, archive <id>\]/);
  assert.match(system, /each mark copied exactly from the owner's words/);
});

const stub = { unsupported: () => undefined, release: async () => undefined, inventory: async () => [], cleanup: async () => ({ remaining: [] }), checkpoint: async () => ({ checkpointId: "cp", durable: true, artifactsDurable: true }), terminate: async () => ({ ended: true, unresolved: [] }) } as unknown as StopPorts;

for (const backend of backends) {
  test(`${backend.name}: the owner marks by chat what a task's hand-offs keep and takes a mark off again; a mark the owner never said and an agent are refused (card C07j)`, async () => {
    let real: HandoffService | undefined;
    // The real service needs the world's store, which exists only once the world is open: every method is passed on to it then.
    const lazy = new Proxy({}, { get: (_t, k) => (...x: unknown[]) => (real as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[k]!.apply(real, x) });
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { handoffs: lazy as never });
    try {
      const pauses = PauseService.withEpoch(w.world.storage, w.projects.epoch, {}, options);
      const stops = StopService.withEpoch(w.world.storage, w.projects.epoch, pauses, stub, options);
      real = HandoffService.withEpoch(w.world.storage, w.projects.epoch, { pauses, stops, assignments: w.assignments, sources: { collect: async () => ({ sections: {} }) } }, options);
      const chat = w.chat();
      const p = await w.project("Garden");
      const t = await w.task(p, "importer");

      const text = "In Garden, the importer hand-offs should always keep anything about SEEDED-EARLY in view";
      script[text] = [cmd("handoff.marks.change", { projectName: "Garden", taskTitle: "importer", add: ["SEEDED-EARLY"] }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "applied", JSON.stringify(r.outcomes[0]));
      assert.deepEqual((await real.marks(w.owner, { taskId: t })).marks, ["SEEDED-EARLY"]);

      // A mark the owner never said is not recorded on their behalf.
      const other = "in Garden keep the importer decisions in its hand-offs";
      script[other] = [cmd("handoff.marks.change", { projectName: "Garden", taskTitle: "importer", add: ["dsk-aaaaaaaaaaaaaaaaaaaa"] }, other)];
      const refused = await chat.submit(w.ownerToken, { messageId: cid("m"), text: other });
      assert.equal(refused.outcomes[0]!.status, "refused", JSON.stringify(refused.outcomes[0]));
      assert.match(String(refused.outcomes[0]!.message), /add/, "refused because the mark is not in the owner's words");
      assert.deepEqual((await real.marks(w.owner, { taskId: t })).marks, ["SEEDED-EARLY"]);

      const off = "in Garden you can stop keeping SEEDED-EARLY for the importer";
      script[off] = [cmd("handoff.marks.change", { projectName: "Garden", taskTitle: "importer", remove: ["SEEDED-EARLY"] }, off)];
      const removed = await chat.submit(w.ownerToken, { messageId: cid("m"), text: off });
      assert.equal(removed.outcomes[0]!.status, "applied", JSON.stringify(removed.outcomes[0]));
      assert.deepEqual((await real.marks(w.owner, { taskId: t })).marks, []);

      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });
}
