import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { localEnvironmentHost } from "./host.js";
import { LocalResourceStore } from "./resources.js";

// Card A09, mount application: the host's named resources. A resource is mountable only when it is a real directory directly inside the host's resource directory with nothing but plain files and directories in it.

const dirs: string[] = [];
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "nn-res-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
/** Makes a link, or reports that this machine does not allow one (Windows without the right). */
function link(target: string, path: string, type: "dir" | "file" = "dir"): boolean {
  try { symlinkSync(target, path, type === "dir" ? "junction" : "file"); return true; } catch { return false; }
}

test("a real directory of plain files is mountable and the host path is never in the answer the controller sees", async () => {
  const root = fresh();
  mkdirSync(join(root, "ann.data", "sub"), { recursive: true });
  writeFileSync(join(root, "ann.data", "a.txt"), "x"); writeFileSync(join(root, "ann.data", "sub", "b.txt"), "y");
  const store = new LocalResourceStore(root);
  const found = await store.resolve("ann.data");
  assert.equal(found.ok, true);
  assert.deepEqual(await store.check("ann.data"), { ok: true });
  assert.equal(JSON.stringify(await store.check("ann.data")).includes(root), false);
});

test("a name that is not a resource name, an absent resource, a file, a missing root and a root that is not a directory are refused with a reason", async () => {
  const root = fresh();
  writeFileSync(join(root, "plain"), "x");
  const store = new LocalResourceStore(root);
  for (const bad of ["", "../x", "a/b", "A.upper", ".hidden", "x".repeat(81), "a b"]) assert.equal((await store.check(bad)).ok, false, bad);
  assert.match((await store.check("absent")).ok === false ? ((await store.check("absent")) as { reason: string }).reason : "", /no resource of that name/);
  assert.match(((await store.check("plain")) as { reason: string }).reason, /not a real directory/);
  assert.match(((await new LocalResourceStore(join(root, "nowhere")).check("x")) as { reason: string }).reason, /no resource directory/);
  assert.match(((await new LocalResourceStore(join(root, "plain")).check("x")) as { reason: string }).reason, /not a real directory/);
});

test("a resource that is a link, reached through a link, or holding a link anywhere inside is refused (a mount does not follow links)", async (t) => {
  const root = fresh(); const outside = fresh();
  mkdirSync(join(root, "ok.one")); writeFileSync(join(outside, "secret"), "s");
  mkdirSync(join(root, "deep", "inner"), { recursive: true });
  const store = new LocalResourceStore(root);
  if (!link(outside, join(root, "vialink"))) return t.skip("this machine does not allow links");
  assert.match(((await store.check("vialink")) as { reason: string }).reason, /not a real directory/);
  assert.equal(link(outside, join(root, "deep", "inner", "escape")), true);
  assert.match(((await store.check("deep")) as { reason: string }).reason, /holds a link/);
  assert.equal(link(join(outside, "secret"), join(root, "ok.one", "file-link"), "file"), true);
  assert.match(((await store.check("ok.one")) as { reason: string }).reason, /holds a link/);
  // A root that is itself a link is refused.
  const rootLink = join(fresh(), "r");
  assert.equal(link(root, rootLink), true);
  assert.match(((await new LocalResourceStore(rootLink).check("deep")) as { reason: string }).reason, /not a real directory/);
});

test("a resource with more entries than the walk limit is refused, never half checked", async () => {
  const root = fresh();
  mkdirSync(join(root, "big"));
  for (let i = 0; i < 12; i++) writeFileSync(join(root, "big", `f${i}`), "x");
  assert.equal((await new LocalResourceStore(root, { walkLimit: 20 }).check("big")).ok, true);
  assert.match(((await new LocalResourceStore(root, { walkLimit: 5 }).check("big")) as { reason: string }).reason, /more than 5 entries/);
});

test("the local host answers the reach mount:<resource> with a read-only mount of its own directory, checked again now, and refuses a resource it does not hold", { skip: process.platform !== "linux" }, async () => {
  const base = fresh(); const data = join(base, "data"); mkdirSync(data);
  const host = localEnvironmentHost({ root: join(base, "environments"), worker: { session: async () => ({ sessionIntact: true, compactionIntact: true }) }, protectedPaths: [data] });
  assert.equal(host.problem, undefined);
  const resources = host.resources!;
  mkdirSync(join(resources.root, "ann.data"), { recursive: true }); writeFileSync(join(resources.root, "ann.data", "a.txt"), "x");
  const order = { agentId: "agent:ann" };
  const grant = await host.reach("mount:ann.data", order);
  assert.deepEqual(grant?.readOnly?.map((m) => [m.guest, m.host.endsWith(join("resources", "ann.data"))]), [["/inputs/mounts/ann.data", true]]);
  assert.equal(grant?.env, undefined, "a mount sets no environment");
  await assert.rejects(() => host.reach("mount:gone.data", order), /cannot be mounted: the host holds no resource/);
  await assert.rejects(() => host.reach("mount:../environments", order), /cannot be mounted/);
  assert.equal(await host.reach("something-else", order), undefined, "a name that is not this function's is left to others");
  // The directory changes after the approval: a link planted now is refused at the next attempt.
  const plant = join(resources.root, "ann.data", "planted");
  if (link(base, plant)) await assert.rejects(() => host.reach("mount:ann.data", order), /holds a link/);
  // A host that cannot have a runtime has no resource store either.
  const none = localEnvironmentHost({ root: join(base, "e2"), worker: { session: async () => ({ sessionIntact: true, compactionIntact: true }) }, platform: "darwin" });
  assert.equal(none.resources, undefined);
});
