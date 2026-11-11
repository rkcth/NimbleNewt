import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ApprovalLoadService, PolicyService, ProfileSuggestionService, type ApprovalsFacade } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService } from "../security/index.js";
import { approvalIntent } from "../web/door.js";
import { cid, openWorld, options, type ApiExtra } from "./testing/harness.js";

after(stopServer);

const withApprovals: ApiExtra = (storage, epoch) => {
  const grants = GrantService.withEpoch(storage, epoch, options);
  const suggestion = ProfileSuggestionService.withEpoch(storage, epoch, PolicyService.withEpoch(storage, epoch, grants, options), options);
  const load = ApprovalLoadService.withEpoch(storage, epoch, grants, { ...options, profile: suggestion });
  const approvals: ApprovalsFacade = { load, suggestion };
  return { approvals, grants };
};

// Card U08b: the Accept and Dismiss buttons of the approvals page run as the chat turn for the same words, with the meaning fixed by code and not read by the assistant.
for (const backend of backends) {
  test(`${backend.name}: the approvals page's buttons are chat turns with a fixed meaning: Accept is shown first, Dismiss is done, nothing is read by the assistant, and a repeat of the key runs once (card U08b)`, async () => {
    const asked: string[] = [];
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, new Proxy(script, { get: (t, k) => { if (typeof k === "string") asked.push(k); return t[k as string]; } }), undefined, withApprovals);
    try {
      const chat = w.chat({});
      const project = await w.project("Garden");
      const task = await w.task(project, "do it");
      const ann = await w.agent("ann", [{ action: "review.request", project }, { action: "attempt.work", project }]);
      const grantsApi = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const review = ReviewService.withEpoch(w.world.storage, w.projects.epoch, options);
      const approve = async (tool: string) => {
        const r = await review.request(ann.principal, { commandId: cid("rq"), taskId: task, operation: { name: tool, args: { n: cid("a") } as never, target: { kind: "repository", id: "main" } }, context: { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["does the thing"] } });
        await review.decide(w.owner, { commandId: cid("dc"), requestId: r.id, expectedRevision: (await review.get(w.owner, r.id))!.revision, verdict: "allow", reason: "fine" });
      };
      const open = async () => (await w.api.handle(w.ownerToken, { v: 1, op: "approval.proposals", args: { state: "open" } }) as any).result.items as { id: string; revision: number; cls: string }[];
      for (let i = 0; i < 3; i++) await approve("git-commit");
      for (let i = 0; i < 3; i++) await approve("git-push");
      await w.api.handle(w.ownerToken, { v: 1, op: "approval.proposals.check", commandId: cid("chk"), args: {} });
      const proposals = await open();
      assert.equal(proposals.length, 2);
      const commit = proposals.find((p) => p.cls === "commit")!, push = proposals.find((p) => p.cls === "push")!;

      // Accept: the same confirmation the chat shows (what would be granted), nothing granted yet, and the assistant was not asked.
      const acc = approvalIntent(commit.id, "accept", { days: 7 });
      const shown = await chat.submit(w.ownerToken, { messageId: "btn-1", text: acc.text }, { fixedIntents: [acc.intent] });
      assert.equal(shown.outcomes[0]!.status, "proposed", JSON.stringify(shown.outcomes));
      assert.match(JSON.stringify(shown.outcomes[0]!.preview), /commit for agent:ann in project [^ ]+ \(development\), approved 3 times, open/);
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 0, "shown, not applied");
      assert.deepEqual(asked, [], "the assistant did not read the button's words");
      // The same key again is the same turn: nothing new is proposed.
      const again = await chat.submit(w.ownerToken, { messageId: "btn-1", text: acc.text }, { fixedIntents: [acc.intent] });
      assert.equal(again.replayed, true);
      assert.equal(again.outcomes[0]!.proposalId, shown.outcomes[0]!.proposalId);
      // Apply is the explicit request, as for any proposal.
      const applied = await chat.applyProposal(w.ownerToken, { commandId: "btn-apply-1", proposalId: shown.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true, JSON.stringify(applied));
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 1);

      // The suggested length (no days) works too, and a length the proposal does not offer is refused by the door's builder.
      assert.throws(() => approvalIntent(push.id, "accept", { days: 3 }), /days must be/);
      assert.throws(() => approvalIntent(push.id, "accept", { statedDays: 3 }), /not accepted/);
      assert.throws(() => approvalIntent(push.id, "dismiss", { reason: "free text" }), /not accepted/);

      // Dismiss: done at once with the page's fixed reason.
      const dis = approvalIntent(push.id, "dismiss", {});
      const done = await chat.submit(w.ownerToken, { messageId: "btn-2", text: dis.text }, { fixedIntents: [dis.intent] });
      assert.equal(done.outcomes[0]!.status, "applied", JSON.stringify(done.outcomes));
      const gone = (await w.api.handle(w.ownerToken, { v: 1, op: "approval.proposals", args: { state: "dismissed" } }) as any).result.items[0];
      assert.deepEqual([gone.id, gone.reason], [push.id, "turned down from the web page"]);

      // A proposal that does not exist is not found; an intent that is not a valid one is refused before anything runs.
      const none = approvalIntent("spr-zzzzzzzzzzzzzzzzzzzz", "dismiss", {});
      const nothing = await chat.submit(w.ownerToken, { messageId: "btn-3", text: none.text }, { fixedIntents: [none.intent] });
      assert.notEqual(nothing.outcomes[0]!.status, "applied", JSON.stringify(nothing.outcomes));
      await assert.rejects(chat.submit(w.ownerToken, { messageId: "btn-4", text: "Dismiss it please now" }, { fixedIntents: [{ kind: "command", op: "x" }] }), /intents\[0\]/);
      // Without fixedIntents nothing changes: the assistant still reads a message, and words that merely look like the button are not trusted as its meaning.
      const plain = await chat.submit(w.ownerToken, { messageId: "btn-5", text: acc.text });
      assert.notEqual(plain.outcomes[0]?.status, "proposed", "the words alone carry no meaning without the assistant");
    } finally { await w.close(); }
  });
}
