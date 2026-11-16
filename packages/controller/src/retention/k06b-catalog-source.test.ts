import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";

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
      assert.equal(await title(scratch), "(archived)");
      const go = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      assert.equal(go.removed, 1);
      assert.equal(await title(scratch), "");
      for (const id of [readme, code, late, lateDoc]) assert.equal(await title(id), "work");
      assert.equal(await content("executable"), CODE);
      assert.equal(await content("instructions"), README);
    } finally { await world.close(); }
  });
}
