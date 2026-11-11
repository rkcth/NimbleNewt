import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ApprovalLoadService, PolicyService, ProfileSuggestionService, type ApprovalsFacade } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService } from "../security/index.js";
import { acceptedArgs, CHAT_OPS, describe } from "./commands.js";
import { cid, openWorld, options, type ApiExtra } from "./testing/harness.js";

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const OPS = ["approval.load", "approval.proposals", "approval.proposals.check", "approval.proposal.accept", "approval.proposal.dismiss", "approval.suggestion", "approval.suggestion.answer"] as const;

/** The approval services on the chat's own storage, wired the way the controller wires them (card U08). */
const withApprovals: ApiExtra = (storage, epoch) => {
  const grants = GrantService.withEpoch(storage, epoch, options);
  const suggestion = ProfileSuggestionService.withEpoch(storage, epoch, PolicyService.withEpoch(storage, epoch, grants, options), options);
  const load = ApprovalLoadService.withEpoch(storage, epoch, grants, { ...options, profile: suggestion });
  const approvals: ApprovalsFacade = { load, suggestion };
  return { approvals, grants };
};

test("the chat can do everything the approval views offer, each with the arguments the interpreter is told, and the risky ones are shown first (card U08)", () => {
  assert.deepEqual(OPS.filter((op) => op !== "approval.load" && op !== "approval.proposals" && op !== "approval.suggestion").filter((op) => CHAT_OPS[op] === undefined), [], "every command of the views is a chat operation");
  assert.equal(CHAT_OPS["approval.proposal.accept"]!.mode, "propose", "a standing grant, or a move to the derived profile, is shown first in every profile");
  assert.equal(CHAT_OPS["approval.suggestion.answer"]!.mode, "propose");
  assert.equal(CHAT_OPS["approval.proposal.dismiss"]!.mode, "apply");
  for (const k of ["days", "expectedRevision", "oneOff", "proposalId", "statedDays", "switchProfile"]) assert.ok(acceptedArgs("approval.proposal.accept")!.includes(k), k);
  for (const k of ["profileAnswer", "expectedRevision"]) assert.ok(acceptedArgs("approval.suggestion.answer")!.includes(k), k);
  assert.match(describe("approval.proposal.accept", { proposalId: "spr-aaaaaaaaaaaaaaaaaaaa", days: 7 }, {}), /Accept a standing-rule proposal/);
});

