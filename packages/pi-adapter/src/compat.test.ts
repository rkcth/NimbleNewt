// G03: forward migration and compatibility rejection, against the production adapter and real fixtures (see
// ../test-fixtures/README.md for where each fixture came from). Fixtures are never modified: every test works on a copy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type Checkpoint, type CheckpointV1 } from "@nimblenewt/contracts";
import {
  CHECKPOINT_FORMAT, CheckpointRejectedError, IncompatibleStorageError, PiAdapter, STORAGE_MIGRATIONS, UnmarkedStorageError, upgradeCheckpoint,
  type AdapterTool, type PiAdapterOptions,
} from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A private copy of a fixture directory. */
function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nn compat-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** Every file under a directory with its content hash: two equal snapshots mean not a byte changed, none added or removed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = createHash("sha256").update(readFileSync(join(current, entry.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

const echo: AdapterTool = { name: "echo", description: "Returns a sentinel", parameters: Type.Object({}), execute: async () => "FIXTURE-SENTINEL" };

async function openAdapter(dir: string, extra: Partial<PiAdapterOptions> = {}) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF, ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux };
}

/** Storage fixtures without a marker: who wrote them is unknown to the adapter. */
const UNMARKED = ["adapter-pre-marker/storage", "pi-1.0.1", "pi-1.2.0", "pi-1.3.0"] as const;
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

// ---------------------------------------------------------------------------------------------- checkpoints

const v1Checkpoints = JSON.parse(readFileSync(join(FIXTURES, "adapter-pre-marker/checkpoints-v1.json"), "utf8")) as Record<"beforeSecond" | "beforeCompaction" | "afterCompaction", CheckpointV1>;

test("format-1 checkpoints written by the earlier adapter are upgraded in memory and resume on the current one; the originals are untouched", async () => {
  const dir = copyOf("adapter-pre-marker/storage");
  const { adapter } = await openAdapter(dir, { adoptUnmarkedStorage: true });
  const before = snapshot(dir);
  for (const [name, v1] of Object.entries(v1Checkpoints)) {
    const frozen = JSON.stringify(v1);
    assert.equal(v1.format, 1, `${name} should be a real format-1 record`);
    assert.deepEqual(await adapter.verifyCheckpoint(v1), { valid: true }, name);
    assert.equal(JSON.stringify(v1), frozen, `${name}: verifying modified the stored checkpoint`);
  }
  assert.deepEqual(snapshot(dir), before, "verifying checkpoints wrote to the storage");

  // The upgrade states exactly what format 1 meant, and a checkpoint taken now for the same boundary agrees with it.
  const upgraded = upgradeCheckpoint(v1Checkpoints.beforeSecond);
  assert.ok(upgraded.ok && upgraded.migrated);
  assert.deepEqual(upgraded.ok && upgraded.checkpoint, {
    format: CHECKPOINT_FORMAT, conversationId: v1Checkpoints.beforeSecond.conversationId, at: v1Checkpoints.beforeSecond.at, digest: v1Checkpoints.beforeSecond.digest,
    runtime: { name: "pi-durable", version: "1.3.0" }, historyFormat: "pi-durable:1", contractsVersion: 1,
  });
  const current = await adapter.root().checkpoint({ at: v1Checkpoints.beforeSecond.at });
  assert.deepEqual(current, upgraded.ok && upgraded.checkpoint, "a checkpoint taken now for the same boundary differs from the upgraded old one");

  // Resuming from an old checkpoint works end to end: the restored task is the old task up to that point.
  const restored = await adapter.restoreCheckpoint(v1Checkpoints.beforeSecond, requestId("restore-old"));
  const text = (await restored.conversation.transcript()).map((e) => e.text).join("|");
  assert.ok(text.includes("use the tool please") && text.includes("first answer") && !text.includes("a second request"));
});

test("old checkpoints that no longer hold, and formats this adapter does not know, are rejected with a reason and change nothing", async () => {
  const dir = copyOf("adapter-pre-marker/storage");
  const { adapter } = await openAdapter(dir, { adoptUnmarkedStorage: true });
  const before = snapshot(dir);
  const base = v1Checkpoints.beforeSecond;
  const reasonOf = async (checkpoint: unknown) => {
    const frozen = JSON.stringify(checkpoint);
    const verdict = await adapter.verifyCheckpoint(checkpoint as Checkpoint);
    assert.equal(JSON.stringify(checkpoint), frozen, "the input was modified");
    return verdict.valid ? "valid" : verdict.reason;
  };
  assert.equal(await reasonOf({ ...base, digest: `${base.digest.slice(0, -1)}${base.digest.endsWith("0") ? "1" : "0"}` }), "history_changed");
  assert.equal(await reasonOf({ ...base, runtimeVersion: "1.2.0" }), "incompatible_runtime");
  assert.equal(await reasonOf({ ...base, at: 999999 }), "unknown_entry");
  for (const unknown of [{ ...base, format: 3 }, { ...base, format: "1" }, { ...base, format: 0 }, { ...base, digest: undefined }, { ...base, at: -1 }, { format: 1 }, null, [], "checkpoint", 7]) {
    assert.equal(await reasonOf(unknown), "unsupported_format", JSON.stringify(unknown));
  }
  await assert.rejects(adapter.restoreCheckpoint({ ...base, format: 3 } as never, requestId("nope")), (e) => e instanceof CheckpointRejectedError && e.reason === "unsupported_format");
  assert.deepEqual(snapshot(dir), before, "a rejected checkpoint wrote to the storage");
  assert.equal((await adapter.root().listBranches()).length, 0, "a rejected checkpoint created a branch");
});

// ------------------------------------------------------------------------------------------ storage marker

test("storage with data and no compatibility marker is refused, and left exactly as it was", async () => {
  for (const name of UNMARKED) {
    const dir = copyOf(name);
    const before = snapshot(dir);
    const offline = createOfflineModels();
    await assert.rejects(
      PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF }),
      (e) => e instanceof UnmarkedStorageError && e.conversations >= 1,
      name,
    );
    assert.deepEqual(snapshot(dir), before, `${name}: a refused open changed the storage`);
  }
});

