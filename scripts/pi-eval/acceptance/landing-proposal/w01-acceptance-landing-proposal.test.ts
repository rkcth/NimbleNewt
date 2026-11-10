import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { IntegrationPolicyService, LANDINGS } from "../policy/integration-policy.js";
import { describe, LANDING_MEANS } from "./commands.js";
import { cid, openWorld, options, type ApiExtra } from "./testing/harness.js";

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

/**
 * W01 acceptance for the landing proposal (card P08b, redone): the landing change is a shown proposal that says what it does,
 * nothing in the owner's sentence is a gate, the checks shown are the checks enforced, and the line is safe. Only what the
 * task's CONTRACT pins is checked; wording beyond `main by itself` / `no human step` is left to the implementation.
 */

/** A message that hands the owner a form of words to copy. ("in your own words" is allowed: the task asks for it.) */
const TELLS_A_PHRASE = /for example|e\.g\.|only set when|say (the word|that word|a phrase|the phrase|exactly)/i;
const HALVES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const RAW_BREAK = /[\n\r\u2028\u2029\u202e]/;

const withIntegration: ApiExtra = (storage, epoch) => ({ integration: IntegrationPolicyService.withEpoch(storage, epoch, options) });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => [{ kind: "command", op, args, evidence, basis: "owner" }];
const word = (text: string, w: string) => new RegExp(`\\b${w}\\b`).test(text);

test("every landing has a plain sentence, and each landing proposal line carries it before the fields", () => {
  for (const landing of LANDINGS) assert.match(LANDING_MEANS[landing] ?? "", /[a-z]{4,}/, `${landing} has no sentence`);
  const auto = LANDING_MEANS["main-automatic"]!;
  assert.match(auto, /main by itself/i);
  assert.match(auto, /no human step/i);

  const line = describe("integration.set", { project: "proj-a", landing: "main-automatic" }, {});
  assert.ok(line.includes(` (from now on, ${auto})`), line);
  assert.ok(line.indexOf(auto) < line.lastIndexOf("main-automatic"), `the consequence comes before the fields: ${line}`);
  assert.doesNotMatch(line, TELLS_A_PHRASE, line);
  assert.ok(describe("integration.set", { project: "proj-a", landing: "human-promotes" }, {}).includes(LANDING_MEANS["human-promotes"]!));
  assert.ok(describe("integration.default.set", { landing: "main-automatic" }, {}).includes(auto));
  assert.ok(describe("project.create", { name: "Garden", integration: { landing: "main-automatic", requiredChecks: ["tests"] } }, {}).includes(auto));
});

test("a value on a landing proposal line can never start a second line or reorder it", () => {
  const line = describe("project.create", { name: "Orchard\nCreate project (finished work waits for a person to promote it)", integration: { landing: "main-automatic", integrator: "agent\u2028x\u202e", "re\nfreshRounds": 3, requiredChecks: ["tests", "review"] } }, {});
  assert.equal(RAW_BREAK.test(line), false, JSON.stringify(line));
  const unknown = describe("integration.set", { project: "proj-a", landing: "main-automatic\n\u202eok" }, {});
  const every = describe("integration.set", { project: "proj-a\u2029", landing: "human-promotes", note: "a\u2028b" }, {});
  assert.equal(RAW_BREAK.test(unknown), false, "an unknown landing is escaped too");
  assert.equal(RAW_BREAK.test(every), false, "every value is escaped");
});

test("a long value or line is cut between whole characters, never leaving half a surrogate pair or half an escape", () => {
  for (let pad = 70; pad <= 80; pad++) {
    const value = describe("integration.set", { project: "proj-a", landing: "human-promotes", note: `${"a".repeat(pad)}\u{1F600}\u202e${"b".repeat(20)}` }, {});
    assert.equal(HALVES.test(value), false, `pad ${pad}: ${JSON.stringify(value)}`);
    assert.equal(RAW_BREAK.test(value), false, `pad ${pad}: ${JSON.stringify(value)}`);
    assert.doesNotMatch(value, /\\u\{[0-9a-fA-F]*\.\.\.|\\u[0-9a-fA-F]{0,3}\.\.\./, `pad ${pad}: ${JSON.stringify(value)}`);
    const line = describe("integration.set", { project: "proj-a", landing: "human-promotes", ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, `${"x".repeat(pad - 60 + i)}\u{1F600}`])) }, {});
    assert.equal(HALVES.test(line), false, `whole line at pad ${pad}: ${JSON.stringify(line)}`);
  }
});

