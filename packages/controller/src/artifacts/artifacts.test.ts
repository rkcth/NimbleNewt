import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, ProjectService, derivedId, type DomainErrorCode } from "../domain/index.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { FaultInjectingStorage } from "../storage/faults.js";
import { MemoryStorage } from "../storage/memory.js";
import { ArtifactService, FileBlobStore } from "./index.js";

after(stopServer);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const T = "2026-10-20T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const me = "rob";
let n = 0;
const cid = (label: string) => `${label}-${n++}`;
const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });
const refuses = (code: DomainErrorCode, run: () => Promise<unknown>, check?: (e: DomainError) => void) =>
  assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); check?.(e); return true; });
const DAY = 24 * 3600 * 1000;
const age = (path: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t); };

async function setup(storage: ConstructorParameters<typeof FaultInjectingStorage>[0] | FaultInjectingStorage) {
  const dir = mkdtempSync(join(tmpdir(), "nn art-"));
  const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
  const artifacts = await ArtifactService.open(storage, blobs, { holder: "c1", ...fast });
  return { dir, blobs, artifacts, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

for (const backend of backends) {
  const suite = (name: string, body: (ctx: Awaited<ReturnType<typeof setup>>, world: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const ctx = await setup(world.storage);
      try { await body(ctx, world); } finally { ctx.done(); await world.close(); }
    });

  suite("publishing records a manifest of verified blobs; every file reads back exactly", async ({ artifacts, blobs }) => {
    const r = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "report", files: [file("docs/report.md", "# Report"), file("data/numbers.csv", "1,2,3\n"), { path: "empty.txt", content: new Uint8Array(0) }] });
    assert.deepEqual([r.revision, r.replayed, r.id], [1, false, derivedId("art", `${"pub"}-${n - 1}`)]);
    const a = (await artifacts.get(r.id))!;
    assert.deepEqual(a.entries.map((e) => [e.path, e.size]), [["data/numbers.csv", 6], ["docs/report.md", 8], ["empty.txt", 0]]);
    assert.equal(a.totalBytes, 14);
    assert.equal(a.entries[1]!.digest, sha("# Report"));
    assert.equal(Buffer.from(await artifacts.readFile(r.id, "docs/report.md")).toString(), "# Report");
    assert.equal((await artifacts.readFile(r.id, "empty.txt")).byteLength, 0);
    assert.deepEqual(await artifacts.verify(r.id), { artifactId: r.id, ok: true, files: 3, bytes: 14, problems: [] });
    assert.equal((await blobs.list()).length, 3);
    await refuses("not_found", () => artifacts.readFile(r.id, "nope.txt"));
  });

  suite("a repeated publication applies once; the same command ID with other files or another name is a conflict", async ({ artifacts, blobs }, world) => {
    const command = { commandId: "pub-1", actor: me, name: "report", files: [file("a.txt", "A"), file("b.txt", "B")] };
    const first = await artifacts.publish(command);
    assert.deepEqual(await artifacts.publish({ ...command, files: [file("b.txt", "B"), file("a.txt", "A")] }), { ...first, replayed: true }, "the order of the files does not matter");
    await refuses("command_conflict", () => artifacts.publish({ ...command, files: [file("a.txt", "A"), file("b.txt", "different")] }));
    await refuses("command_conflict", () => artifacts.publish({ ...command, name: "other name" }));
    await refuses("command_conflict", () => artifacts.publish({ ...command, files: [file("a.txt", "A")] }));
    assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
    assert.equal((await artifacts.list({ limit: 10 })).length, 1);
    assert.ok((await blobs.list()).some((b) => b.digest === sha("different")), "the rejected attempt's blob is an orphan, not a reference");
    assert.equal(sha("different") in Object.fromEntries((await artifacts.get(first.id))!.entries.map((e) => [e.digest, 1])), false);
  });

  suite("identical files published as separate artifacts share their blobs, and each artifact verifies on its own", async ({ artifacts, blobs }) => {
    const a = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "one", files: [file("x.txt", "shared"), file("y.txt", "only-one")] });
    const b = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "two", files: [file("renamed.txt", "shared")] });
    assert.equal((await blobs.list()).length, 2);
    assert.ok((await artifacts.verify(a.id)).ok && (await artifacts.verify(b.id)).ok);
    assert.notEqual(a.id, b.id);
  });

  suite("a damaged blob blocks resuming: missing, truncated or altered, each is reported with its file", async ({ artifacts, blobs }) => {
    const ok = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "ok", files: [file("fine.txt", "fine")] });
    const bad = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "bad", files: [file("one.txt", "first file"), file("two.txt", "second file"), file("three.txt", "third file")] });
    assert.deepEqual(await artifacts.checkResumable([ok.id, bad.id]), { ok: true, blocked: [] });
    await artifacts.assertResumable([ok.id, bad.id]);
    const path = (text: string) => blobs.pathOf(sha(text));
    unlinkSync(path("first file"));
    chmodSync(path("second file"), 0o666); writeFileSync(path("second file"), "tampered!!!"); // same length (11) as "second file"
    chmodSync(path("third file"), 0o666); writeFileSync(path("third file"), "cut");
    const verdict = await artifacts.verify(bad.id);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems.map((p) => [p.path, p.problem]).sort(), [["one.txt", "missing"], ["three.txt", "size_mismatch"], ["two.txt", "corrupt"]]);
    const resumable = await artifacts.checkResumable([ok.id, bad.id, bad.id]);
    assert.deepEqual([resumable.ok, resumable.blocked.map((b) => b.artifactId)], [false, [bad.id]]);
    await refuses("integrity", () => artifacts.assertResumable([ok.id, bad.id]), (e) => assert.match(e.message, new RegExp(`${bad.id}.*(missing|corrupt|size_mismatch).*2 more`)));
    await refuses("integrity", () => artifacts.readFile(bad.id, "one.txt"));
    await refuses("integrity", () => artifacts.readFile(bad.id, "two.txt"));
    await refuses("integrity", () => artifacts.readFile(bad.id, "three.txt"));
    assert.equal(Buffer.from(await artifacts.readFile(ok.id, "fine.txt")).toString(), "fine", "an undamaged artifact is unaffected");
    await refuses("not_found", () => artifacts.verify(derivedId("art", "ghost")));
  });

  suite("a record whose manifest digest does not match its files is reported", async ({ artifacts }, world) => {
    const r = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "x", files: [file("a.txt", "A")] });
    const a = await world.storage.getAggregate({ kind: "artifact", id: r.id });
    // Someone edits the stored record behind the service's back.
    await world.storage.applyOperation({
      operationId: "tamper", epoch: artifacts.epoch, actor: "intruder", correlationId: "tamper", at: T,
      changes: [{ type: "update", ref: { kind: "artifact", id: r.id }, expectedRevision: 1, body: { ...a!.body, entries: [{ path: "a.txt", digest: sha("B"), size: 1 }] } }],
      audit: [{ type: "tamper", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    });
    const verdict = await artifacts.verify(r.id);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.problem === "manifest_mismatch"));
  });

  suite("orphan cleanup deletes only unreferenced blobs older than the grace period, and never a referenced one", async ({ artifacts, blobs }) => {
    const kept = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "kept", files: [file("k.txt", "referenced and old")] });
    const stray = [(await blobs.put(Buffer.from("old orphan"))).digest, (await blobs.put(Buffer.from("young orphan"))).digest];
    age(blobs.pathOf(sha("referenced and old")), 10 * DAY);
    age(blobs.pathOf(stray[0]!), 10 * DAY);
    const dry = await artifacts.collectOrphans({ olderThanMs: DAY, dryRun: true });
    assert.deepEqual([dry.examined, dry.referenced, dry.keptRecent, dry.orphans, dry.dryRun], [3, 1, 1, [stray[0]], true]);
    assert.equal(await blobs.has(stray[0]!), true, "a dry run deletes nothing");
    const real = await artifacts.collectOrphans({ olderThanMs: DAY });
    assert.deepEqual(real.orphans, [stray[0]]);
    assert.deepEqual([await blobs.has(stray[0]!), await blobs.has(stray[1]!), await blobs.has(sha("referenced and old"))], [false, true, true]);
    assert.ok((await artifacts.verify(kept.id)).ok);
    const later = await artifacts.collectOrphans({ olderThanMs: 0, now: Date.now() + 1000 });
    assert.deepEqual(later.orphans, [stray[1]], "with no grace the young orphan goes too, the referenced blob still stays");
    assert.deepEqual((await blobs.list()).map((b) => b.digest), [sha("referenced and old")]);
    await refuses("invalid_command", () => artifacts.collectOrphans({ olderThanMs: -1 }));
  });

  suite("cleanup removes stray temporary files from writes that never finished, only when old enough", async ({ artifacts, blobs }) => {
    const tmp = join(blobs.directory, "tmp");
    writeFileSync(join(tmp, "dead-write"), "half a blob");
    writeFileSync(join(tmp, "live-write"), "being written");
    age(join(tmp, "dead-write"), 3 * DAY);
    assert.equal((await artifacts.collectOrphans({ olderThanMs: DAY })).tempRemoved, 1);
    assert.equal((await artifacts.collectOrphans({ olderThanMs: DAY })).tempRemoved, 0);
  });

  suite("cleanup cannot run while a publication is in flight, so it never removes bytes a manifest is about to refer to", async ({ artifacts, blobs }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* slow(): AsyncGenerator<Uint8Array> { yield Buffer.from("first half "); await gate; yield Buffer.from("second half"); }
    const publishing = artifacts.publish({ commandId: cid("slow"), actor: me, name: "slow", files: [file("early.txt", "stored early"), { path: "slow.bin", content: slow() }] });
    for (let i = 0; i < 200 && !(await blobs.has(sha("stored early"))); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await blobs.has(sha("stored early")), true, "the first file's blob is on disk while the publication waits");
    age(blobs.pathOf(sha("stored early")), 10 * DAY);
    let collected = false;
    const collecting = artifacts.collectOrphans({ olderThanMs: 0, now: Date.now() + 1000 }).then((r) => { collected = true; return r; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(collected, false, "cleanup waits for the publication");
    release();
    const [published, report] = await Promise.all([publishing, collecting]);
    assert.deepEqual(report.orphans, [], "nothing it was about to need was deleted");
    assert.ok((await artifacts.verify(published.id)).ok);
  });

  suite("a deposed controller does not delete anything", async ({ artifacts, blobs }, world) => {
    await blobs.put(Buffer.from("orphan"));
    age(blobs.pathOf(sha("orphan")), 5 * DAY);
    await ProjectService.open(world.storage, { holder: "c2", ...fast });
    await refuses("stale_epoch", () => artifacts.collectOrphans({ olderThanMs: DAY }));
    assert.equal(await blobs.has(sha("orphan")), true);
  });

  suite("publication checks its input before storing a byte, and names the field", async ({ artifacts, blobs }, world) => {
    const base = { commandId: cid("pub"), actor: me, name: "n", files: [file("a.txt", "A")] };
    const bad: [string, () => Promise<unknown>][] = [
      ["files", () => artifacts.publish({ ...base, files: [] })],
      ["files", () => artifacts.publish({ ...base, files: "a.txt" as never })],
      ["files[0].path", () => artifacts.publish({ ...base, files: [file("../escape", "x")] })],
      ["files[0].path", () => artifacts.publish({ ...base, files: [file("/abs", "x")] })],
      ["files[1].path", () => artifacts.publish({ ...base, files: [file("ok.txt", "x"), file("CON", "y")] })],
      ["files", () => artifacts.publish({ ...base, files: [file("Same.txt", "x"), file("same.TXT", "y")] })],
      ["files", () => artifacts.publish({ ...base, files: [file("a", "x"), file("a/b", "y")] })],
      ["files[0].content", () => artifacts.publish({ ...base, files: [{ path: "a.txt", content: "a string" as never }] })],
      ["files[0].content", () => artifacts.publish({ ...base, files: [{ path: "a.txt" } as never] })],
      ["files[0]", () => artifacts.publish({ ...base, files: [null as never] })],
      ["extra", () => artifacts.publish({ ...base, extra: 1 } as never)],
      ["name", () => artifacts.publish({ ...base, name: "" })],
      ["projectId", () => artifacts.publish({ ...base, projectId: "nope" })],
      ["taskId", () => artifacts.publish({ ...base, taskId: "nope" })],
    ];
    for (const [field, run] of bad) await refuses("invalid_command", run, (e) => assert.ok(e.field === field || e.message.includes(field), `${field}: ${e.message}`));
    assert.deepEqual(await blobs.list(), [], "nothing was stored for any refused publication");
    assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 10 })).length, 0);
  });

  suite("an artifact can belong to a project and a task, which must exist and agree", async ({ artifacts }, world) => {
    const projects = ProjectService.withEpoch(world.storage, artifacts.epoch, fast);
    const p1 = await projects.createProject({ commandId: cid("p"), actor: me, name: "P1" });
    const p2 = await projects.createProject({ commandId: cid("p"), actor: me, name: "P2" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p1.id, title: "T" });
    const ok = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "n", projectId: p1.id, taskId: t.id, files: [file("a.txt", "A")] });
    const a = (await artifacts.get(ok.id))!;
    assert.deepEqual([a.projectId, a.taskId, a.createdBy], [p1.id, t.id, me]);
    await refuses("invalid_command", () => artifacts.publish({ commandId: cid("pub"), actor: me, name: "n", projectId: p2.id, taskId: t.id, files: [file("a.txt", "A")] }), (e) => assert.match(e.message, /belongs to project/));
    await refuses("not_found", () => artifacts.publish({ commandId: cid("pub"), actor: me, name: "n", projectId: derivedId("proj", "ghost"), files: [file("a.txt", "A")] }));
    await refuses("not_found", () => artifacts.publish({ commandId: cid("pub"), actor: me, name: "n", taskId: derivedId("task", "ghost"), files: [file("a.txt", "A")] }));
    const bare = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "free-standing", files: [file("a.txt", "A")] });
    assert.deepEqual(["projectId" in (await artifacts.get(bare.id))!, "taskId" in (await artifacts.get(bare.id))!], [false, false]);
  });

  suite("a very large file streams through without being held in memory twice", async ({ artifacts, blobs }) => {
    async function* big(): AsyncGenerator<Uint8Array> { for (let i = 0; i < 40; i++) yield Buffer.alloc(1024 * 1024, i); }
    const r = await artifacts.publish({ commandId: cid("pub"), actor: me, name: "big", files: [{ path: "big.bin", content: big() }] });
    const a = (await artifacts.get(r.id))!;
    assert.equal(a.totalBytes, 40 * 1024 * 1024);
    assert.equal(await blobs.verify(a.entries[0]!.digest, a.totalBytes), "ok");
    await assert.rejects(artifacts.readFile(r.id, "big.bin", { maxBytes: 1024 }), (e: unknown) => e instanceof DomainError && /more than the 1024 allowed/.test(e.message), "a read has a size limit");
    assert.equal((await artifacts.readFile(r.id, "big.bin", { maxBytes: 64 * 1024 * 1024 })).byteLength, 40 * 1024 * 1024);
  });
}

