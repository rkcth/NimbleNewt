import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { NewDependency } from "./dependencies.js";
import { DependencyService } from "./index.js";
import { checkoutDependencyObserver, type ProbeFileSystem } from "./observe.js";

after(stopServer);

const options = { clock: () => "2026-11-09T10:00:00.000Z", pause: async () => undefined };
const H = (text: string): string => createHash("sha256").update(text).digest("hex");
const real: ProbeFileSystem = {
  realpath: (p) => realpath(p),
  stat: async (p) => { const s = await stat(p); return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), size: s.size }; },
  readFile: (p) => readFile(p),
  readdir: async (p) => await readdir(p),
};
/** The same file system, telling which paths a probe asked for (to show what it never touched). */
const watched = (seen: string[], inner: ProbeFileSystem = real): ProbeFileSystem => ({
  realpath: async (p) => { seen.push(p); return inner.realpath(p); },
  stat: async (p) => { seen.push(p); return inner.stat(p); },
  readFile: async (p) => { seen.push(p); return inner.readFile(p); },
  readdir: async (p) => { seen.push(p); return inner.readdir(p); },
});
/** A file system where one named file refuses every look. */
const blocked = (name: string, code: string, inner: ProbeFileSystem = real): ProbeFileSystem => ({
  realpath: (p) => inner.realpath(p),
  stat: async (p) => { if (p.endsWith(name)) throw Object.assign(new Error(`${name}: permission denied`), { code }); return inner.stat(p); },
  readFile: async (p) => { if (p.endsWith(name)) throw Object.assign(new Error(`${name}: permission denied`), { code }); return inner.readFile(p); },
  readdir: (p) => inner.readdir(p),
});

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

