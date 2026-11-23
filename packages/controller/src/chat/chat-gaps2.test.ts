import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { StatusService } from "../status/index.js";
import { DecisionService } from "../decisions/index.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { CHAT_OPS, GAPS_CHAT_ARGS, acceptedArgs, proposalReason } from "./commands.js";
import { ModelInterpreter, type ModelCall } from "./model-interpreter.js";
import type { Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Chat-control gaps, second slice: the owner settles a conflict between two of their own instructions, labels a role, and detaches, moves or re-scopes a bound resource, all in free words. Everything goes through the real chat and
// the real ModelInterpreter; the stand-in model sees only the prompt and the owner's words, answers only for an operation whose line (with every argument it gives) is in the prompt, and records every value it hands over that the
// owner did not say (except the ones that are read from the owner's words on purpose: `access`, `label` null).

after(stopServer);

type Rule = { op: string; args: Record<string, unknown>; invents?: boolean };
const RULES: Record<string, Rule> = {
  "Settle the database conflict: go with the SQLite one": { op: "decision.resolve-dispute", args: { disputeTopic: "database", choiceWords: "SQLite" } },
  "Settle the database conflict": { op: "decision.resolve-dispute", args: { disputeTopic: "database" } },
  "Settle the conflict, go with the SQLite one": { op: "decision.resolve-dispute", args: { choiceWords: "SQLite" } },
  "Settle the database conflict: go with the first one": { op: "decision.resolve-dispute", invents: true, args: { disputeTopic: "database", choiceWords: "MySQL" } },
  "Settle the logging conflict: go with the JSON one": { op: "decision.resolve-dispute", args: { disputeTopic: "logging", choiceWords: "JSON" } },
  "Settle the cache conflict, go with Redis": { op: "decision.resolve-dispute", args: { disputeTopic: "cache", choiceWords: "Redis" } },
  "Settle the conflict about the database with disp-aaaaaaaaaaaa": { op: "decision.resolve-dispute", invents: true, args: { disputeId: "disp-aaaaaaaaaaaa", chosen: "dec-aaaaaaaaaaaa" } },
  "Call the director role CTO": { op: "role.label", args: { name: "director", label: "CTO" } },
  "Call the director role Chief": { op: "role.label", invents: true, args: { name: "director", label: "Boss" } },
  "Clear the label of the director role": { op: "role.label", args: { name: "director", label: null } },
  "Show the director role differently": { op: "role.label", invents: true, args: { name: "director", label: null } },
  "Detach the Web resource": { op: "resource.unbind", args: { resourceLabel: "Web" } },
  "Detach the Web resource, id res-aaaaaaaaaaaa": { op: "resource.unbind", args: { resourceId: "res-aaaaaaaaaaaa" } },
  "Detach the Web resource please": { op: "resource.unbind", invents: true, args: { resourceId: "res-bbbbbbbbbbbb" } },
  "Detach the Zed resource": { op: "resource.unbind", args: { resourceLabel: "Zed" } },
  "Detach a resource": { op: "resource.unbind", args: {} },
  "Point the Web resource at https://new.example.test": { op: "resource.move", args: { resourceLabel: "Web", locator: "https://new.example.test" } },
  "Point the Web resource somewhere else": { op: "resource.move", invents: true, args: { resourceLabel: "Web", locator: "https://elsewhere.example.test" } },
  "Make the Docs resource read only": { op: "resource.scope", args: { resourceLabel: "Docs", access: "read" } },
  "Make the Docs resource look-only": { op: "resource.scope", invents: true, args: { resourceLabel: "Docs", access: "write" } },
  "Let the project change the Docs resource": { op: "resource.scope", args: { resourceLabel: "Docs", access: "write" } },
};
const DERIVED = new Set(["access", "label"]);

test("the operations are in the table, shown first, take names and words and never an ID of the model's own, and the prompt lists them", async () => {
  let system = "";
  await new ModelInterpreter({ complete: async (_r, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]).interpret({ text: "hi", quoted: [], focus: {}, proposals: [] });
  for (const op of Object.keys(GAPS_CHAT_ARGS)) {
    assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is a proposal`);
    assert.ok(proposalReason(op, {}, false, { profile: "autonomous", said: true, quoted: false }) !== undefined, `${op} says why it is shown first, whatever the profile`);
    assert.ok(system.includes(`${op}(${(acceptedArgs(op) ?? []).filter((k) => k !== "projectName" && k !== "taskTitle" && k !== "prerequisiteTitle").join(", ")}) - `), `${op} is listed with its arguments`);
  }
  for (const op of ["decision.resolve-dispute", "role.label"]) for (const bad of ["expectedRevision", "resourceId", "projectId"]) assert.ok(!(acceptedArgs(op) ?? []).includes(bad), `${op} takes no ${bad} from the model`);
  assert.ok(!(acceptedArgs("resource.unbind") ?? []).includes("expectedRevision"), "a revision is read, not said");
  assert.match(system, /decision\.resolve-dispute: disputeTopic is words from the topic/);
});

for (const backend of backends) {
  const open = async () => {
    const invented: string[] = [];
    const violations: string[] = [];
    const seen: string[] = [];
    const model: ModelCall = {
      complete: async (_route, r) => {
        const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
        seen.push(r.user);
        const pendingAsk = /Pending question (turn-[A-Za-z0-9]+)/.exec(r.user);
        if (pendingAsk !== null && RULES[owner] === undefined) return JSON.stringify([{ kind: "answer", turnId: pendingAsk[1], choice: owner, evidence: owner, basis: "owner" }]);
        const rule = RULES[owner];
        if (rule === undefined) return JSON.stringify([{ kind: "none", reason: "no rule" }]);
        const line = new RegExp(`(?:^|; )${rule.op.replace(/\./g, "\\.")}\\(([^)]*)\\) - `).exec(r.system);
        if (line === null || !Object.keys(rule.args).every((k) => line[1]!.split(", ").includes(k))) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
        for (const [k, v] of Object.entries(rule.args)) if (typeof v === "string" && !DERIVED.has(k) && !owner.toLowerCase().includes(v.toLowerCase())) violations.push(`${k}=${v}`);
        if (rule.invents === true) invented.push(owner);
        return JSON.stringify([{ kind: "command", op: rule.op, args: rule.args, evidence: owner, basis: "owner" }]);
      },
    };
    const w = await openWorld(backend, {}, undefined, (storage, epoch, built) => {
      const decisions = DecisionService.withEpoch(storage, epoch, {}, options);
      const status = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, disputes: (by, limit) => decisions.openDisputes(by, limit) }, options);
      return { status };
    });
    const chat = w.chat({ interpreter: new ModelInterpreter(model, () => ["test/model"]) });
    const project = await w.project("Garden");
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: project });
    w.profile.value = "autonomous";
    const say = async (text: string): Promise<Outcome> => { const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text }); assert.equal(r.outcomes.length, 1, JSON.stringify(r.outcomes)); return r.outcomes[0]!; };
    const apply = async (o: Outcome) => chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! });
    /** Two sessions of the owner say different things about the same topic: a conflict, as the decision service makes one. */
    const conflict = async (topic: string, first: string, second: string) => {
      const dec = (over: Record<string, unknown>) => w.decisions.record(w.owner, { commandId: cid("dec"), projectId: project, category: "decision", topic, source: { channel: "direct" }, ...over } as never) as Promise<{ recorded: boolean; id: string; disputeId?: string; version: number }>;
      const base = await dec({ statement: "Use Postgres", wording: "we use Postgres", basedOn: 0 });
      const one = await dec({ statement: first, wording: `switch to ${first}`, basedOn: base.version });
      const two = await dec({ statement: second, wording: `make it ${second}`, basedOn: base.version });
      assert.ok(two.disputeId, "the conflict is surfaced");
      return { one: one.id, two: two.id, dispute: two.disputeId! };
    };
    const needs = async (): Promise<{ kind: string; id: string; text: string; members?: { id: string; statement: string }[]; answer: { kind: string; choices?: string[] } }[]> => {
      const r = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "status.ask", args: { request: { kind: "needs_you", limit: 50 } } });
      assert.ok(r.ok, JSON.stringify(r));
      return ((r as unknown as { result: { item: { items: never[] } } }).result.item.items);
    };
    return { w, chat, project, say, apply, conflict, needs, invented, violations, seen };
  };

  test(`${backend.name}: a conflict between two instructions is a Needs-you item and is settled by words: shown first, nothing chosen until the owner agrees, then the chosen one stands`, async () => {
    const { w, project, say, apply, conflict, needs, violations, seen } = await open();
    try {
      const c = await conflict("database", "MySQL", "SQLite");
      const item = (await needs()).find((i) => i.kind === "dispute")!;
      assert.ok(item, "the conflict is listed for the owner");
      assert.equal(item.id, c.dispute);
      assert.deepEqual(item.members?.map((m) => m.statement).sort(), ["MySQL", "SQLite"]);
      assert.deepEqual([...(item.answer.choices ?? [])].sort(), [c.one, c.two].sort());
      assert.match(item.text, /conflict on "database"/);
      const o = await say("Settle the database conflict: go with the SQLite one");
      assert.equal(o.status, "proposed", JSON.stringify(o));
      const shown = JSON.stringify(o);
      assert.ok(shown.includes("SQLite") && shown.includes("database") && shown.includes("stands"), shown);
      assert.ok(!shown.includes(c.two) && !shown.includes(c.dispute), "the proposal shows words, not IDs");
      assert.equal((await w.decisions.authoritative(w.owner, { projectId: project, topic: "database" }))?.status, "disputed", "nothing is chosen before the owner agrees");
      assert.deepEqual(violations, [], "the stand-in handed over only the owner's words");
      assert.ok(!seen.join("\n").includes("earlier answer"), "the interpreter sees no earlier answer");
      const applied = await apply(o);
      assert.equal(applied.applied, true, JSON.stringify(applied));
      const now = await w.decisions.authoritative(w.owner, { projectId: project, topic: "database" });
      assert.equal(now?.status === "decided" ? now.decision.statement : undefined, "SQLite");
      assert.equal((await needs()).filter((i) => i.kind === "dispute").length, 0, "the item is gone");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the conflict and the instruction are the owner's words: an invented choice is refused, a missing one asks, a made-up ID is refused, no conflict is said plainly`, async () => {
    const { w, project, say, conflict, invented, chat } = await open();
    try {
      const none = await say("Settle the database conflict: go with the SQLite one");
      assert.equal(none.status, "refused", JSON.stringify(none));
      assert.match(JSON.stringify(none), /none of your instructions conflict/);
      const c = await conflict("database", "MySQL", "SQLite");
      const made = await say("Settle the database conflict: go with the first one");
      assert.equal(made.status, "refused", JSON.stringify(made));
      assert.match(JSON.stringify(made), /not in your message/);
      assert.deepEqual(invented, ["Settle the database conflict: go with the first one"], "the stand-in did invent that one");
      const id = await say("Settle the conflict about the database with disp-aaaaaaaaaaaa");
      assert.equal(id.status, "refused", JSON.stringify(id));
      // The instruction not said: the owner is asked, with both instructions, and the answer picked from them is the choice.
      const ask = await say("Settle the database conflict");
      assert.equal(ask.status, "asked", JSON.stringify(ask));
      assert.equal(ask.options?.length, 2);
      assert.ok(ask.options!.some((x) => x.includes("MySQL")) && ask.options!.some((x) => x.includes("SQLite")));
      assert.equal((await w.decisions.authoritative(w.owner, { projectId: project, topic: "database" }))?.status, "disputed");
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text: c.two });
      assert.equal(r.outcomes[0]?.status, "proposed", JSON.stringify(r.outcomes));
      assert.ok(JSON.stringify(r.outcomes[0]).includes("SQLite"));
    } finally { await w.close(); }
  });

  test(`${backend.name}: several conflicts: the topic words pick one, a topic that fits none is refused, two of them are asked about (never the first taken)`, async () => {
    const { w, say, conflict } = await open();
    try {
      await conflict("database", "MySQL", "SQLite");
      await conflict("logging", "JSON lines", "plain text");
      const ask = await say("Settle the conflict, go with the SQLite one");
      assert.equal(ask.status, "asked", JSON.stringify(ask));
      assert.equal(ask.options?.length, 2);
      const one = await say("Settle the logging conflict: go with the JSON one");
      assert.equal(one.status, "proposed", JSON.stringify(one));
      assert.ok(JSON.stringify(one).includes("JSON lines"));
      const miss = await say("Settle the cache conflict, go with Redis");
      assert.equal(miss.status, "refused", JSON.stringify(miss));
      assert.match(JSON.stringify(miss), /no conflict between your instructions is about/);
    } finally { await w.close(); }
  });

  test(`${backend.name}: the Needs-you list answers a conflict too (the web buttons), with the chosen decision; an agent cannot see or settle it`, async () => {
    const { w, project, conflict, needs } = await open();
    try {
      const c = await conflict("database", "MySQL", "SQLite");
      const refused = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "needs-you.answer", commandId: cid("na"), args: { kind: "dispute", id: c.dispute, answer: "dec-aaaaaaaaaaaa" } } as never);
      assert.equal(refused.ok, false);
      const ann = await w.agent("ann", [{ action: "attempt.work", project }]);
      const denied = await w.api.handle(ann.token, { v: API_VERSION, op: "needs-you.answer", commandId: cid("na"), args: { kind: "dispute", id: c.dispute, answer: c.one } } as never);
      assert.equal(denied.ok, false);
      assert.equal((await needs()).filter((i) => i.kind === "dispute").length, 1, "still waiting");
      const done = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "needs-you.answer", commandId: cid("na"), args: { kind: "dispute", id: c.dispute, answer: c.one } } as never);
      assert.ok(done.ok, JSON.stringify(done));
      const now = await w.decisions.authoritative(w.owner, { projectId: project, topic: "database" });
      assert.equal(now?.status === "decided" ? now.decision.statement : undefined, "MySQL");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a role's label is set and cleared by words, the label is the owner's own, a clear needs the owner to say so, and nothing changes before they agree`, async () => {
    const { w, say, apply, violations } = await open();
    try {
      await w.agents.defineRole(w.owner, { commandId: cid("r"), name: "director", capabilities: [] });
      const o = await say("Call the director role CTO");
      assert.equal(o.status, "proposed", JSON.stringify(o));
      assert.ok(JSON.stringify(o).includes("CTO") && JSON.stringify(o).includes("director"));
      assert.equal(((await w.agents.getRole(w.owner, "director")) as unknown as { label?: string }).label, undefined, "nothing before the owner agrees");
      assert.equal((await apply(o)).applied, true);
      assert.equal(((await w.agents.getRole(w.owner, "director")) as unknown as { label?: string }).label, "CTO");
      assert.deepEqual(violations, []);
      const invented = await say("Call the director role Chief");
      assert.equal(invented.status, "refused", JSON.stringify(invented));
      const vague = await say("Show the director role differently");
      assert.equal(vague.status, "refused", "a clear the owner did not ask for is refused");
      assert.match(JSON.stringify(vague), /Clearing the label is not what your message says/);
      const clear = await say("Clear the label of the director role");
      assert.equal(clear.status, "proposed", JSON.stringify(clear));
      assert.equal((await apply(clear)).applied, true);
      assert.equal(((await w.agents.getRole(w.owner, "director")) as unknown as { label?: string }).label, undefined);
    } finally { await w.close(); }
  });

  test(`${backend.name}: a bound resource is detached, moved and re-scoped by its label: shown first, the revision is read, an unclear one asks, an unknown label is refused, an invented place or access is refused`, async () => {
    const { w, project, say, apply, violations } = await open();
    try {
      const bind = async (label: string, locator: string) => (await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: project, kind: "service", label, locator } as never)).id;
      const web = await bind("Web", "https://example.test");
      const docs = await bind("Docs", "https://docs.example.test");
      const state = async (id: string) => (await w.resources.get(w.owner, id))! as unknown as { state: string; locator: string; scope: { mode: string } };
      const ask = await say("Detach a resource");
      assert.equal(ask.status, "asked", "with two bound, one is never taken");
      assert.equal((await state(web)).state, "bound");
      assert.equal((await say("Detach the Zed resource")).status, "refused");
      const madeUp = await say("Detach the Web resource, id res-aaaaaaaaaaaa");
      assert.equal(madeUp.status, "refused", JSON.stringify(madeUp));
      assert.equal((await state(web)).state, "bound");
      // A real resource ID the interpreter was never given by the owner: refused although it exists (the ID check alone would let it through).
      RULES["Detach the Web resource please"]!.args["resourceId"] = web;
      assert.equal((await say("Detach the Web resource please")).status, "refused", "an ID the owner did not say is refused");
      assert.equal((await state(web)).state, "bound");
      const un = await say("Detach the Web resource");
      assert.equal(un.status, "proposed", JSON.stringify(un));
      assert.equal((await state(web)).state, "bound", "nothing before the owner agrees");
      assert.ok(JSON.stringify(un).includes("Web"));
      { const r = await apply(un); assert.equal(r.applied, true, JSON.stringify(r)); }
      assert.equal((await state(web)).state, "unbound");
      assert.equal((await state(docs)).state, "bound");
      const wrongPlace = await say("Point the Web resource somewhere else");
      assert.equal(wrongPlace.status, "refused", JSON.stringify(wrongPlace));
      const mv = await say("Point the Web resource at https://new.example.test");
      assert.equal(mv.status, "refused", "an unbound resource is no longer there to move");
      assert.equal((await state(docs)).locator, "https://docs.example.test");
      const wide = await say("Make the Docs resource look-only");
      assert.equal(wide.status, "refused", "write access the owner did not ask for is refused");
      const rw = await say("Let the project change the Docs resource");
      assert.equal(rw.status, "proposed", JSON.stringify(rw));
      assert.match(JSON.stringify(rw), /write access|what the project may do/);
      assert.equal((await state(docs)).scope.mode, "read", "nothing before the owner agrees");
      { const r = await apply(rw); assert.equal(r.applied, true, JSON.stringify(r)); }
      assert.equal((await state(docs)).scope.mode, "write");
      const ro = await say("Make the Docs resource read only");
      assert.equal(ro.status, "proposed", JSON.stringify(ro));
      { const r = await apply(ro); assert.equal(r.applied, true, JSON.stringify(r)); }
      assert.equal((await state(docs)).scope.mode, "read");
      assert.deepEqual(violations, [`resourceId=${web}`, "locator=https://elsewhere.example.test"], "only the cases that invent on purpose handed over a value the owner did not say");
    } finally { await w.close(); }
  });
}
