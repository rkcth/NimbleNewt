// Card D01 (release by words): the owner says "commit the approved parser fix" and the CHAT, not the model, finds the task's approved code that is not committed yet. The stand-in model below never hands a
// submission ID (the real model sees no earlier answer), so every ID in a proposal comes from the chat's own lookup over the real submission service on every backend.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { SubmissionService } from "../submissions/index.js";
import type { Principal } from "../security/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { approvedCodeLookup, APPROVED_CODE_ASKED } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const T = (c: string): string => c.repeat(40);
let now = Date.parse("2026-11-22T10:00:00.000Z");
const clock = (): string => new Date(now += 60_000).toISOString();

for (const backend of backends) {
  const scene = (name: string, body: (c: {
    w: Awaited<ReturnType<typeof openWorld>>; task: string; svc: SubmissionService; asked: { operation: string; taskId: string; reason: string; submissionId?: string }[];
    chat: ReturnType<Awaited<ReturnType<typeof openWorld>>["chat"]>; reply: (intents: unknown[]) => void;
    say: (text: string, args?: Record<string, unknown>) => Promise<{ turnId?: string; outcomes: { status: string; preview?: unknown; message?: unknown; proposalId?: string; question?: unknown; options?: unknown }[] }>;
    author: Principal; reviewer: Principal; commits: Set<string>; failing: { on: boolean }; lookups: string[];
    code(tree: string): Promise<string>; approve(id: string): Promise<void>;
  }) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const asked: { operation: string; taskId: string; reason: string; submissionId?: string }[] = [];
    const stub = { request: async (_by: unknown, c: { operation: string; taskId: string; reason: string; submissionId?: string }) => { asked.push({ operation: c.operation, taskId: c.taskId, reason: c.reason, ...(c.submissionId === undefined ? {} : { submissionId: c.submissionId }) }); return { requestId: "wsr-x", state: "done", operation: c.operation } as never; } };
    const w = await openWorld(backend, {}, undefined, { workspaceOps: stub as never });
    try {
      const roles = new Map<string, string[]>();
      const svc = SubmissionService.withEpoch(w.world.storage, w.projects.epoch, async (id) => roles.get(id) ?? [], { ...options, clock });
      const author = (await w.agent("ann", [{ action: "*", project: "*" }])).principal;
      const reviewer = (await w.agent("rev", [{ action: "*", project: "*" }])).principal;
      roles.set(author.id, ["author"]); roles.set(reviewer.id, ["reviewer"]);
      const p = await w.project("Parser work");
      const task = await w.task(p, "parser fix");
      const commits = new Set<string>();
      const failing = { on: false };
      const lookups: string[] = [];
      const lookup = approvedCodeLookup({ submissions: svc, commit: async (id) => { lookups.push(id); if (failing.on) throw new Error("storage went away"); return commits.has(id) ? { commitId: "ab".repeat(20) } : undefined; } });
      let reply: unknown[] = [];
      // The REAL interpreter path: the model call answers with intents (never with a submission ID unless a test says so), and the interpreter's own checks run on them.
      const model = new ModelInterpreter({ complete: async () => JSON.stringify(reply) }, () => ["a/primary"]);
      const chat = w.chat({ interpreter: model, approvedCode: async (by, t) => lookup(by, t) });
      const say = async (text: string, args: Record<string, unknown> = {}) => {
        reply = [{ kind: "command", op: "workspace.request", args: { operation: "release", taskTitle: "parser fix", reason: text, ...args }, evidence: text, basis: "owner" }];
        return await chat.submit(w.ownerToken, { messageId: cid("m"), text }) as never;
      };
      const code = async (tree: string): Promise<string> => (await svc.record(author, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: T("c"), tree, patchId: T("d") })).id;
      const approve = async (id: string): Promise<void> => { await svc.record(reviewer, { commandId: cid("r"), taskId: task, kind: "review", role: "reviewer", subject: id, verdict: "approve" }); };
      await body({ chat, reply: (i) => { reply = i; }, w, task, svc, asked, say, author, reviewer, commits, failing, lookups, code, approve });
    } finally { await w.close(); }
  });

  scene("one approved uncommitted submission: the proposal shows its ID and the task title, filled by the chat, and it is carried out once on yes", async (c) => {
    const first = await c.code(T("a"));
    await c.approve(first);
    const r = await c.say("commit the approved parser fix");
    assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes[0]));
    assert.match(String(r.outcomes[0]!.preview), new RegExp(`submissionId=${first}`), JSON.stringify(r.outcomes[0]!.preview));
    assert.match(JSON.stringify(r.outcomes[0]), /parser fix/);
    assert.deepEqual(c.asked, [], "nothing is asked of the host until the owner confirms");
    const applied = await c.w.chat({}).applyProposal(c.w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(c.asked, [{ operation: "release", taskId: c.task, reason: "commit the approved parser fix", submissionId: first }]);
    assert.equal((await c.w.chat({}).applyProposal(c.w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).replayed, true);
    assert.equal(c.asked.length, 1, "carried out once");
    // The lookup only read: no submission or commit was made by it.
    assert.equal((await c.svc.list(c.w.owner, c.task, { limit: 100 })).items.length, 2);
  });

  scene("no approved uncommitted code (nothing approved, not approved, already committed, own-author approval, other task): a plain refusal and no proposal", async (c) => {
    const refuse = async (text: string, args?: Record<string, unknown>): Promise<string> => {
      const r = await c.say(text, args);
      assert.equal(r.outcomes[0]!.status, "refused", JSON.stringify(r.outcomes[0]));
      assert.equal(r.outcomes[0]!.proposalId, undefined);
      return String(r.outcomes[0]!.message);
    };
    assert.match(await refuse("commit the approved parser fix"), /no approved code of "parser fix" waiting to be committed/i);
    const unapproved = await c.code(T("a"));
    assert.match(await refuse("commit the approved parser fix now"), /no approved code/i);
    await c.approve(unapproved);
    c.commits.add(unapproved);
    assert.match(await refuse("commit the approved parser fix again"), /already committed/);
    assert.equal(c.asked.length, 0);
    // A made-up ID the model supplies, or the committed one, is not approved code waiting for a commit.
    assert.match(await refuse("commit sbm-aaaaaaaaaaaaaaaaaaaa of the parser fix", { submissionId: "sbm-aaaaaaaaaaaaaaaaaaaa" }), /not approved code of "parser fix" that is waiting/);
    assert.match(await refuse("commit that parser fix one please", { submissionId: unapproved }), /waiting to be committed/);
    assert.equal(c.asked.length, 0);
  });

  scene("two approved uncommitted submissions: the owner is asked which, with IDs and submit times; the choice is carried out once; an ID the owner names is verified", async (c) => {
    const a = await c.code(T("a")); await c.approve(a);
    const b = await c.code(T("b")); await c.approve(b);
    const r = await c.say("commit the approved parser fix");
    assert.equal(r.outcomes[0]!.status, "asked", JSON.stringify(r.outcomes[0]));
    const text = JSON.stringify(r.outcomes[0]);
    assert.ok(text.includes(a) && text.includes(b), text);
    assert.match(text, /submitted 2026-11-22T/);
    assert.ok(text.indexOf(b) < text.indexOf(a), "newest first");
    assert.deepEqual(c.asked, []);
    // The owner picks one from the question: the chat looks the choice up again, shows it, and carries it out once on yes.
    const pick = "the older one please";
    c.reply([{ kind: "answer", turnId: (r as { turnId?: string }).turnId, choice: a, evidence: pick, basis: "owner" }]);
    const picked = await c.chat.submit(c.w.ownerToken, { messageId: cid("m"), text: pick }) as unknown as { outcomes: { status: string; preview?: unknown; proposalId?: string }[] };
    assert.equal(picked.outcomes[0]!.status, "proposed", JSON.stringify(picked.outcomes[0]));
    assert.match(String(picked.outcomes[0]!.preview), new RegExp(`submissionId=${a}`));
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("a"), proposalId: picked.outcomes[0]!.proposalId! })).applied, true);
    assert.deepEqual(c.asked.map((x: { submissionId?: string }) => x.submissionId), [a]);
    c.asked.length = 0;
    // The owner who names one of them gets a proposal at once, with no question.
    const named = await c.say(`commit submission ${a} of the parser fix`, { submissionId: a });
    assert.equal(named.outcomes[0]!.status, "proposed", JSON.stringify(named.outcomes[0]));
    assert.match(String(named.outcomes[0]!.preview), new RegExp(`submissionId=${a}`));
    assert.equal(c.asked.length, 0);
  });

  scene("more waiting submissions than are listed: only five are offered; a lookup that fails proposes nothing (fails closed)", async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < APPROVED_CODE_ASKED + 2; i++) { const id = await c.code(i.toString(16).repeat(40)); await c.approve(id); ids.push(id); }
    const r = await c.say("commit the approved parser fix");
    assert.equal(r.outcomes[0]!.status, "asked", JSON.stringify(r.outcomes[0]));
    const text = JSON.stringify(r.outcomes[0]);
    assert.equal(ids.filter((id) => text.includes(id)).length, APPROVED_CODE_ASKED, text);
    assert.match(text, new RegExp(`${APPROVED_CODE_ASKED + 2} approved submissions`));
    c.failing.on = true;
    const down = await c.say("commit the approved parser fix please");
    assert.equal(down.outcomes[0]!.status, "refused", JSON.stringify(down.outcomes[0]));
    assert.match(String(down.outcomes[0]!.message), /could not be checked/);
    assert.equal(down.outcomes[0]!.proposalId, undefined);
    assert.deepEqual(c.asked, []);
  });

  scene("a stranger or an agent cannot trigger it, and a release with no task is never proposed", async (c) => {
    const id = await c.code(T("a")); await c.approve(id);
    const agent = await c.w.agent("sneaky", [{ action: "*", project: "*" }]);
    const chat = c.w.chat({ interpreter: new ModelInterpreter({ complete: async () => "[]" }, () => ["a/primary"]), approvedCode: async () => { throw new Error("must not be looked up"); } });
    await assert.rejects(chat.submit(agent.token, { messageId: cid("n"), text: "commit the approved parser fix" }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    assert.deepEqual(c.asked, []);
  });

  scene("the lookup itself: a reviewer's approval counts; unapproved code, a committed one and another task's code do not; it reads and records nothing", async (c) => {
    const a = await c.code(T("a"));
    await c.approve(a);
    const b = await c.code(T("b"));
    c.commits.add(b); await c.approve(b);
    const lookup = approvedCodeLookup({ submissions: c.svc, commit: async (id) => (c.commits.has(id) ? { commitId: "x" } : undefined) });
    const found = await lookup(c.w.owner, c.task);
    assert.deepEqual(found.items.map((i) => i.id), [a]);
    assert.equal(found.truncated, false);
    const other = await c.w.task((await c.w.project("Other")), "Other task");
    assert.deepEqual((await lookup(c.w.owner, other)).items, []);
  });
}

test("with no lookup wired, a release naming no submission is refused and one naming a submission passes to the service's own checks", async () => {
  const backend = backends[0]!;
  const asked: unknown[] = [];
  const w = await openWorld(backend, {}, undefined, { workspaceOps: { request: async (_b: unknown, c: unknown) => { asked.push(c); return { requestId: "wsr-x", state: "done" } as never; } } as never });
  try {
    const p = await w.project("Parser work");
    const task = await w.task(p, "parser fix");
    let reply: unknown[] = [];
    const chat = w.chat({ interpreter: new ModelInterpreter({ complete: async () => JSON.stringify(reply) }, () => ["a/primary"]) });
    const say = async (text: string, args: Record<string, unknown>) => {
      reply = [{ kind: "command", op: "workspace.request", args: { operation: "release", taskId: task, reason: text, ...args }, evidence: text, basis: "owner" }];
      return await chat.submit(w.ownerToken, { messageId: cid("m"), text });
    };
    const none = await say("commit the approved parser fix", {});
    assert.equal(none.outcomes[0]!.status, "refused", JSON.stringify(none.outcomes[0]));
    assert.match(String(none.outcomes[0]!.message), /cannot be looked up here/);
    const named = await say("commit sbm-abcdefghijklmnopqrst of the parser fix", { submissionId: "sbm-abcdefghijklmnopqrst" });
    assert.equal(named.outcomes[0]!.status, "proposed", JSON.stringify(named.outcomes[0]));
    assert.deepEqual(asked, []);
  } finally { await w.close(); }
});
