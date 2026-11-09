import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LANDINGS } from "../policy/integration-policy.js";
import { describe, LANDING_MEANS, proposalReason } from "./commands.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { cid, openWorld, options, type ApiExtra } from "./testing/harness.js";

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

/**
 * How finished work lands (card P08b), redone the way the flaky release approval was: an owner may say it in any words at all, and nothing in their
 * sentence is scanned for a phrase. The change is drawn up as a PROPOSAL that says plainly what the landing does and what gates it, and the owner's
 * confirmation of that shown proposal is the consent — so an interpreter that guesses or misreads the choice still changes no record. No message
 * tells the owner to say anything in particular. Everything here runs on the real ChatService and the real integration policy over the chat's own storage.
 */

/** Nothing that reaches the owner may tell them to put a phrase in a message: no example wording, no "your own words say/say so", no "for example". */
const TELLS_A_PHRASE = /(for example|your own (message|words)|only set when|say (the word|that word|a phrase|the phrase)|in particular|phrase)/i;

/** The integration policy service, on the same storage the chat turns on: landing settings are real records here, not a stub. */
/** The integration policy service, on the same storage the chat turns on: landing settings are real records here, not a stub. */
const withIntegration: ApiExtra = (storage, epoch) => ({ integration: IntegrationPolicyService.withEpoch(storage, epoch, options) });

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => [{ kind: "command", op, args, evidence, basis: "owner" }];

