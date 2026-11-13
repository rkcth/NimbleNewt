import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CommandRunner } from "../domain/runner.js";
import { options as clockOptions, cid, openWorld, type World } from "../chat/testing/harness.js";
import { ACTIONS, allows } from "./access.js";
import { TaskCredentialService } from "./task-credentials.js";
import type { Principal } from "./principals.js";
import { effectiveOf, archivedAmong, FENCE_PAGE_FROM, readOnlyGrant } from "./grants.js";

// Card P06 review: the archived-project fence reads the projects a principal holds non-read grants for in pages when there are many, and the answer is the same as reading each one.
after(stopServer);

const setState = async (w: World, projectId: string, state: "active" | "archived") => {
  const cur = (await w.world.storage.getAggregate({ kind: "project", id: projectId }))!;
  await w.projects.updateProject({ commandId: cid("st"), actor: "owner:rob", projectId, expectedRevision: cur.revision, state } as never);
};

/** A runner that counts its reads. */
function counting(w: World) {
  const real = new CommandRunner(w.world.storage, w.projects.epoch, clockOptions);
  const n = { get: 0, list: 0 };
  const projectReads = { n: 0 };
  const runner = { now: () => real.now(), get: (k: string, id: string) => { n.get++; if (k === "project") projectReads.n++; return real.get(k, id); }, list: (k: string, p: { afterId?: string; limit: number }) => { n.list++; if (k === "project") projectReads.n++; return real.list(k, p); } } as unknown as CommandRunner;
  return { runner, n, real, projectReads };
}

/** The plain answer: each project read on its own. */
const oneByOne = async (runner: CommandRunner, ids: readonly string[]) => {
  const out = new Set<string>();
  for (const id of ids) if (((await runner.get("project", id))?.body as { state?: string } | undefined)?.state === "archived") out.add(id);
  return out;
};
const sorted = (s: Set<string>) => [...s].sort();

test("P06 fence: only the controller's own .read actions count as read-only; tools, wildcards, unknown and new actions count as more than a read", () => {
  for (const a of ["task.read", "desk.read", "desk.scratch.read", "history.sensitive.read", "project.read", "job.read"]) assert.equal(readOnlyGrant(a), true, a);
  for (const a of ["tool.files.read", "tool.a-x.read", "task.*", "*", "task.update", "conversation.receive", "invented.read", "future-thing.read", "task.read.extra", "Task.read", ""]) assert.equal(readOnlyGrant(a), false, a);
  assert.equal(ACTIONS.filter((a) => readOnlyGrant(a)).every((a) => a.endsWith(".read")), true);
});

