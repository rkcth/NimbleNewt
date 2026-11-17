import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { after, test } from "node:test";
import { BackupConfigService } from "../backup/config.js";
import { CHAT_LIMITS } from "../chat/interpreter.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { NetworkGrantService, NetworkRefused, WebFetch } from "../network/index.js";
import { NotificationService } from "../notifications/index.js";
import { PrincipalService } from "../security/index.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { WipBackupService } from "../wip-backup/index.js";
import { KeptSecretUseCheck, KEPT_SECRET_USE_REF, cutText, keptSecretUseText, reportKeptSecretUses } from "./kept-secret-uses.js";

after(stopServer);

// Task T4b: a record made before the kept-secret rule (a network grant, a backup target or a work-in-progress backup naming a secret the installation keeps for something else) is found, told to the owner by the
// secret's NAME, refused where it is used, and shown in the owner's status answer. The old records here are made with services that were given no kept names, which is what an older version did.
const KEPT = ["controller-db-url", "my-signing-key"];
const FAKE_VALUE = "fake-value-for-tests-only-0000";
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const PUBLIC = "93.184.216.34";

/** Changes the secret a recorded grant names behind the service (what an older version, or someone by hand, could leave): the service itself now refuses the owner's names and the fixed ones. */
async function renameGrantRef(x: Awaited<ReturnType<typeof world>>, host: string, ref: string): Promise<void> {
  const id = (await x.grants.credentialUses()).find((u) => u.host === host)!.id;
  const at = { kind: "net-grant", id };
  const have = (await x.w.storage.getAggregate(at))!;
  const body = have.body as { credential: { header: string; ref: string } };
  await x.w.storage.applyOperation({ operationId: cid("rename"), epoch: x.e, actor: "owner:test", correlationId: "rename", at: new Date().toISOString(), audit: [{ type: "network.grant", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    changes: [{ type: "update", ref: at, expectedRevision: have.revision, body: { ...body, credential: { ...body.credential, ref } } }] } as never);
}

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1" });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, {});
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const projectId = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Garden" })).id;
  const taskId = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId, title: "weed" })).id;
  const e = projects.epoch;
  // What an older version could record: no kept names given.
  const oldConfig = BackupConfigService.withEpoch(w.storage, e, {});
  const oldWip = WipBackupService.withEpoch(w.storage, e, {});
  const oldGrants = NetworkGrantService.withEpoch(w.storage, e, {});
  const grants = NetworkGrantService.withEpoch(w.storage, e, { kept: () => KEPT });
  const config = BackupConfigService.withEpoch(w.storage, e, {}, () => KEPT);
  const wip = WipBackupService.withEpoch(w.storage, e, { kept: () => KEPT });
  const check = new KeptSecretUseCheck({ kept: () => KEPT, grants: () => grants, backupConfig: config, wip });
  return { w, projects, e, owner, projectId, taskId, oldConfig, oldWip, oldGrants, grants, config, wip, check };
}