test("a fresh storage gets the marker once; reopening is accepted; the marker says it was not adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn compat-fresh-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const first = await openAdapter(dir);
  assert.deepEqual(await first.adapter.storageInfo(), { markerFormat: 1, runtimeVersion: "1.3.0", historyFormat: "pi-durable:1", adoptedUnmarked: false });
  await first.adapter.close();
  cleanup.pop();
  const second = await openAdapter(dir);
  assert.equal((await second.adapter.storageInfo()).adoptedUnmarked, false);
});

for (const name of UNMARKED) {
  test(`adopting ${name}: the scan passes, the marker is written, and the old conversation continues (extension tool results and compaction included)`, async () => {
    const dir = copyOf(name);
    const { adapter, faux } = await openAdapter(dir, { adoptUnmarkedStorage: true, tools: [echo] });
    assert.deepEqual(await adapter.storageInfo(), { markerFormat: 1, runtimeVersion: "1.3.0", historyFormat: "pi-durable:1", adoptedUnmarked: true });

    // The extension fixture: a request the old runtime answered through a tool call is readable as a semantic result.
    const old = await adapter.root().lookup(requestId("req-1"));
    assert.deepEqual([old?.status, old && "text" in old && old.text, old?.toolCalls.map((c) => [c.name, c.status, "output" in c ? c.output : ""])], ["completed", "first answer", [["echo", "ok", "FIXTURE-SENTINEL"]]]);

    // The compaction fixture: the old conversation has a compaction, a checkpoint can be taken at it, and the model context for
    // a new request starts from the summary and still contains the old tool result.
    let sawContext = "";
    faux.setResponses([(context) => { sawContext = JSON.stringify(context.messages); return fauxAssistantMessage("continued"); }]);
    const transcript = await adapter.root().transcript();
    assert.ok(transcript.some((e) => e.kind === "pi.compaction"), "the fixture should contain a compaction");
    const checkpoint = await adapter.root().checkpoint();
    assert.equal(checkpoint.at, transcript.at(-1)?.id, "the latest boundary of the old conversation is its compaction");
    assert.deepEqual(await adapter.verifyCheckpoint(checkpoint), { valid: true });
    const result = await (await adapter.root().submit(input("after-adoption", "carry on from the old conversation"))).result();
    assert.equal(result.status, "completed");
    assert.ok(sawContext.includes("SUMMARY-TEXT"), "the compaction summary is missing from the new request's context");
    assert.ok(sawContext.includes("carry on from the old conversation"));

    // The compacted history is still branchable: the branch starts from the compaction.
    const branch = await adapter.root().branch({ requestId: requestId("branch-old"), at: checkpoint.at });
    assert.ok((await branch.conversation.transcript()).some((e) => e.kind === "pi.compaction"));

    // A reopened adapter no longer needs the flag.
    await adapter.close();
    cleanup.pop();
    const again = await openAdapter(dir);
    assert.equal((await again.adapter.storageInfo()).adoptedUnmarked, true);
  });
}