for (const backend of backends) {
  test(`${backend.name}: P06 fence: paged, capped and one-by-one reads give the same archived set as reading each project, right after an archive and a restore, and a missing project is not archived`, async () => {
    const w = await openWorld(backend);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push(await w.project(`F${i}`));
      for (const i of [1, 4, 6]) await setState(w, ids[i]!, "archived");
      const wanted = [...ids, "project-that-does-not-exist"];
      const { runner, n, real } = counting(w);
      const expect = sorted(await oneByOne(real, wanted));
      assert.deepEqual(expect, sorted(new Set([ids[1]!, ids[4]!, ids[6]!])));

      // The page cap is reached before the end of the list (3 pages of 2 for 8 wanted): the projects not seen are read one by one.
      assert.deepEqual(sorted(await archivedAmong(runner, wanted, { page: 2, from: 3 })), expect);
      assert.equal(n.list, 3, "no more pages than the cap");
      assert.equal(n.get, 2, "the two projects not seen (one of them missing) are read one by one");

      // The whole list fits in one page: no single reads, and the missing project is known not to exist.
      n.get = 0; n.list = 0;
      assert.deepEqual(sorted(await archivedAmong(runner, wanted, { page: 100, from: 3 })), expect);
      assert.deepEqual(n, { get: 0, list: 1 });

      // Below the threshold each project is read on its own.
      n.get = 0; n.list = 0;
      assert.deepEqual(sorted(await archivedAmong(runner, [ids[0]!, ids[1]!], { page: 2, from: 3 })), [ids[1]!]);
      assert.deepEqual(n, { get: 2, list: 0 });

      // Every subset and page size agrees with the plain answer, right after a restore and an archive.
      await setState(w, ids[4]!, "active");
      await setState(w, ids[2]!, "archived");
      for (const page of [1, 2, 3, 5, 8, 100]) for (const from of [1, 2, 4]) for (const take of [wanted, wanted.slice(2), [wanted[7]!, wanted[2]!], wanted.filter((_, i) => i % 2 === 1)]) {
        assert.deepEqual(sorted(await archivedAmong(real, take, { page, from })), sorted(await oneByOne(real, take)), `page ${page}, from ${from}, ${take.length} wanted`);
      }
      assert.deepEqual(sorted(await archivedAmong(real, wanted, { page: 2, from: 1 })), sorted(new Set([ids[1]!, ids[2]!, ids[6]!])));

      // A snapshot of a principal holding only read grants and grants for every project reads no project at all.
      const c = counting(w);
      const snap = await effectiveOf(c.runner, { id: "agent:r", kind: "agent", name: "r", grants: [...ids.map((p) => ({ action: "task.read", project: p })), { action: "task.update", project: "*" }] } as Principal, real.now());
      assert.equal(c.projectReads.n, 0, "no project is read");
      assert.equal(allows(snap, "task.read", ids[1]!), true);
    } finally { await w.close(); }
  });

  test(`${backend.name}: P06 fence with the default page sizes: an agent holding task.update for ${FENCE_PAGE_FROM + 5} projects loses it in the one archived project at once and has it again right after the restore; the others and its reads are untouched`, async () => {
    const w = await openWorld(backend);
    try {
      const ids: string[] = [];
      for (let i = 0; i < FENCE_PAGE_FROM + 5; i++) ids.push(await w.project(`G${i}`));
      const many = ids;
      const target = many[many.length - 1]!;
      // A tool whose name ends in `.read` can still do anything: it is fenced like any other execution grant.
      const grants = [...ids.flatMap((p) => [{ action: "task.update", project: p }, { action: "task.read", project: p }]), { action: "tool.files.read", project: target }];
      const a = await w.agent("many", grants);
      const snap = () => w.principals.authenticate(a.token);
      assert.equal(allows(await snap(), "task.update", target), true);
      assert.equal(allows(await snap(), "tool.files.read", target), true);
      await setState(w, target, "archived");
      const s = await snap();
      assert.equal(allows(s, "task.update", target), false, "refused right after the archive");
      assert.equal(allows(s, "tool.files.read", target), false, "a tool named like a read is fenced too");
      assert.equal(allows(s, "task.read", target), true, "reading stays");
      assert.equal(many.filter((p) => p !== target).every((p) => allows(s, "task.update", p)), true, "the other projects keep the grant");
      await setState(w, target, "active");
      assert.equal(allows(await snap(), "task.update", target), true, "back right after the restore");
      assert.equal(allows(await snap(), "tool.files.read", target), true);
    } finally { await w.close(); }
  });

  test(`${backend.name}: P06 fence on a task credential: an agent's grant for every project, narrowed to its task's project, stops writing once that project is archived and works again after the restore; reads stay, and another project is untouched`, async () => {
    const w = await openWorld(backend);
    try {
      const p = await w.project("Orchard"), q = await w.project("Barn");
      const t = await w.task(p, "Prune"), u = await w.task(q, "Paint");
      await w.agent("wide", [{ action: "task.update", project: "*" }, { action: "task.read", project: "*" }]);
      const creds = TaskCredentialService.withEpoch(w.world.storage, w.projects.epoch, clockOptions);
      const tp = (await creds.issue(w.owner, { commandId: cid("tc"), taskId: t, agentId: "agent:wide" })).token;
      const tq = (await creds.issue(w.owner, { commandId: cid("tc"), taskId: u, agentId: "agent:wide" })).token;
      assert.equal(allows(await creds.authenticate(tp), "task.update", p), true);
      await setState(w, p, "archived");
      const s = await creds.authenticate(tp);
      assert.equal(allows(s, "task.update", p), false, "the narrowed grant is fenced");
      assert.equal(allows(s, "task.read", p), true, "reading stays");
      assert.equal(allows(await creds.authenticate(tq), "task.update", q), true, "a credential for another project is untouched");
      assert.equal(allows(await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:wide")).token), "task.update", q), true, "the agent's own grant for every project is untouched");
      await setState(w, p, "active");
      assert.equal(allows(await creds.authenticate(tp), "task.update", p), true, "back after the restore");
    } finally { await w.close(); }
  });
}