interface Ctx { deps: DependencyService; owner: Principal; ann: Principal; task: string; checkout: string; outside: string; dir: string }
for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    const dir = mkdtempSync(join(tmpdir(), "nn-probe-"));
    const checkout = join(dir, "checkout"), outside = join(dir, "outside");
    mkdirSync(checkout, { recursive: true }); mkdirSync(outside, { recursive: true });
    try {
      const projects = await ProjectService.open(world.storage, { holder: "probe", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "attempt.work", project: a }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      await body({ deps: DependencyService.withEpoch(world.storage, projects.epoch, options), owner, ann, task, checkout, outside, dir });
    } finally { await world.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  const record = (c: Ctx, dependencies: NewDependency[]) => c.deps.record(c.ann, { commandId: cid("r"), taskId: c.task, dependencies });
  const observe = (c: Ctx, extra: Partial<Parameters<typeof checkoutDependencyObserver>[0]> = {}) => checkoutDependencyObserver({ manifest: async (taskId) => await c.deps.get(c.owner, taskId), locate: () => c.checkout, ...extra });
  const statuses = async (c: Ctx, observations: Awaited<ReturnType<ReturnType<typeof checkoutDependencyObserver>>>): Promise<Record<string, string>> =>
    Object.fromEntries((await c.deps.check(c.owner, c.task, observations)).map((r) => [r.key, r.status]));

  suite("a probe reads each recorded file and directory again: unchanged, changed, deleted, not unknown", async (c) => {
    writeFileSync(join(c.checkout, "a.ts"), "one");
    writeFileSync(join(c.checkout, "b.ts"), "different than recorded");
    mkdirSync(join(c.checkout, "src"), { recursive: true });
    writeFileSync(join(c.checkout, "src", "x.ts"), "x");
    writeFileSync(join(c.checkout, "src", "new.ts"), "new");
    await record(c, [
      { kind: "file", key: "a.ts", hash: H("one") },
      { kind: "file", key: "b.ts", hash: H("recorded") },
      { kind: "file", key: "gone.ts", hash: H("was here") },
      { kind: "directory", key: "src", members: ["x.ts", "gone.ts"] },
    ]);
    const by = await statuses(c, await observe(c)(c.task));
    assert.deepEqual(by, { "a.ts": "unchanged", "b.ts": "changed", "gone.ts": "deleted", src: "new-members" });
  });

  suite("without the probe the same manifest is all unknown (what L04d replaces)", async (c) => {
    writeFileSync(join(c.checkout, "a.ts"), "one");
    await record(c, [{ kind: "file", key: "a.ts", hash: H("one") }, { kind: "directory", key: "src", members: ["x.ts"] }]);
    assert.deepEqual(await statuses(c, {}), { "a.ts": "unknown", src: "unknown" });
    assert.deepEqual(await statuses(c, await observe(c)(c.task)), { "a.ts": "unchanged", src: "deleted" }, "the same task, probed");
  });

  suite("a key that is not a path below the checkout is never opened", async (c) => {
    writeFileSync(join(c.outside, "secret"), "the outside file");
    writeFileSync(join(c.checkout, "ok.ts"), "fine");
    await record(c, [
      { kind: "file", key: "../outside/secret", hash: H("x") },
      { kind: "file", key: "/etc/passwd", hash: H("x") },
      { kind: "file", key: "src/../../outside/secret", hash: H("x") },
      { kind: "file", key: "C:/Windows/win.ini", hash: H("x") },
      { kind: "file", key: "~/.ssh/id_ed25519", hash: H("x") },
      { kind: "file", key: "ok.ts", hash: H("fine") },
    ]);
    const seen: string[] = [];
    const observations = await observe(c, { fs: watched(seen) })(c.task);
    assert.deepEqual(await statuses(c, observations), { "../outside/secret": "unknown", "/etc/passwd": "unknown", "src/../../outside/secret": "unknown", "C:/Windows/win.ini": "unknown", "~/.ssh/id_ed25519": "unknown", "ok.ts": "unchanged" });
    assert.ok(seen.every((p) => !p.includes("secret") && !p.includes("passwd") && !p.includes("id_ed25519") && !p.includes("win.ini")), `the probe looked outside the checkout: ${seen.join(" ")}`);
    assert.ok(!Object.values(observations).some((o) => o.hash === H("the outside file")), "the outside file was not hashed");
  });

  suite("a link out of the checkout is not followed", async (c) => {
    writeFileSync(join(c.outside, "secret"), "the outside file");
    symlinkSync(join(c.outside, "secret"), join(c.checkout, "link.ts"));
    await record(c, [{ kind: "file", key: "link.ts", hash: H("whatever") }]);
    const observations = await observe(c)(c.task);
    assert.deepEqual(await statuses(c, observations), { "link.ts": "unknown" });
    assert.deepEqual(observations, {}, "nothing is claimed about a file that resolves outside the checkout");
  });

  suite("what is too big to read, too wide to list or beyond the cap is left unknown", async (c) => {
    writeFileSync(join(c.checkout, "big.ts"), "0123456789");
    writeFileSync(join(c.checkout, "small.ts"), "small");
    mkdirSync(join(c.checkout, "wide"), { recursive: true });
    for (let i = 0; i < 201; i++) writeFileSync(join(c.checkout, "wide", `f${i}.ts`), "x");
    await record(c, [
      { kind: "file", key: "big.ts", hash: H("0123456789") },
      { kind: "file", key: "small.ts", hash: H("small") },
      { kind: "directory", key: "wide", members: ["f0.ts"] },
    ]);
    const bySize = await statuses(c, await observe(c, { maxBytes: 8 })(c.task));
    assert.deepEqual(bySize, { "big.ts": "unknown", "small.ts": "unchanged", wide: "unknown" }, "a file larger than a probe reads is not guessed at, and a directory wider than a listing is neither");
    const ids = (await c.deps.get(c.owner, c.task))!.entries.map((e) => e.id).sort();
    const capped = await observe(c, { maxEntries: 1 })(c.task);
    assert.deepEqual(Object.keys(capped), [ids[0]], "only the first entry of the cap is read");
    assert.deepEqual(Object.keys(await observe(c, { maxEntries: 0 })(c.task)), [], "a cap of none reads nothing");
  });

  suite("a checkout that cannot be found, or a manifest that cannot be read, leaves everything unknown and throws nothing", async (c) => {
    writeFileSync(join(c.checkout, "a.ts"), "one");
    await record(c, [{ kind: "file", key: "a.ts", hash: H("one") }]);
    const none = checkoutDependencyObserver({ manifest: async (taskId) => await c.deps.get(c.owner, taskId), locate: () => undefined });
    assert.deepEqual(await none(c.task), {});
    const relative = checkoutDependencyObserver({ manifest: async (taskId) => await c.deps.get(c.owner, taskId), locate: () => "checkout" });
    assert.deepEqual(await relative(c.task), {}, "a location that is not an absolute path is nowhere to look");
    const gone = checkoutDependencyObserver({ manifest: async (taskId) => await c.deps.get(c.owner, taskId), locate: () => join(c.dir, "not-here") });
    assert.deepEqual(await gone(c.task), {});
    const broken = checkoutDependencyObserver({ manifest: async () => { throw new Error("the store is closed"); }, locate: () => c.checkout });
    assert.deepEqual(await broken(c.task), {});
    assert.deepEqual(await statuses(c, await gone(c.task)), { "a.ts": "unknown" });
  });

  suite("one unreadable file leaves that one unknown and the rest read", async (c) => {
    writeFileSync(join(c.checkout, "locked.ts"), "closed");
    writeFileSync(join(c.checkout, "ok.ts"), "open");
    await record(c, [{ kind: "file", key: "locked.ts", hash: H("closed") }, { kind: "file", key: "ok.ts", hash: H("open") }]);
    const faults: string[] = [];
    const observations = await observe(c, { fs: blocked("locked.ts", "EACCES"), onFault: (d) => faults.push(d) })(c.task);
    assert.deepEqual(await statuses(c, observations), { "locked.ts": "unknown", "ok.ts": "unchanged" });
    assert.ok(faults.some((f) => f.includes("locked.ts")), JSON.stringify(faults));
  });

  suite("a name that changed kind is left unknown, and a directory that is gone reads deleted", async (c) => {
    mkdirSync(join(c.checkout, "turned"), { recursive: true });
    await record(c, [{ kind: "file", key: "turned", hash: H("x") }, { kind: "directory", key: "was-here", members: ["a"] }]);
    writeFileSync(join(c.checkout, "was-here"), "a file where a directory was");
    const faults: string[] = [];
    const observations = await observe(c, { onFault: (d) => faults.push(d) })(c.task);
    assert.deepEqual(await statuses(c, observations), { turned: "unknown", "was-here": "unknown" }, "what a file became, or a directory became, is not a listing the probe can give");
    assert.ok(faults.some((f) => f.includes("turned")) && faults.some((f) => f.includes("was-here")), JSON.stringify(faults));
    unlinkSync(join(c.checkout, "was-here"));
    assert.deepEqual(await statuses(c, await observe(c)(c.task)), { turned: "unknown", "was-here": "deleted" }, "gone is something a probe can tell");
  });

  suite("the kinds a probe cannot settle are left out of its answer", async (c) => {
    writeFileSync(join(c.checkout, "a.ts"), "one");
    await record(c, [
      { kind: "file", key: "a.ts", hash: H("one") },
      { kind: "search", key: "todo", scope: { query: "TODO" }, cursor: 40, hash: H("results") },
      { kind: "external", key: "https://example.test/spec", hash: H("page"), freshness: "conditional-read" },
      { kind: "mcp-resource", key: "mcp://srv/res1", hash: H("r"), server: "srv", protocol: "2025-06-18", freshness: "authoritative-query" },
      { kind: "negative", key: "worker:gone" },
    ]);
    const observations = await observe(c)(c.task);
    assert.deepEqual(Object.keys(observations).length, 1, JSON.stringify(observations));
    const by = Object.fromEntries((await c.deps.check(c.owner, c.task, observations)).map((r) => [r.kind, r.status]));
    assert.deepEqual(by, { file: "unchanged", search: "unknown", external: "unknown", "mcp-resource": "unknown", negative: "unknown" });
  });
}
