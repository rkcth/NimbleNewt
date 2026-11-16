import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OWNER_SECRET_PREFIX } from "../admin/admin.js";
import { BackupConfigService } from "../backup/config.js";
import { startFakeTarget } from "../backup/testing/target-server.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NetworkGrantService } from "../network/index.js";
import { PrincipalService } from "../security/index.js";
import { keptSecretRefusal } from "../setup/reserved-secrets.js";
import { WipBackupService } from "../wip-backup/index.js";
import { startController } from "./index.js";

after(stopServer);

// Task T4, second review: a model provider's key was not the only credential read from the secret store by NAME and sent to another party. A work-in-progress backup's push credential goes to its https remote, an
// off-machine backup target's credential goes to that target as a bearer token, and a network grant's credential goes to the granted destination in a header. None of them may name a secret the installation keeps
// for something else (the database address, a transfer target's address, the backup signing key, an owner credential), in any letter case: refused when recorded, and for the backup target also where it is read.
const KEPT = ["controller-db-url", "my-signing-key"];
const RESERVED = [...KEPT, "CONTROLLER-DB-URL", "My-Signing-Key", "backup-signing-key", "BACKUP-SIGNING-KEY", OWNER_SECRET_PREFIX, `${OWNER_SECRET_PREFIX}-0123456789abcdef`, `${OWNER_SECRET_PREFIX.toUpperCase()}-ABCDEF`];
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refused = (field: string) => (error: unknown): boolean => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, "invalid_command"); assert.match(error.message, new RegExp(`${field.replace(/\./g, "\\.")}.*(owner's credential|keeps that secret for something else|backup-signing key)`)); return true; };

test("the shared check names where the value would go and keeps the provider wording", () => {
  for (const name of RESERVED) {
    assert.match(keptSecretRefusal(name, KEPT, "a backup target")!, /never sent to a backup target$/, name);
    assert.match(keptSecretRefusal(name, KEPT, "a backup remote")!, /never sent to a backup remote$/, name);
  }
  for (const name of ["offsite-key", "controller-db", "my-signing-key-2", "nimblenewt-owner"]) assert.equal(keptSecretRefusal(name, KEPT, "a backup target"), undefined, name);
});

