// Card D01 (release by words): the owner says "commit the approved parser fix" and the CHAT, not the model, finds the task's approved code that is not committed yet. The stand-in model below never hands a
// submission ID (the real model sees no earlier answer), so every ID in a proposal comes from the chat's own lookup over the real submission service on every backend.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { SubmissionService } from "../submissions/index.js";
import type { Principal } from "../security/index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { approvedCodeLookup, APPROVED_CODE_PAGES } from "./index.js";
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

  scene("no approved uncommitted code (no code, newest not approved, newest already committed, made-up or unapproved ID): a plain refusal and no proposal", async (c) => {
    const refuse = async (text: string, args?: Record<string, unknown>): Promise<string> => {
      const r = await c.say(text, args);
      assert.equal(r.outcomes[0]!.status, "refused", JSON.stringify(r.outcomes[0]));
      assert.equal(r.outcomes[0]!.proposalId, undefined);
      return String(r.outcomes[0]!.message);
    };
    assert.match(await refuse("commit the approved parser fix"), /No code has been submitted on "parser fix"/);
    const unapproved = await c.code(T("a"));
    assert.match(await refuse("commit the approved parser fix now"), new RegExp(`newest code of "parser fix" \\(${unapproved}, submitted [^)]+\\) is not approved code waiting to be committed[^]*nothing was proposed\\.$`));
    await c.approve(unapproved);
    c.commits.add(unapproved);
    assert.match(await refuse("commit the approved parser fix again"), /already committed/);
    assert.equal(c.asked.length, 0);
    // A made-up ID the model supplies, or the committed one, is not approved code waiting for a commit.
    assert.match(await refuse("commit sbm-aaaaaaaaaaaaaaaaaaaa of the parser fix", { submissionId: "sbm-aaaaaaaaaaaaaaaaaaaa" }), /not approved code of "parser fix" that is waiting/);
    assert.match(await refuse("commit that parser fix one please", { submissionId: unapproved }), /waiting to be committed/);
    assert.equal(c.asked.length, 0);
  });

  scene("several approved uncommitted submissions: only the newest is filled in; an older one is proposed only when the owner names it; code that newer unapproved code followed is not filled in", async (c) => {
    const a = await c.code(T("a")); await c.approve(a);
    const b = await c.code(T("b")); await c.approve(b);
    const r = await c.say("commit the approved parser fix");
    assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes[0]));
    assert.match(String(r.outcomes[0]!.preview), new RegExp(`submissionId=${b}`));
    assert.match(JSON.stringify(r.outcomes[0]), /the task's newest code, approved and not committed yet/);
    assert.deepEqual(c.asked, []);
    // The owner who names the older one gets a proposal for it, and it is carried out once on yes.
    const named = await c.say(`commit submission ${a} of the parser fix`, { submissionId: a });
    assert.equal(named.outcomes[0]!.status, "proposed", JSON.stringify(named.outcomes[0]));
    assert.match(String(named.outcomes[0]!.preview), new RegExp(`submissionId=${a}`));
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("a"), proposalId: named.outcomes[0]!.proposalId! })).applied, true);
    assert.deepEqual(c.asked.map((x: { submissionId?: string }) => x.submissionId), [a]);
    c.asked.length = 0;
    // Newer code that is not approved yet: neither approved one is filled in, and the answer says why.
    const n = await c.code(T("e"));
    const later = await c.say("commit the approved parser fix please");
    assert.equal(later.outcomes[0]!.status, "refused", JSON.stringify(later.outcomes[0]));
    assert.equal(later.outcomes[0]!.proposalId, undefined);
    assert.match(String(later.outcomes[0]!.message), new RegExp(`newest code of "parser fix" \\(${n},`));
    assert.match(String(later.outcomes[0]!.message), /2 older approved submissions are not committed, but newer code followed them/);
    assert.deepEqual(c.asked, []);
  });

  scene("a lookup that fails proposes nothing (fails closed), and a release that names no task is never proposed", async (c) => {
    const id = await c.code(T("a")); await c.approve(id);
    c.failing.on = true;
    const down = await c.say("commit the approved parser fix please");
    assert.equal(down.outcomes[0]!.status, "refused", JSON.stringify(down.outcomes[0]));
    assert.match(String(down.outcomes[0]!.message), /could not be checked/);
    assert.equal(down.outcomes[0]!.proposalId, undefined);
    c.failing.on = false;
    c.lookups.length = 0;
    const text = "commit the approved code";
    c.reply([{ kind: "command", op: "workspace.request", args: { operation: "release", reason: text }, evidence: text, basis: "owner" }]);
    const none = await c.chat.submit(c.w.ownerToken, { messageId: cid("m"), text }) as unknown as { outcomes: { status: string; message?: unknown; proposalId?: string }[] };
    assert.equal(none.outcomes[0]!.status, "refused", JSON.stringify(none.outcomes[0]));
    assert.match(String(none.outcomes[0]!.message), /no task was named/);
    assert.equal(none.outcomes[0]!.proposalId, undefined);
    assert.deepEqual(c.lookups, [], "nothing is looked up for no task");
    assert.deepEqual(c.asked, []);
  });

  scene("an agent cannot trigger it: it is refused before any planning or lookup", async (c) => {
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
    assert.equal(found.newest?.id, b, "the newest code is named whatever its state");
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

// The lookup's rule is the release's own (workspace-ops `#approved`), over a stand-in submission service: the one-agent approval counts, an approval that names the author does not, nor one of another
// task's record; a call that stopped at its own read bound and handed a cursor is followed (not partial); only the last call's cursor at the page bound makes the answer partial.
test("the lookup counts exactly what a release accepts and reads the scan bound as the submissions view does", async () => {
  const owner = { id: "owner:o", kind: "owner", grants: [] } as unknown as Principal;
  const sid = (c: string): string => `sbm-${c.repeat(20)}`;
  const approvals: Record<string, Record<string, unknown>> = {
    [sid("a")]: { taskId: "tsk-1", approved: true, approvedBy: "review_disabled_single_agent", submittedBy: "agent:ann" },
    [sid("b")]: { taskId: "tsk-1", approved: true, approvedBy: "agent:ann", submittedBy: "agent:ann" },
    [sid("c")]: { taskId: "tsk-2", approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" },
    [sid("d")]: { taskId: "tsk-1", approved: false, submittedBy: "agent:ann" },
    [sid("e")]: { taskId: "tsk-1", approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" },
  };
  const at = (n: number): string => `2026-11-22T10:0${n}:00.000Z`;
  const rows = [sid("a"), sid("b"), sid("c"), sid("d"), sid("e")].map((id, n) => ({ id, kind: "code", submittedAt: at(n) }));
  let calls = 0;
  // Each call hands one row and a cursor while rows are left, as a call that stops at its read bound does (scanLimited with next).
  const lookup = approvedCodeLookup({
    submissions: {
      list: async (_by: unknown, _t: unknown, q: { afterId?: string }) => { calls++; const from = q.afterId === undefined ? 0 : Number(q.afterId) + 1; return { items: rows.slice(from, from + 1), ...(from + 1 < rows.length ? { next: String(from), scanLimited: true } : {}) } as never; },
      approvalOf: async (id: string) => approvals[id] as never,
    } as never,
    commit: async () => undefined,
  });
  const all = await lookup(owner, "tsk-1");
  assert.deepEqual(all.items.map((i) => i.id), [sid("e"), sid("a")], "a reviewer's and the one-agent approval count; the author's own, another task's and an unapproved one do not");
  assert.equal(all.newest?.id, sid("e"));
  assert.equal(all.truncated, false, "a call stopped at its read bound is followed, not read as partial");
  assert.equal(calls, rows.length);
});

test("the lookup stops after its page bound and says so", async () => {
  const owner = { id: "owner:o", kind: "owner", grants: [] } as unknown as Principal;
  let calls = 0;
  const lookup = approvedCodeLookup({
    submissions: { list: async () => { calls++; return { items: [], next: "cursor", scanLimited: true } as never; }, approvalOf: async () => undefined } as never,
    commit: async () => undefined,
  });
  const found = await lookup(owner, "tsk-1");
  assert.equal(found.truncated, true);
  assert.equal(found.newest, undefined);
  assert.equal(calls, APPROVED_CODE_PAGES);
});

test("a partial scan never fills in a submission: the chat asks for the ID and proposes nothing", async () => {
  const backend = backends[0]!;
  const asked: unknown[] = [];
  const w = await openWorld(backend, {}, undefined, { workspaceOps: { request: async (_b: unknown, c: unknown) => { asked.push(c); return { requestId: "wsr-x", state: "done" } as never; } } as never });
  try {
    const p = await w.project("Parser work");
    await w.task(p, "parser fix");
    const only = { id: "sbm-aaaaaaaaaaaaaaaaaaaa", submittedAt: "2026-11-22T10:00:00.000Z" };
    const text = "commit the approved parser fix";
    const chat = w.chat({ interpreter: new ModelInterpreter({ complete: async () => JSON.stringify([{ kind: "command", op: "workspace.request", args: { operation: "release", taskTitle: "parser fix", reason: text }, evidence: text, basis: "owner" }]) }, () => ["a/primary"]), approvedCode: async () => ({ items: [only], newest: only, truncated: true }) });
    const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
    assert.equal(r.outcomes[0]!.status, "refused", JSON.stringify(r.outcomes[0]));
    assert.match(String(r.outcomes[0]!.message), /Not every submission of "parser fix" could be read/);
    assert.equal((r.outcomes[0] as { proposalId?: string }).proposalId, undefined);
    assert.deepEqual(asked, []);
  } finally { await w.close(); }
});
