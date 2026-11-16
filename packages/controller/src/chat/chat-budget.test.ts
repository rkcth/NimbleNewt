import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS, OPERATION_BY_NAME } from "../api/operations.js";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import type { Principal } from "../security/principals.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { ModelInterpreter, type ModelCall, type ModelReply } from "./model-interpreter.js";
import { CHAT_BUDGET_LIMITS, ChatSpendService, GuardedModelCall } from "./routed-model.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// T2 (follow-up to L04d): the owner reads and sets the daily cap on the controller's own model calls through the API and by chat, on every storage backend.

after(stopServer);

const say = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });

/** A model that answers every route and counts its calls, reporting a token usage. */
class Counting implements ModelCall {
  calls = 0;
  constructor(readonly tokens: number) {}
  async complete(route: string): Promise<string> { return (await this.completeDetailed(route)).text; }
  async completeDetailed(_route?: string): Promise<ModelReply> { this.calls++; return { text: "ok", usage: { inputTokens: this.tokens, outputTokens: 0 } }; }
}

test("the interpreter prompt describes both operations from the tables, and the free-form ways to set, clear and read the cap", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.ok(acceptedArgs("chat.budget.set")!.includes("maxTokensPerDay") && !acceptedArgs("chat.budget.set")!.includes("commandId"));
  assert.ok(system.includes(`chat.budget.set(${acceptedArgs("chat.budget.set")!.filter((k) => k !== "projectName").join(", ")}) - ${CHAT_OPS["chat.budget.set"]!.verb}`), "the operation line comes from the table");
  const kind = STATUS_KINDS["chat_budget"]!;
  assert.ok(system.includes(`chat_budget(${kind.keys.join(", ")}) - ${kind.about}`), "the status kind comes from the table");
  for (const words of ["two million", "take the daily token cap off", "how much of today's allowance", "null"]) assert.ok(system.includes(words), words);
  assert.equal(CHAT_OPS["chat.budget.set"]!.mode, "propose", "always shown first");
  assert.ok(OPERATIONS.some((o) => o.name === "chat.budget.get" && o.kind === "query"));
  assert.ok(OPERATIONS.some((o) => o.name === "chat.budget.set" && o.kind === "command"));
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, spend: ChatSpendService, status: StatusService, day: { value: string }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const day = { value: "2026-11-15T10:00:00.000Z" };
      let spend!: ChatSpendService;
      const w = await openWorld(backend, script, undefined, (storage, epoch) => { spend = ChatSpendService.withEpoch(storage, epoch, { clock: () => day.value }); return { chatSpend: spend }; });
      try {
        const status = StatusService.withEpoch(w.world.storage, w.projects.epoch, { chatBudget: { view: (by: Principal) => spend.view(by) } } as never, options);
        await body(w, script, spend, status, day);
      } finally { await w.close(); }
    });
  const call = (w: World, token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;

  suite("get reads no cap and no use by default; set is owner only, validated, replay-safe and audited; a task credential and an agent are refused", async (w, _script, spend) => {
    const first = await call(w, w.ownerToken, "chat.budget.get", {});
    assert.deepEqual(first.result.item, { maxTokensPerDay: null, day: "2026-11-15", tokens: 0, calls: 0, remaining: null });
    assert.equal((await call(w, w.ownerToken, "chat.budget.get", { x: 1 })).error?.code, "invalid_command", "unknown arguments are refused");

    const set = await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 1000 }, "cap-1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal(set.result.replayed, false);
    const got = (await call(w, w.ownerToken, "chat.budget.get", {})).result.item;
    assert.equal(got.maxTokensPerDay, 1000);
    assert.equal(got.remaining, 1000);
    assert.equal(got.setBy, w.owner.id);
    assert.equal(typeof got.setAt, "string");

    // The same command ID with the same value is a replay and changes nothing; with another value it is refused.
    const again = await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 1000 }, "cap-1");
    assert.equal(again.result.replayed, true);
    assert.equal((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 2000 }, "cap-1")).error?.code, "command_conflict");
    assert.equal((await call(w, w.ownerToken, "chat.budget.get", {})).result.item.maxTokensPerDay, 1000, "the refused repeat changed nothing");
    assert.equal((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 5 })).error?.code, "invalid_command", "a command needs its command ID");

    // Every bad value is refused and the cap stays.
    const bad: unknown[] = [0, -1, 1.5, CHAT_BUDGET_LIMITS.maxTokensPerDay + 1, "500", true, NaN, Infinity, [5], {}];
    for (const [i, v] of bad.entries()) assert.equal((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: v }, `bad-${i}`)).error?.code, "invalid_command", JSON.stringify(v));
    assert.equal((await call(w, w.ownerToken, "chat.budget.set", {}, "bad-missing")).error?.code, "invalid_command", "no value is not 'no cap'");
    assert.equal((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 5, extra: 1 }, "bad-extra")).error?.code, "invalid_command");
    assert.equal((await call(w, w.ownerToken, "chat.budget.get", {})).result.item.maxTokensPerDay, 1000);

    // The ends of the range are taken; null removes the cap.
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 1 }, "lo")).ok);
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: CHAT_BUDGET_LIMITS.maxTokensPerDay }, "hi")).ok);
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: null }, "off")).ok);
    const cleared = (await call(w, w.ownerToken, "chat.budget.get", {})).result.item;
    assert.equal(cleared.maxTokensPerDay, null);
    assert.equal(cleared.remaining, null);
    assert.equal((await spend.budget())?.maxTokensPerDay, undefined);

    // The audit trail names the owner, the record and the value of each change.
    const audit = (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "chat.budget");
    assert.deepEqual(audit.map((a) => a.detail["maxTokensPerDay"]), [1000, 1, CHAT_BUDGET_LIMITS.maxTokensPerDay, null], "one entry per change; the replay and the refusals wrote none");
    assert.ok(audit.every((a) => a.actor === w.owner.id && a.subject?.kind === "chat-budget" && a.subject.id === "chat-budget"));

    // Not the owner: an agent holding every right may neither read nor set it.
    const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
    assert.equal((await call(w, ann.token, "chat.budget.get", {})).error?.code, "forbidden");
    assert.equal((await call(w, ann.token, "chat.budget.set", { maxTokensPerDay: 5 }, "ann-1")).error?.code, "forbidden");
    // A task-scoped credential, even one that carries the owner's identity, is refused at the operation and at the service.
    const scoped = { ...w.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } } as Principal;
    const ctx = { principal: scoped, chatSpend: spend } as never;
    for (const [op, args, id] of [["chat.budget.get", {}, undefined], ["chat.budget.set", { maxTokensPerDay: 5 }, "scoped-1"]] as const) {
      await assert.rejects(OPERATION_BY_NAME.get(op)!.run(ctx, args, id), (e: unknown) => e instanceof DomainError && e.code === "forbidden", op);
    }
    await assert.rejects(spend.setBudget(scoped, { commandId: "scoped-2", maxTokensPerDay: 5 }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    await assert.rejects(spend.view(scoped), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    assert.equal((await call(w, w.ownerToken, "chat.budget.get", {})).result.item.maxTokensPerDay, null, "nothing was set by the refused calls");
    assert.equal((await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "chat.budget").length, 4);
  });

  suite("the cap set through the API stops the reviewer's route (a guard built as the controller builds it), counts its calls, and a new UTC day starts again", async (w, _script, spend, _status, day) => {
    // The controller builds one spend service per guard on the same store; the cap is shared through the store, not through memory.
    const reviewerSpend = ChatSpendService.withEpoch(w.world.storage, w.projects.epoch, { clock: () => day.value });
    const reviewer = new Counting(60);
    const guard = new GuardedModelCall(reviewer, { spend: reviewerSpend });
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 100 }, "r-cap")).ok);
    await guard.complete("local/reviewer", { system: "s", user: "u" });
    await guard.complete("local/reviewer", { system: "s", user: "u" });
    const mid = (await call(w, w.ownerToken, "chat.budget.get", {})).result.item;
    assert.deepEqual({ tokens: mid.tokens, calls: mid.calls, remaining: mid.remaining }, { tokens: 120, calls: 2, remaining: 0 }, "the API reads what the guard recorded; remaining is never negative");
    await assert.rejects(guard.complete("local/reviewer", { system: "s", user: "u" }), /budget: the chat's token budget for today \(100\) is used/);
    assert.equal(reviewer.calls, 2, "at the cap the reviewer's route is not called");
    // Raising the cap through the API lets the next call through at once; lowering it below the count stops it again.
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 1000 }, "r-up")).ok);
    await guard.complete("local/reviewer", { system: "s", user: "u" });
    assert.equal(reviewer.calls, 3);
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: 50 }, "r-down")).ok);
    await assert.rejects(guard.complete("local/reviewer", { system: "s", user: "u" }), /budget:/);
    assert.equal(reviewer.calls, 3);
    day.value = "2026-11-16T00:00:00.000Z";
    const next = (await call(w, w.ownerToken, "chat.budget.get", {})).result.item;
    assert.deepEqual({ day: next.day, tokens: next.tokens, calls: next.calls, remaining: next.remaining }, { day: "2026-11-16", tokens: 0, calls: 0, remaining: 50 }, "a new UTC day counts from zero");
    await guard.complete("local/reviewer", { system: "s", user: "u" });
    assert.equal(reviewer.calls, 4);
    // Removing the cap lifts the block.
    await guard.complete("local/reviewer", { system: "s", user: "u" }).then(() => assert.fail("the second call of the day (60 + 60 over 50) should be refused"), (e: unknown) => assert.match(String((e as Error).message), /budget:/));
    assert.ok((await call(w, w.ownerToken, "chat.budget.set", { maxTokensPerDay: null }, "r-off")).ok);
    await guard.complete("local/reviewer", { system: "s", user: "u" });
    assert.equal(reviewer.calls, 5);
    void spend;
  });

  suite("by chat: a cap in free words is shown first with its number and applies only on the owner's yes; 'remove it' sends null; reading it is answered from the records, cites them and writes nothing", async (w, script, spend, status) => {
    const chat = w.chat({ status });
    w.profile.value = "autonomous";
    const submit = async (text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; };
    const cap = async () => (await spend.budget())?.maxTokensPerDay;

    // Propose, then yes.
    const t1 = "Please keep your own model use to two million tokens a day.";
    const [proposed] = await submit(t1, [say("chat.budget.set", { maxTokensPerDay: 2_000_000 }, t1)]);
    assert.equal(proposed!.status, "proposed", `shown first even in the autonomous profile: ${JSON.stringify(proposed)}`);
    assert.match(JSON.stringify(proposed), /maxTokensPerDay=2000000/, "the owner reads the number first");
    assert.equal(await cap(), undefined, "nothing is set before the owner agrees");
    const t2 = "Yes, go ahead.";
    const [done] = await submit(t2, [{ kind: "apply_proposal", proposalId: proposed!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(done!.status, "applied", JSON.stringify(done));
    assert.equal(await cap(), 2_000_000);
    const applied = (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "chat.budget");
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.actor, w.owner.id);
    // A second yes is a replay, not a second change.
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: proposed!.proposalId! })).replayed, true);
    assert.equal((await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "chat.budget").length, 1);

    // Reading, in free words: answered, every line cites its record, and nothing is written.
    await spend.record(1234, "k-1");
    const writes = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "chat.budget" || !a.type.startsWith("chat.")).length;
    const before = await writes();
    for (const text of ["how much of the daily token allowance have you used?", "what is your own model cap?"]) {
      const [r] = await submit(text, [ask({ kind: "chat_budget" }, text)]);
      assert.equal(r!.status, "answered", JSON.stringify(r));
      assert.ok(r!.lines!.every((l) => l.cites.length > 0), "every line cites a record");
      const said = r!.lines!.map((l) => l.text).join("\n");
      assert.match(said, /may use 2000000 tokens a day/);
      assert.match(said, /Today \(2026-11-15\) they used 1234 tokens in 1 counted call; 1998766 tokens are left\./);
    }
    assert.equal(await writes(), before, "reading changes no record: no budget entry and nothing outside the chat's own log");

    // Remove it: null, shown first and applied on yes.
    const t3 = "Take the daily token cap off.";
    const [off] = await submit(t3, [say("chat.budget.set", { maxTokensPerDay: null }, t3)]);
    assert.equal(off!.status, "proposed");
    assert.match(JSON.stringify(off), /maxTokensPerDay=null/);
    assert.equal(await cap(), 2_000_000, "still set until the owner agrees");
    const [offDone] = await submit("Yes, remove it.", [{ kind: "apply_proposal", proposalId: off!.proposalId, evidence: "remove it", basis: "owner" }]);
    assert.equal(offDone!.status, "applied", JSON.stringify(offDone));
    assert.equal(await cap(), undefined);
    const [none] = await submit("is there a daily token cap now?", [ask({ kind: "chat_budget" }, "is there a daily token cap now?")]);
    assert.match(none!.lines!.map((l) => l.text).join("\n"), /There is no daily cap on the tokens/);

    // A number that is not in the owner's words never becomes a cap: an out-of-range value is refused when applied.
    const t4 = "Cap yourself at a very large number of tokens a day.";
    const [huge] = await submit(t4, [say("chat.budget.set", { maxTokensPerDay: 5_000_000_000 }, t4)]);
    assert.equal(huge!.status, "proposed");
    const [refused] = await submit("Yes.", [{ kind: "apply_proposal", proposalId: huge!.proposalId, evidence: "yes", basis: "owner" }]);
    assert.notEqual(refused!.status, "applied", JSON.stringify(refused));
    assert.equal(await cap(), undefined, "an out-of-range cap was not set");
  });

  suite("an agent cannot read the cap by chat status or set it: the status view is the owner's alone", async (w, _script, _spend, status) => {
    const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
    assert.equal(await status.ask(ann.principal, { kind: "chat_budget" }), undefined);
    const bare = StatusService.withEpoch(w.world.storage, w.projects.epoch, {} as never, options);
    assert.equal(await bare.ask(w.owner, { kind: "chat_budget" }), undefined, "not offered where the budget is not running");
    assert.ok(await status.ask(w.owner, { kind: "chat_budget" }));
  });
}