for (const backend of backends) {
  test(`${backend.name}: records made before the rule that name a kept secret are found by name; ordinary, revoked and unrelated records are not; letter case is ignored (task T4b)`, async () => {
    const x = await world(backend);
    try {
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "api.example.com", port: 443, credential: { header: "x-api-key", ref: "Controller-DB-URL" } });
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "ok.example.com", port: 443, credential: { header: "x-api-key", ref: "docs-token" } });
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "none.example.com", port: 443 });
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "gone.example.com", port: 443, credential: { header: "x-api-key", ref: "my-signing-key" } });
      await x.oldGrants.revoke(x.owner, { commandId: cid("r"), taskId: x.taskId, host: "gone.example.com", port: 443 });
      await x.oldConfig.addTarget(x.owner, { commandId: cid("bt"), name: "Cloud", kind: "offsite", location: "https://backup.example.invalid/store", credential: "MY-SIGNING-KEY" });
      await x.oldConfig.addTarget(x.owner, { commandId: cid("bt"), name: "Fine", kind: "offsite", location: "https://fine.example.invalid/store", credential: "offsite-key" });
      await x.oldWip.set(x.owner, { commandId: cid("w"), projectId: x.projectId, enabled: true, remote: "https://git.example.invalid/wip.git", credential: "controller-db-url" });
      const found = await x.check.find();
      assert.deepEqual(found.map((u) => [u.kind, u.secret, u.where]), [
        ["network grant", "Controller-DB-URL", "api.example.com:443"],
        ["backup target", "MY-SIGNING-KEY", "Cloud"],
        ["work-in-progress backup", "controller-db-url", `project ${x.projectId}`],
      ]);
      assert.equal(new Set(found.map((u) => u.key)).size, 3);
      assert.deepEqual((await x.check.find()).map((u) => u.key), found.map((u) => u.key), "the same records give the same keys");
      // The listings keep only the matching records, so ordinary ones never use up the limit (whichever order the store lists them in, one of the two asks would get the wrong grant otherwise).
      assert.deepEqual((await x.grants.credentialUses(1, (r) => r === "Controller-DB-URL")).map((u) => u.host), ["api.example.com"]);
      assert.deepEqual((await x.grants.credentialUses(1, (r) => r === "docs-token")).map((u) => u.host), ["ok.example.com"]);
      assert.deepEqual(await x.wip.credentialUses(5, () => false), []);
      for (const u of found) assert.match(keptSecretUseText(u),/names the secret ".+", which the installation keeps for something else, so nothing is sent\. /);
      // Nothing is found when no kept name applies (a controller started without the configuration's names still knows the fixed ones).
      assert.deepEqual(await new KeptSecretUseCheck({ kept: () => [], grants: () => x.grants, backupConfig: x.config, wip: x.wip }).find(), []);
      assert.deepEqual(await new KeptSecretUseCheck({ kept: () => KEPT }).find(), [], "no source, nothing found");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: each old record is told to the owner once by the secret's name in at most 200 units, never twice, and the notice closes when the record is fixed (task T4b)`, async () => {
    const x = await world(backend);
    try {
      const notes = NotificationService.withEpoch(x.w.storage, x.e, {});
      const longName = "n".repeat(60);
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "api.example.com", port: 443, credential: { header: "x-api-key", ref: "controller-db-url" } });
      await x.oldConfig.addTarget(x.owner, { commandId: cid("bt"), name: longName, kind: "offsite", location: "https://backup.example.invalid/store", credential: "my-signing-key" });
      await x.oldWip.set(x.owner, { commandId: cid("w"), projectId: x.projectId, enabled: true, remote: "https://git.example.invalid/wip.git", credential: "controller-db-url" });
      const errors: string[] = [];
      assert.deepEqual(await reportKeptSecretUses(x.check, notes, (m) => errors.push(m)), { found: 3, closed: 0 });
      assert.deepEqual(await reportKeptSecretUses(x.check, notes, (m) => errors.push(m)), { found: 3, closed: 0 });
      assert.deepEqual(errors, []);
      const open = async () => (await notes.inbox(x.owner)).items.filter((i) => i.ref.kind === KEPT_SECRET_USE_REF && i.state !== "settled");
      const items = await open();
      assert.equal(items.length, 3, "once each, not once per run");
      for (const i of items) {
        assert.ok(i.detail !== undefined && i.detail.length <= 200, `${i.detail?.length} units`);
        assert.doesNotMatch(i.detail!, /[\ud800-\udbff]$/, "never cut inside a character");
        assert.equal(i.level, "needs-you");
      }
      const text = items.map((i) => i.detail).join("\n");
      assert.match(text, /network grant \(api\.example\.com:443\) names the secret "controller-db-url"/);
      assert.match(text, /work-in-progress backup \(project /);
      assert.match(text, /Revoke the grant and ask again with another secret\./);
      assert.match(text, /Remove the target and add it again with the store's own credential\./);
      assert.match(text, /Set the backup again with another secret\./);
      // Fixing the records (a new grant for the host replaces nothing; the old one is revoked, the target removed, the backup pointed at another secret) closes the notices.
      await x.oldGrants.revoke(x.owner, { commandId: cid("r"), taskId: x.taskId, host: "api.example.com", port: 443 });
      const targetId = (await x.config.effective()).targets[0]!.id;
      await x.config.removeTarget(x.owner, { commandId: cid("rt"), id: targetId });
      const result = await reportKeptSecretUses(x.check, notes);
      assert.deepEqual(result, { found: 1, closed: 2 });
      assert.equal((await open()).length, 1);
      await x.wip.set(x.owner, { commandId: cid("w"), projectId: x.projectId, remote: "https://git.example.invalid/wip.git", credential: "wip-push-token" });
      assert.deepEqual(await reportKeptSecretUses(x.check, notes), { found: 0, closed: 1 });
      assert.equal((await open()).length, 0);
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a failure while looking is reported to the caller and never thrown (task T4b)`, async () => {
    const x = await world(backend);
    try {
      const notes = NotificationService.withEpoch(x.w.storage, x.e, {});
      const broken = new KeptSecretUseCheck({ kept: () => KEPT, grants: () => ({ credentialUses: async () => { throw new Error(`the store said ${FAKE_VALUE}`.padEnd(400, "x")); } }) });
      const errors: string[] = [];
      assert.deepEqual(await reportKeptSecretUses(broken, notes, (m) => errors.push(m)), { found: 0, closed: 0 });
      assert.equal(errors.length, 1);
      assert.ok(errors[0]!.length < 260);
      assert.deepEqual(await reportKeptSecretUses(broken, notes, () => { throw new Error("a callback that fails"); }), { found: 0, closed: 0 });
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: an old grant naming a kept secret sends nothing: the web tool refuses before the secret is read, and says which secret and what to do; the embedder's own reader is never asked (task T4b)`, async () => {
    const x = await world(backend);
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.end("page"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const asked: string[] = []; const dials: number[] = [];
      const make = (kept?: () => readonly string[]) => new WebFetch({
        grants: x.grants, resolve: async () => [PUBLIC], dial: () => { dials.push(1); return netConnect({ host: "127.0.0.1", port }); },
        secret: (name: string) => { asked.push(name); return FAKE_VALUE; }, ...(kept === undefined ? {} : { kept }),
      });
      const ctx = { taskId: x.taskId, projectId: x.projectId, attemptId: "att-1" };
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "api.example.com", port: 80, credential: { header: "x-api-key", ref: "Controller-DB-URL" } });
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "owner.example.com", port: 80, credential: { header: "x-api-key", ref: "docs-token" } });
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "fixed.example.com", port: 80, credential: { header: "x-api-key", ref: "docs-token" } });
      await renameGrantRef(x, "owner.example.com", "nimblenewt-owner-token-0123456789abcdef");
      await renameGrantRef(x, "fixed.example.com", "Backup-Signing-Key");
      await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: "fine.example.com", port: 80, credential: { header: "x-api-key", ref: "docs-token" } });
      const web = make(() => KEPT);
      for (const host of ["api.example.com", "owner.example.com", "fixed.example.com"]) {
        await assert.rejects(() => web.run(ctx, { url: `http://${host}/` }), (e: unknown) => {
          assert.ok(e instanceof NetworkRefused);
          assert.match(e.message, /sends the secret "[^"]+" to this destination, but .*never sent to a network destination; nothing is sent\. The owner can revoke the grant and ask for it again naming another secret/);
          assert.equal(e.message.includes(FAKE_VALUE), false);
          return true;
        });
      }
      assert.deepEqual([asked, dials.length, hits], [[], 0, 0], "the secret was not read, nothing was dialled or sent");
      // The fixed names and the owner's prefix are refused even when the embedder gave no kept names; an ordinary name still works.
      for (const host of ["owner.example.com", "fixed.example.com"]) await assert.rejects(() => make().run(ctx, { url: `http://${host}/` }), /never sent to a network destination/);
      assert.deepEqual([asked, hits], [[], 0]);
      assert.equal((await make(() => KEPT).run(ctx, { url: "http://fine.example.com/" })).status, 200);
      assert.deepEqual([asked, hits], [["docs-token"], 1], "an ordinary secret is read and used");
      // A names list that cannot be read fails closed.
      await assert.rejects(() => make(() => { throw new Error("no list"); }).run(ctx, { url: "http://fine.example.com/" }));
      assert.deepEqual([asked.length, hits], [1, 1]);
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await x.w.close(); }
  });

  test(`${backend.name}: the status answer lists the old records by secret name for the owner only, within the chat's ${CHAT_LIMITS.statusLines} lines (task T4b)`, async () => {
    const x = await world(backend);
    try {
      const status = StatusService.withEpoch(x.w.storage, x.e, { keptSecretUses: x.check } as never);
      const none = await status.ask(x.owner, { kind: "kept_secret_uses" });
      assert.match(none!.lines[0]!.text, /^No network grant, backup target or work-in-progress backup names a secret/);
      for (let i = 0; i < 35; i++) await x.oldGrants.grant(x.owner, { commandId: cid("g"), taskId: x.taskId, host: `h${i}.example.com`, port: 443, credential: { header: "x-api-key", ref: i % 2 === 0 ? "controller-db-url" : "MY-SIGNING-KEY" } });
      const ans = await status.ask(x.owner, { kind: "kept_secret_uses" });
      assert.ok(ans!.lines.length <= CHAT_LIMITS.statusLines, `${ans!.lines.length} lines`);
      assert.equal(ans!.lines.length, CHAT_LIMITS.statusLines);
      assert.match(ans!.lines[0]!.text, /^35 record\(s\) name a secret the installation keeps for something else/);
      assert.match(ans!.lines.at(-1)!.text, /^7 more are not shown/);
      assert.match(ans!.lines[1]!.text, /names the secret "(controller-db-url|MY-SIGNING-KEY)"/);
      assert.equal(JSON.stringify(ans).includes(FAKE_VALUE), false);
      // Only the owner reads it; a controller without the check does not offer it.
      const agent = { kind: "agent", id: "agent:ann", name: "ann" } as never;
      assert.equal(await status.ask(agent, { kind: "kept_secret_uses" }), undefined);
      assert.equal(await StatusService.withEpoch(x.w.storage, x.e, {} as never).ask(x.owner, { kind: "kept_secret_uses" }), undefined);
    } finally { await x.w.close(); }
  });
}

test("the chat is told the view and the notice text fits; the line cap matches the chat's", async () => {
  assert.ok("kept_secret_uses" in STATUS_KINDS);
  assert.equal(CHAT_LIMITS.statusLines, 30, "the status view's own cap mirrors the chat's");
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "does anything still use a secret it should not?", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /kept_secret_uses\(\) - owner only \(task T4b\)/);
  assert.equal(cutText("ab\u{1F600}", 3), "ab", "a pair is never cut in half");
  assert.equal(cutText("abc", 3), "abc");
  const long = keptSecretUseText({ key: "ks-x", kind: "backup target", where: "w".repeat(40), secret: "s".repeat(64), remedy: "r".repeat(100) });
  assert.ok(long.length <= 200);
});
