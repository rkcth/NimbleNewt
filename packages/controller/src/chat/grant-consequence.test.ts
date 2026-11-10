import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PolicyService, type Profile } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService, idleEnd, type GrantRecordBody } from "../security/index.js";
import { PolicyEditService, type Outcome } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);

const NOW = "2026-10-22T10:00:00.000Z";
const pe = (change: Record<string, unknown>, evidence: string) => ({ kind: "policy_edit", change, evidence, basis: "owner" });
const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1, JSON.stringify(outcomes)); return outcomes[0]!; };
/** Every approval profile the policy engine has. A grant loosens something, so it is shown first in all of them. */
const PROFILES: readonly Profile[] = ["strict", "derived", "autonomous"];
/** What the owner is shown: the proposal's own lines, what the chat adds, and the record's stored summary. */
const shown = (o: Outcome, reply: readonly string[]): string => [...(o.preview ?? []), ...(o.explanation ?? []), ...reply].join(" ");

/**
 * Nothing an owner may read may tell them how to word a message: no example phrase, no "say the limit", no "only when your own message says so".
 * Two kinds of line are deliberately not matched here. A plain question asking for information ("How much may Rex spend under this grant — a figure,
 * or no ceiling at all?") asks for a fact, not for a form of words. And an invention guard naming the value it wants ("40 days is not a length your
 * message gives … How long should the grant last?", "What was given for grantee is not in your message … What did you mean instead?") is the allowed ID-and-value guard: it
 * stops the chat inventing something the record would hold, and the owner may answer it in any words they like.
 */
