import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { backends } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/index.js";
import { RECOVERY_MANIFEST_FILE, RecoveryManifestBad, RecoveryWriteRefused, readRecoveryManifest, writeFencedRecoveryManifest, writeRecoveryManifest, type RecoverySource } from "./index.js";
import { promoteDatabaseWith } from "./promotion.js";

// Card K04, second review: two writers on one manifest folder, interleaved at each file-system step of the swap. A is an old primary still running on its own copy of the database (its
// epoch looks current there), B the primary that took over. Whatever the order, the folder never ends up holding a manifest a promotion accepts that is older than B's: it holds B's
// whole manifest, or a mix a promotion refuses with B's manifest.json still in place (so A stops at its next look and B's next round writes a whole one again).

const T = "2026-11-27T10:00:00.000Z";
const FILES = ["manifest.json", "aggregates.jsonl", "blobs.jsonl"] as const;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k04i-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const fsc = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const realRename = fsc.renameSync;
const realLink = fsc.linkSync;

/** Runs `inject` right after A's `at`-th rename or link that touches `folder` (0: before the first move-aside); after the run when A made fewer calls. Restores the real functions after. */
async function interleaved<T>(folder: string, at: number, inject: () => void, run: () => Promise<T>): Promise<{ readonly result: T | undefined; readonly error: unknown; readonly calls: number }> {
  let calls = 0; let done = false;
  const touches = (a: unknown, b: unknown): boolean => dirname(String(a)) === folder || dirname(String(b)) === folder;
  // `at` k: B runs after A's k-th call and before its next one (0: before the first); a call that throws still counts
  const now = (): void => { if (calls === at && !done) { done = true; inject(); } };
  const step = <R>(a: unknown, b: unknown, real: () => R): R => { if (!touches(a, b)) return real(); now(); try { return real(); } finally { calls++; now(); } };
  fsc.renameSync = ((a: string, b: string) => step(a, b, () => realRename(a, b))) as typeof fsc.renameSync;
  fsc.linkSync = ((a: string, b: string) => step(a, b, () => realLink(a, b))) as typeof fsc.linkSync;
  syncBuiltinESMExports();
  try {
    const result = await run();
    if (!done) { done = true; inject(); }
    return { result, error: undefined, calls };
  } catch (error) {
    if (!done) { done = true; inject(); }
    return { result: undefined, error, calls };
  } finally {
    fsc.renameSync = realRename; fsc.linkSync = realLink; syncBuiltinESMExports();
  }
}