// ---- a crash between the blobs and the manifest --------------------------------------------------------------------------
test("a commit that fails before the manifest is recorded leaves blobs but no artifact, cleanup reclaims them, and the same command then completes", async () => {
  const inner = new MemoryStorage();
  const faulty = new FaultInjectingStorage(inner, [{ when: "before", kind: "unavailable" }]);
  const { artifacts, blobs, done } = await setup(faulty);
  try {
    const command = { commandId: "crashy", actor: me, name: "x", files: [file("a.txt", "A"), file("b.txt", "B")] };
    await refuses("unavailable", () => artifacts.publish(command));
    assert.deepEqual(await artifacts.list({ limit: 10 }), [], "no artifact is accepted");
    assert.equal((await blobs.list()).length, 2, "the blobs are there, unreferenced");
    const swept = await artifacts.collectOrphans({ olderThanMs: 0, now: Date.now() + 1000 });
    assert.equal(swept.orphans.length, 2);
    assert.deepEqual(await blobs.list(), []);
    const r = await artifacts.publish(command); // the retry stores the blobs again and records the manifest
    assert.equal(r.replayed, false);
    assert.ok((await artifacts.verify(r.id)).ok);
  } finally { done(); }
});

test("a manifest commit whose answer was lost is settled by the command ID, and the artifact is complete", async () => {
  const inner = new MemoryStorage();
  const faulty = new FaultInjectingStorage(inner, [{ when: "after", kind: "uncertain_commit" }]);
  const { artifacts, done } = await setup(faulty);
  try {
    const r = await artifacts.publish({ commandId: "lost-answer", actor: me, name: "x", files: [file("a.txt", "A")] });
    assert.deepEqual([r.revision, r.replayed], [1, true]);
    assert.ok((await artifacts.verify(r.id)).ok);
    assert.equal((await artifacts.list({ limit: 10 })).length, 1);
  } finally { done(); }
});

