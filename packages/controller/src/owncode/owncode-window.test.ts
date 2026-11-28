import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBackup, restoreBackup } from "../backup/index.js";
import { AssignmentService, type Owner } from "../domain/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectResourceService } from "../projects/index.js";
import { RETENTION_DEFAULTS, RetentionService, type RetentionValues } from "../retention/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { Aggregate, ControllerStorage, JsonObject } from "../storage/types.js";
import { OWNCODE_LIMITS, OwnCodeService } from "./index.js";

// Card B06, retention slice (K06's recorded gap "own-code requests: 500 with no window"). The installation lists at most 500 requests to work on NimbleNewt's own code. Before this slice, after 500 requests in
// all (ended ones included) nobody could ask again. Now a new request that would make the list longer first moves the oldest ENDED requests out of it in the same write (archived: kept unchanged, readable by
// its ID, its task link kept, the start gate unaffected), as cards B04 and B05 do for adoptions and experiments. Ended is rejected, withdrawn, or approved with its task done or cancelled; waiting, approved
// with its task open or not yet made, and anything that does not read as a request status stay (fail closed). Only when all 500 are open is a request refused. The retention status still counts every
// request, the owner's export still carries the approved ones, and a backup (scoped too) restores them all. Real storage on each backend; a fresh service at each step; the clock is the test's.

after(stopServer);

const now = Date.parse("2026-11-28T15:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const ASK = { what: "list blocked tasks first in the stand-up brief", why: "owners miss them", effort: "two hours", cost: "a few cents" };
const off: RetentionValues = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };
/** `count` distinct well-formed request IDs that no record has. */
const fakeIds = (count: number, lead = "q"): string[] => Array.from({ length: count }, (_, i) => `ocr-${lead}${"a".repeat(13)}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + Math.floor(i / 676))}aaa`.slice(0, 24));
const LISTED = OWNCODE_LIMITS.listed;

interface Ctx {
  owner: Principal; dev: Principal; dev2: Principal; devProject: string; storage: ControllerStorage; epoch: number; projects: ProjectService; scratch: string;
  /** A fresh service; `counted` also counts the storage reads by kind. */
  svc(counted?: Map<string, number>): OwnCodeService;
  ask(by?: Principal): Promise<string>;
  rev(id: string): Promise<number>;
  approve(id: string): Promise<string>;
  reject(id: string): Promise<void>;
  withdraw(id: string, by?: Principal): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  start(taskId: string): Promise<string>;
  index(): Promise<{ ids: string[]; pending: Record<string, string[]>; archived?: number } & { revision: number }>;
  /** Writes the index (and any records) as the test says, in one storage operation. */
  plant(ids: unknown, records?: readonly { id: string; body: Record<string, unknown> }[], extra?: Record<string, unknown>): Promise<void>;
  retention(): RetentionService;
}