const PHRASE_INSTRUCTIONS: readonly { readonly re: RegExp; readonly unless?: RegExp }[] = [
  { re: /for example\s*["\u201c']/i },
  // An imperative to say a thing ("Say the limit, or say there is none."). A statement that the owner did not say something
  // ("you did not say how long, so the 30-day default is used") is not an instruction and is excluded.
  { re: /\bsay (the limit|there is none|it has no end|it is permanent|how much|how long|who may|which)\b/i, unless: /\b(did ?n[o']?t|don'?t|does ?n[o']?t|never|not|no one|nobody)\s(say|says|said)\b/i },
  { re: /only (set|done|made|possible) when your own message says/i },
  { re: /your own words (say|must say|must)\b/i },
  { re: /\bas you said\b/i },
  { re: /\buse (the words|the phrase)\b/i },
];
const assertNoPhraseInstruction = (label: string, lines: readonly (string | undefined)[]): void => {
  for (const [n, line] of lines.entries()) {
    if (line === undefined) continue;
    for (const { re, unless } of PHRASE_INSTRUCTIONS) {
      if (unless !== undefined && unless.test(line)) continue;
      assert.doesNotMatch(line, re, `${label}: line ${n} tells the owner what to say: ${line}`);
    }
  }
};

interface Agent { readonly name: string; readonly principal: string }
interface Held { readonly body: GrantRecordBody }

/**
 * A grant that has no spending limit or no end is a proposal whose own text says so, and the owner's confirmation of that proposal is the consent (the shape the flaky release approval and landing on
 * main were given). None of this reads the owner's wording for a phrase: an ordinary sentence, a question and a denial the interpreter read backwards all produce the same shown proposal, none of them
 * grants anything, and what a grant is missing is asked about in a plain question. Every line the owner is shown is checked here for an instruction to say something.
 */
for (const backend of backends) {
  interface World {
    readonly w: Awaited<ReturnType<typeof openWorld>>;
    readonly edits: PolicyEditService;
    readonly say: (id: string, text: string, intents: unknown[]) => Promise<{ readonly outcomes: readonly Outcome[]; readonly reply: readonly string[] }>;
    readonly held: (who: Agent) => Promise<Held[]>;
    readonly setProfile: (profile: Profile) => Promise<void>;
    readonly agent: (name: string) => Promise<Agent>;
  }
  const open = async (): Promise<World> => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    const storage = w.world.storage; const epoch = w.projects.epoch;
    const grants = GrantService.withEpoch(storage, epoch, options);
    const policy = PolicyService.withEpoch(storage, epoch, grants, options);
    const reviews = ReviewService.withEpoch(storage, epoch, options);
    const configuration = ConfigurationService.withEpoch(storage, epoch, options);
    const garden = await w.project("Garden");
    const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews, grants, configuration, interpreter: w.interpreter }, options);
    const chat = w.chat({ policy, policyEdits: edits });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: garden });
    return {
      w, edits,
      agent: async (name: string) => ({ name, principal: `agent:${(await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name })).id}` }),
      held: async (who: Agent) => (await grants.held(who.principal, NOW)) as Held[],
      setProfile: async (profile: Profile) => {
        const current = await policy.get(w.owner, "installation");
        await policy.set(w.owner, { commandId: cid("pol"), scope: "installation", profile, ...(current === undefined ? {} : { expectedRevision: current.revision }) });
      },
      say: async (id, text, intents) => {
        script[text] = intents;
        const out = await chat.submit(w.ownerToken, { messageId: id, text });
        assertNoPhraseInstruction(`"${text}"`, [...out.outcomes.flatMap((o) => [o.message, o.question, ...(o.preview ?? []), ...(o.explanation ?? [])]), ...out.reply]);
        return { outcomes: out.outcomes, reply: out.reply };
      },
    };
  };

  test(`${backend.name}: a spending grant with no limit is a proposal that says it has no limit, in every approval profile, and grants nothing until that proposal is confirmed`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      for (const profile of PROFILES) {
        await x.setProfile(profile);
        const before = (await x.held(rex)).length;
        const words = `${rex.name} keeps stopping to ask me about payments. Let ${rex.name} pay for what the work needs and do not put a ceiling on it.`;
        const out = await x.say(`nl-${profile}`, words, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" }, spendLimit: null }, `let ${rex.name} pay for what the work needs`)]);
        const o = only(out.outcomes);
        assert.equal(o.status, "proposed", `${profile}: ${JSON.stringify(o)}`);
        assert.match(shown(o, out.reply), /no spending limit|spend limit: none/i, `${profile}: the proposal must say there is no limit`);
        assert.match(shown(o, out.reply), /any amount|however large/i, `${profile}: and what that means`);
        assert.equal((await x.held(rex)).length, before, `${profile}: shown first, nothing granted`);
        const edit = (await x.edits.get(x.w.owner, o.editId!))!;
        assert.equal(edit.status, "proposed");
        assert.equal(edit.direct, false, `${profile}: the message that asked never applies it`);
        assert.equal((edit.op as unknown as { spendUnlimited?: true }).spendUnlimited, true, "the proposal carries the term itself, not a note about wording");
        assert.match(edit.summary.join(" "), /no spending limit/i, "the consequence is in the stored summary the owner reads first");
        const done = await x.say(`nl-${profile}-ok`, "Yes, go ahead with it.", [{ kind: "apply_proposal", proposalId: o.editId, evidence: "go ahead with it", basis: "owner" }]);
        assert.equal(only(done.outcomes).status, "applied", `${profile}: confirming the shown proposal is what applies it`);
        assert.match(shown(only(done.outcomes), done.reply), /no spending limit|spend limit: none/i, "the line the owner confirmed is repeated with the grant");
        const held = await x.held(rex);
        assert.equal(held.length, before + 1, `${profile}: one grant, and only from the confirmed proposal`);
        assert.deepEqual([held[before]!.body.terms?.spendUnlimited, held[before]!.body.terms?.spendLimit], [true, undefined]);
        assert.match(shown(o, out.reply), /Length: 30 days/i, `${profile}: the default length is stated on the proposal too, not read out of the sentence`);
        assert.equal(idleEnd(held[before]!.body), "2026-11-21T10:00:00.000Z", "the length is the 30-day default the proposal showed");
      }
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a grant that never ends says so on the proposal, in every approval profile; the owner's no discards it and a denial read backwards still only proposes it`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      for (const profile of PROFILES) {
        await x.setProfile(profile);
        const before = (await x.held(rex)).length;
        const words = `Stop asking me about every push ${rex.name} wants. Make it a standing thing so I am not asked again.`;
        const out = await x.say(`ne-${profile}`, words, [pe({ type: "grant", grantee: rex.name, approve: { class: "push" }, lengthDays: null }, "make it a standing thing")]);
        const o = only(out.outcomes);
        assert.equal(o.status, "proposed", `${profile}: ${JSON.stringify(o)}`);
        assert.match(shown(o, out.reply), /no end/i, `${profile}: the proposal says the grant has no end`);
        assert.match(shown(o, out.reply), /never runs out|until you revoke it/i, `${profile}: and what that means in practice`);
        assert.doesNotMatch(shown(o, out.reply), /\bpermanent\b/i, "it says it in ordinary words");
        assert.equal((await x.held(rex)).length, before, `${profile}: a proposal grants nothing`);
        const edit = (await x.edits.get(x.w.owner, o.editId!))!;
        assert.equal(edit.direct, false, `${profile}: the message that asked never applies it`);
        assert.equal((edit.op as unknown as { permanent?: true }).permanent, true);
        assert.match(edit.summary.join(" "), /no end/i);
        // The owner says no: it is discarded and nothing is held.
        const no = await x.say(`ne-${profile}-no`, "No, that is more than I wanted.", [{ kind: "discard_proposal", proposalId: o.editId, evidence: "that is more than I wanted", basis: "owner" }]);
        assert.equal(only(no.outcomes).status, "discarded", `${profile}: the owner's no ends it`);
        assert.equal((await x.held(rex)).length, before, `${profile}: nothing held after the no`);
      }

      // An interpreter that reads a flat denial backwards gets the same treatment: shown, stated plainly, nothing applied.
      const flat = `Don't let ${rex.name} merge to staging whenever he feels like it.`;
      const back = await x.say("ne-3", flat, [pe({ type: "grant", grantee: rex.name, approve: { class: "merge" }, environments: ["staging"], lengthDays: null }, `let ${rex.name} merge to staging`)]);
      const b = only(back.outcomes);
      assert.equal(b.status, "proposed", JSON.stringify(b));
      assert.match(shown(b, back.reply), /no end/i);
      assert.deepEqual(await x.held(rex), [], "the owner's no is what stops it, not a wording test");

      // A question about it also applies nothing.
      const ask = await x.say("ne-4", `Would ${rex.name}'s approval for git-push run out on its own some day?`, [pe({ type: "grant", grantee: rex.name, approve: { tool: "git-push" }, lengthDays: null }, `${rex.name}'s approval for git-push`)]);
      assert.equal(only(ask.outcomes).status, "proposed");
      assert.deepEqual(await x.held(rex), []);
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a spending grant with no ceiling stated asks a plain question in every approval profile and grants nothing; the figure said in ordinary words gets the proposal`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      for (const profile of PROFILES) {
        await x.setProfile(profile);
        const words = `Let ${rex.name} pay for the model services the project needs without asking me each time.`;
        const out = await x.say(`ml-${profile}`, words, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" } }, `let ${rex.name} pay for the model services the project needs`)]);
        const o = only(out.outcomes);
        assert.equal(o.status, "asked", `${profile}: ${JSON.stringify(o)}`);
        assert.match(o.question!, /how much may .* spend/i, `${profile}: the chat asks what it needs to know`);
        assert.ok(o.question!.trim().endsWith("?"), `a plain question: ${o.question}`);
        assert.deepEqual(o.options ?? [], [], "nothing is offered to say back: an answer in ordinary words will do");
        assert.match(out.reply.join(" "), /how much may .* spend/i);
        assert.deepEqual(await x.held(rex), [], `${profile}: the question holds nothing granted`);
      }

      // The owner answers in their own words.
      const again = await x.say("ml-2", `Up to 500 is fine for what ${rex.name} pays for.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" }, spendLimit: 500 }, "up to 500 is fine")]);
      const second = only(again.outcomes);
      assert.equal(second.status, "proposed", JSON.stringify(second));
      assert.match(shown(second, again.reply), /Spend limit: 500\./);
      assert.deepEqual(await x.held(rex), [], "still only a proposal");

      // A send with no audience asks too, and names no phrase.
      const send = await x.say("ml-3", `Let ${rex.name} send the weekly note out when it is ready.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "external-send" } }, `let ${rex.name} send the weekly note out`)]);
      const s = only(send.outcomes);
      assert.equal(s.status, "asked", JSON.stringify(s));
      assert.match(s.question!, /which account or audience/i);
      assert.deepEqual(await x.held(rex), []);
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a figure the owner never gave is still not invented, and the answer comes back as a question, not a phrase to say`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      const words = `Give ${rex.name} a standing go-ahead for commits in Garden.`;
      const out = await x.say("iv-1", words, [pe({ type: "grant", grantee: rex.name, approve: { class: "commit" }, lengthDays: 40 }, `give ${rex.name} a standing go-ahead for commits`)]);
      const o = only(out.outcomes);
      assert.equal(o.status, "refused", JSON.stringify(o));
      assert.equal(o.code, "unsupported_value");
      assert.match(o.message!, /40 days is not a length your message gives/i);
      assert.match(o.message!, /\?\s*$/, "it asks back, it does not demand a form of words");
      assert.deepEqual(await x.held(rex), []);
      const amount = await x.say("iv-2", `Give ${rex.name} a standing go-ahead for spending.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" }, spendLimit: 9999 }, `give ${rex.name} a standing go-ahead for spending`)]);
      assert.equal(only(amount.outcomes).code, "unsupported_value");
      assert.match(only(amount.outcomes).message!, /9999 is not an amount your message gives/i);
      assert.deepEqual(await x.held(rex), []);
    } finally { await x.w.close(); }
  });
}
