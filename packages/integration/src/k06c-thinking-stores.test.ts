import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { startController, type EnvironmentFacts, type FilesystemDetector } from "@nimblenewt/controller";
import { PiAdapter, removeStoredThinking } from "@nimblenewt/pi-adapter";
import { LocalConversationStores } from "@nimblenewt/worker";

// Card K06c, end to end: a real Pi conversation keeps the model's thinking in its store; a controller composed with the host's stores and the Pi adapter's removal cleans it through `retention.run` when the task has been done for thinkingDays,
// and the conversation still opens and goes on afterwards. The model is scripted (no network).

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DAY = 86_400_000;
const ATT = "att-aaaaaaaaaaaaaaaaaaaa", ATT_LIVE = "att-bbbbbbbbbbbbbbbbbbbb";
const SECRET = "THOUGHT-the vendor quote looks low", SIGNATURE = "SIGNATURE-ONLY-THE-PROVIDER-NEEDS";

async function converse(dir: string, label: string): Promise<void> {
  const models = createModels();
  const faux = fauxProvider({ api: "anthropic-messages", provider: "anthropic", models: [{ id: "claude-x", reasoning: true }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([{ ...fauxThinking(`${SECRET} (${label})`), thinkingSignature: SIGNATURE }, fauxText(`The quote is in euros (${label}).`)])]);
  mkdirSync(dir, { recursive: true });
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models, model: { provider: "anthropic", modelId: "claude-x" }, tools: [] });
  await (await adapter.root().submit({ kind: "input", requestId: requestId(`r-${label}`), content: "is the quote right?" })).result();
  await adapter.close();
}
const everything = (dir: string): string => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

test("a task done long enough has the thinking removed from its real conversation store through retention.run; the running task's store and the words said are untouched; the conversation opens and goes on (card K06c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k06c-"));
  const homes = new LocalConversationStores({ root: join(d, "homes") });
  mkdirSync(join(d, "data"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    dispatch: { timer: { schedule: () => () => undefined }, manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, piState: { source: homes.source, final: homes.final, purge: removeStoredThinking }, build: () => ({ hostId: "host:local" }) as never } },
    backup: { directory: join(d, "backups") } } as never);
  try {
    await converse(join(homes.home(ATT), "pi"), "done");
    await converse(join(homes.home(ATT_LIVE), "pi"), "live");
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    // The tasks are written with a time 40 days back (the controller has no clock to move): one done, one still running.
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const put = async (kind: string, id: string, body: object) => c.storage.applyOperation({ operationId: `put:${kind}:${id}`, epoch: c.epoch, actor: "test", correlationId: "put", at: old, changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    await put("task", "task-doneaaaaaaaaaaaaaaaa", { projectId: project, title: "finished", state: "done" });
    await put("task", "task-liveaaaaaaaaaaaaaaaa", { projectId: project, title: "running", state: "in_progress" });
    await put("dispatch", "dsp-1", { taskId: "task-doneaaaaaaaaaaaaaaaa", attemptId: ATT, state: "finished" });
    await put("dispatch", "dsp-2", { taskId: "task-liveaaaaaaaaaaaaaaaa", attemptId: ATT_LIVE, state: "running" });
    const donePi = join(homes.home(ATT), "pi"), livePi = join(homes.home(ATT_LIVE), "pi");
    assert.ok(everything(donePi).includes(SECRET) && everything(donePi).includes(SIGNATURE), "the thinking is in the store before");

    const preview = await call("retention.run", {}, "prev1");
    assert.ok(preview.ok, JSON.stringify(preview));
    const mine = preview.result.candidates.filter((x: { kind: string }) => x.kind === "pi-thinking");
    assert.deepEqual(mine.map((x: { id: string }) => x.id), ["task-doneaaaaaaaaaaaaaaaa"]);
    assert.ok(everything(donePi).includes(SECRET), "a preview cleans nothing");
    const run = await call("retention.run", { dryRun: false, confirm: preview.result.digest }, "run1");
    assert.ok(run.ok, JSON.stringify(run));

    const after = everything(donePi);
    assert.ok(!after.includes(SECRET) && !after.includes(SIGNATURE) && !/"type"\s*:\s*"thinking"/.test(after), "the thinking is gone from the store");
    assert.ok(after.includes("The quote is in euros (done).") && after.includes("is the quote right?"), "the words said stay");
    assert.ok(everything(livePi).includes(SECRET), "the running task's store is untouched");
    const status = (await call("retention.status", {})).result.item;
    assert.equal(status.growth["thinking-purge"], 1);
    const record = await c.storage.getAggregate({ kind: "thinking-purge", id: "task-doneaaaaaaaaaaaaaaaa" });
    assert.deepEqual((record!.body as { attempts: unknown }).attempts, { [ATT]: "purged" });
    assert.equal((await call("retention.run", {}, "prev2")).result.candidates.filter((x: { kind: string }) => x.kind === "pi-thinking").length, 0);

    // The cleaned conversation opens and answers again.
    const models = createModels();
    const faux = fauxProvider({ api: "anthropic-messages", provider: "anthropic", models: [{ id: "claude-x", reasoning: true }] });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Delivery is on the 5th.")]);
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(donePi, BACKGROUND_CONTEXT), models, model: { provider: "anthropic", modelId: "claude-x" }, tools: [] });
    try {
      assert.deepEqual(await adapter.root().thinking(), []);
      const next = await (await adapter.root().submit({ kind: "input", requestId: requestId("r-next"), content: "and the delivery?" })).result();
      assert.equal(next.status, "completed");
    } finally { await adapter.close(); }
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
