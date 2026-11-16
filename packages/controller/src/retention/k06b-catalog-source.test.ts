import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";
import { CATALOG_SOURCE_REASON } from "./service.js";

after(stopServer);

// Card K06b follow-up: an agent may register a personal tool or skill from its own accepted PRIVATE desk records. When the owner turns the scratch rule on, those records of a finished task must not be archived or
// removed (the tool would fail with "the recorded executable is missing or has changed"). Same approach as the backup scope tier (K01d second review); an unfinished read of the catalog removes nothing.
const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };
const manifest = {
  purpose: "fetch a page", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/fetch.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart",
};
const CODE = "console.log('tool code 6631')", README = "how to use the tool 6632";

for (const backend of backends) {
  test(`${backend.name}: scratch archive and purge leave the private records a catalogued tool reads its text from; an unfinished catalog read removes nothing; a tool registered while the run goes is held (card K06b follow-up)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 60 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(storage, epoch, options);
      const write = async (body: string): Promise<string> => (await desks.write(ann, { commandId: cid("w"), projectId: project, taskId: task, kind: "note", title: "work", body, visibility: "private", status: "accepted" } as never)).id;
      const readme = await write(README), code = await write(CODE), scratch = await write("plain scratch 6633"), late = await write("code registered later 6634"), lateDoc = await write("doc registered later 6635");
      const cat = CatalogService.withEpoch(storage, epoch, desks, options);
      const registered = await cat.register(ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code } as never);
      for (const id of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: id as never });

      let breakCatalog = false; let scanLimit: number | undefined; let hook: (() => Promise<void>) | undefined;
      const guarded = new Proxy(storage, { get: (t, k) => { const v = (t as never)[k] as unknown; if (k === "listAggregates") return (kind: string, o: never) => { if (breakCatalog && kind === "catalog-version") throw new Error("catalog read failed"); return (t as ControllerStorage).listAggregates(kind, o); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as ControllerStorage;
      const at = (days: number, v: object) => RetentionService.withEpoch(guarded, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + days * DAY, catalogScanLimit: scanLimit, beforeBatch: async () => { await hook?.(); } } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });
      const title = async (id: string): Promise<string> => ((await storage.getAggregate({ kind: "desk-record", id }))!.body as { title: string }).title;
      const content = async (k: "executable" | "instructions"): Promise<string> => cat.content(ann, registered.name, "1.0.0", k);
      assert.equal(await content("executable"), CODE);

      // Archive: ordinary scratch is archived, the two source records are not and are shown as held.
      const preview = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id).sort(), [late, lateDoc, scratch].sort());
      assert.deepEqual(preview.retained.filter((r) => r.id === readme || r.id === code).map((r) => r.reasons.join(" ")).map((t) => /catalogued tool/.test(t)), [true, true]);
      // An unfinished read of the catalog (it fails): nothing at all is a candidate and the answer says it is partial.
      breakCatalog = true;
      const blind = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(blind.candidates, []); assert.equal(blind.partial, true);
      breakCatalog = false;

      // The bounded read of the catalog reaches its limit (500 versions with a limit of 500): the same, nothing is a candidate.
      const filler = Array.from({ length: 499 }, (_, i) => ({ type: "create" as const, ref: { kind: "catalog-version", id: `cv-filler-${i}` }, body: { name: `filler${i}` } as never }));
      for (let i = 0; i < filler.length; i += 100) await storage.applyOperation({ operationId: cid("fill"), epoch, actor: "test", correlationId: "fill", at: options.clock(), changes: filler.slice(i, i + 100), audit: [{ type: "test.fill", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      scanLimit = 500;
      const bounded = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(bounded.candidates, []); assert.equal(bounded.partial, true);
      scanLimit = undefined;

      // A tool registered while the run goes (after the preview) is held when the batch is reached.
      hook = async () => { hook = undefined; await cat.register(ann, { commandId: cid("r"), name: "later", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: lateDoc, executableRecordId: late } as never); };
      const ran = await at(0, { scratchArchiveDays: 30 }).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 1);
      assert.equal(await title(scratch), "(archived)");
      for (const id of [readme, code, late, lateDoc]) assert.equal(await title(id), "work", "a source record stays whole");
      assert.ok(ran.retained.some((r) => r.id === late), "the record of the tool registered mid-run is shown as held");

      const again = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(again.candidates, [], "nothing else to archive");

      // Purge, much later: the archived scratch goes, the sources stay and the tool still works.
      const pv = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, {});
      assert.deepEqual(pv.candidates.map((c) => [c.kind, c.id]), [["scratch-purge", scratch]]);
      hook = async () => { hook = undefined; breakCatalog = true; };
      const stopped = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      breakCatalog = false;
      assert.equal(stopped.removed, 0, "the catalog could not be read when the batch was reached: nothing removed");
      assert.equal(stopped.partial, true, "a batch whose catalog read did not finish makes the run partial");
      assert.ok(stopped.retained.some((r) => r.id === scratch && r.reasons.some((t) => /did not finish/.test(t))));
      assert.equal(await title(scratch), "(archived)");
      const go = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      assert.equal(go.removed, 1);
      assert.equal(await title(scratch), "");
      for (const id of [readme, code, late, lateDoc]) assert.equal(await title(id), "work");
      assert.equal(await content("executable"), CODE);
      assert.equal(await content("instructions"), README);
      // A purged record is an empty shell: it is not a source either.
      await assert.rejects(cat.register(ann, { commandId: cid("r"), name: "from-purged", kind: "skill", version: "1.0.0", manifest: { ...manifest, entryPoint: undefined, interpreter: undefined }, instructionsRecordId: scratch } as never), (e: Error & { code?: string }) => e.code === "invalid_command" && /archived or deleted/.test(e.message));
    } finally { await world.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the owner's archive of a task and the scratch purge hold a source a tool or skill named after their first read; register refuses an archived record and loses to an archive that lands first; the owner's own deletion is unchanged (card K06b follow-up)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 60 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const newTask = async (): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const finish = async (task: string): Promise<void> => { for (const id of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: id as never }); };
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(storage, epoch, options);
      const write = async (task: string, body: string): Promise<string> => (await desks.write(ann, { commandId: cid("w"), projectId: project, taskId: task, kind: "note", title: "work", body, visibility: "private", status: "accepted" } as never)).id;
      const title = async (id: string): Promise<string> => ((await storage.getAggregate({ kind: "desk-record", id }))!.body as { title: string }).title;
      const skillManifest = { ...manifest, entryPoint: undefined, interpreter: undefined };
      const cat = CatalogService.withEpoch(storage, epoch, desks, options);
      let howtoName = "";
      const skill = (name: string, doc: string) => cat.register(ann, { commandId: cid("r"), name, kind: "skill", version: "1.0.0", manifest: skillManifest, instructionsRecordId: doc } as never);

      const t1 = await newTask();
      const skillDoc = await write(t1, "a skill 6641"), plain = await write(t1, "plain 6642"), gapDoc = await write(t1, "doc 6643"), gapCode = await write(t1, "code 6644");
      howtoName = (await skill("howto", skillDoc)).name;
      await finish(t1);
      const name = (n: string): string => `${howtoName.slice(0, -"howto".length)}${n}`;

      let archiveHook: (() => Promise<void>) | undefined; let listHook: ((kind: string) => Promise<void>) | undefined; let failCatalog = false;
      const watched = new Proxy(storage, { get: (t, k) => { const v = (t as never)[k] as unknown; if (k === "listAggregates") return async (kind: string, o: never) => { if (failCatalog && kind === "catalog-version") throw new Error("catalog read failed"); const page = await (t as ControllerStorage).listAggregates(kind, o); await listHook?.(kind); return page; }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as ControllerStorage;
      const at = (days: number, v: object = {}) => RetentionService.withEpoch(watched, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + days * DAY, beforeArchiveWrite: async () => { const h = archiveHook; archiveHook = undefined; await h?.(); } } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });

      // The owner archives the task. A tool is registered from two of its records inside the first guarded archive (after the archive's first read of the catalog): both are held, as is the skill's source.
      archiveHook = async () => { await cat.register(ann, { commandId: cid("r"), name: "gap", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: gapDoc, executableRecordId: gapCode } as never); };
      const archived = await at(0).archive(owner, { commandId: cid("a"), taskId: t1 });
      assert.equal(archiveHook, undefined, "the gap was reached");
      assert.deepEqual(archived.archived, [plain]);
      assert.deepEqual(archived.retained.map((r) => r.id).sort(), [gapCode, gapDoc, skillDoc].sort());
      for (const r of archived.retained) assert.deepEqual(r.reasons, [CATALOG_SOURCE_REASON]);
      for (const id of [skillDoc, gapDoc, gapCode]) assert.equal(await title(id), "work");
      assert.equal(await title(plain), "(archived)");
      assert.equal(await cat.content(ann, name("howto"), "1.0.0", "instructions"), "a skill 6641");
      assert.equal(await cat.content(ann, name("gap"), "1.0.0", "executable"), "code 6644");

      // An archived record is not a source; neither is one archived between register's read of it and its write.
      await assert.rejects(skill("from-archive", plain), (e: Error) => /archived or deleted/.test(e.message));
      const t2 = await newTask();
      const racy = await write(t2, "racy 6645");
      const published = (await desks.write(ann, { commandId: cid("w"), projectId: project, taskId: t2, kind: "note", title: "work", body: "published 6647", visibility: "shared", status: "accepted" } as never)).id;
      await finish(t2);
      let fired = false;
      const racing = new Proxy(storage, { get: (t, k) => { const v = (t as never)[k] as unknown; if (k === "applyOperation") return async (op: { changes: { type: string; ref: { kind: string } }[] }) => { if (!fired && op.changes.some((c) => c.type === "create" && c.ref.kind === "catalog-version")) { fired = true; await at(0).archive(owner, { commandId: cid("a"), taskId: t2 }); } return (t as ControllerStorage).applyOperation(op as never); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as ControllerStorage;
      const lateCat = CatalogService.withEpoch(racing, epoch, DeskService.withEpoch(racing, epoch, options), options);
      await assert.rejects(lateCat.register(ann, { commandId: cid("r"), name: "racy", kind: "skill", version: "1.0.0", manifest: skillManifest, instructionsRecordId: racy } as never), (e: Error & { code?: string }) => e.code === "stale_revision");
      assert.ok(fired);
      assert.equal(await title(racy), "(archived)");
      await assert.rejects(cat.content(ann, name("racy"), "1.0.0", "instructions"), "no version of the refused registration exists");
      // The owner's release of a shared record that the task archive emptied is refused the same way.
      assert.equal(await title(published), "(archived)");
      await assert.rejects(cat.register(owner, { commandId: cid("r"), name: "toolbox.published", kind: "skill", version: "1.0.0", manifest: skillManifest, instructionsRecordId: published } as never), (e: Error & { code?: string }) => e.code === "invalid_command" && /archived or deleted/.test(e.message));


      // Scratch purge: a skill is registered from a record after the batch's read of the catalog and before the deletion's own check: the deletion holds it (and records that it did).
      const t3 = await newTask();
      const late = await write(t3, "late 6646");
      await finish(t3);
      const pv = await at(0, { scratchPurgeDays: 30 }).run(owner, {});
      assert.deepEqual(pv.candidates.map((c) => [c.kind, c.id]), [["scratch-purge", late]]);
      let lists = 0;
      listHook = async (kind) => { if (kind !== "catalog-version") return; lists += 1; if (lists === 2) { listHook = undefined; await skill("late", late); } };
      const ran = await at(0, { scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      assert.equal(listHook, undefined, "the gap after the batch's read was reached");
      assert.equal(ran.removed, 0);
      assert.equal(await title(late), "work");
      assert.ok(ran.retained.some((r) => r.id === late && r.kind === "scratch-purge" && r.reasons.includes(CATALOG_SOURCE_REASON)));
      const deletions = await storage.listAggregates("retention-deletion", { limit: 500 });
      assert.ok(deletions.some((d) => (d.body as { recordId?: string; status?: string }).recordId === late && (d.body as { status?: string }).status === "retained"), "the hold came from the deletion's own check");
      assert.equal(await cat.content(ann, name("late"), "1.0.0", "instructions"), "late 6646");

      // The owner's own request to delete a named record is not held by the catalog (unchanged): the record goes and the skill can no longer read it.
      const del = await at(0).delete(owner, { commandId: cid("d"), recordId: skillDoc, reason: "owner removes it" });
      assert.equal(del.status, "deleted");
      await assert.rejects(cat.content(ann, name("howto"), "1.0.0", "instructions"), /was removed/);

      // The catalog becomes unreadable between the archive's first read and its last one (inside the guarded write): the record is kept and the reason says the check did not finish.
      const t4 = await newTask();
      const kept = await write(t4, "kept 6648");
      await finish(t4);
      archiveHook = async () => { failCatalog = true; };
      const blind = await at(0).archive(owner, { commandId: cid("a"), taskId: t4 }).finally(() => { failCatalog = false; });
      assert.deepEqual(blind.archived, []);
      assert.deepEqual(blind.retained.map((r) => [r.id, r.reasons.some((t) => /did not finish/.test(t))]), [[kept, true]]);
      assert.equal(await title(kept), "work");
    } finally { await world.close(); }
  });
}