for (const backend of backends) {
  test(`${backend.name}: a backup target's, a work-in-progress backup's and a network grant's credential may not name a kept secret, in any letter case; nothing is recorded; an ordinary name is accepted (task T4)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1" });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, {});
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Garden" })).id;
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId, title: "weed" })).id;
      const config = BackupConfigService.withEpoch(world.storage, projects.epoch, {}, () => KEPT);
      const wip = WipBackupService.withEpoch(world.storage, projects.epoch, { kept: () => KEPT });
      const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch, { kept: () => KEPT });
      const auditBefore = (await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).length;
      for (const name of RESERVED) {
        await assert.rejects(config.addTarget(owner, { commandId: cid("bt"), name: "Cloud", kind: "offsite", location: "https://backup.example.invalid/store", credential: name }), refused("credential"), name);
        await assert.rejects(wip.set(owner, { commandId: cid("w"), projectId, enabled: true, remote: "https://git.example.invalid/wip.git", credential: name }), refused("credential"), name);
        await assert.rejects(grants.grant(owner, { commandId: cid("g"), taskId, host: "api.example.com", port: 443, credential: { header: "x-api-key", ref: name } }), refused("credential.ref"), name);
      }
      assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).length, auditBefore, "no refused command recorded anything");
      assert.deepEqual((await config.effective()).targets, []);
      // Ordinary names are accepted by each.
      assert.equal((await config.addTarget(owner, { commandId: cid("bt"), name: "Cloud", kind: "offsite", location: "https://backup.example.invalid/store", credential: "offsite-key" })).target.credential, "offsite-key");
      assert.equal((await wip.set(owner, { commandId: cid("w"), projectId, enabled: true, remote: "https://git.example.invalid/wip.git", credential: "wip-push-token" })).enabled, true);
      assert.equal((await grants.grant(owner, { commandId: cid("g"), taskId, host: "api.example.com", port: 443, credential: { header: "x-api-key", ref: "docs-token" } })).state, "granted");
      // Without the configuration's names only the fixed ones and the owner's prefix are refused (the controller always gives them).
      const bare = BackupConfigService.withEpoch(world.storage, projects.epoch, {});
      await assert.rejects(bare.addTarget(owner, { commandId: cid("bt"), name: "Other", kind: "offsite", location: "https://other.example.invalid/store", credential: "Backup-Signing-Key" }), refused("credential"));
    } finally { await world.close(); }
  });
}

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("sqlite, the controller's wiring: the API refuses kept names for a backup target, a work-in-progress backup and a network grant; a target record edited to name one is never read for it and nothing reaches the target (task T4)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t4k-"));
  const fake = await startFakeTarget("ok-value");
  // A second loopback server that only records the authorization headers it is sent.
  const seen: (string | undefined)[] = [];
  const spy = http.createServer((req, res) => { seen.push(req.headers.authorization); res.statusCode = 401; res.end(); });
  await new Promise<void>((r) => spy.listen(0, "127.0.0.1", () => r()));
  const spyUrl = `http://127.0.0.1:${(spy.address() as AddressInfo).port}/`;
  const values = new Map<string, string>([["offsite-key", "ok-value"], ["controller-db-url", "postgres://u:db-pass-value@h/db"]]);
  const asked: string[] = [];
  const store = { resolve: async (name: string) => { asked.push(name); return values.get(name); }, set: async (name: string, value: string) => { values.set(name, value); } };
  try {
    const c = await startController({
      storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
      adminSecrets: { store, reserved: ["controller-db-url"] },
      backup: { directory: join(d, "backups"), signing: { store, secretName: "my-signing-key" } },
    });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
      const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
      const task = (await call("task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
      for (const name of ["Controller-DB-URL", "MY-SIGNING-KEY", "backup-signing-key", `${OWNER_SECRET_PREFIX}-0123456789abcdef`]) {
        const bt = await call("backup.target.add", { name: "Spy", kind: "offsite", location: spyUrl, credential: name }, cid("bt"));
        assert.equal(bt.error?.code, "invalid_command", `${name}: ${JSON.stringify(bt)}`);
        const wip = await call("wip.backup.set", { project, enabled: true, remote: "https://git.example.invalid/wip.git", credential: name }, cid("w"));
        assert.equal(wip.error?.code, "invalid_command", `${name}: ${JSON.stringify(wip)}`);
        const g = await call("network.grant", { taskId: task, host: "api.example.com", port: 443, credential: { header: "x-api-key", ref: name } }, cid("g"));
        assert.equal(g.error?.code, "invalid_command", `${name}: ${JSON.stringify(g)}`);
      }
      assert.deepEqual(seen, [], "the target was never tested with a kept name");
      assert.equal(asked.some((k) => k.toLowerCase() === "controller-db-url"), false, "the database address was never read");
      // An ordinary credential reaches its target.
      const added = await call("backup.target.add", { name: "Cloud", kind: "offsite", location: fake.url }, "ok1");
      assert.equal(added.ok, false, "without the credential the fake target refuses the test");
      const ok = await call("backup.target.add", { name: "Cloud", kind: "offsite", location: fake.url, credential: "offsite-key" }, "ok2");
      assert.ok(ok.ok, JSON.stringify(ok));
      // The target record is changed behind the API's back (by hand, or by an older version) to name the database address's secret and to point at the spy.
      const ref = { kind: "backup-config", id: "main" };
      const have = (await c.storage.getAggregate(ref))!;
      const body = have.body as { targets: Record<string, unknown>[] };
      const edited = { ...body, targets: body.targets.map((t) => ({ ...t, location: spyUrl, credential: "Controller-DB-URL" })) };
      await c.storage.applyOperation({ operationId: "t4k-edit", epoch: c.epoch, actor: "owner:test", correlationId: "t4k-edit", at: new Date().toISOString(), audit: [{ type: "backup.target.add", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
        changes: [{ type: "update", ref, expectedRevision: have.revision, body: edited }] } as never);
      asked.length = 0;
      const tested = await call("backup.target.test", { id: "Cloud" }, "tt1");
      assert.equal(tested.result?.ok === true, false, JSON.stringify(tested));
      assert.deepEqual(seen, [], "no request reached the target with the database address, or at all");
      assert.equal(asked.some((k) => k.toLowerCase() === "controller-db-url"), false, "the secret store was never asked for the database address");
      assert.equal(JSON.stringify(tested).includes("db-pass-value"), false);
    } finally { await c.close(); }
  } finally {
    await fake.close();
    await new Promise<void>((r) => spy.close(() => r()));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