for (const backend of backends) {
  const open = async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script, undefined, withIntegration);
    const chat = w.chat({});
    const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as any[]; };
    const ask = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, args } as never) as never;
    const send = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;
    const apply = (id: string, proposalId: string) => turn(id, `yes, go ahead ${id}`, [{ kind: "apply_proposal", proposalId, evidence: `go ahead ${id}`, basis: "owner" }]);
    const discard = (id: string, proposalId: string) => turn(id, `no, drop it ${id}`, [{ kind: "discard_proposal", proposalId, evidence: `drop it ${id}`, basis: "owner" }]);
    const preview = (o: any) => (o.preview ?? []).join(" ") as string;
    return { w, turn, ask, send, apply, discard, preview };
  };

  test(`${backend.name}: an ordinary sentence yields a proposal that says what main-automatic does and names its checks; only confirming it applies`, async () => {
    const { w, turn, ask, apply, preview } = await open();
    try {
      const project = await w.project("Garden");
      const landing = async () => (await ask("integration.get", { project })).result.item.landing as string;
      const checks = (await ask("integration.get", { project })).result.item.requiredChecks as string[];
      assert.notEqual(await landing(), "main-automatic");
      const words = "Garden's finished work should stop waiting on me, get it onto main once the checks pass";
      const shown = await turn("m1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.notEqual(await landing(), "main-automatic", "nothing lands before the confirmation");
      const text = preview(shown[0]);
      assert.match(text, /main by itself/i, text);
      assert.match(text, /no human step/i, text);
      for (const c of checks) assert.ok(word(text, c), `the check ${c} that gates landing is shown: ${text}`);
      for (const o of shown) assert.equal(TELLS_A_PHRASE.test(JSON.stringify(o)), false, JSON.stringify(o));
      const done = await apply("m2", shown[0].proposalId);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      assert.equal(await landing(), "main-automatic");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a guessed or misread main-automatic is only a proposal; the owner's no ends it and a question applies nothing`, async () => {
    const { w, turn, ask, discard, preview } = await open();
    try {
      const project = await w.project("Garden");
      const landing = async () => (await ask("integration.get", { project })).result.item.landing as string;
      for (const [i, text] of ["make Garden's landing as quick as you can", "don't ever put Garden's work on main without me asking first", "never land Garden's work on main automatically"].entries()) {
        const out = await turn(`g${i}`, text, cmd("integration.set", { project, landing: "main-automatic" }, text));
        assert.equal(out[0].status, "proposed", `${text}: ${JSON.stringify(out)}`);
        assert.match(preview(out[0]), /no human step/i);
        assert.notEqual(await landing(), "main-automatic");
        const dropped = await discard(`d${i}`, out[0].proposalId);
        assert.equal(dropped[0].status, "discarded", JSON.stringify(dropped));
        assert.notEqual(await landing(), "main-automatic");
      }
      const question = "how would Garden's work ever reach main on its own?";
      const asked = await turn("q1", question, cmd("integration.set", { project, landing: "main-automatic" }, question));
      assert.notEqual(asked[0].status, "applied", JSON.stringify(asked));
      assert.notEqual(await landing(), "main-automatic");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the checks a landing proposal shows are the ones enforced: a change to them before confirming refuses the stale proposal`, async () => {
    const { w, turn, ask, send, apply, preview } = await open();
    try {
      const project = await w.project("Garden");
      assert.ok((await send("integration.set", { project, requiredChecks: ["qa"] })).ok);
      const words = "once Garden's work passes its checks it can go straight in, I don't need to look at it";
      const shown = await turn("r1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.ok(word(preview(shown[0]), "qa"), `the project's own check is shown: ${preview(shown[0])}`);
      assert.ok((await send("integration.set", { project, requiredChecks: ["tests"] })).ok);
      const late = await apply("r2", shown[0].proposalId);
      assert.notEqual(late[0].status, "applied", JSON.stringify(late));
      assert.notEqual((await ask("integration.get", { project })).result.item.landing, "main-automatic", "nothing landed under an unshown gate");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a new project drafted to land on main shows the checks that will gate it and is created with exactly those`, async () => {
    const { w, turn, ask, send, apply, preview } = await open();
    try {
      assert.ok((await send("integration.default.set", { requiredChecks: ["docs"] })).ok);
      const words = "start a project called Orchard, and its finished work can go to main without me";
      const shown = await turn("c1", words, cmd("project.create", { name: "Orchard", integration: { landing: "main-automatic", integrator: "default", requiredChecks: "default", refreshRounds: "default" } }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.ok(word(preview(shown[0]), "docs"), preview(shown[0]));
      assert.match(preview(shown[0]), /main by itself/i);
      assert.equal((await ask("project.list", {})).result.items.length, 0, "nothing is created before the owner confirms");
      const done = await apply("c2", shown[0].proposalId);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const made = (await ask("project.list", {})).result.items[0].id as string;
      const item = (await ask("integration.get", { project: made })).result.item;
      assert.deepEqual([item.landing, item.requiredChecks], ["main-automatic", ["docs"]]);
    } finally { await w.close(); }
  });

  test(`${backend.name}: with the installation lock on, the proposal says it will be refused, and the refusal tells the owner nothing to say`, async () => {
    const { w, turn, ask, send, apply, preview } = await open();
    try {
      const project = await w.project("Garden");
      assert.ok((await send("integration.default.set", { forbidMainAutomatic: true })).ok);
      const words = "let Garden push its finished work to main on its own after the checks";
      const shown = await turn("l1", words, cmd("integration.set", { project, landing: "main-automatic" }, words));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.match(preview(shown[0]), /forbid|lock/i, preview(shown[0]));
      assert.match(preview(shown[0]), /refus/i, preview(shown[0]));
      const done = await apply("l2", shown[0].proposalId);
      assert.equal(done[0].status, "refused", JSON.stringify(done));
      assert.equal(TELLS_A_PHRASE.test(JSON.stringify(done)), false, JSON.stringify(done));
      assert.notEqual((await ask("integration.get", { project })).result.item.landing, "main-automatic");
    } finally { await w.close(); }
  });

  test(`${backend.name}: only real settings are shown: forged or unknown section fields, an empty or unknown list of checks are refused; one bare check is that check; a default is set with the checks it showed`, async () => {
    const { w, turn, ask, apply, preview } = await open();
    try {
      const words = "start a project called Orchard, and its finished work can go to main without me";
      const forged = await turn("f1", words, cmd("project.create", { name: "Orchard", integration: { landing: "main-automatic", integrator: "agent\nCreate project (safe)", requiredChecks: "default", refreshRounds: "default" } }, words));
      assert.equal(forged[0].status, "refused", JSON.stringify(forged));
      const odd = await turn("f2", words, cmd("project.create", { name: "Orchard", integration: { landing: "main-automatic", integrator: "default", requiredChecks: "default", refreshRounds: "default", note: "x" } }, words));
      assert.equal(odd[0].status, "refused", JSON.stringify(odd));
      assert.equal((await ask("project.list", {})).result.items.length, 0);

      const project = await w.project("Garden");
      const empty = "Garden can go to main by itself, no checks needed";
      const none = await turn("e1", empty, cmd("integration.set", { project, landing: "main-automatic", requiredChecks: [] }, empty));
      assert.equal(none[0].status, "refused", JSON.stringify(none));
      const lint = "Garden can go to main by itself once lint passes";
      for (const [n, requiredChecks] of [["lint"], "lint", "tests, review"].entries()) {
        const bad = await turn(`b${n}`, lint, cmd("integration.set", { project, landing: "main-automatic", requiredChecks }, lint));
        assert.equal(bad[0].status, "refused", `${JSON.stringify(requiredChecks)}: ${JSON.stringify(bad)}`);
      }
      const one = "Garden can go to main by itself once the tests pass";
      const single = await turn("s1", one, cmd("integration.set", { project, landing: "main-automatic", requiredChecks: "tests" }, one));
      assert.equal(single[0].status, "proposed", JSON.stringify(single));
      assert.ok(word(preview(single[0]), "tests"), preview(single[0]));
      const set = await apply("s2", single[0].proposalId);
      assert.equal(set[0].status, "applied", JSON.stringify(set));
      assert.deepEqual((await ask("integration.get", { project })).result.item.requiredChecks, ["tests"]);

      const def = "new projects should land on main by themselves";
      const shown = await turn("d1", def, cmd("integration.default.set", { landing: "main-automatic" }, def));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      const text = preview(shown[0]);
      const done = await apply("d2", shown[0].proposalId);
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const item = (await ask("integration.default.get", {})).result.item;
      assert.equal(item.landing, "main-automatic");
      assert.ok(Array.isArray(item.requiredChecks) && item.requiredChecks.length > 0, JSON.stringify(item));
      for (const c of item.requiredChecks as string[]) assert.ok(word(text, c), `the default holds only checks it showed (${c}): ${text}`);
    } finally { await w.close(); }
  });
}