const counting = (storage: ControllerStorage, counts: Map<string, number>): ControllerStorage => new Proxy(storage, {
  get(target, prop, receiver) {
    if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => { counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1); return target.getAggregate(ref); };
    const v = Reflect.get(target, prop, receiver) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-b06r-")));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (nm: string): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [] });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const devProject = (await projects.createProject({ commandId: cid("pd"), actor: owner.id, name: "NimbleNewt development" })).id;
        const install = join(scratch, "install");
        const checkout = join(scratch, "checkout");
        mkdirSync(install); mkdirSync(checkout);
        const resources = ProjectResourceService.withEpoch(world.storage, epoch, options);
        await resources.bindResource(owner, { commandId: cid("bind"), projectId: devProject, kind: "repository", label: "NimbleNewt source", locator: checkout, access: "write" } as never);
        const svc = (counted?: Map<string, number>) => OwnCodeService.withEpoch(counted === undefined ? world.storage : counting(world.storage, counted), epoch, { ...options, projects, checkout: { places: (p, l) => resources.localPlaces(p, l), guarded: [{ what: "the running installation's program files", path: install }] } });
        const assign = AssignmentService.withEpoch(world.storage, epoch, projects, { ...options, attemptGate: (taskId) => svc().checkAttempt(taskId) });
        const dev = await enroll("dev");
        const op = (changes: unknown[]) => world.storage.applyOperation({ operationId: cid("op"), epoch, actor: "test", correlationId: "plant", at: new Date(now).toISOString(), changes, audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
        const ctx: Ctx = {
          owner, dev, dev2: await enroll("dev2"), devProject, storage: world.storage, epoch, projects, scratch, svc,
          ask: async (by = dev) => (await svc().request(by, { commandId: cid("rq"), ...ASK } as never)).id,
          rev: async (id) => (await svc().get(owner, id))!.revision,
          approve: async (id) => (await svc().decide(owner, { commandId: cid("ok"), requestId: id, expectedRevision: await ctx.rev(id), decision: "approve" })).taskId!,
          reject: async (id) => { await svc().decide(owner, { commandId: cid("no"), requestId: id, expectedRevision: await ctx.rev(id), decision: "reject" }); },
          withdraw: async (id, by = owner) => { await svc().withdraw(by, { commandId: cid("wd"), requestId: id, expectedRevision: await ctx.rev(id), reason: "not now" }); },
          cancelTask: async (taskId) => { const t = (await projects.getTask(taskId))!; await projects.transitionTask({ commandId: cid("cx"), actor: owner.id, taskId, expectedRevision: t.revision, to: "cancelled" }); },
          start: async (taskId) => {
            const task = await projects.getTask(taskId);
            if (task!.state === "proposed") await projects.transitionTask({ commandId: cid("ready"), actor: owner.id, taskId, expectedRevision: task!.revision, to: "ready" });
            let a = await assign.getAssignment(taskId);
            const who: Owner = { kind: "agent", id: "dev" };
            if (a === undefined || a.state !== "assigned") { await assign.assignTask({ commandId: cid("as"), actor: owner.id, taskId, owner: who, ...(a === undefined ? {} : { expectedRevision: a.revision }) }); a = await assign.getAssignment(taskId); }
            return (await assign.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId, expectedRevision: a!.revision, generation: a!.generation, owner: who })).id;
          },
          index: async () => { const f = (await world.storage.getAggregate({ kind: "owncode-index", id: "installation" }))!; return { ...(f.body as never as { ids: string[]; pending: Record<string, string[]>; archived?: number }), revision: f.revision }; },
          plant: async (ids, records = [], extra = {}) => {
            const f = await world.storage.getAggregate({ kind: "owncode-index", id: "installation" });
            const pending = (f?.body as { pending?: unknown } | undefined)?.pending ?? {};
            // Storage takes at most 100 changes in one operation: the records go in batches, the index last.
            for (let i = 0; i < records.length; i += 90) await op(records.slice(i, i + 90).map((r) => ({ type: "create", ref: { kind: "owncode-request", id: r.id }, body: r.body })));
            const body = { ids, pending, ...extra } as unknown as JsonObject;
            await op([f === undefined ? { type: "create", ref: { kind: "owncode-index", id: "installation" }, body } : { type: "update", ref: { kind: "owncode-index", id: "installation" }, expectedRevision: f.revision, body }]);
          },
          retention: () => RetentionService.withEpoch(world.storage, epoch, { settings: { effective: async () => off }, now: () => now }, options),
        };
        await svc().enable(owner, { commandId: cid("en"), projectId: devProject });
        await body(ctx);
      } finally { await world.close(); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });

  suite("a full list moves its oldest ENDED request out in the same write as the new one; open ones (waiting, approved with work open, unreadable) never leave; the start gate is unaffected", async (c) => {
    const rejected = await c.ask(); await c.reject(rejected);
    const waiting = await c.ask();
    const open = await c.ask(); const openTask = await c.approve(open);
    const cancelled = await c.ask(); const cancelledTask = await c.approve(cancelled); await c.cancelTask(cancelledTask);
    const unapproved = await c.ask(); const withdrawnTask = await c.approve(unapproved); await c.withdraw(unapproved);
    const taken = await c.ask(); await c.withdraw(taken, c.dev);
    // Damaged records stay (fail closed): a status that is none of the four, an approval naming no task, an approval whose task does not exist (an approval whose task was never made is still the owner's to finish).
    const odd = "ocr-zzzzzzzzzzzzzzzzzzzz"; const noTask = "ocr-zzzzzzzzzzzzzzzzzzzy"; const lostTask = "ocr-zzzzzzzzzzzzzzzzzzzx";
    const real = [open, waiting, odd, noTask, lostTask, rejected, cancelled, unapproved, taken];
    const fill = fakeIds(LISTED - real.length);
    // Order: the open ones first, then the ended ones, then entries that name no record (they hold nothing and are ended too).
    await c.plant(real.concat(fill), [
      { id: odd, body: { requestedBy: c.dev.id, status: "odd", request: ASK, history: [] } },
      { id: noTask, body: { requestedBy: c.dev.id, status: "approved", request: ASK, history: [] } },
      { id: lostTask, body: { requestedBy: c.dev.id, status: "approved", taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.devProject, request: ASK, history: [] } },
    ]);
    const before = await c.storage.getAggregate({ kind: "owncode-request", id: rejected });
    assert.equal((await c.index()).ids.length, LISTED);

    const order = [rejected, cancelled, unapproved, taken];
    const added: string[] = [];
    for (const [i, out] of order.entries()) {
      const id = await c.ask(c.dev2);
      added.push(id);
      const idx = await c.index();
      assert.equal(idx.ids.length, LISTED, "the list stays at its cap");
      assert.equal(idx.ids.at(-1), id, "the new request is listed last");
      assert.ok(!idx.ids.includes(out), `${out} left the list`);
      for (const later of order.slice(i + 1)) assert.ok(idx.ids.includes(later), "only the oldest ended request leaves");
      for (const keep of [open, waiting, odd, noTask, lostTask]) assert.ok(idx.ids.includes(keep), "an open or unreadable request never leaves");
      assert.equal(idx.archived, i + 1);
      // dev2's request waits: it is in its asker's pending list in the same write.
      assert.ok(idx.pending[c.dev2.id]!.includes(id));
      await c.withdraw(id, c.dev2);
    }
    // Moved out, a request is kept unchanged and stays readable by its ID with the same rights.
    assert.deepEqual(await c.storage.getAggregate({ kind: "owncode-request", id: rejected }), before);
    assert.equal((await c.svc().get(c.owner, rejected))!.status, "rejected");
    assert.equal((await c.svc().get(c.dev, rejected))!.status, "rejected");
    assert.equal(await c.svc().get(c.dev2, rejected), undefined);
    // The owner's list says how many left it; an agent's list does not.
    const owners = await c.svc().list(c.owner, { limit: 100 });
    assert.equal(owners.archived, 4);
    assert.deepEqual(owners.items.slice(0, 2).map((i) => i.id), [open, waiting]);
    assert.equal((await c.svc().list(c.dev, { limit: 100 })).archived, undefined);
    await refuses("invalid_command", () => c.svc().list(c.owner, { afterId: rejected }), /not in the list/);
    // The start gate reads the link and the request, never the list: the withdrawn approval's task is still refused, the open approval's task still starts.
    await refuses("invalid_command", () => c.start(withdrawnTask), /owner withdrew the approval/);
    assert.ok(await c.start(openTask));
    // The next ones are entries that name no record (no records stand behind them).
    const next = await c.ask(c.dev2);
    assert.ok(!(await c.index()).ids.includes(fill[0]!));
    assert.equal((await c.index()).archived, 5);
    await c.withdraw(next, c.dev2);
    // A decision and a withdrawal keep the count (they write the index too).
    const w = await c.ask(c.dev2);
    await c.reject(w);
    assert.equal((await c.index()).archived, 6);
    assert.equal(added.length, 4);
  });

  suite("when every listed request is open a new one is refused with nothing written; one ended (by withdrawal or its task finished) makes room for exactly one", async (c) => {
    const open = await c.ask(); const task = await c.approve(open);
    // 499 more approvals whose work is open (they share the open task, as only the stored shape is read).
    const ids = fakeIds(LISTED - 1, "p");
    await c.plant([open, ...ids], ids.map((id) => ({ id, body: { requestedBy: c.dev.id, status: "approved", projectId: c.devProject, taskId: task, request: ASK, history: [] } })));
    const before = await c.index();
    const counts = new Map<string, number>();
    await refuses("unavailable", () => c.svc(counts).request(c.dev2, { commandId: "full-1", ...ASK } as never), /500 requests to work on NimbleNewt's own code are listed and all are waiting or approved/);
    assert.deepEqual(await c.index(), before, "nothing is written");
    assert.equal((await c.svc().list(c.dev2)).items.length, 0);
    // Bounded: one read of each listed request and of each one's task, no more (the command machinery reads a few records of its own).
    assert.ok((counts.get("owncode-request") ?? 0) <= LISTED + 2, `request reads ${counts.get("owncode-request")}`);
    assert.ok((counts.get("task") ?? 0) <= LISTED + 1, `task reads ${counts.get("task")}`);
    // The owner withdraws the approval in the middle: that one leaves for the next request, the others stay.
    const mid = ids[200]!;
    await c.withdraw(mid);
    const added = await c.ask(c.dev2);
    let idx = await c.index();
    assert.ok(!idx.ids.includes(mid) && idx.ids.includes(ids[199]!) && idx.ids.includes(ids[201]!) && idx.ids.at(-1) === added);
    assert.equal(idx.archived, 1);
    await c.withdraw(added, c.dev2);
    // The real approval's task is cancelled: its request is ended and leaves next (it is the oldest), the shared-task approvals are judged by the same task and leave after it only as needed.
    await c.cancelTask(task);
    const counted = new Map<string, number>();
    const third = (await c.svc(counted).request(c.dev2, { commandId: cid("rq"), ...ASK } as never)).id;
    idx = await c.index();
    assert.ok(!idx.ids.includes(open) && idx.ids.includes(ids[0]!) && idx.ids.at(-1) === third);
    assert.equal(idx.archived, 2);
    assert.ok((counted.get("owncode-request") ?? 0) <= 4, `only the oldest is looked at once it is ended (${counted.get("owncode-request")} reads)`);
    // A list that is not full reads no listed request at all.
    const small = new Map<string, number>();
    await c.plant([third]);
    await c.svc(small).request(c.dev, { commandId: cid("rq"), ...ASK } as never);
    assert.ok((small.get("owncode-request") ?? 0) <= 2, `a list with room is not looked at (${small.get("owncode-request")} reads)`);
  });

  suite("hostile index shapes: a list that is not a list of strings is refused with nothing written, entries that are not request IDs hold nothing, a damaged archived count reads as 0", async (c) => {
    for (const bad of ["not a list", { 0: "ocr-x" }, [1, 2, 3], [null], [["ocr-aaaaaaaaaaaaaaaaaaaa"]]]) {
      await c.plant(bad);
      const before = await c.index();
      await refuses("integrity", () => c.ask(), /cannot be read, so no request is added/);
      assert.deepEqual(await c.index(), before);
    }
    // Entries that are no request ID name no record: in a full list they are ended and leave first, oldest first; a damaged count is read as 0 and replaced.
    const junk = ["../../etc/passwd", "__proto__", "constructor", "", "ocr-AAAAAAAAAAAAAAAAAAAA"];
    await c.plant([]);
    const keep = await c.ask(); await c.approve(keep);
    for (const archived of [-3, "7", 1.5, { n: 9 }, true, null]) {
      await c.plant([...junk, keep, ...fakeIds(LISTED - junk.length - 1, "j")], [], { archived });
      const id = await c.ask(c.dev2);
      const idx = await c.index();
      assert.deepEqual(idx.ids.slice(0, 5), [...junk.slice(1), keep]);
      assert.equal(idx.archived, 1, `archived ${String(archived)} is read as 0`);
      await c.withdraw(id, c.dev2);
    }
    // A list over the cap (an older or damaged index) comes back under it, still never moving an open request.
    await c.plant([keep, ...fakeIds(LISTED + 3, "k")]);
    await c.ask(c.dev2);
    const idx = await c.index();
    assert.equal(idx.ids.length, LISTED);
    assert.equal(idx.ids[0], keep);
    assert.equal(idx.archived, 5, "five ended entries left: 504 listed, the new one makes 500");
  });

  suite("first review: two requests at the cap at once each move out a different ended request (or the second is refused when only one was ended); none is lost or listed twice and archived counts each once", async (c) => {
    const open = await c.ask(); const task = await c.approve(open);
    const ended = fakeIds(2, "r");
    const ids = fakeIds(LISTED - 3, "s");
    const approved = (id: string) => ({ id, body: { requestedBy: c.dev.id, status: "approved", projectId: c.devProject, taskId: task, request: ASK, history: [] } });
    await c.plant([open, ...ended, ...ids], [...ended.map((id) => ({ id, body: { requestedBy: c.dev.id, status: "rejected", request: ASK, history: [] } })), ...ids.map(approved)]);
    const [a, b] = await Promise.all([c.ask(c.dev), c.ask(c.dev2)]);
    let idx = await c.index();
    assert.equal(idx.ids.length, LISTED);
    assert.equal(new Set(idx.ids).size, LISTED, "no entry is listed twice");
    assert.ok(idx.ids.includes(a) && idx.ids.includes(b) && idx.ids[0] === open);
    assert.ok(!ended.some((x) => idx.ids.includes(x)));
    assert.equal(idx.archived, 2);
    // Only one ended now: of two at once, one is added and the other is refused with nothing of its own written.
    await c.withdraw(ids[100]!);
    const results = await Promise.allSettled([c.ask(c.dev), c.ask(c.dev2)]);
    const added = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(added.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(refused[0]!.reason instanceof DomainError && refused[0]!.reason.code === "unavailable", String(refused[0]!.reason));
    idx = await c.index();
    assert.equal(idx.ids.length, LISTED);
    assert.equal(new Set(idx.ids).size, LISTED);
    assert.ok(idx.ids.at(-1) === added[0] && !idx.ids.includes(ids[100]!));
    assert.equal(idx.archived, 3);
    assert.equal(Object.values(idx.pending).flat().length, 3, "the refused request waits nowhere");
  });

  suite("first review: an approval whose task is done is ended and leaves; one withdrawn from approval leaves although its task is still open (the gate still refuses that task)", async (c) => {
    const open = await c.ask(); const task = await c.approve(open);
    const made = async (label: string): Promise<{ id: string; revision: number }> => { const t = await c.projects.createTask({ commandId: cid(label), actor: c.owner.id, projectId: c.devProject, title: label, description: label }); return { id: t.id, revision: (await c.projects.getTask(t.id))!.revision }; };
    const step = async (taskId: string, to: "ready" | "in_progress" | "done") => { await c.projects.transitionTask({ commandId: cid(to), actor: c.owner.id, taskId, expectedRevision: (await c.projects.getTask(taskId))!.revision, to }); };
    const finished = await made("finished");
    await step(finished.id, "ready"); await step(finished.id, "in_progress"); await step(finished.id, "done");
    assert.equal((await c.projects.getTask(finished.id))!.state, "done");
    const [doneReq, withdrawnReq] = fakeIds(2, "w");
    const ids = fakeIds(LISTED - 3, "x");
    const approved = (id: string, taskId: string, extra: Record<string, unknown> = {}) => ({ id, body: { requestedBy: c.dev.id, status: "approved", projectId: c.devProject, taskId, request: ASK, history: [], ...extra } });
    await c.plant([open, doneReq!, withdrawnReq!, ...ids], [approved(doneReq!, finished.id), approved(withdrawnReq!, task, { status: "withdrawn", withdrawnFrom: "approved" }), ...ids.map((id) => approved(id, task))]);
    await c.ask(c.dev2);
    let idx = await c.index();
    assert.ok(!idx.ids.includes(doneReq!) && idx.ids.includes(withdrawnReq!) && idx.ids[0] === open, "the done approval leaves first");
    await c.ask(c.dev2);
    idx = await c.index();
    assert.ok(!idx.ids.includes(withdrawnReq!) && idx.ids[0] === open && idx.ids[1] === ids[0]);
    assert.equal(idx.archived, 2);
    assert.ok((await c.svc().get(c.owner, withdrawnReq!)) !== undefined, "moved out, still readable by its ID");
  });

  suite("first review: a list longer than the window (a damaged store) reads only its last 500 places; the entries before them are not read and count as open, so nothing leaves and the request is refused", async (c) => {
    const open = await c.ask(); const task = await c.approve(open);
    const before500 = fakeIds(1500, "u");
    const ids = fakeIds(LISTED - 1, "v");
    await c.plant([...before500, open, ...ids], ids.map((id) => ({ id, body: { requestedBy: c.dev.id, status: "approved", projectId: c.devProject, taskId: task, request: ASK, history: [] } })));
    const before = await c.index();
    const counts = new Map<string, number>();
    await refuses("unavailable", () => c.svc(counts).request(c.dev2, { commandId: "over-1", ...ASK } as never), /all are waiting or approved/);
    assert.deepEqual(await c.index(), before, "nothing is written");
    assert.ok((counts.get("owncode-request") ?? 0) <= LISTED + 2, `request reads ${counts.get("owncode-request")}`);
    assert.ok((counts.get("task") ?? 0) <= LISTED + 1, `task reads ${counts.get("task")}`);
    // An ended place in the window does not help: the unread entries cannot leave, so the list cannot come under the cap (fail closed until the store is repaired); still nothing is written.
    await c.withdraw(ids[0]!);
    const after = await c.index();
    await refuses("unavailable", () => c.ask(c.dev2), /all are waiting or approved/);
    assert.deepEqual(await c.index(), after);
    assert.deepEqual(after.ids.slice(0, 1500), before500);
    // 600 listed, the 101 oldest rejected: only one of them is in the window (the 100 before it are not read), so the list cannot come under the cap and nothing leaves.
    const old = fakeIds(101, "y");
    await c.plant([...old, open, ...ids.slice(1, LISTED - 1)], old.map((id) => ({ id, body: { requestedBy: c.dev.id, status: "rejected", request: ASK, history: [] } })));
    const six = await c.index();
    assert.equal(six.ids.length, 600);
    await refuses("unavailable", () => c.ask(c.dev2), /all are waiting or approved/);
    assert.deepEqual(await c.index(), six);
  });

  suite("retention: the status counts every request (archived ones too), the owner's export still carries the approved ones moved out, and a scoped backup restores every own-code record unchanged", async (c) => {
    const kept = await c.ask(); const keptTask = await c.approve(kept);
    const gone = await c.ask(); const goneTask = await c.approve(gone); await c.withdraw(gone);
    const rejected = await c.ask(); await c.reject(rejected);
    await c.plant([gone, rejected, kept, ...fakeIds(LISTED - 3, "r")]);
    await c.ask(c.dev2);
    await c.ask(c.dev2);
    const idx = await c.index();
    assert.ok(!idx.ids.includes(gone) && !idx.ids.includes(rejected) && idx.ids.includes(kept));
    assert.equal(idx.archived, 2);
    // The status counts the records (5 requests: the two archived among them), not the list.
    const st = await c.retention().status(c.owner) as unknown as { growth: Record<string, number | string> };
    assert.equal(st.growth["owncode-request"], 5);
    assert.equal(st.growth["owncode-index"], 1);
    assert.equal(st.growth["owncode-task"], 2);
    // The export carries the approved requests of the development project, the archived withdrawn approval included; a rejected or waiting one never had a project.
    const items: { kind: string; id: string }[] = [];
    for (let afterCursor: string | undefined; ;) {
      const page = await c.retention().export(c.owner, { projectId: c.devProject, limit: 200, ...(afterCursor === undefined ? {} : { after: afterCursor }) });
      items.push(...page.items);
      if (page.next === undefined) break;
      afterCursor = page.next;
    }
    assert.deepEqual(items.filter((i) => i.kind === "owncode-request").map((i) => i.id).sort(), [gone, kept].sort());
    assert.deepEqual(items.filter((i) => i.kind === "task").map((i) => i.id).sort(), [goneTask, keptTask].sort());

    const own = async (storage: ControllerStorage): Promise<Aggregate[]> => {
      const out: Aggregate[] = [];
      for (const kind of ["owncode-request", "owncode-index", "owncode-task", "owncode-settings"]) {
        const ids = kind === "owncode-request" ? [kept, gone, rejected, ...idx.ids.slice(-2)] : kind === "owncode-task" ? [keptTask, goneTask] : ["installation"];
        for (const id of ids) { const a = await storage.getAggregate({ kind, id }); assert.ok(a !== undefined, `${kind} ${id}`); out.push(a); }
      }
      return out.map((a) => ({ ...a, body: a.body }));
    };
    const root = mkdtempSync(join(c.scratch, "bk-"));
    const made = await createBackup(c.storage, { root, kind: "manual", version: "t", now: () => new Date(now + 40 * 86_400_000), leaveOut: { scratchDays: 30, transcriptDays: null, logDays: null } });
    const target = await backend.open();
    try {
      await restoreBackup(made.path, target.storage);
      const want = await own(c.storage); const got = await own(target.storage);
      assert.deepEqual(got.map((a) => [a.kind, a.id, a.revision, a.body]), want.map((a) => [a.kind, a.id, a.revision, a.body]));
      // The restored store keeps the window and its count, and the restored gate still refuses the withdrawn approval's task.
      const restored = OwnCodeService.withEpoch(target.storage, (await target.storage.currentEpoch()) + 0, options);
      assert.equal((await restored.list(c.owner, { limit: 100 })).archived, 2);
      assert.match((await restored.checkAttempt(goneTask))!, /owner withdrew the approval/);
    } finally { await target.close(); }
  });
}
