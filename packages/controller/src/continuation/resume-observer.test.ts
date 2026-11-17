import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ManifestBody } from "../dependencies/index.js";
import { resumeObserver } from "./resume-observer.js";

// Card L04e: which disk the resume check reads a task's recorded files from on this machine, and when it does not read this machine's disk at all.
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), "nn-ro-")));
const put = (root: string, path: string, text: string): void => { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, text); };
const manifest = (...keys: string[]): ManifestBody => ({ taskId: "tsk-1", projectId: "prj-1", entries: keys.map((key, i) => ({ id: `dpm-${i}`, kind: "file" as const, key, hash: sha("x"), observedAt: "2026-11-16T00:00:00.000Z" })) as never });

test("the checkout the worker of this machine works in is read before the folder the repository is bound at, under the project's paths; with no worker checkout the bound folder is read", async () => {
  const bound = folder(), worker = folder();
  try {
    put(bound, "src/a.ts", "BOUND"); put(worker, "src/a.ts", "WORKER"); put(worker, "private/b.ts", "NO");
    const tell = async (workerCheckout: ((t: { taskId: string; projectId: string }) => string | undefined) | undefined) => await resumeObserver({
      manifest: async () => manifest("src/a.ts", "private/b.ts"), placedHostOf: async () => "host:here", remoteHostIds: new Set(), binding: async () => ({ root: bound, paths: ["src"] }),
      ...(workerCheckout === undefined ? {} : { workerCheckout }),
    })("tsk-1");
    const seenWorker = await tell(({ taskId, projectId }) => { assert.deepEqual([taskId, projectId], ["tsk-1", "prj-1"]); return worker; });
    assert.deepEqual(Object.values(seenWorker).map((o) => o.hash), [sha("WORKER")], "the file the agent changed in its own checkout, not the repository's copy; a file beyond the project's paths is never read");
    assert.deepEqual(Object.values(await tell(() => undefined)).map((o) => o.hash), [sha("BOUND")], "no worker checkout yet: the bound folder");
    assert.deepEqual(Object.values(await tell(undefined)).map((o) => o.hash), [sha("BOUND")]);
  } finally { rmSync(bound, { recursive: true, force: true }); rmSync(worker, { recursive: true, force: true }); }
});

test("with remote hosts, a task placed on one is never read from this machine's disk, and a task never placed is not read either; one placed here is", async () => {
  const bound = folder();
  try {
    put(bound, "a.ts", "A");
    const where: Record<string, string | undefined> = { far: "host:far", near: "host:near" };
    const make = (task: string, remote?: () => never) => resumeObserver({ manifest: async () => manifest("a.ts"), placedHostOf: async () => where[task], remoteHostIds: new Set(["host:far"]), binding: async () => ({ root: bound, paths: [] }), ...(remote === undefined ? {} : { remote }) });
    assert.equal(Object.keys(await make("near")("near")).length, 1, "placed on this machine");
    assert.deepEqual(await make("never")("never"), {}, "never placed: it may be about to go to a remote host");
    assert.deepEqual(await make("far")("far"), {}, "placed remotely and no way to ask that host: unknown, not this disk");
  } finally { rmSync(bound, { recursive: true, force: true }); }
});

test("a failure while asking a remote host is reported and leaves everything unobserved; it never throws and never falls back to this machine's disk", async () => {
  const bound = folder();
  try {
    put(bound, "a.ts", "A");
    const faults: string[] = [];
    const observe = resumeObserver({ manifest: async () => manifest("a.ts"), placedHostOf: async () => { throw new Error("storage went away"); }, remoteHostIds: new Set(["host:far"]), binding: async () => ({ root: bound, paths: [] }), onFault: (d) => faults.push(d) });
    assert.deepEqual(await observe("tsk-1"), {});
    assert.match(faults.join(" "), /storage went away/);
  } finally { rmSync(bound, { recursive: true, force: true }); }
});