test("every landing is explained in plain words, and a proposal line says what the change does (card P08b, redone)", () => {
  // The table covers every landing the policy accepts, so a new choice can never arrive without a sentence for the owner.
  for (const landing of LANDINGS) assert.match(LANDING_MEANS[landing] ?? "", /[a-z]{4,}/, `${landing} has no plain sentence for the owner`);
  assert.match(LANDING_MEANS["main-automatic"]!, /main by itself/i, "the automatic landing is named as what it does");
  assert.match(LANDING_MEANS["main-automatic"]!, /no human step/i, "and says there is no person in the way");

  const line = describe("integration.set", { project: "proj-a", landing: "main-automatic" }, {});
  assert.match(line, /goes to main by itself once its required checks pass, with no human step/, line);
  assert.doesNotMatch(line, TELLS_A_PHRASE, `a proposal line tells the owner what happens, never what to say: ${line}`);
  // What the change does comes before the fields, so a long project name can never push the consequence off the line.
  assert.ok(line.indexOf("main by itself") < line.indexOf("landing=main-automatic"), `the consequence is said first: ${line}`);
  assert.match(describe("integration.default.set", { landing: "main-automatic" }, {}), /every new project starts this way/, "the installation default speaks for new projects");
  assert.match(describe("integration.set", { project: "proj-a", landing: "human-promotes" }, {}), /waits for a person to promote it/, "the safe landing is explained too");
  // A new project's integration section is shown as settings, not as a JSON blob the owner has to decode.
  const drafted = describe("project.create", { name: "Garden", integration: { landing: "main-automatic", requiredChecks: ["tests"] } }, {});
  assert.match(drafted, /this project's finished work goes to main by itself/, drafted);
  assert.equal(drafted.includes("{"), false, `a drafted project is shown as words: ${drafted}`);

  // Why each is shown first, said plainly.
  const always = { profile: "autonomous", said: true, quoted: false };
  assert.match(proposalReason("integration.set", { project: "proj-a", landing: "main-automatic" }, false, always) ?? "", /no human step/, "an automatic landing is shown first whatever the profile");
  assert.match(proposalReason("integration.default.set", { landing: "main-automatic" }, false, always) ?? "", /shown first/, "the installation default likewise");
  assert.doesNotMatch(proposalReason("integration.set", { project: "proj-a", landing: "main-automatic" }, false, always) ?? "", /role's capabilities/, "the reason is about landing, not about roles");
  assert.match(proposalReason("project.create", { name: "Garden", integration: { landing: "main-automatic" } }, false, always) ?? "", /no human step/, "a drafted project that lands on main says so in its reason");
});

for (const backend of backends) {
  test(`${backend.name}: the owner's own sentence about not waiting for a person is proposed, and lands nothing until that proposal is confirmed (card P08b, redone)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      // A query takes no commandId; a command needs one.
      const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
      const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
      const project = await w.project("Garden");
      const landing = async () => (await ask("integration.get", { project })).result.item.landing as string;
      assert.notEqual(await landing(), "main-automatic", "a project with no setting of its own does not land on main by itself");

      // An ordinary sentence, in the owner's own words, with nothing special about it.
      const words = "Garden's finished work should stop waiting on me — get it onto main by itself once the checks pass";
      const shown = await turn("m1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", `shown first, in any wording: ${JSON.stringify(shown)}`);
      assert.notEqual(await landing(), "main-automatic", "nothing lands until the owner confirms the proposal they were shown");
      const preview = (shown[0].preview ?? []).join(" ");
      assert.match(preview, /goes to main by itself/i, `the proposal says what will happen: ${preview}`);
      assert.match(preview, /no human step|no person approves each one/i, `and says no person is in the way: ${preview}`);
      assert.match(preview, /its checks \(tests, review\)|the checks it requires/i, `the gate is read from the project's record and shown: ${preview}`);
      for (const outcome of shown) assert.equal(TELLS_A_PHRASE.test(JSON.stringify(outcome)), false, `nothing tells the owner to say a phrase: ${JSON.stringify(outcome)}`);

      // The owner confirms the proposal they were shown; only then does the record change.
      const done = await turn("m2", "yes, that's what I want", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "that's what I want", basis: "owner" }]);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      assert.equal(await landing(), "main-automatic", "confirmed: the project's work now goes to main by itself");
    } finally { await w.close(); }
  });

  test(`${backend.name}: an interpreter that guesses main-automatic cannot apply its guess: the shown proposal stands between it and the record (card P08b, redone)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      // A query takes no commandId; a command needs one.
      const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
      const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
      const project = await w.project("Garden");
      const landing = async () => (await ask("integration.get", { project })).result.item.landing as string;

      // A sentence that says nothing of the kind, but the interpreter offered main-automatic anyway: it is shown, stated plainly, and goes no further on its own.
      const vague = "make Garden's landing as quick as you can";
      const guessed = await turn("g1", vague, cmd("integration.set", { project, landing: "main-automatic" }, vague));
      assert.equal(guessed[0].status, "proposed", `a guess is shown, never applied: ${JSON.stringify(guessed)}`);
      assert.notEqual(await landing(), "main-automatic", "the guess changes nothing by itself");
      const dropped = await turn("g2", "no, forget that", [{ kind: "discard_proposal", proposalId: guessed[0].proposalId, evidence: "forget that", basis: "owner" }]);
      assert.equal(dropped[0].status, "discarded", JSON.stringify(dropped));
      assert.notEqual(await landing(), "main-automatic", "the owner's no ends it");

      // The same against a denial the interpreter read backwards: the words are not scanned, so the proposal is what protects the owner.
      const denied = "don't ever put Garden's work on main without me asking first";
      const wrong = await turn("g3", denied, cmd("integration.set", { project, landing: "main-automatic" }, denied));
      assert.equal(wrong[0].status, "proposed", `a misread becomes a proposal the owner can say no to: ${JSON.stringify(wrong)}`);
      assert.match((wrong[0].preview ?? []).join(" "), /no human step/i, "the misreading is shown for what it would do");
      assert.notEqual(await landing(), "main-automatic", "and it is still the owner's say");
      await turn("g4", "no", [{ kind: "discard_proposal", proposalId: wrong[0].proposalId, evidence: "no", basis: "owner" }]);
      assert.notEqual(await landing(), "main-automatic", "a denial is not turned into consent by any wording check");

      // Asking about it changes nothing either: a question is not an order, and no sentence is tested for one.
      const question = "how would Garden's work ever reach main on its own?";
      const askedAbout = await turn("g5", question, cmd("integration.set", { project, landing: "main-automatic" }, question));
      assert.equal(askedAbout[0].status === "applied", false, `a question applies nothing: ${JSON.stringify(askedAbout)}`);
      assert.notEqual(await landing(), "main-automatic", "still nothing lands on main by itself");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the checks a landing proposal names are the ones that gate it when confirmed: read from the project's record, and a change in between refuses the stale proposal (card P08b, redone; review)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
      const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
      const project = await w.project("Garden");
      assert.ok((await send("integration.set", { project, requiredChecks: ["qa"] })).ok, "the project's own record requires qa");
      const words = "once Garden's work passes its checks it can go straight in, I don't need to look at it";
      const shown = await turn("r1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      const preview = (shown[0].preview ?? []).join(" ");
      assert.match(preview, /its checks \(qa\)/, `the gate shown is the project's own record, not a guess: ${preview}`);
      // The owner then drops the check that the proposal named; confirming the old proposal must not land work on main under a gate they were never shown.
      assert.ok((await send("integration.set", { project, requiredChecks: ["tests"] })).ok);
      const late = await turn("r2", "yes, go ahead with that", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "go ahead with that", basis: "owner" }]);
      assert.notEqual(late[0].status, "applied", `a proposal whose shown gate is out of date is not applied: ${JSON.stringify(late)}`);
      assert.notEqual((await ask("integration.get", { project })).result.item.landing, "main-automatic", "nothing landed on main under an unshown gate");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a new project drafted to land on main names the checks that will gate it, and is created with exactly those (card P08b, redone; review)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
      const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
      assert.ok((await send("integration.default.set", { requiredChecks: ["docs"] })).ok, "the installation default requires docs");
      const words = "start a project called Orchard, and its finished work can go to main without me";
      const shown = await turn("c1", words, cmd("project.create", { name: "Orchard", integration: { landing: "main-automatic", integrator: "default", requiredChecks: "default", refreshRounds: "default" } }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      const preview = (shown[0].preview ?? []).join(" ");
      assert.match(preview, /its checks \(docs\)/, `the gate of the new project is named: ${preview}`);
      assert.match(preview, /goes to main by itself/, preview);
      assert.equal((await ask("project.list", {})).result.items.length, 0, "nothing is created before the owner confirms");
      const done = await turn("c2", "yes please", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "yes please", basis: "owner" }]);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const made = (await ask("project.list", {})).result.items[0].id as string;
      const item = (await ask("integration.get", { project: made })).result.item;
      assert.deepEqual([item.landing, item.requiredChecks], ["main-automatic", ["docs"]], "created with the gate that was shown");
    } finally { await w.close(); }
  });

  test(`${backend.name}: with the installation lock on, the proposal says the change will be refused, and the refusal after confirming tells the owner nothing to say (card P08b, redone)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
      // A query takes no commandId; a command needs one.
      const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
      const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
      const project = await w.project("Garden");
      assert.ok((await send("integration.default.set", { forbidMainAutomatic: true })).ok, "the installation forbids landing on main automatically");

      const words = "let Garden push its finished work to main on its own after the checks";
      const shown = await turn("l1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      const preview = (shown[0].preview ?? []).join(" ");
      assert.match(preview, /forbids landing on main automatically/, `the lock the owner must lift is shown with the proposal: ${preview}`);
      assert.match(preview, /refused while that lock stands/, `and so is what will happen when confirmed: ${preview}`);

      const done = await turn("l2", "go ahead", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "go ahead", basis: "owner" }]);
      assert.equal(done[0].status, "refused", JSON.stringify(done));
      const text = JSON.stringify(done);
      assert.equal(TELLS_A_PHRASE.test(text), false, `a refusal says why, not what to say: ${text}`);
      assert.equal((await ask("integration.get", { project })).result.item.landing, "human-promotes", "the lock holds whatever the chat proposed");
    } finally { await w.close(); }
  });
}
