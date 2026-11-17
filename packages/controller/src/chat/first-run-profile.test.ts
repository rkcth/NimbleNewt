import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AdminViewService } from "../admin/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService } from "../conversations/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { PolicyService } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { RoutingService } from "../routing/index.js";
import { GrantService } from "../security/index.js";
import { SETUP_GUIDE, SetupProviderService, SetupReadinessService } from "../setup/index.js";
import { StatusService } from "../status/index.js";
import { adminIntent } from "../web/door.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { PolicyEditService } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card U08: "The first-run question explains derived, recommends it, and asks whether to switch; the same question in chat setup." The web page says it and so does the chat's setup walk-through; an
// answer from either is the same policy change, recorded the same way, and a "stay strict" is recorded too so the question is not asked again. All four storage backends.

after(stopServer);
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const pe = (change: Record<string, unknown>, evidence: string) => ({ kind: "policy_edit", change, evidence, basis: "owner" });
const lines = (outcomes: readonly { lines?: readonly { text: string }[] }[]): string => outcomes.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");

test("the profile step of the chat setup explains the derived profile, recommends it for testing and development and asks whether to switch from strict (card U08)", () => {
  const g = SETUP_GUIDE.profile;
  assert.match(g.question, /new installation starts in strict/i);
  assert.match(g.question, /Derived lets what you say authorize what it reasonably needs/);
  assert.match(g.question, /building, fixing what fails, merging into the integration branch, deploying to development and test/);
  assert.match(g.question, /still asks about anything wider, such as a customer-live environment, new outside access or spending beyond the estimate/);
  assert.match(g.question, /Do you want to switch from strict to derived\?$/, "it ends on the question");
  assert.match(g.recommended, /Derived for testing and development work/);
  assert.match(g.ifDeclined, /stays strict/); assert.match(g.ifDeclined, /recorded/); assert.match(g.ifDeclined, /chosen later/);
  assert.ok(g.question.length <= 700 && g.recommended.length <= 200 && g.ifDeclined.length <= 250, "within what the chat's setup line carries");
  assert.doesNotMatch(g.recommended + g.question, /Start with strict; after a few approvals/, "the old one-line answer is gone");
});

test("the interpreter is told that the first question is the profile and what its answers are (card U08)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "help me get started", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /explains the derived profile, recommends it for testing and development and asks whether to switch from strict/);
  assert.match(system, /answer to stay is one to strict \(also kept, so it is not asked again\)/);
});

