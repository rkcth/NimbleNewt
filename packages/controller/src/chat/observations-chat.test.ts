import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { BlockerService } from "../domain/blockers.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ObservationService } from "../observations/index.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { CHAT_OPS } from "./commands.js";
import { ModelInterpreter, promptAbout } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Card B02: the owner asks in any words what keeps going wrong in a project and settles an observation by chat; nothing needs a fixed phrase.

after(stopServer);

const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

test("the interpreter prompt describes the observations view and settling one, from the one status-kind and operation tables (card B02)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "what keeps going wrong", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["observations"]!;
  assert.ok(system.includes(`observations(${kind.keys.join(", ")}) - ${promptAbout(kind.about)}`), "the view is listed from the one table");
  assert.ok(system.includes("observation.dispose(observationId, expectedRevision, to, reason, improvementId, owner"), "the operation is listed with the arguments the chat takes");
  assert.match(system, /what keeps going wrong in Garden\?/);
  assert.match(system, /observation\.dispose with the observationId shown there \(its revision is filled in\)/);
  assert.equal(CHAT_OPS["observation.dispose"]?.revision, "observation");
  for (const op of ["observation.submit", "observation.get", "observation.list", "observation.dispose"]) assert.ok(OPERATIONS.some((o) => o.name === op), op);
  assert.ok(!Object.keys(CHAT_OPS).includes("observation.submit"), "the owner does not report friction as an agent");
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, obs: ObservationService, status: StatusService) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      let obs: ObservationService | undefined;
      const w = await openWorld(backend, script, undefined, (storage, epoch) => { obs = ObservationService.withEpoch(storage, epoch, options); return { observations: obs }; });
      try {
        const epoch = w.projects.epoch;
        const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, epoch, options), contracts: w.contracts, observations: obs! }, options);
        await body(w, script, obs!, status);
      } finally { await w.close(); }
    });

  suite("the owner asks in free words what went wrong, is shown each observation once with its reports, settles one by chat with the revision filled in, and a stranger sees nothing", async (w, script, obs, status) => {
    const a = await w.project("Garden");
    const task = await w.task(a, "Build login");
    const runner = new CommandRunner(w.world.storage, w.projects.epoch, options);
    const sbm = derivedId("sbm", cid("s"));
    await runner.command("test.put", { commandId: cid("put"), actor: w.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "submission", id: sbm }, creates: true, changes: [{ type: "create" as const, ref: { kind: "submission", id: sbm }, body: { projectId: a, taskId: task, kind: "review", submittedBy: "agent:rev" } as never }], detail: {} }) }));
    const made = await obs.record(w.owner, { commandId: "obs-review:x", kind: "failed-review", summary: "agent:rev asked for changes to the work submitted on the login task.", sources: [{ kind: "submission", id: sbm }] });
    const dev = await w.agent("dev", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]);
    await obs.submit(dev.principal, { commandId: cid("f"), projectId: a, summary: "my login change came back again", sources: [{ kind: "submission", id: sbm }] });
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });

    for (const text of ["what keeps going wrong in Garden?", "any failed reviews lately"]) {
      script[text] = [ask({ kind: "observations", ...(text.includes("reviews") ? { observationKind: "failed-review" } : {}) }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      const o = r.outcomes[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      const said = o.lines!.map((l) => l.text).join("\n");
      assert.match(said, /1 open observation\(s\)/);
      assert.match(said, /failed-review \(seen by the controller, 2 reports from 2 reporter\(s\)/);
      assert.match(said, /asked for changes to the work submitted on the login task/);
      assert.match(said, /This hour \(from 10:00 UTC\): 1 new observation\(s\); none was held back\./);
      assert.ok(o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
    }

    const id = (made as { id: string }).id;
    const text = `drop ${id}, the review was a one-off`;
    script[text] = [cmd("observation.dispose", { observationId: id, to: "dismissed", reason: "the review was a one-off" }, text)];
    const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const o = r.outcomes[0]!;
    assert.deepEqual([o.status, o.op], ["applied", "observation.dispose"], JSON.stringify(o));
    const after1 = await obs.get(w.owner, id);
    assert.deepEqual([after1?.disposition, after1?.reason, after1?.revision], ["dismissed", "the review was a one-off", 3]);
    const empty = await chat.submit(w.ownerToken, { messageId: cid("m"), text: "what keeps going wrong in Garden?" });
    assert.match(empty.outcomes[0]!.lines!.map((l) => l.text).join("\n"), /No observation is open in this project\./);

    // Another agent's view: an agent with no meeting right in the project sees no list and no record.
    const far = await w.agent("far", [{ action: "task.read", project: a }]);
    const listed = await w.api.handle(far.token, { v: 1, op: "observation.list", args: { projectId: a } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([listed.ok, listed.error?.code], [false, "not_found"]);
    const got = await w.api.handle(far.token, { v: 1, op: "observation.get", args: { observationId: id } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([got.ok, got.error?.code], [false, "not_found"]);
  });
}