for (const backend of backends) {
  test(`${backend.name}: the approval views through the API and the chat: owner only, bounded, shown first, replay-safe, and nothing changes until the owner agrees (card U08)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withApprovals);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      const cmd = (op: string, args: Record<string, unknown>, evidence: string) => [{ kind: "command", op, args, evidence, basis: "owner" }];
      const as = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
      const ask = (op: string, args: Record<string, unknown> = {}) => as(w.ownerToken, op, args);
      const send = (op: string, args: Record<string, unknown>, commandId = cid("x")) => as(w.ownerToken, op, args, commandId);
      const project = await w.project("Garden");
      const task = await w.task(project, "do it");
      const ann = await w.agent("ann", [{ action: "review.request", project }, { action: "attempt.work", project }]);
      const grantsApi = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);

      // Owner only: an agent is refused every one of them, and an unknown argument or a bad window is refused for the owner.
      for (const op of OPS) assert.equal((await as(ann.token, op, {}, CHAT_OPS[op] !== undefined ? "n1" : undefined)).error?.code, "forbidden", op);
      assert.equal((await ask("approval.load", { extra: 1 })).error?.code, "invalid_command");
      for (const days of [0, 91, 1.5, "7"]) assert.equal((await ask("approval.load", { days })).error?.code, "invalid_command", String(days));
      assert.equal((await ask("approval.proposals", { state: "all" })).error?.code, "invalid_command");
      const empty = (await ask("approval.load", {})).result.item;
      assert.deepEqual([empty.days, empty.ownerDecisions, empty.pendingCount, empty.averageOwnerWaitMinutes], [7, 0, 0, null]);

      // Three approvals of one class: the chat has the controller look, and one proposal opens, changing no right.
      const review = ReviewService.withEpoch(w.world.storage, w.projects.epoch, options);
      const approve = async (tool: string) => {
        const r = await review.request(ann.principal, { commandId: cid("rq"), taskId: task, operation: { name: tool, args: { n: cid("a") } as never, target: { kind: "repository", id: "main" } }, context: { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["does the thing"] } });
        await review.decide(w.owner, { commandId: cid("dc"), requestId: r.id, expectedRevision: (await review.get(w.owner, r.id))!.revision, verdict: "allow", reason: "fine" });
      };
      for (let i = 0; i < 3; i++) await approve("git-commit");
      const checked = await turn("m1", "have a look whether I keep approving the same thing", cmd("approval.proposals.check", {}, "have a look whether I keep approving the same thing"));
      assert.equal(checked[0].status, "applied", JSON.stringify(checked));
      const open = (await ask("approval.proposals", { state: "open" })).result.items as { id: string; revision: number; requester: string; cls: string; count: number }[];
      assert.equal(open.length, 1);
      assert.deepEqual([open[0]!.requester, open[0]!.cls, open[0]!.count], [`agent:ann`, "commit", 3]);
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 0, "a proposal makes no grant");
      const load = (await ask("approval.load", {})).result.item;
      assert.equal(load.ownerDecisions, 3);

      // Answering by the profile makes no grant, so it takes no length, and only the two kinds of switch.
      assert.equal((await send("approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision, switchProfile: "permanent", days: 7 })).error?.code, "invalid_command");
      assert.equal((await send("approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision, switchProfile: "forever" })).error?.code, "invalid_command");
      assert.equal((await send("approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision, days: 7, statedDays: 7 })).error?.code, "invalid_command", "a length, or what to derive it from, not both");
      assert.equal((await ask("approval.proposals", { state: "open" })).result.items.length, 1, "none of them changed anything");

      // Accepting is shown first; the chat reads the revision itself; nothing is granted until the owner agrees.
      const said = "yes, let the commits for ann stand as a rule for a week";
      // A revision the interpreter makes up is not trusted: the confirmed proposal is refused as stale, and nothing is granted.
      const guessed = await turn("m2a", said, cmd("approval.proposal.accept", { proposalId: open[0]!.id, days: 7, expectedRevision: 999 }, said));
      assert.equal(guessed[0].status, "proposed", JSON.stringify(guessed));
      const refused = await turn("m2b", "go ahead", [{ kind: "apply_proposal", proposalId: guessed[0].proposalId, evidence: "go ahead", basis: "owner" }]);
      assert.equal(refused[0].status, "refused", JSON.stringify(refused));
      assert.equal(refused[0].code, "stale_revision");
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 0);
      // Without it the chat reads the revision itself; the proposal is shown first and nothing is granted until the owner agrees.
      const shown = await turn("m2", said, cmd("approval.proposal.accept", { proposalId: open[0]!.id, days: 7 }, said));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.equal((await ask("approval.proposals", { state: "open" })).result.items.length, 1, "shown, not applied");
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 0);
      const done = await turn("m3", "go ahead", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "go ahead", basis: "owner" }]);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const accepted = (await ask("approval.proposals", { state: "accepted" })).result.items[0];
      assert.deepEqual([accepted.state, accepted.via, accepted.chosenLength.days], ["accepted", undefined, 7]);
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 1, "one grant, for the length chosen");
      // Accepting again at the old revision is refused and makes no second grant.
      assert.equal((await send("approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision, days: 7 }, "same-1")).error?.code, "stale_revision");
      assert.equal((await grantsApi.list(w.owner, {} as never)).items.length, 1);

      // Dismissing needs no consent but keeps the owner's own reason; a second class is dismissed through the chat.
      for (let i = 0; i < 3; i++) await approve("git-push");
      await send("approval.proposals.check", {});
      const second = (await ask("approval.proposals", { state: "open" })).result.items[0] as { id: string; cls: string };
      assert.equal(second.cls, "push");
      const why = "I do not want pushes to run without me";
      const dismissed = await turn("m4", why, cmd("approval.proposal.dismiss", { proposalId: second.id, reason: why }, why));
      assert.equal(dismissed[0].status, "applied", JSON.stringify(dismissed));
      const gone = (await ask("approval.proposals", { state: "dismissed" })).result.items[0];
      assert.deepEqual([gone.id, gone.reason], [second.id, why]);
      // A proposal that does not exist is not found by the chat.
      const nothing = await turn("m5", "dismiss spr-zzzzzzzzzzzzzzzzzzzz", cmd("approval.proposal.dismiss", { proposalId: "spr-zzzzzzzzzzzzzzzzzzzz", reason: "dismiss" }, "dismiss spr-zzzzzzzzzzzzzzzzzzzz"));
      assert.notEqual(nothing[0].status, "applied", JSON.stringify(nothing));

      // The profile question: due after three owner approvals; the answer is shown first, then moves the installation, and it is not asked again.
      const due = (await ask("approval.suggestion")).result.item;
      assert.deepEqual([due.due, due.kind, due.answers], [true, "switch", ["switch", "trial", "not-now"]]);
      assert.equal((await send("approval.suggestion.answer", { profileAnswer: "keep", expectedRevision: due.revision })).error?.code, "invalid_command", "an answer this question does not offer");
      const answer = "switch me to the derived profile for good";
      const proposed = await turn("m6", answer, cmd("approval.suggestion.answer", { profileAnswer: "switch" }, answer));
      assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
      assert.equal((await ask("approval.suggestion")).result.item.due, true, "nothing is switched by showing it");
      const switched = await turn("m7", "yes, go ahead", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "go ahead", basis: "owner" }]);
      assert.equal(switched[0].status, "applied", JSON.stringify(switched));
      assert.equal((await ask("approval.suggestion")).result.item.due, false);
      const policy = PolicyService.withEpoch(w.world.storage, w.projects.epoch, grantsApi, options);
      assert.equal((await policy.effective(w.owner))?.profile, "derived");
    } finally { await w.close(); }
  });
}
