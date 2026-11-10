import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PolicyService, type Profile } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService, type GrantRecordBody } from "../security/index.js";
import { describe } from "./commands.js";
import { PolicyEditService, type Outcome } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

// W01 acceptance for grant-proposals: a grant with no spending limit or no end is a shown proposal that states the
// consequence; what a grant lacks is asked as a plain question; grant.create's preview line states its end and scope.

after(stopServer);

const NOW = "2026-10-22T10:00:00.000Z";
const pe = (change: Record<string, unknown>, evidence: string) => ({ kind: "policy_edit", change, evidence, basis: "owner" });
const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1, JSON.stringify(outcomes)); return outcomes[0]!; };
const PROFILES: readonly Profile[] = ["strict", "derived", "autonomous"];
/** What the owner is shown: the proposal's own lines and what the chat adds. */
const shown = (o: Outcome, reply: readonly string[]): string => [o.message ?? "", o.question ?? "", ...(o.preview ?? []), ...(o.explanation ?? []), ...reply].join(" ");

/** An instruction telling the owner which words to use (the CONTRACT: no message tells the owner what to say). */
const PHRASE_INSTRUCTIONS: readonly { readonly re: RegExp; readonly unless?: RegExp }[] = [
  { re: /for example\s*["“']/i },
  { re: /\bsay (the limit|there is none|it has no end|it is permanent|how much|how long|who may|which)\b/i, unless: /\b(did ?n[o']?t|don'?t|does ?n[o']?t|never|not|no one|nobody)\s(say|says|said)\b/i },
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

test("a grant.create preview says its end (or that it has none) and its scope in plain words, before the names", () => {
  const given = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(given, /\(ends 2026-12-01T00:00:00\.000Z; everywhere: it covers every project/);
  assert.doesNotMatch(given, /no end/);
  const open = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*" }, {});
  assert.match(open, /\(no end: it never runs out and stays until you revoke it; everywhere: it covers every project, including ones made later\)/);
  // One project with no name known: the ID is shown (quoted or not).
  assert.match(describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "proj-x" }, {}), /\(no end: it never runs out and stays until you revoke it; only in "?proj-x"?\)/);
  assert.doesNotMatch(describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "proj-x" }, {}), /everywhere|every project/);
  // One project whose name is known: the name is shown in quotes, before the names and the basis, even on a cut line.
  const long = "a".repeat(80);
  const line = describe("grant.create", { basis: `owner chat: ${"let it run ".repeat(30)}`, grantee: `agent:${long}`, action: `approve.${long}`, project: "proj-x" }, { "proj-x": "Garden" });
  assert.ok(line.startsWith("Grant right ("), line);
  assert.match(line, /\(no end: it never runs out and stays until you revoke it; only in "Garden"\)/, line);
  const ends = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", basis: "b".repeat(400), expiresAt: "2026-12-01T00:00:00.000Z" }, { "proj-x": "Garden" });
  assert.ok(ends.startsWith("Grant right ("), ends);
  assert.match(ends, /\(ends 2026-12-01T00:00:00\.000Z; only in "Garden"\)/, ends);
});

interface Agent { readonly name: string; readonly principal: string }
interface Held { readonly body: GrantRecordBody }

for (const backend of backends) {
  const open = async () => {
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
      agent: async (name: string): Promise<Agent> => ({ name, principal: `agent:${(await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name })).id}` }),
      held: async (who: Agent) => (await grants.held(who.principal, NOW)) as Held[],
      setProfile: async (profile: Profile) => {
        const current = await policy.get(w.owner, "installation");
        await policy.set(w.owner, { commandId: cid("pol"), scope: "installation", profile, ...(current === undefined ? {} : { expectedRevision: current.revision }) });
      },
      say: async (id: string, text: string, intents: unknown[]) => {
        script[text] = intents;
        const out = await chat.submit(w.ownerToken, { messageId: id, text });
        assertNoPhraseInstruction(`"${text}"`, [...out.outcomes.flatMap((o) => [o.message, o.question, ...(o.preview ?? []), ...(o.explanation ?? [])]), ...out.reply]);
        return { outcomes: out.outcomes, reply: out.reply };
      },
    };
  };

  test(`${backend.name}: a spending grant with no limit is a proposal that says so, in every approval profile, and grants nothing until confirmed`, async () => {
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
        assert.match(shown(o, out.reply), /Spend limit: none\./, `${profile}: the proposal says there is no limit`);
        assert.match(shown(o, out.reply), /any amount|however large/i, `${profile}: and what that means`);
        assert.match(shown(o, out.reply), /Length: 30 days/, `${profile}: the default length is shown`);
        assert.equal((await x.held(rex)).length, before, `${profile}: shown first, nothing granted`);
        const done = await x.say(`nl-${profile}-ok`, "Yes, go ahead with it.", [{ kind: "apply_proposal", proposalId: o.editId, evidence: "go ahead with it", basis: "owner" }]);
        assert.equal(only(done.outcomes).status, "applied", `${profile}: confirming the shown proposal applies it`);
        const held = await x.held(rex);
        assert.equal(held.length, before + 1, `${profile}: one grant, only from the confirmed proposal`);
        assert.deepEqual([held[before]!.body.terms?.spendUnlimited, held[before]!.body.terms?.spendLimit], [true, undefined]);
        assert.equal(held[before]!.body.expiresAt, "2026-11-21T10:00:00.000Z", "the 30-day default");
      }
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a grant with no end is a proposal that says it has no end, in every approval profile; the owner's no discards it; a misread denial or a question is still only proposed`, async () => {
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
        assert.match(shown(o, out.reply), /Length: no end \(nothing in it expires by itself\)/, `${profile}: the proposal says the grant has no end`);
        assert.equal((await x.held(rex)).length, before, `${profile}: a proposal grants nothing`);
        const no = await x.say(`ne-${profile}-no`, "No, that is more than I wanted.", [{ kind: "discard_proposal", proposalId: o.editId, evidence: "that is more than I wanted", basis: "owner" }]);
        assert.equal(only(no.outcomes).status, "discarded", `${profile}: the owner's no ends it`);
        assert.equal((await x.held(rex)).length, before, `${profile}: nothing held after the no`);
      }
      const flat = `Don't let ${rex.name} merge to staging whenever he feels like it.`;
      const back = await x.say("ne-3", flat, [pe({ type: "grant", grantee: rex.name, approve: { class: "merge" }, environments: ["staging"], lengthDays: null }, `let ${rex.name} merge to staging`)]);
      assert.equal(only(back.outcomes).status, "proposed", JSON.stringify(back.outcomes));
      assert.deepEqual(await x.held(rex), []);
      const ask = await x.say("ne-4", `Would ${rex.name}'s approval for git-push run out on its own some day?`, [pe({ type: "grant", grantee: rex.name, approve: { tool: "git-push" }, lengthDays: null }, `${rex.name}'s approval for git-push`)]);
      assert.equal(only(ask.outcomes).status, "proposed");
      assert.deepEqual(await x.held(rex), []);
      // Confirmed, it is held with no end date, and repeating the confirmation makes no second grant.
      const keep = `Let ${rex.name} commit in Garden from now on.`;
      const k = only((await x.say("ne-5", keep, [pe({ type: "grant", grantee: rex.name, approve: { class: "commit" }, lengthDays: null }, `let ${rex.name} commit`)])).outcomes);
      assert.equal(k.status, "proposed", JSON.stringify(k));
      assert.equal((await x.edits.apply(x.w.owner, { commandId: cid("a"), editId: k.editId! })).status, "applied");
      assert.equal((await x.edits.apply(x.w.owner, { commandId: cid("a2"), editId: k.editId! })).replayed, true);
      const held = await x.held(rex);
      assert.equal(held.length, 1);
      assert.equal(held[0]!.body.expiresAt, undefined, "no end date");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a spending grant with no ceiling stated, or a send with no audience, asks a plain question and grants nothing; the figure in the owner's words gets the proposal`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      for (const profile of PROFILES) {
        await x.setProfile(profile);
        const words = `Let ${rex.name} pay for the model services the project needs without asking me each time.`;
        const out = await x.say(`ml-${profile}`, words, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" } }, `let ${rex.name} pay for the model services the project needs`)]);
        const o = only(out.outcomes);
        assert.equal(o.status, "asked", `${profile}: ${JSON.stringify(o)}`);
        assert.match(o.question!, /how much/i, `${profile}: the chat asks how much`);
        assert.ok(o.question!.trim().endsWith("?"), `a plain question: ${o.question}`);
        assert.notEqual(o.code, "needs_limit");
        assert.deepEqual(await x.held(rex), [], `${profile}: the question holds nothing granted`);
      }
      const again = await x.say("ml-2", `Up to 500 is fine for what ${rex.name} pays for.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" }, spendLimit: 500 }, "up to 500 is fine")]);
      const second = only(again.outcomes);
      assert.equal(second.status, "proposed", JSON.stringify(second));
      assert.match(shown(second, again.reply), /Spend limit: 500\./);
      assert.deepEqual(await x.held(rex), [], "still only a proposal");
      const send = await x.say("ml-3", `Let ${rex.name} send the weekly note out when it is ready.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "external-send" } }, `let ${rex.name} send the weekly note out`)]);
      const s = only(send.outcomes);
      assert.equal(s.status, "asked", JSON.stringify(s));
      assert.match(s.question!, /account|audience/i);
      assert.ok(s.question!.trim().endsWith("?"), `a plain question: ${s.question}`);
      assert.deepEqual(await x.held(rex), []);
      // With an audience it is drawn up.
      const named = await x.say("ml-4", `Let ${rex.name} send mail to team@example.org.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "external-send" }, audiences: ["team@example.org"] }, "send mail to team")]);
      assert.equal(only(named.outcomes).status, "proposed", JSON.stringify(named.outcomes));
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a figure the owner never gave is still not drawn up, and the refusal asks back instead of dictating`, async () => {
    const x = await open();
    try {
      const rex = await x.agent("Rex");
      const out = await x.say("iv-1", `Give ${rex.name} a standing go-ahead for commits in Garden.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "commit" }, lengthDays: 40 }, `give ${rex.name} a standing go-ahead for commits`)]);
      const o = only(out.outcomes);
      assert.equal(o.status, "refused", JSON.stringify(o));
      assert.equal(o.code, "unsupported_value");
      assert.match(o.message!, /40 days/);
      assert.match(o.message!, /\?\s*$/, "it asks back");
      assert.deepEqual(await x.held(rex), []);
      const amount = await x.say("iv-2", `Give ${rex.name} a standing go-ahead for spending.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "spend" }, spendLimit: 9999 }, `give ${rex.name} a standing go-ahead for spending`)]);
      const a = only(amount.outcomes);
      assert.equal(a.code, "unsupported_value");
      assert.match(a.message!, /9999/);
      assert.match(a.message!, /\?\s*$/, "it asks back");
      assert.deepEqual(await x.held(rex), []);
      // A finite length over the ceiling is refused, the ceiling itself is drawn up.
      const over = only((await x.say("iv-3", `Let ${rex.name} commit for 36501 days.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "commit" }, lengthDays: 36501 }, "commit for 36501 days")])).outcomes);
      assert.equal(over.status, "refused", JSON.stringify(over));
      const ceiling = await x.say("iv-4", `Let ${rex.name} commit for 36500 days.`, [pe({ type: "grant", grantee: rex.name, approve: { class: "commit" }, lengthDays: 36500 }, "commit for 36500 days")]);
      assert.equal(only(ceiling.outcomes).status, "proposed");
    } finally { await x.w.close(); }
  });
}
