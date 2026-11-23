// Card H12o (seventh slice), chat level: the owner asks in free words whether approved code was committed and, when the release that the reviewer's approval asked for was refused, is told so and why.
// The real chat, the REAL ModelInterpreter (its stand-in model only answers with a status request naming the task; it never sees an earlier answer and hands over nothing the owner did not say), the real
// status service and the real submission service on every backend. The release records are a stand-in for the workspace service (a read keyed by the approval's review).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { StatusService } from "../status/index.js";
import { SubmissionService } from "../submissions/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const T = (c: string): string => c.repeat(40);

test("the interpreter is told that the submissions view gives the reason when the commit a reviewer's approval asks for by itself was refused or failed (card H12o, seventh slice)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "was the approved parser fix committed?", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /or not yet, with the reason when the commit that a reviewer's approval asks for by itself was refused or failed; to commit it, propose workspace\.request/);
});

for (const backend of backends) {
  test(`${backend.name}: asked in free words, the owner is told the automatic commit was refused and why; an agent that wrote nothing of it is told nothing; asking creates nothing (card H12o, seventh slice)`, async () => {
    const roles = new Map<string, string[]>();
    const autos = new Map<string, { state: string; at: string; finishedAt?: string; summary?: string }>();
    const reads: string[] = [];
    let svc: SubmissionService | undefined;
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, {}, undefined, (storage, epoch, built) => {
      svc = SubmissionService.withEpoch(storage, epoch, async (id) => roles.get(id) ?? [], options);
      const status = StatusService.withEpoch(storage, epoch, {
        assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts,
        submissions: { list: (by, t, q) => svc!.list(by, t, q), approvalOf: (id) => svc!.approvalOf(id) },
        submissionRelease: { commit: async () => undefined, open: async () => undefined, automatic: async (id, review) => { reads.push(`${id}:${review}`); return autos.get(`${id}:${review}`); } },
      }, options);
      statusSvc = status;
      return { status } as never;
    });
    try {
      const author = (await w.agent("ann", [{ action: "*", project: "*" }])).principal;
      const reviewer = (await w.agent("rev", [{ action: "*", project: "*" }])).principal;
      const other = await w.agent("zed", [{ action: "*", project: "*" }]);
      roles.set(author.id, ["author"]); roles.set(reviewer.id, ["reviewer"]);
      const p = await w.project("Parser work");
      const task = await w.task(p, "parser fix");
      const sub = (await svc!.record(author, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: T("c"), tree: T("a"), patchId: T("d") })).id;
      const review = (await svc!.record(reviewer, { commandId: cid("r"), taskId: task, kind: "review", role: "reviewer", subject: sub, verdict: "approve" })).id;
      autos.set(`${sub}:${review}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", finishedAt: "2026-11-22T10:02:01.000Z", summary: "the checkout holds files that were not approved" });
      // The stand-in model only names the status kind and the task, in the owner's words; no submission or review ID passes through it.
      const seen: string[] = [];
      const text = "did the platform manage to commit the approved parser fix in Parser work?";
      const model = new ModelInterpreter({ complete: async (_route, r) => { seen.push(r.system + JSON.stringify(r)); return JSON.stringify([{ kind: "switch_focus", projectName: "Parser work", evidence: "Parser work", basis: "owner" }, { kind: "status", request: { kind: "submissions", taskTitle: "parser fix" }, evidence: "parser fix", basis: "owner" }]); } }, () => ["a/primary"]);
      const chat = w.chat({ interpreter: model, status: statusSvc! });
      const before = JSON.stringify(await svc!.list(w.owner, task, { limit: 100 }));
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[1]!.status, "answered", JSON.stringify(r.outcomes));
      const said = (r.outcomes as unknown as { lines?: { text: string }[] }[]).flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
      assert.match(said, /Commit: not made yet; the release that this approval asked for was refused at 2026-11-22T10:02:01\.000Z\. It said: "the checkout holds files that were not approved"\./);
      assert.deepEqual(reads, [`${sub}:${review}`]);
      // Nothing the owner did not say went to the model, and the answer text did not go back to it on this turn.
      assert.equal(seen.some((s) => s.includes(sub) || s.includes(review) || s.includes("holds files that were not approved")), false);
      assert.equal(JSON.stringify(await svc!.list(w.owner, task, { limit: 100 })), before, "asking created nothing");
      // A second question is answered afresh and the interpreter again sees no earlier answer.
      const again = "and is the approved parser fix in Parser work committed now?";
      autos.clear();
      const r2 = await chat.submit(w.ownerToken, { messageId: cid("m"), text: again });
      const said2 = (r2.outcomes as unknown as { lines?: { text: string }[] }[]).flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
      assert.doesNotMatch(said2, /asked for/);
      assert.match(said2, /Commit: not made yet; it is committed only when a release request commits it/);
      assert.equal(seen.some((s) => s.includes("holds files that were not approved") || s.includes("10:02:01")), false);
      // An agent with no part in the code (not its author, no review asked of it) is told nothing of the commit and nothing is read for it.
      reads.length = 0;
      const chatOther = w.chat({ interpreter: model, status: statusSvc! });
      autos.set(`${sub}:${review}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", summary: "private words of the host" });
      let told = "";
      try { const r3 = await chatOther.submit(other.token, { messageId: cid("m"), text }); told = JSON.stringify(r3.outcomes); } catch (e) { told = String((e as { code?: string }).code ?? e); }
      assert.doesNotMatch(told, /private words of the host|Commit:/);
      assert.deepEqual(reads, []);
    } finally { await w.close(); }
  });
}
