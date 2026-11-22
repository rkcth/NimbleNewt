import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";

after(stopServer);

const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const DAY = 86_400_000;
const at = (): string => new Date(T0).toISOString();
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const values = { ...RETENTION_DEFAULTS, reserveBytes: 0, generationRunDays: 30 as number | null };

const run = (state: string, extra: Record<string, unknown> = {}): JsonObject => ({
  taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-aaaaaaaaaaaaaaaaaaaa", owner: "svc:dispatcher", number: 1, contextRevision: 1, state, text: "hello", chunks: 1, toolCalls: [], late: [], lateCount: 0,
  startedAt: at(), sensitive: true, ...extra,
}) as JsonObject;

/** Writes generation-run records as they stand, under the given epoch. */
async function put(storage: ControllerStorage, epoch: number, records: Record<string, JsonObject>): Promise<void> {
  const runner = new CommandRunner(storage, epoch, { clock: at, pause: async () => undefined });
  for (const [id, body] of Object.entries(records)) {
    const ref = { kind: "generation-run" as const, id };
    await runner.command("test.put-run", { commandId: cid("put"), actor: "system" }, async () => ({ payload: { id }, build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body }], detail: {} }) }));
  }
}

for (const backend of backends) {
  test(`${backend.name}: retention removes an old generation left streaming under an older primary epoch, and keeps one streaming under the current epoch, one without an epoch, and a gone one holding a complete call (G04 slice 7)`, async () => {
    const w = await backend.open();
    try {
      const options = { clock: at, pause: async () => undefined };
      const first = await ProjectService.open(w.storage, { holder: "c1", ...options });
      const ids = { gone: "grun-aaaaaaaaaaaaaaaaaaaa-0000000001", bare: "grun-aaaaaaaaaaaaaaaaaaaa-0000000002", goneCallable: "grun-aaaaaaaaaaaaaaaaaaaa-0000000003", ours: "grun-aaaaaaaaaaaaaaaaaaaa-0000000004", newer: "grun-aaaaaaaaaaaaaaaaaaaa-0000000005" };
      await put(w.storage, first.epoch, {
        [ids.gone]: run("streaming", { epoch: first.epoch }),
        [ids.bare]: run("streaming"),
        [ids.goneCallable]: run("streaming", { epoch: first.epoch, toolCalls: [{ id: "c1", name: "t", args: "{}", state: "complete" }] }),
      });
      // A new controller takes the next epoch; it begins a generation of its own.
      const second = await ProjectService.open(w.storage, { holder: "c2", ...options });
      assert.ok(second.epoch > first.epoch);
      await put(w.storage, second.epoch, { [ids.ours]: run("streaming", { epoch: second.epoch }), [ids.newer]: run("streaming", { epoch: second.epoch + 1 }) });
      const principals = PrincipalService.withEpoch(w.storage, second.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      // The runner's clock is 40 days on: every record is older than the 30-day rule.
      const retention = RetentionService.withEpoch(w.storage, second.epoch, { settings: { effective: async () => values } }, { clock: () => new Date(T0 + 40 * DAY).toISOString() });
      const preview = await retention.run(owner, {});
      assert.deepEqual(preview.candidates.filter((c) => c.kind === "generation-run").map((c) => c.id), [ids.gone]);
      await retention.run(owner, { dryRun: false, confirm: preview.digest! });
      const has = async (id: string) => (await w.storage.getAggregate({ kind: "generation-run", id })) !== undefined;
      assert.equal(await has(ids.gone), false, "left streaming by a controller that is gone: removed");
      assert.equal(await has(ids.bare), true, "no epoch recorded: kept");
      assert.equal(await has(ids.goneCallable), true, "a complete call could still be admitted: kept");
      assert.equal(await has(ids.ours), true, "streaming under this controller: kept");
      assert.equal(await has(ids.newer), true, "an epoch later than this controller's: kept");
    } finally { await w.close(); }
  });
}
