// Card P09 (owner view of the checks), chat level: the owner asks in free words why a task's work did or did not land, and is shown what each required check said. The real chat, the REAL ModelInterpreter (its stand-in
// model only names the status kind and the task by its title or the project in focus, in the owner's words; it hands over no ID), and the real status service on every backend. The landing records are a stand-in
// for the workspace service's read (that read, its index and the view's lines are tested with the real service in workspace-ops-p09-view.test.ts).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { StatusService } from "../status/index.js";
import type { WorkspaceAnswer } from "../workspace-ops/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const T = (c: string): string => c.repeat(40);

test("the interpreter is told, in one sentence and the status list, how to read what the landing checks said (card P09)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /\\?"Why did that not land\?\\?" or \\?"what did the checks say\?\\?" reads landing_checks \(the task by title, else the project\)/);
  assert.match(system, /landing_checks\(taskId\|taskTitle, projectId, after\) - owner only: /);
});

for (const backend of backends) {
  test(`${backend.name}: asked in free words, the owner is shown the checks of a task's landing by its title, of the project in focus, and the older page by count; an agent is refused (card P09)`, async () => {
    const asked: unknown[] = [];
    const attempt = (taskId: string, projectId: string, id: string): WorkspaceAnswer => ({
      id, replayed: false, operation: "landing", taskId, projectId, requestedBy: "owner:rob", reason: "ready", state: "refused", at: "2026-11-23T10:00:00.000Z", finishedAt: "2026-11-23T10:00:05.000Z",
      summary: "a required check that had passed changed before the landing was made (review failed: the newest review asks for changes), so nothing was landed",
      queued: { submissionId: "sbm-aaaaaaaaaaaaaaaaaaaa", base: T("b"), tree: T("e"), branch: "main" },
      checks: { required: ["review", "defects"], passed: false, base: T("b"), tree: T("e"), patchId: T("a"), at: "2026-11-23T10:00:03.000Z", results: [
        { check: "review", result: "fail", boundTo: T("e"), summary: "the newest review asks for changes" },
        { check: "defects", result: "pass", boundTo: T("e"), summary: "no defect of this task is open" },
      ] },
      rechecked: { outcome: "changed", checks: ["review"] },
    });
    let ids: { task: string; project: string } | undefined;
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, {}, undefined, (storage, epoch, built) => {
      statusSvc = StatusService.withEpoch(storage, epoch, {
        assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts,
        landingChecks: { landings: async (scope, after, limit) => { asked.push({ scope, after, limit }); return { items: ids === undefined ? [] : [attempt(ids.task, ids.project, "wsr-aaaaaaaaaaaaaaaaaaaa")], total: 7 }; } },
      }, options);
      return { status: statusSvc } as never;
    });
    try {
      const project = await w.project("Orchard");
      const task = await w.task(project, "importer");
      ids = { task, project };
      const zed = await w.agent("zed", [{ action: "*", project: "*" }]);
      const model = (intents: unknown[]) => new ModelInterpreter({ complete: async () => JSON.stringify(intents) }, () => ["a/primary"]);
      const textOf = (r: { outcomes: readonly unknown[] }): string => (r.outcomes as { lines?: { text: string }[] }[]).flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");

      // By the task's title, the project named in the owner's words: the chat finds the task, no ID passes through the model.
      const q1 = "why did the importer work not land in Orchard?";
      const one = await w.chat({ interpreter: model([{ kind: "switch_focus", projectName: "Orchard", evidence: "in Orchard", basis: "owner" }, { kind: "status", request: { kind: "landing_checks", taskTitle: "importer" }, evidence: q1, basis: "owner" }]), status: statusSvc! }).submit(w.ownerToken, { messageId: cid("m"), text: q1 });
      assert.equal(one.outcomes[1]!.status, "answered", JSON.stringify(one.outcomes));
      const said1 = textOf(one);
      assert.match(said1, /task importer: 7 landing attempt\(s\) on record, newest first; showing 1 to 1/);
      assert.match(said1, /review failed: the newest review asks for changes/);
      assert.match(said1, /found check\(s\) \(review\) no longer passing, so the landing was refused/);
      assert.deepEqual(asked[0], { scope: { taskId: task }, after: 0, limit: 5 });

      // With no task named, the project in focus is read.
      const q2 = "what did the checks say about the latest landing in Orchard?";
      const two = await w.chat({ interpreter: model([{ kind: "status", request: { kind: "landing_checks" }, evidence: q2, basis: "owner" }]), status: statusSvc! }).submit(w.ownerToken, { messageId: cid("m"), text: q2 });
      assert.equal(two.outcomes[0]!.status, "answered", JSON.stringify(two.outcomes));
      assert.match(textOf(two), /project Orchard: 7 landing attempt\(s\)/);
      assert.deepEqual(asked[1], { scope: { projectId: project }, after: 0, limit: 5 });

      // The older page is asked by count.
      const q3 = "show me the older ones for the importer";
      const three = await w.chat({ interpreter: model([{ kind: "status", request: { kind: "landing_checks", taskTitle: "importer", after: 5 }, evidence: q3, basis: "owner" }]), status: statusSvc! }).submit(w.ownerToken, { messageId: cid("m"), text: q3 });
      assert.equal(three.outcomes[0]!.status, "answered", JSON.stringify(three.outcomes));
      assert.deepEqual(asked[2], { scope: { taskId: task }, after: 5, limit: 5 });

      // A project named beside the task's title gives way to the task: the view takes one or the other, and the owner asked about the task.
      const q5 = "why did the importer not land in Orchard?";
      const five = await w.chat({ interpreter: model([{ kind: "status", request: { kind: "landing_checks", taskTitle: "importer", projectId: project }, evidence: q5, basis: "owner" }]), status: statusSvc! }).submit(w.ownerToken, { messageId: cid("m"), text: q5 });
      assert.equal(five.outcomes[0]!.status, "answered", JSON.stringify(five.outcomes));
      assert.deepEqual(asked[3], { scope: { taskId: task }, after: 0, limit: 5 });

      // A title no task has is refused, and nothing is read.
      const before = asked.length;
      const q4 = "why did the exporter not land?";
      const four = await w.chat({ interpreter: model([{ kind: "status", request: { kind: "landing_checks", taskTitle: "exporter" }, evidence: q4, basis: "owner" }]), status: statusSvc! }).submit(w.ownerToken, { messageId: cid("m"), text: q4 });
      assert.equal(four.outcomes[0]!.status, "refused", JSON.stringify(four.outcomes));
      assert.equal(asked.length, before);

      // An agent's own chat is not the owner's: it is refused before any view is read.
      await assert.rejects(w.chat({ interpreter: model([{ kind: "status", request: { kind: "landing_checks", taskId: task }, evidence: q1, basis: "owner" }]), status: statusSvc! }).submit(zed.token, { messageId: cid("n"), text: q1 }), (e: unknown) => (e as { code?: string }).code === "forbidden");
      assert.equal(asked.length, before);
    } finally { await w.close(); }
  });
}
