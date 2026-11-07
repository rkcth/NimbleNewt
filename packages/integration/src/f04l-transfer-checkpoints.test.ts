import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { ScriptedInterpreter, SqliteStorage, startController, type EnvironmentFacts, type FilesystemDetector } from "@nimblenewt/controller";
import { PiAdapter, missingCheckpoints } from "@nimblenewt/pi-adapter";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card F04l: a database move is refused when a recovery point's conversation checkpoint does not hold against the Pi conversation store, using the real Pi adapter's check.
const at = "2026-10-31T10:00:00.000Z";

test("the Pi adapter answers the controller's checkpoint check: a recovery point whose checkpoint the conversation store still holds is moved, one it does not hold refuses the move and nothing is moved (card F04l)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-f04l-"));
  const models = createModels();
  const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("answer one")]);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models, model: { provider: "offline", modelId: "scripted" } });
  const conversation = adapter.root();
  await (await conversation.submit({ kind: "input", requestId: requestId("t1"), content: "first request" })).result();
  const real = await conversation.checkpoint();
  const stored = { conversationId: real.conversationId, at: real.at, digest: real.digest, runtime: real.runtime, format: real.format };
  const dbPath = join(d, "c.sqlite");
  const seed = async (checkpoint: unknown): Promise<void> => {
    const s = await SqliteStorage.open({ path: dbPath });
    const { epoch } = await s.acquireEpoch({ holder: "seed", at });
    await s.applyOperation({ operationId: "seed-1", epoch, actor: "owner:rob", correlationId: "c-seed", at, audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], changes: [
      { type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }, { type: "create", ref: { kind: "attempt", id: "att-1" }, body: { taskId: "task-a" } },
      { type: "create", ref: { kind: "artifact", id: "art-aaaaaaaaaaaaaaaaaaaa" }, body: { entries: [{ digest: "sha256:" + "d".repeat(64) }] } },
      { type: "create", ref: { kind: "recovery-point", id: "rp-1" }, body: { attemptId: "att-1", taskId: "task-a", artifactId: "art-aaaaaaaaaaaaaaaaaaaa", checkpoint } },
    ] } as never);
    await s.close();
  };
  const say: Record<string, unknown[]> = {};
  const attempt = async (messageId: string) => {
    const c = await startController({ storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: { schedule: () => () => undefined }, tickMs: 3_600_000 },
      chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
      transfer: { stateDirectory: d, targets: [], targetEntries: [{ name: "moved", kind: "sqlite", path: join(d, "moved.sqlite") }], references: { checkpoints: (points: readonly { id: string; attemptId: string; checkpoint: string }[]) => missingCheckpoints(adapter, points) } } } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" }).catch(() => undefined);
      assert.ok(boot !== undefined, "owner exists");
      const text = "move the database to moved";
      say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: text, basis: "owner" }];
      return (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string };
    } finally { await c.close().catch(() => undefined); }
  };
  try {
    // A checkpoint of a history the store does not hold (the digest differs): refused, and the text says which recovery point.
    await seed({ ...stored, digest: `v1:sha256:${"2".repeat(64)}` });
    const refused = await attempt("m1");
    assert.equal(refused.status, "refused", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /checkpoint of recovery point rp-1 is not in the conversation store, or does not match it/);
    // The real checkpoint, as the controller stores it: the move is not refused for it.
    rmSync(dbPath, { force: true }); rmSync(`${dbPath}-wal`, { force: true }); rmSync(`${dbPath}-shm`, { force: true });
    await seed(stored);
    const proposed = await attempt("m2");
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
  } finally { await adapter.close(); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