/** B's swap as one step, with the real calls: its files moved aside (when `moveAside`), the other two renamed in, manifest.json linked in last. */
function swapIn(folder: string, from: string, moveAside: boolean): void {
  const aside = mkdtempSync(join(dirname(folder), "b-aside-"));
  if (moveAside) for (const f of FILES) { try { realRename(join(folder, f), join(aside, f)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  for (const f of ["aggregates.jsonl", "blobs.jsonl", "manifest.json"]) { copyFileSync(join(from, f), join(aside, `${f}.new`)); }
  realRename(join(aside, "aggregates.jsonl.new"), join(folder, "aggregates.jsonl"));
  realRename(join(aside, "blobs.jsonl.new"), join(folder, "blobs.jsonl"));
  realRename(join(aside, "manifest.json.new"), join(folder, "manifest.json"));
  gone(aside);
}

const epochOf = (folder: string): number | "refused" => { try { return readRecoveryManifest(folder).manifest.watermark.epoch; } catch (e) { assert.ok(e instanceof RecoveryManifestBad, String(e)); return "refused"; } };
const text = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

async function twoCopies(): Promise<{ readonly a: ControllerStorage; readonly b: ControllerStorage; readonly ea: number; readonly eb: number; close(): Promise<void> }> {
  const wa = await backends[0]!.open(); const wb = await backends[0]!.open();
  await wa.storage.acquireEpoch({ holder: "old", at: T });
  await wb.storage.acquireEpoch({ holder: "old", at: T });
  await wb.storage.acquireEpoch({ holder: "promoted", at: T });
  // different records on each copy, so a mix of their files never matches either manifest
  const blobDir = tmp();
  const blobs = await FileBlobStore.open({ directory: blobDir });
  let n = 0;
  for (const [w, name] of [[wa, "old-report"], [wb, "new-report"], [wb, "newer-report"]] as const) {
    const artifacts = await ArtifactService.open(w.storage, blobs, { holder: "x", clock: () => T, pause: async () => undefined });
    await artifacts.publish({ commandId: `pub-${n++}`, actor: "rob", name, files: [{ path: "a.txt", content: Buffer.from(name) }] });
  }
  return { a: wa.storage, b: wb.storage, ea: await wa.storage.currentEpoch(), eb: await wb.storage.currentEpoch(), close: async () => { await wa.close(); await wb.close(); gone(blobDir); } };
}

test("A stale and B current, B's swap at every step of A's: the folder ends with B's whole manifest or a mix a promotion refuses with B's manifest.json in place; A is never counted as written", async () => {
  const s = await twoCopies();
  const dir = tmp();
  try {
    // B's manifest, made by the real fenced writer from B's store
    const bsrc = join(dir, "bsrc");
    await writeFencedRecoveryManifest({ storage: s.b, epoch: s.eb, directory: bsrc, now: () => new Date(T) });
    const bManifest = text(join(bsrc, RECOVERY_MANIFEST_FILE));
    const outcomes: string[] = [];
    // with an older manifest of A's epoch in the folder (B moves it aside first), and with an empty folder B fills without a move-aside
    for (const [scenario, seeded, moveAside] of [["older in place", true, true], ["empty, B renames in", false, false], ["older in place, B renames in", true, false]] as const) {
      for (let at = 0; at <= 6; at++) {
        const m = join(dir, `${scenario.replace(/\W+/g, "-")}-${at}`);
        if (seeded) await writeFencedRecoveryManifest({ storage: s.a, epoch: s.ea, directory: m, now: () => new Date(T) });
        const before = readdirSync(dir).filter((n) => n.includes(".partial-")).length;
        const r = await interleaved(m, at, () => swapIn(m, bsrc, moveAside), () => writeFencedRecoveryManifest({ storage: s.a, epoch: s.ea, directory: m }));
        const final = epochOf(m);
        const label = `${scenario}, B before A's step ${at} (A made ${r.calls} calls)`;
        assert.notEqual(final, s.ea, `${label}: an older manifest a promotion would accept is in place`);
        if (final === "refused") assert.equal(text(join(m, RECOVERY_MANIFEST_FILE)), bManifest, `${label}: a refused folder still holds B's manifest.json`);
        else assert.equal(final, s.eb, label);
        assert.equal(r.result, undefined, `${label}: A is not counted as written`);
        assert.ok(r.error instanceof RecoveryWriteRefused || r.error instanceof Error, label);
        assert.equal(readdirSync(dir).filter((n) => n.includes(".partial-")).length, before, `${label}: no staging folder left`);
        outcomes.push(`${label}: ${final === "refused" ? "refused mix" : "B whole"} / ${r.error instanceof RecoveryWriteRefused ? r.error.reason : (r.error as Error).message.slice(0, 40)}`);
      }
    }
    // the steps that matter were all reached: B's swap landed before A's move-aside, between its steps, and after its link
    assert.ok(outcomes.some((o) => /B whole/.test(o)) && outcomes.filter((o) => /step 6/.test(o)).length === 3, outcomes.join("\n"));
    // most orders keep B whole; a mix is left only where B's files arrive after A moved the aggregates file aside and before A renamed its blobs file in (a rename cannot refuse a taken
    // name, so B's aggregates or blobs file is replaced there); B's manifest.json stays, so it is refused, never accepted
    for (const o of outcomes) if (/refused mix/.test(o)) assert.match(o, /step [234] /, o);
    assert.ok(outcomes.filter((o) => /B whole/.test(o)).length >= 12, outcomes.join("\n"));
  } finally { await s.close(); gone(dir); }
});

test("A current and C stale, C's swap at every step of A's: A's whole manifest ends in place (an older one in the slot is replaced) or A says it did not write", async () => {
  const s = await twoCopies();
  const dir = tmp();
  try {
    const csrc = join(dir, "csrc");
    await writeFencedRecoveryManifest({ storage: s.a, epoch: s.ea, directory: csrc, now: () => new Date(T) });
    for (let at = 0; at <= 6; at++) {
      const m = join(dir, `m-${at}`);
      await writeFencedRecoveryManifest({ storage: s.b, epoch: s.eb, directory: m, now: () => new Date("2026-11-27T09:00:00.000Z") });
      const r = await interleaved(m, at, () => swapIn(m, csrc, true), () => writeFencedRecoveryManifest({ storage: s.b, epoch: s.eb, directory: m }));
      const final = epochOf(m);
      if (r.error === undefined) assert.equal(final, s.eb, `step ${at}: written means A's whole manifest is in place`);
      else assert.ok(!(r.error instanceof RecoveryWriteRefused && r.error.reason === "manifest_newer"), `step ${at}: the current writer is never fenced by an older manifest (${String(r.error)})`);
      // an older manifest a promotion would accept is left only when C's whole swap lands after A's last step: B's next round replaces it, and a promotion's notes say its epoch is older
      if (final === s.ea) { assert.equal(at, 6, `step ${at}`); assert.match(String(r.error), /replaced the manifest just put in place with an older one/); }
    }
  } finally { await s.close(); gone(dir); }
});

test("two writers in one process never share a staging folder, and the manifest.json link is refused by a taken name: a plain writer then keeps the other manifest and puts its files back", async () => {
  const dir = tmp();
  try {
    const src = (epoch: number): RecoverySource => ({ watermark: async () => ({ epoch, auditSeq: epoch, deliverySeq: 0 }), aggregates: async function* () { yield { kind: "task", id: `t${epoch}`, revision: 1 }; } });
    const m = join(dir, "m");
    // two writes at once in one process: both complete, each with its own staging folder, and the folder holds one whole manifest
    const seen = new Set<string>();
    let slow: () => void = () => undefined;
    const gate = new Promise<void>((r) => { slow = r; });
    const one = writeRecoveryManifest(src(1), m, { beforeSwap: async () => { for (const n of readdirSync(dir)) if (n.includes(".partial-")) seen.add(n); await gate; } });
    const two = writeRecoveryManifest(src(2), m, { beforeSwap: async () => { for (const n of readdirSync(dir)) if (n.includes(".partial-")) seen.add(n); slow(); } });
    await Promise.all([one, two]);
    assert.equal(seen.size, 2, `two staging folders: ${[...seen].join(", ")}`);
    assert.match([...seen][0]!, new RegExp(`^m\\.partial-${process.pid}-[0-9a-f]{12}$`));
    assert.equal(readRecoveryManifest(m).manifest.watermark.epoch, 1, "the later swap's manifest is whole");
    assert.deepEqual(readdirSync(dir), ["m"]);
    for (const f of FILES) assert.equal(statSync(join(m, f)).mode & 0o777, 0o600, f);
    // a manifest.json put in the slot after the move-aside: the plain writer keeps it and puts back the files it names
    const other = join(dir, "other");
    await writeRecoveryManifest(src(9), other);
    const keep = text(join(other, RECOVERY_MANIFEST_FILE));
    const r = await interleaved(m, 5, () => swapIn(m, other, true), () => writeRecoveryManifest(src(3), m));
    assert.ok(r.error instanceof RecoveryManifestBad && /another writer put a manifest\.json/.test(r.error.message), String(r.error));
    assert.equal(text(join(m, RECOVERY_MANIFEST_FILE)), keep);
    assert.equal(readRecoveryManifest(m).manifest.watermark.epoch, 9, "whole: its own aggregates and blobs files");
    // its aggregates file moved aside by the writer (it arrived between the move-aside steps) is put back from staging
    const m2 = join(dir, "m2");
    await writeRecoveryManifest(src(1), m2);
    const r2 = await interleaved(m2, 1, () => swapIn(m2, other, false), () => writeRecoveryManifest(src(3), m2));
    assert.ok(r2.error instanceof RecoveryManifestBad, String(r2.error));
    assert.equal(readRecoveryManifest(m2).manifest.watermark.epoch, 9, "the displaced aggregates and blobs of the kept manifest were put back");
  } finally { gone(dir); }
});

test("a crash at any step of a single writer's swap leaves the old manifest, none, or the new one: never a mix a promotion accepts", async () => {
  const dir = tmp();
  try {
    const src = (epoch: number): RecoverySource => ({ watermark: async () => ({ epoch, auditSeq: epoch, deliverySeq: 0 }), aggregates: async function* () { yield { kind: "task", id: `t${epoch}`, revision: epoch }; } });
    for (let at = 0; at <= 6; at++) {
      const m = join(dir, `m-${at}`);
      await writeRecoveryManifest(src(1), m);
      const snap = join(dir, `snap-${at}`);
      // the folder as a crash at this step would leave it (copied before the step runs)
      await interleaved(m, at, () => { mkdirSync(snap); for (const f of FILES) if (existsSync(join(m, f))) copyFileSync(join(m, f), join(snap, f)); }, () => writeRecoveryManifest(src(2), m));
      const e = epochOf(snap);
      assert.ok(e === 1 || e === 2 || e === "refused", `step ${at}: ${e}`);
      if (e === "refused") assert.equal(existsSync(join(snap, RECOVERY_MANIFEST_FILE)), false, `step ${at}: refused only for want of manifest.json, never a mix`);
      assert.equal(epochOf(m), 2);
    }
  } finally { gone(dir); }
});

test("a mix of two manifests' files is refused by a promotion (manifest.json is checked against the checksums of the files it names)", async () => {
  const dir = tmp();
  try {
    const src = (epoch: number): RecoverySource => ({ watermark: async () => ({ epoch, auditSeq: 10, deliverySeq: 3 }), aggregates: async function* () { yield { kind: "task", id: "t1", revision: epoch }; } });
    const a = join(dir, "a"); const b = join(dir, "b");
    await writeRecoveryManifest(src(2), a); await writeRecoveryManifest(src(3), b);
    copyFileSync(join(b, "aggregates.jsonl"), join(a, "aggregates.jsonl"));
    assert.throws(() => readRecoveryManifest(a), /aggregates\.jsonl does not match the manifest's size and checksum/);
    const facts = { inRecovery: true, writable: false, systemIdentifier: "7", positionLsn: "0/5000000", receivedLsn: "0/5000000", synchronousStandbyNames: "", synchronousCommit: "on" };
    let promoted = 0;
    const steps = { probe: async () => facts, state: () => ({ watermark: async () => ({ epoch: 3, auditSeq: 10, deliverySeq: 3 }), aggregates: async function* () { yield { kind: "task", id: "t1", revision: 3 }; } }), promote: async () => { promoted++; return { promoted: true as const, positionLsn: "0/6000000" }; } } as unknown as Parameters<typeof promoteDatabaseWith>[1];
    const options = { manifestDirectory: a, standby: { url: "postgres://standby/y", schema: "nimblenewt" }, blobs: { verify: async () => "ok" as const }, oldPrimaryUrl: null, replayWaitMs: 60 } as Parameters<typeof promoteDatabaseWith>[0];
    await assert.rejects(promoteDatabaseWith(options, steps), (e: unknown) => e instanceof Error && e.name === "PromotionRefused");
    assert.equal(promoted, 0);
    // the whole manifest of the earlier epoch passes with a note; the decision is the same as without the note's condition
    const ok = await promoteDatabaseWith({ ...options, manifestDirectory: b }, steps);
    assert.equal(ok.database, "promoted"); assert.equal(promoted, 1);
    assert.doesNotMatch(ok.notes.join(" | "), /written under epoch/);
    const older = join(dir, "older"); await writeRecoveryManifest(src(2), older);
    const withNote = await promoteDatabaseWith({ ...options, manifestDirectory: older }, steps);
    assert.equal(withNote.database, "promoted"); assert.match(withNote.notes.join(" | "), /written under epoch 2 and the standby holds epoch 3/);
    // a standby behind the older manifest is still refused, note or not
    const behind = { ...steps, state: () => ({ watermark: async () => ({ epoch: 3, auditSeq: 9, deliverySeq: 3 }), aggregates: async function* () { yield { kind: "task", id: "t1", revision: 3 }; } }) } as unknown as Parameters<typeof promoteDatabaseWith>[1];
    await assert.rejects(promoteDatabaseWith({ ...options, manifestDirectory: older }, behind), (e: unknown) => e instanceof Error && e.name === "PromotionRefused" && /audit log stops at 9/.test(e.message));
    assert.equal(promoted, 2);
  } finally { gone(dir); }
});
