import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter, acceptedArgs } from "../chat/index.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { DEFAULT_STARTUP_WINDOW_SECONDS, LAUNCHER_FILE, Launcher, startNoticeText, type LauncherNotice } from "../release/index.js";
import { Clock, makeRelease, pointerSwitcher } from "../release/start-fixture.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

/** What the launcher does when it runs with the controller (and so the database) stopped: only the launcher's file and the pointer change. */
function launcherSide(root: string, clock: Clock) {
  const sw = pointerSwitcher(root);
  const launcher = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: { min: 1, max: 1 } });
  const announce = async (tag: string) => { const r = makeRelease(root, tag); await launcher.expect({ ...r, protocol: { min: 1, max: 1 } }); return r; };
  const run = async (r: { id: string; digest: string }) => { await sw.write(r.id); return launcher.prepare(); };
  return { launcher, announce, run };
}

test("a fall-back the launcher made while the controller was down is told at the next start as Needs you, once however often the controller restarts, with the window the owner set read by the watchdog; the owner acknowledges it (K02e/K02f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k02f-"));
  const root = join(d, "rel"); mkdirSync(root, { recursive: true });
  const clock = new Clock();
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { text: string }) => { sent.push(m); } } };
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], notifications: { channels },
    releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" } } });
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = (await c.services.principals.authenticate(boot.token))!;
    await c.services.principals.enroll(owner, { commandId: "e1", kind: "agent", name: "builder", grants: [{ action: "release.report", project: "*" }] });
    const builderToken = (await c.services.principals.issueCredential(owner, "agent:builder")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, id?: string) => c.api.handle(token, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<Reply>;
    const ask = (op: string, args: Record<string, unknown>, id?: string) => call(boot.token, op, args, id);
    const inbox = async () => (await NotificationService.withEpoch(c.storage, c.epoch, { channels }).inbox(owner)).items.filter((i) => i.ref.kind === "release-start" && i.state !== "answered" && i.state !== "settled");

    // The window is the owner's setting; it must be sensible, and the launcher gets its own copy because it cannot read the database.
    for (const bad of [5, 90_000, 30.5, "soon"]) assert.equal((await ask("release.staging.settings.set", { startupWindowSeconds: bad }, `w-${bad}`)).error?.code, "invalid_command", String(bad));
    assert.equal((await ask("release.staging.settings.set", { startFailureLevel: "loud" }, "lvl-bad")).error?.code, "invalid_command");
    assert.equal((await call(builderToken, "release.staging.settings.set", { startupWindowSeconds: 20 }, "b1")).error?.code, "forbidden");
    assert.ok((await ask("release.staging.settings.set", { startupWindowSeconds: 45 }, "w1")).ok);
    assert.equal(JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")).window, 45, "mirrored into the launcher's own file");
    const settings = (await ask("release.staging.settings.get", {})).result.item;
    assert.deepEqual([settings.startupWindowSeconds, settings.startFailureLevel], [45, "needs-you"]);
    await c.close();

    // The controller is down. The launcher runs a release that never reports, its watchdog (window 45 seconds, read from the file) judges it, and the decision falls back. Nothing could be sent.
    const l = launcherSide(root, clock);
    const good = await l.announce("good"); await l.run(good); await l.launcher.confirm(good.id);
    const bad = await l.announce("bad"); await l.run(bad);
    clock.advance(44);
    assert.equal((await l.launcher.watchdog()).action, "waiting");
    clock.advance(1);
    assert.equal((await l.launcher.watchdog()).action, "failed");
    const fell = await l.launcher.prepare();
    assert.equal((fell as { releaseId: string }).releaseId, good.id);

    // The next start reads the file and tells the owner: Needs you (the default), one item for the release, queued for the digest (not an interruption), the text holding the release IDs only.
    c = await open();
    let items = await inbox();
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(items[0]!.level, "needs-you");
    assert.equal(items[0]!.kind, "maintenance");
    assert.equal(items[0]!.ref.id, bad.id);
    assert.match(items[0]!.label, new RegExp(`release ${bad.id} failed to start; the launcher fell back to release ${good.id}`));
    assert.doesNotMatch(items[0]!.label, /[\\/]/, "no path leaves the installation");
    assert.match(items[0]!.detail ?? "", /startup window/);
    assert.equal(items[0]!.state, "queued");
    assert.deepEqual(sent, []);
    const status = (await ask("release.status", {})).result.item;
    assert.deepEqual(status.startNotices.map((n: any) => [n.kind, n.release, n.told, n.state]), [["fell_back", bad.id, true, "open"]]);

    // Restarting any number of times adds nothing: told once, one item.
    await c.close(); c = await open(); await c.close(); c = await open();
    items = await inbox();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.count, 1, "told once; the restarts told nothing");

    // Only the owner acknowledges; it closes the item and the notices; nothing else changes.
    assert.equal((await call(builderToken, "release.start.acknowledge", {}, "b2")).error?.code, "forbidden");
    assert.equal((await ask("release.start.acknowledge", { releaseId: `rcn-${"0".repeat(24)}` }, "ack0")).result.acknowledged, 0, "nothing about that release");
    assert.equal((await ask("release.start.acknowledge", { releaseId: bad.id }, "ack1")).result.acknowledged, 1);
    assert.equal((await inbox()).length, 0, "the item left the inbox");
    assert.deepEqual((await ask("release.status", {})).result.item.startNotices.map((n: any) => n.state), ["acknowledged"]);
    assert.equal(JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")).known.id, good.id, "no release changed");
    // Starting again does not bring it back.
    await c.close(); c = await open();
    assert.equal((await inbox()).length, 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("with the level set to urgent a fall-back is sent at once through the channel; a later start that confirms closes it; a failed start with nothing to fall back to is always urgent (K02f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k02f2-"));
  const root = join(d, "rel"); mkdirSync(root, { recursive: true });
  const clock = new Clock();
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { text: string }) => { sent.push(m); } } };
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], notifications: { channels },
    releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" } } });
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = (await c.services.principals.authenticate(boot.token))!;
    const ask = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(boot.token, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<Reply>;
    assert.ok((await ask("notifications.configure", { channel: "external", channelName: "chat" }, "n1")).ok);
    assert.ok((await ask("release.staging.settings.set", { startFailureLevel: "urgent" }, "l1")).ok);
    const service = () => NotificationService.withEpoch(c.storage, c.epoch, { channels });
    const inbox = async () => (await service().inbox(owner)).items.filter((i) => i.ref.kind === "release-start" && i.state !== "answered" && i.state !== "settled");
    await c.close();

    const l = launcherSide(root, clock);
    const good = await l.announce("good"); await l.run(good); await l.launcher.confirm(good.id);
    const bad = await l.announce("bad"); await l.run(bad);
    clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    assert.equal((await l.launcher.watchdog()).action, "failed");
    await l.launcher.prepare();

    c = await open();
    const items = await inbox();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.level, "urgent");
    await service().runDue();
    assert.equal(sent.length, 1, JSON.stringify(sent));
    assert.match(sent[0]!.text, new RegExp(`release ${bad.id} failed to start; the launcher fell back to release ${good.id}`));
    assert.doesNotMatch(sent[0]!.text, /startup window|[\\/]/, "the reason and any path stay in the inbox");
    await c.close(); c = await open(); await service().runDue();
    assert.equal(sent.length, 1, "a restart does not tell it again");

    // The next release starts and is confirmed (here by the launcher's own record, as a started controller does): the item closes at the next start.
    const next = await l.announce("next"); await l.run(next);
    assert.equal(await l.launcher.confirm(next.id), true);
    await c.close(); c = await open();
    assert.equal((await inbox()).length, 0, "closed by the next confirmed start");
    assert.deepEqual((await ask("release.status", {})).result.item.startNotices.map((n: any) => n.state), ["confirmed"]);

    // A failed start with no other release known to work left nothing running: urgent whatever the owner chose.
    const only: LauncherNotice = { kind: "failed_start", release: bad.id, fallback: false, reason: "x", at: clock.now() };
    for (const level of ["needs-you", "urgent"] as const) assert.equal(startNoticeText(only, level).level, "urgent");
    assert.equal(startNoticeText({ ...only, fallback: true }, "needs-you").level, "needs-you");
    assert.match(startNoticeText(only, "needs-you").label, /no other release is known to work/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a notice that cannot be raised now (the notification service refuses) stays in the launcher's file and is told by a later try; the window and level are set and the notice acknowledged by free-form chat, and the interpreter is told the arguments (K02e/K02f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k02f3-"));
  const root = join(d, "rel"); mkdirSync(root, { recursive: true });
  const clock = new Clock();
  const say: Record<string, unknown[]> = {};
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" } } });
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = (await c.services.principals.authenticate(boot.token))!;
    const ask = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(boot.token, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<Reply>;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };

    // The interpreter's argument list and prompt name the new settings and the acknowledgement.
    for (const a of ["startupWindowSeconds", "startFailureLevel"]) assert.ok(acceptedArgs("release.staging.settings.set")!.includes(a), a);
    assert.ok(acceptedArgs("release.start.acknowledge")!.includes("releaseId"));
    let system = "";
    await new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]).interpret({ text: "hello", quoted: [], focus: {}, proposals: [] } as never);
    assert.match(system, /release\.staging\.settings\.set\([^)]*startupWindowSeconds, startFailureLevel[^)]*\)/);
    assert.match(system, /release\.start\.acknowledge\([^)]*releaseId[^)]*\)/);

    // Free-form chat sets both (a settings change is shown first, the owner's word confirms), with no special phrase.
    const words = "give a new release two minutes to start before it counts as failed, and tell me urgently when the launcher falls back";
    const shown = await turn("m1", words, [{ kind: "command", op: "release.staging.settings.set", args: { startupWindowSeconds: 120, startFailureLevel: "urgent" }, evidence: words, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await ask("release.staging.settings.get", {})).result.item.startupWindowSeconds, 300, "a proposal changes nothing");
    const done = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(done[0]!.status, "applied", JSON.stringify(done));
    const set = (await ask("release.staging.settings.get", {})).result.item;
    assert.deepEqual([set.startupWindowSeconds, set.startFailureLevel], [120, "urgent"]);
    assert.equal(JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")).window, 120);
    await c.close();

    const l = launcherSide(root, clock);
    const good = await l.announce("good"); await l.run(good); await l.launcher.confirm(good.id);
    const bad = await l.announce("bad"); await l.run(bad);
    clock.advance(120); await l.launcher.watchdog(); await l.launcher.prepare();

    // The notification service cannot take it now (a failing sink): nothing is lost, the file keeps it pending.
    c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
      releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" }, notices: { raise: async () => { throw new Error("the notification service is down"); }, settle: async () => undefined } } });
    const pending = JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")).notices as LauncherNotice[];
    assert.equal(pending.length, 1);
    assert.ok(pending.every((n) => n.sentAt === undefined), "still pending");
    await c.close();
    c = await open();
    const after = JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")).notices as LauncherNotice[];
    assert.ok(after.every((n) => n.sentAt !== undefined), "told by the next start");
    const inbox = async () => (await NotificationService.withEpoch(c.storage, c.epoch, {}).inbox(owner)).items.filter((i) => i.ref.kind === "release-start" && i.state !== "answered" && i.state !== "settled");
    assert.equal((await inbox()).length, 1);
    assert.equal((await inbox())[0]!.level, "urgent");

    // The owner says they have seen it: acknowledging closes a notice and changes nothing else, so it applies at once.
    const seen = `I have seen that ${bad.id} failed to start, no need to keep telling me`;
    const ack = await turn("m3", seen, [{ kind: "command", op: "release.start.acknowledge", args: { releaseId: bad.id }, evidence: seen, basis: "owner" }]);
    assert.equal(ack[0]!.status, "applied", JSON.stringify(ack));
    assert.equal((await inbox()).length, 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