for (const backend of backends) {
  test(`${backend.name}: the chat setup asks the profile question first, an answer to switch or to stay is the page's own change and is recorded, and the question is then not asked again (card U08)`, async () => {
    const script: Record<string, unknown[]> = {};
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      const routing = RoutingService.withEpoch(storage, epoch, options);
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing });
      const providers = SetupProviderService.withEpoch(storage, epoch, options, {});
      const admin = new AdminViewService({ configuration, routing: async () => undefined, endpoints: () => providers.endpoints(), hosts: async () => [] });
      const setup = SetupReadinessService.withEpoch(storage, epoch);
      statusSvc = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, admin, setup }, options);
      return { admin, status: statusSvc, setupReadiness: setup } as never;
    });
    try {
      const storage = w.world.storage, epoch = w.projects.epoch;
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing: RoutingService.withEpoch(storage, epoch, options) });
      const grants = GrantService.withEpoch(storage, epoch, options);
      const policy = PolicyService.withEpoch(storage, epoch, grants, options);
      const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews: ReviewService.withEpoch(storage, epoch, options), grants, configuration, conversations: ConversationService.withEpoch(storage, epoch, options), interpreter: w.interpreter }, options);
      const chat = w.chat({ policy, policyEdits: edits, status: statusSvc! });
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
      const profileItem = async () => (await SetupReadinessService.withEpoch(storage, epoch).check(w.owner)).items.find((i) => i.id === "profile")!;

      // A fresh installation: nothing chosen. The setup read puts the profile question first, in the words of the guide, with its recommendation and what each answer does.
      assert.equal((await profileItem()).state, "default");
      const q1 = "help me get started";
      const first = await say(q1, [ask({ kind: "setup" }, q1)]);
      const t1 = lines(first.outcomes as never);
      assert.match(t1, /Next to ask: How much should the team ask you before it acts\? A new installation starts in strict/);
      assert.match(t1, /Do you want to switch from strict to derived\?/);
      assert.match(t1, /Recommended: Derived for testing and development work/);
      assert.match(t1, /If you decline: It stays strict/);
      assert.match(t1, /The answer is a policy_edit profile change to derived or to strict \(strict is recorded too/);
      assert.match(t1, /Approval profile: default \(nothing chosen, works as it is\)/);

      // The answer "switch": the same change the page's button draws up, shown first, applied on yes, and recorded in the policy's history.
      const page = adminIntent("profile", { to: "derived" });
      assert.deepEqual((page.intent as { change: unknown }).change, { type: "profile", to: "derived" });
      const yes = "yes, switch to the derived profile";
      const p = await say(yes, [pe({ type: "profile", to: "derived" }, "switch to the derived profile")]);
      assert.equal(p.outcomes[0]!.status, "proposed", JSON.stringify(p.outcomes));
      assert.equal((await profileItem()).state, "default", "nothing is recorded by the proposal");
      const done = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (p.outcomes[0] as any).proposalId } as never);
      assert.equal((done as any).applied, true, JSON.stringify(done));
      const rec = await policy.get(w.owner, "installation");
      assert.equal(rec!.profile, "derived");
      assert.deepEqual([rec!.revision, rec!.history.map((h) => h.summary)], [1, ["profile derived"]]);
      const after = await profileItem();
      assert.deepEqual([after.state, /^derived/.test(after.detail)], ["done", true]);
      // The page's own button, run as a chat turn, finds nothing left to change (the same service, the same answer).
      const again = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: page.text }, { fixedIntents: [page.intent] } as never);
      assert.match(JSON.stringify(again.outcomes), /already|noop/i);
      // The question is not asked again: the setup read now goes to the first open step.
      const q2 = "what is left to set up?";
      const next = lines((await say(q2, [ask({ kind: "setup" }, q2)])).outcomes as never);
      assert.doesNotMatch(next, /Next to ask: How much should the team ask you/);
      assert.match(next, /Next to ask: What is your first project/);
    } finally { await w.close(); }
  });

  test(`${backend.name}: an answer to stay strict is recorded as the owner's choice, so the chat setup does not ask again and the page shows strict as chosen (card U08)`, async () => {
    const script: Record<string, unknown[]> = {};
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      const routing = RoutingService.withEpoch(storage, epoch, options);
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing });
      const providers = SetupProviderService.withEpoch(storage, epoch, options, {});
      const admin = new AdminViewService({ configuration, routing: async () => undefined, endpoints: () => providers.endpoints(), hosts: async () => [] });
      statusSvc = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, admin, setup: SetupReadinessService.withEpoch(storage, epoch) }, options);
      return { admin, status: statusSvc } as never;
    });
    try {
      const storage = w.world.storage, epoch = w.projects.epoch;
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing: RoutingService.withEpoch(storage, epoch, options) });
      const grants = GrantService.withEpoch(storage, epoch, options);
      const policy = PolicyService.withEpoch(storage, epoch, grants, options);
      const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews: ReviewService.withEpoch(storage, epoch, options), grants, configuration, conversations: ConversationService.withEpoch(storage, epoch, options), interpreter: w.interpreter }, options);
      const chat = w.chat({ policy, policyEdits: edits, status: statusSvc! });
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
      const item = async () => (await SetupReadinessService.withEpoch(storage, epoch).check(w.owner)).items.find((i) => i.id === "profile")!;
      assert.equal(await policy.get(w.owner, "installation"), undefined, "no policy record on a fresh installation");

      const no = "no, keep it strict for now";
      const p = await say(no, [pe({ type: "profile", to: "strict" }, "keep it strict")]);
      assert.equal(p.outcomes[0]!.status, "proposed", JSON.stringify(p.outcomes));
      assert.match(JSON.stringify(p.outcomes), /Keep the installation in the strict profile/);
      assert.equal(await policy.get(w.owner, "installation"), undefined, "shown first: nothing is recorded yet");
      const done = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (p.outcomes[0] as any).proposalId } as never);
      assert.equal((done as any).applied, true, JSON.stringify(done));
      const rec = await policy.get(w.owner, "installation");
      assert.deepEqual([rec!.profile, rec!.revision, rec!.history.map((h) => h.summary)], ["strict", 1, ["profile strict"]]);
      const chosen = await item();
      assert.deepEqual([chosen.state, /^strict/.test(chosen.detail)], ["done", true]);
      // The page's currentProfile still reads strict from this detail, and the effective policy is the one strict always was: nothing else moved.
      assert.equal((await policy.effective(w.owner))!.profile, "strict");
      const q = "what is left to set up?";
      assert.doesNotMatch(lines((await say(q, [ask({ kind: "setup" }, q)])).outcomes as never), /Next to ask: How much should the team ask you/);
      // Asking for strict again is "already so": a second record is not written.
      const again = await say("stay strict", [pe({ type: "profile", to: "strict" }, "stay strict")]);
      assert.match(JSON.stringify(again.outcomes), /already|noop/i);
      assert.equal((await policy.get(w.owner, "installation"))!.revision, 1);
    } finally { await w.close(); }
  });

  test(`${backend.name}: when the owner changed a cell before answering, "stay strict" is still recorded, so the setup does not ask the profile question forever (card U08 review)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script);
    try {
      const storage = w.world.storage, epoch = w.projects.epoch;
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing: RoutingService.withEpoch(storage, epoch, options) });
      const grants = GrantService.withEpoch(storage, epoch, options);
      const policy = PolicyService.withEpoch(storage, epoch, grants, options);
      const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews: ReviewService.withEpoch(storage, epoch, options), grants, configuration, conversations: ConversationService.withEpoch(storage, epoch, options), interpreter: w.interpreter }, options);
      const chat = w.chat({ policy, policyEdits: edits });
      const item = async () => (await SetupReadinessService.withEpoch(storage, epoch).check(w.owner)).items.find((i) => i.id === "profile")!;
      // A cell change first: the record exists (revision 1) but holds no profile, so setup still asks the profile question.
      await policy.set(w.owner, { commandId: cid("gate"), scope: "installation", allCommandGate: true });
      assert.deepEqual([(await policy.get(w.owner, "installation"))!.revision, (await policy.get(w.owner, "installation"))!.profile], [1, undefined]);
      assert.equal((await item()).state, "default");
      const no = "keep it strict";
      script[no] = [pe({ type: "profile", to: "strict" }, "keep it strict")];
      const p = await chat.submit(w.ownerToken, { messageId: cid("m"), text: no });
      assert.equal(p.outcomes[0]!.status, "proposed", JSON.stringify(p.outcomes));
      assert.match(JSON.stringify(p.outcomes), /Keep the installation in the strict profile/);
      const done = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (p.outcomes[0] as any).proposalId } as never);
      assert.equal((done as any).applied, true, JSON.stringify(done));
      const rec = await policy.get(w.owner, "installation");
      assert.deepEqual([rec!.profile, rec!.revision, rec!.allCommandGate], ["strict", 2, true], "the profile is recorded and the earlier gate change stays");
      assert.equal((await item()).state, "done");
    } finally { await w.close(); }
  });
}
