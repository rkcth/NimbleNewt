import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { createBackup, restoreBackup } from "./index.js";

after(stopServer);

// Card K01d, second review: an agent may register a personal tool or skill from its own accepted PRIVATE desk records. The catalog version is kept in every backup and reads its text back from those records, so a
// scoped backup that left them out (they look like scratch of a finished task) would restore a tool whose instructions and code are missing. They are kept; ordinary scratch of the same task is still left out.
const options = { clock: () => "2026-10-22T12:00:00.000Z", pause: async () => undefined };
const LATER = new Date("2027-01-15T12:00:00.000Z");
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const manifest = {
  purpose: "fetch a page", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/fetch.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart",
};

for (const backend of backends) {
  test(`${backend.name}: private records that are the source of a catalogued tool are kept by a scoped backup and the restored tool still reads its text (card K01d second review)`, async () => {
    const world = await backend.open();
    const root = mkdtempSync(join(tmpdir(), "nn-k01dc-"));
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const write = async (body: string): Promise<string> => (await desks.write(ann, { commandId: cid("w"), projectId: a, taskId: ta, kind: "note", title: "work", body, visibility: "private", status: "accepted" } as never)).id;
      const readme = await write("how to use the tool 5521");
      const code = await write("console.log('tool code 5522')");
      const scratch = await write("plain scratch 5523");
      const cat = CatalogService.withEpoch(world.storage, projects.epoch, desks, options);
      const registered = await cat.register(ann, { commandId: cid("r"), name: "fetch", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code } as never);
      assert.equal(await cat.content(ann, registered.name, "1.0.0", "executable"), "console.log('tool code 5522')");
      // The task ends; its private records now look like scratch of a finished task.
      const task = (await world.storage.getAggregate({ kind: "task", id: ta }))!;
      await world.storage.applyOperation({ operationId: cid("op"), epoch: projects.epoch, actor: "owner:rob", correlationId: cid("co"), at: options.clock(), changes: [{ type: "update", ref: { kind: "task", id: ta }, expectedRevision: task.revision, body: { ...task.body, state: "cancelled" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);

      const made = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => LATER, leaveOut: { scratchDays: 30, transcriptDays: null, logDays: null } });
      const text = readFileSync(join(made.path, "aggregates.jsonl"), "utf8");
      assert.ok(!text.includes("plain scratch 5523"), "ordinary scratch of the finished task is left out");
      assert.ok(text.includes("tool code 5522") && text.includes("how to use the tool 5521"), "the sources of the catalogued tool are kept");
      const line = made.manifest.contentScope!.leftOut.find((l) => l.kind === "desk-record")!;
      assert.deepEqual([line.left, line.heldBack], [1, 2]);

      const target = await backend.open();
      try {
        await restoreBackup(made.path, target.storage);
        assert.equal(await target.storage.getAggregate({ kind: "desk-record", id: scratch }), undefined);
        const { epoch } = await target.storage.acquireEpoch({ holder: "c2", at: LATER.toISOString() });
        const restored = CatalogService.withEpoch(target.storage, epoch, DeskService.withEpoch(target.storage, epoch, options), options);
        assert.equal(await restored.content(ann, registered.name, "1.0.0", "executable"), "console.log('tool code 5522')");
        assert.equal(await restored.content(ann, registered.name, "1.0.0", "instructions"), "how to use the tool 5521");
      } finally { await target.close(); }
    } finally { await world.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