test("a tool of the old extension that this adapter does not provide fails explicitly instead of silently doing nothing", async () => {
  const dir = copyOf("pi-1.2.0");
  const { adapter, faux } = await openAdapter(dir, { adoptUnmarkedStorage: true }); // no `echo` tool registered
  faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", {}, { id: "again" }), { stopReason: "toolUse" }), fauxAssistantMessage("gave up")]);
  const result = await (await adapter.root().submit(input("use-old-tool", "use the echo tool again"))).result();
  assert.deepEqual([result.status, "code" in result && result.code, result.toolCalls.map((c) => c.status)], ["failed", "unknown_tool", ["unknown_tool"]]);
});

// ------------------------------------------------------------------------- incompatible, refused unchanged

test("unmarked storage whose scan finds problems is refused even when adoption is requested, and left unchanged", async () => {
  const cases: readonly [string, (text: string) => string, RegExp][] = [
    ["an entry kind this adapter does not know (synthetic: no newer runtime exists)", (t) => t.replace('"kind":"pi.assistant"', '"kind":"pi.hologram"'), /unknown entry kind pi\.hologram/],
    ["a tool result without content (synthetic: the shape that hid results from the model in the old API)", (t) => t.replace('"toolName":"echo","content":', '"toolName":"echo","output":'), /tool result without content/],
  ];
  for (const [label, edit, finding] of cases) {
    const dir = copyOf("pi-1.3.0");
    const file = join(dir, "main.jsonl");
    const original = readFileSync(file, "utf8");
    const edited = edit(original);
    assert.notEqual(edited, original, `${label}: the edit did not apply`);
    writeFileSync(file, edited);
    const before = snapshot(dir);
    const offline = createOfflineModels();
    await assert.rejects(
      PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF, adoptUnmarkedStorage: true }),
      (e) => e instanceof IncompatibleStorageError && e.findings.some((f) => finding.test(f)),
      label,
    );
    assert.deepEqual(snapshot(dir), before, `${label}: a refused adoption changed the storage`);
  }
});