test("if a blob disappears between storing and recording, nothing is accepted", async () => {
  const inner = new MemoryStorage();
  const { artifacts, blobs, done } = await setup(inner);
  try {
    async function* vanishing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("second");
      unlinkSync(blobs.pathOf(sha("first"))); // the first file's blob is removed by something else while the second streams
    }
    await refuses("integrity", () => artifacts.publish({ commandId: "vanish", actor: me, name: "x", files: [file("first.txt", "first"), { path: "second.txt", content: vanishing() }] }), (e) => assert.match(e.message, /no longer in the store/));
    assert.deepEqual(await artifacts.list({ limit: 10 }), []);
  } finally { done(); }
});

test("the blob store failing is reported as unavailable, not as bad input", async () => {
  const inner = new MemoryStorage();
  const { artifacts, blobs, done } = await setup(inner);
  try {
    rmSync(join(blobs.directory, "tmp"), { recursive: true, force: true }); // the store's own folder is gone
    await refuses("unavailable", () => artifacts.publish({ commandId: "no-disk", actor: me, name: "x", files: [file("a.txt", "A")] }));
  } finally { done(); }
});

test("services that share a store, even through separate store objects, exclude each other: cleanup with no grace never takes a blob another service is about to record", async () => {
  const inner = new MemoryStorage();
  const { artifacts: a, blobs, dir, done } = await setup(inner);
  try {
    const sameDirectory = await FileBlobStore.open({ directory: blobs.directory }); // another object over the same folder, as another request handler might have
    const b = ArtifactService.withEpoch(inner, a.epoch, sameDirectory, fast);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* slow(): AsyncGenerator<Uint8Array> { yield Buffer.from("tail "); await gate; yield Buffer.from("end"); }
    const publishing = b.publish({ commandId: "shared-store", actor: me, name: "x", files: [file("early.txt", "stored early"), { path: "slow.bin", content: slow() }] });
    for (let i = 0; i < 200 && !(await blobs.has(sha("stored early"))); i++) await new Promise((r) => setTimeout(r, 10));
    age(blobs.pathOf(sha("stored early")), 10 * DAY);
    let finished = false;
    const collecting = a.collectOrphans({ olderThanMs: 0, now: Date.now() + 1000 }).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finished, false, "cleanup by the other service waits for the publication");
    release();
    const [published, report] = await Promise.all([publishing, collecting]);
    assert.deepEqual(report.orphans, []);
    assert.ok((await b.verify(published.id)).ok);
    void dir;
  } finally { done(); }
});

test("a deposed controller stops deleting between blobs", async () => {
  const inner = new MemoryStorage();
  const { artifacts, blobs, done } = await setup(inner);
  try {
    for (const text of ["one", "two", "three"]) { await blobs.put(Buffer.from(text)); age(blobs.pathOf(sha(text)), 5 * DAY); }
    let takeover = false;
    const spy = new Proxy(inner, { get: (target, name) => {
      const value = Reflect.get(target, name) as unknown;
      if (typeof value !== "function") return value;
      if (name === "currentEpoch") return async () => { const epoch = await target.currentEpoch(); if (takeover) return epoch + 1; takeover = (await blobs.list()).length < 3; return epoch; };
      return value.bind(target);
    } });
    const service = ArtifactService.withEpoch(spy, artifacts.epoch, blobs, fast);
    await refuses("stale_epoch", () => service.collectOrphans({ olderThanMs: DAY }), (e) => assert.match(e.message, /lost the primary epoch/));
    assert.ok((await blobs.list()).length >= 1, "the controller stopped before finishing its list");
  } finally { done(); }
});
