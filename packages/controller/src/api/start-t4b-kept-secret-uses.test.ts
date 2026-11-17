import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackupConfigService } from "../backup/config.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NetworkGrantService } from "../network/index.js";
import { NotificationService } from "../notifications/index.js";
import { KEPT_SECRET_USE_REF } from "../setup/index.js";
import { WipBackupService } from "../wip-backup/index.js";
import { startController } from "./index.js";

// Task T4b through the started controller: records made before the rule (a network grant, a backup target, a work-in-progress backup naming the database address's secret or the signing key) are told to the owner
// when the controller starts, listed in chat in free words, and the web tool built by the controller refuses the old grant before the embedder's own secret reader is asked.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PUBLIC = "93.184.216.34";
const FAKE_VALUE = "fake-value-for-tests-only-0000";

test("sqlite, the controller's wiring: old records naming a kept secret are told once at start, shown in chat, and the controller's web tool refuses the old grant without asking for the secret (task T4b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t4b-"));
  const page = httpServer((_req, res) => { res.end("page"); });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
  const port = (page.address() as { port: number }).port;
  const path = join(d, "c.sqlite");
  const say: Record<string, unknown[]> = {};
  const asked: string[] = [];
  const values = new Map<string, string>([["offsite-key", FAKE_VALUE]]);
  const store = { resolve: async (name: string) => { asked.push(name); return values.get(name); }, set: async (name: string, value: string) => { values.set(name, value); } };
  const base = { storage: { kind: "sqlite" as const, path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] };
  try {
    // First start: an older controller's records, made with no kept names.
    let ownerToken = ""; let taskId = ""; let projectId = "";
    const first = await startController({ ...base } as never);
    try {
      const boot = await first.services.principals.bootstrapOwner({ name: "rob" });
      const owner = await first.services.principals.authenticate(boot.token);
      ownerToken = (await first.services.principals.issueCredential(owner, owner.id)).token;
      projectId = (await first.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
      taskId = (await first.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId, title: "weed" })).id;
      await NetworkGrantService.withEpoch(first.storage, first.epoch, {}).grant(owner, { commandId: "g1", taskId, host: "api.example.com", port: 80, credential: { header: "x-api-key", ref: "Controller-DB-URL" } });
      await BackupConfigService.withEpoch(first.storage, first.epoch, {}).addTarget(owner, { commandId: "bt1", name: "Cloud", kind: "offsite", location: "https://backup.example.invalid/store", credential: "MY-SIGNING-KEY" });
      await WipBackupService.withEpoch(first.storage, first.epoch, {}).set(owner, { commandId: "w1", projectId, enabled: true, remote: "https://git.example.invalid/wip.git", credential: "controller-db-url" });
    } finally { await first.close(); }
    // Second start: the configuration names the kept secrets; the owner is told, once, however often it starts.
    const startAgain = async () => startController({
      ...base,
      adminSecrets: { store, reserved: ["controller-db-url"] },
      backup: { directory: join(d, "backups"), signing: { store, secretName: "my-signing-key" } },
      chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
      dispatch: {
        timer: new ManualTimer(), manual: true,
        local: { window: () => 32768, acceptUnenforcedLimits: true, build: () => new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "done" })) },
        network: { resolve: async () => [PUBLIC], dial: () => netConnect({ host: "127.0.0.1", port }), secret: async (name: string) => { asked.push(name); return FAKE_VALUE; } },
      },
      harnesses: [PI],
    } as never);
    for (let round = 0; round < 2; round++) {
      const c = await startAgain();
      try {
        assert.ok(c.dispatch !== undefined, c.dispatchProblem);
        const owner = await c.services.principals.authenticate(ownerToken);
        const notes = NotificationService.withEpoch(c.storage, c.epoch, {});
        const items = (await notes.inbox(owner)).items.filter((i) => i.ref.kind === KEPT_SECRET_USE_REF);
        assert.equal(items.length, 3, `round ${round}: once each, not once per start`);
        for (const i of items) { assert.ok(i.detail!.length <= 200); assert.equal(i.level, "needs-you"); assert.equal(i.detail!.includes(FAKE_VALUE), false); }
        assert.match(items.map((i) => i.detail).join("\n"), /network grant \(api\.example\.com:80\) names the secret "Controller-DB-URL"/);
        // Chat: a free-form question, answered from the status kind the interpreter is told.
        const q = `does anything still use a secret it should not (${round})?`;
        say[q] = [{ kind: "status", request: { kind: "kept_secret_uses" }, evidence: q, basis: "owner" }];
        const o = (await c.chat!.submit(ownerToken, { messageId: `m${round}`, text: q })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(o.status, "answered", JSON.stringify(o));
        const text = (o.lines ?? []).map((l) => l.text).join("\n");
        assert.match(text, /^3 record\(s\) name a secret the installation keeps for something else/);
        assert.match(text, /backup target \(Cloud\) names the secret "MY-SIGNING-KEY"/);
        assert.match(text, /work-in-progress backup \(project .*\) names the secret "controller-db-url"/);
        // The web tool the controller built: the old grant sends nothing, and the embedder's own reader is never asked for the secret.
        asked.length = 0;
        const webTool = c.dispatch.network!.webTool;
        const call = { taskId, projectId, attemptId: "att-1", agent: { id: owner.id } } as never;
        await assert.rejects(() => webTool.run(call, { url: "http://api.example.com/" } as never, undefined as never), (e: unknown) => /sends the secret "Controller-DB-URL" to this destination/.test(String((e as Error).message)) && /revoke the grant and ask for it again naming another secret/.test(String((e as Error).message)));
        assert.equal(asked.some((k) => k.toLowerCase() === "controller-db-url"), false, "the secret reader was not asked for the database address's secret");
      } finally { await c.close(); }
    }
    // Fixing the grant (revoking it) closes its notice at the next start; the other two stay open.
    const fixing = await startAgain();
    try { await NetworkGrantService.withEpoch(fixing.storage, fixing.epoch, {}).revoke(await fixing.services.principals.authenticate(ownerToken), { commandId: "r1", taskId, host: "api.example.com", port: 80 }); } finally { await fixing.close(); }
    const last = await startAgain();
    try {
      const owner = await last.services.principals.authenticate(ownerToken);
      const open = (await NotificationService.withEpoch(last.storage, last.epoch, {}).inbox(owner)).items.filter((i) => i.ref.kind === KEPT_SECRET_USE_REF && i.state !== "settled");
      assert.equal(open.length, 2, "the revoked grant's notice is closed");
    } finally { await last.close(); }
  } finally {
    await new Promise<void>((r) => page.close(() => r()));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