test("a marker naming another runtime version, history layout or marker format is refused and the storage is left unchanged", async () => {
  const dir = copyOf("pi-1.2.0");
  await (await openAdapter(dir, { adoptUnmarkedStorage: true })).adapter.close();
  cleanup.pop();
  const markerFile = readdirSync(dir).filter((f) => f.startsWith("doc-")).find((f) => readFileSync(join(dir, f), "utf8").includes('"runtimeVersion"'));
  assert.ok(markerFile, "the marker document file should exist after adoption");
  const original = readFileSync(join(dir, markerFile), "utf8");

  const variants: readonly [string, (t: string) => string, RegExp][] = [
    ["another Pi Durable version", (t) => t.replace('"runtimeVersion":"1.3.0"', '"runtimeVersion":"1.2.0"'), /written by Pi Durable 1\.2\.0.*no migration/],
    ["a newer Pi Durable version", (t) => t.replace('"runtimeVersion":"1.3.0"', '"runtimeVersion":"2.0.0"'), /written by Pi Durable 2\.0\.0/],
    ["another history layout", (t) => t.replace('"historyFormat":"pi-durable:1"', '"historyFormat":"pi-durable:2"'), /history layout "pi-durable:2"/],
    ["a newer marker format", (t) => t.replace('"markerFormat":1', '"markerFormat":2'), /marker format 2 is newer/],
  ];
  for (const [label, edit, expected] of variants) {
    writeFileSync(join(dir, markerFile), edit(original));
    assert.notEqual(readFileSync(join(dir, markerFile), "utf8"), original, `${label}: the edit did not apply`);
    const before = snapshot(dir);
    const offline = createOfflineModels();
    await assert.rejects(
      PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF, adoptUnmarkedStorage: true }),
      (e) => e instanceof IncompatibleStorageError && expected.test(e.message),
      label,
    );
    assert.deepEqual(snapshot(dir), before, `${label}: a refused open changed the storage`);
  }
  assert.deepEqual(STORAGE_MIGRATIONS, [], "no storage migration is defined, so none is silently attempted");
});

test("a storage format number Pi Durable itself does not know is refused by Pi before the adapter sees it, unchanged (synthetic)", async () => {
  const dir = copyOf("adapter-pre-marker/storage");
  const file = join(dir, "main.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").replace('"format":1', '"format":2'));
  const before = snapshot(dir);
  await assert.rejects(openNodeJsonlStorage(dir, BACKGROUND_CONTEXT));
  assert.deepEqual(snapshot(dir), before);
});

test("a refused open can still change a storage, but only through the backend's own crash recovery: the adapter writes nothing", async () => {
  const pristine = snapshot(join(FIXTURES, "pi-1.2.0"));
  const dir = copyOf("pi-1.2.0");
  writeFileSync(join(dir, "main.jsonl"), readFileSync(join(dir, "main.jsonl"), "utf8") + '{"partial":'); // a torn, unconfirmed trailing record
  assert.notDeepEqual(snapshot(dir), pristine, "the torn copy should differ from the fixture");
  const offline = createOfflineModels();
  await assert.rejects(PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF }), UnmarkedStorageError);
  // Pi's JSONL storage dropped the incomplete record when it opened (before the adapter could check anything); the adapter
  // refused and wrote nothing, so what remains is exactly the pristine fixture.
  assert.deepEqual(snapshot(dir), pristine);
});

// ------------------------------------------------------------------------------------- failed adoption

test("a failed adoption leaves the original storage byte for byte as it was, and a later adoption still works", async () => {
  for (const name of ["pi-1.0.1", "adapter-pre-marker/storage"] as const) {
    const dir = copyOf(name);
    const before = snapshot(dir);
    const real = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
    const failing = new Proxy(real, {
      get(target, property) {
        if (property === "commit") return async () => { throw new Error("disk full (injected)"); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const offline = createOfflineModels();
    await assert.rejects(PiAdapter.open({ storage: failing, models: offline.models, model: OFFLINE_MODEL_REF, adoptUnmarkedStorage: true }), /disk full/);
    assert.deepEqual(snapshot(dir), before, `${name}: a failed adoption changed the storage`);

    const retry = await openAdapter(dir, { adoptUnmarkedStorage: true });
    assert.equal((await retry.adapter.storageInfo()).adoptedUnmarked, true, `${name}: adoption did not work after a failed attempt`);
  }
});

test("a failed marker write on an empty storage leaves it empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn compat-empty-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const real = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
  const before = snapshot(dir);
  const failing = new Proxy(real, { get(target, property) { if (property === "commit") return async () => { throw new Error("disk full (injected)"); }; const v = Reflect.get(target, property, target) as unknown; return typeof v === "function" ? v.bind(target) : v; } });
  const offline = createOfflineModels();
  await assert.rejects(PiAdapter.open({ storage: failing, models: offline.models, model: OFFLINE_MODEL_REF }), /disk full/);
  assert.deepEqual(snapshot(dir), before);
});
