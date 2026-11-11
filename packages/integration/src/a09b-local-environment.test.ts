import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ScriptedInterpreter, startController, type EnvironmentFacts, type EnvironmentRuntime, type FilesystemDetector } from "@nimblenewt/controller";
import { hostEnvironmentsBase, localEnvironmentHost, type ArtifactSource } from "@nimblenewt/worker";

// Card A09 follow-up: the real local environment runtime (the worker package) behind the controller's real applier. The archives are built here by hand (a minimal ustar writer), nothing is fetched from a network:
// the "registry" is a map from the request's https source to bytes.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

function tarEntry(path: string, data: string): Buffer {
  const body = Buffer.from(data); const h = Buffer.alloc(512);
  h.write(path, 0); h.write("0000644\0", 100, "latin1"); h.write("0000000\0", 108, "latin1"); h.write("0000000\0", 116, "latin1");
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1"); h.write("00000000000\0", 136, "latin1"); h.fill(0x20, 148, 156); h.write("0", 156, "latin1"); h.write("ustar\0", 257, "latin1"); h.write("00", 263, "latin1");
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function pack(name: string, version: string, files: Record<string, string>, scripts?: Record<string, string>): { bytes: Buffer; digest: string } {
  const meta = JSON.stringify({ name, version, ...(scripts === undefined ? {} : { scripts }) });
  const bytes = gzipSync(Buffer.concat([tarEntry("nimblenewt-package.json", meta), ...Object.entries(files).map(([p, d]) => tarEntry(p, d)), Buffer.alloc(1024)]));
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}
const D = (c: string): string => `sha256:${c.repeat(64)}`;

test("an approved package is installed into the agent's environment directory by the real local runtime: digest checked, scripts off, revision active, owner informed; a wrong digest and undeclared scripts are refused (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09b-"));
  const data = join(d, "data"); mkdirSync(data);
  const registry = new Map<string, Uint8Array>(); const fetched: string[] = [];
  const source: ArtifactSource = { fetch: async (url) => { fetched.push(url); const b = registry.get(url); if (b === undefined) throw new Error("not in the registry"); return b; } };
  const restarts: number[] = [];
  const host = localEnvironmentHost({ root: hostEnvironmentsBase(data), protectedPaths: [data], source, worker: { restart: async (e) => { restarts.push(e.revision); }, session: async () => ({ sessionIntact: true, compactionIntact: true }) } });
  assert.equal(host.problem, undefined);
  // The compiler checks that the worker's runtime is the controller's port.
  const port: EnvironmentRuntime = host.runtime!;
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], chat: { interpreter: new ScriptedInterpreter(() => []) }, maintenance: { environmentRuntime: port } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    let n = 0; const cid = (l: string): string => `${l}-${n++}`;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ann = await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: "Ann", roles: ["author"] } as never);
    const annToken = (await c.services.principals.issueCredential(rob, `agent:${ann.id}`)).token;
    const agentId = `agent:${ann.id}`;
    await c.services.environments.change(rob, { commandId: cid("env"), agentId, manifest: { base: { name: "nimblenewt-base", version: "1.0.0", digest: D("1") }, packages: [], skills: [], capabilities: [], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 1024, diskMb: 500, processes: 100 }, protectedExtensions: [] }, reason: "first environment" });
    await c.services.environments.activate(rob, { commandId: cid("act"), agentId, revision: 1, observed: {} });
    const approve = async (request: Record<string, unknown>, commandId: string): Promise<any> => {
      const asked = await call(annToken, "maintenance.request", { kind: "package", spec: request, reason: "needed", rollbackPlan: "remove it" }, commandId);
      assert.equal(asked.ok, true, JSON.stringify(asked));
      const id = asked.result.maintenanceId as string;
      const specDigest = (await call(boot.token, "maintenance.get", { maintenanceId: id })).result.item.specDigest;
      assert.ok((await call(boot.token, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest }, cid("d"))).ok);
      await c.services.maintenance.idle();
      return (await call(boot.token, "maintenance.get", { maintenanceId: id })).result.item;
    };

    // ---- a good package: installed for real
    const good = pack("ripgrep", "1.2.3", { "bin/rg.js": "console.log('rg')\n" });
    registry.set("https://registry.example.org/ripgrep.tgz", good.bytes);
    const done = await approve({ name: "ripgrep", version: "1.2.3", digest: good.digest, source: "https://registry.example.org/ripgrep.tgz", installScripts: false }, "e1");
    assert.equal(done.status, "applied", JSON.stringify(done));
    assert.equal(done.effect.environmentRevision, 2);
    const live = realpathSync(join(host.runtime!.environments.agentDir(agentId), "active"));
    assert.equal(readFileSync(join(live, "packages", "ripgrep", "bin", "rg.js"), "utf8"), "console.log('rg')\n");
    assert.deepEqual(restarts, [2]);
    assert.equal((await call(boot.token, "environment.get", { agentId })).result.item.active.revision, 2);
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: ann.id }))?.intent, "active", "the agent works again");
    assert.deepEqual(fetched, ["https://registry.example.org/ripgrep.tgz"], "fetched once, for the trial; the reload used the verified copy");
    const grant = await host.reach("environment", { agentId });
    assert.equal(grant!.readOnly![0]!.guest, "/opt/environment");

    // ---- the bytes served are not the bytes approved: nothing is installed and the request fails with the reason
    const wrong = pack("fd", "9.0.0", { "bin/fd.js": "evil\n" });
    registry.set("https://registry.example.org/fd.tgz", wrong.bytes);
    const mismatch = await approve({ name: "fd", version: "9.0.0", digest: D("c"), source: "https://registry.example.org/fd.tgz", installScripts: false }, "e2");
    assert.equal(mismatch.status, "failed");
    assert.match(mismatch.failure.reason, /digest mismatch/);
    assert.equal((await call(boot.token, "environment.get", { agentId })).result.item.active.revision, 2);
    assert.ok(!readdirSync(join(live, "packages")).includes("fd"));

    // ---- a package whose scripts the request did not declare: refused, nothing installed
    const sneaky = pack("native", "1.0.0", { "setup.js": "process.stdout.write('pwned')" }, { install: "setup.js" });
    registry.set("https://registry.example.org/native.tgz", sneaky.bytes);
    const scripts = await approve({ name: "native", version: "1.0.0", digest: sneaky.digest, source: "https://registry.example.org/native.tgz", installScripts: false }, "e3");
    assert.equal(scripts.status, "failed");
    assert.match(scripts.failure.reason, /install scripts/);
    assert.equal((await call(boot.token, "environment.get", { agentId })).result.item.active.revision, 2);
    assert.equal(existsSync(join(host.runtime!.root, "agents")), true);
    assert.deepEqual(readdirSync(join(host.runtime!.root, "trials")), [], "no disposable environment is left");
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: ann.id }))?.intent, "active");
    assert.deepEqual(readdirSync(data).filter((f) => f.includes("environments")), [], "nothing was written inside the data directory");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("the local host builder wires the environment runtime into the controller's start only when the setup asks for it and the host supports it (card A09)", async (t) => {
  const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { SandboxLauncher } = await import("@nimblenewt/worker");
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) { if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const { localHostBuilder } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string; environments?: boolean }) => (ctx: unknown) => Promise<{ start: { maintenance?: { environmentRuntime?: unknown } }; close(): Promise<void> } | { problem: string }> };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn a09b host ")));
  try {
    for (const environments of [false, true]) {
      const dataDir = join(parent, environments ? "on" : "off"); mkdirSync(dataDir);
      const plan = await localHostBuilder({ root: repository, environments })({ dataDir, print: () => undefined, endpoint: async () => undefined, controller: () => { throw new Error("not needed to build"); } });
      assert.ok(!("problem" in plan), JSON.stringify(plan));
      if ("problem" in plan) return;
      try {
        assert.equal(plan.start.maintenance?.environmentRuntime !== undefined, environments);
        assert.equal(existsSync(hostEnvironmentsBase(dataDir)), environments, "the environments directory exists only when asked for, beside the data directory");
        assert.deepEqual(readdirSync(dataDir), [], "and nothing was made inside the data directory");
      } finally { await plan.close(); }
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
