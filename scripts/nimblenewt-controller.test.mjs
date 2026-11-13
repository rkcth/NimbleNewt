// The controller entry (scripts/nimblenewt-controller.mjs): its settings, and real controllers started from it (a temporary data directory, SQLite, no network): by hand, and as a child of the
// release launcher (launcher -> entry -> startController -> confirmation -> clean SIGTERM stop, exit 0; and exit 75 -> the launcher starts it again).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { composeSecrets, controllerSettings, controllerStartOptions, main, parseControllerArgs, startConfirmed } from "./nimblenewt-controller.mjs";
import { environmentsRequested, localHostBuilder } from "./local-host.mjs";
import { main as startMain, starterConfig } from "./nimblenewt.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (pkg, file) => import(pathToFileURL(join(repo, "packages", pkg, "dist", file)).href);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const required = process.env.NIMBLENEWT_REQUIRE_SANDBOX === "1";
const RELEASE = "rcn-0123456789abcdef01234567";

const capture = () => { let text = ""; return { stderr: { write: (t) => { text += t; } }, get text() { return text; } }; };
const until = async (what, cond, ms = 30_000) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); } };

/** Staged releases are read-only; make them removable. */
const unlockAll = (dir) => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };

/**
 * The file-backed secret store this host can use, chosen up front so a test never touches the account's own store: owner-only files on POSIX, DPAPI-protected files on Windows (where the product refuses the
 * protected-file store: it needs POSIX permissions). Both keep their files under `<dataDir>/secrets`.
 */
const FILE_STORE_KIND = process.platform === "win32" ? "windows-dpapi" : "protected-file";
const fileStore = async (dataDir) => {
  const { protectedFileStore, windowsDpapiStore } = await dist("config", "index.js");
  return (process.platform === "win32" ? windowsDpapiStore : protectedFileStore)(join(dataDir, "secrets"));
};

/** A fresh installation on disk: the starter configuration, and the file secret store chosen up front (a test never touches the account's own secret store). */
function installation(extra = (c) => c) {
  const base = mkdtempSync(join(tmpdir(), "nn-entry-"));
  const dataDir = join(base, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "secret-store.json"), `${JSON.stringify({ kind: FILE_STORE_KIND })}\n`);
  const config = extra(starterConfig(dataDir, {}));
  const configFile = join(dataDir, "nimblenewt.config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { base, dataDir, configFile, config, cleanup: () => { unlockAll(base); rmSync(base, { recursive: true, force: true }); } };
}

/** Runs the entry in this process until `during` has run against the live controller, then stops it the way SIGTERM does. */
async function runEntry(args, env, during = async () => undefined, extra = {}) {
  const c = capture();
  const ac = new AbortController();
  let seen;
  const done = main(["--allow-unsupported-environment", ...args], { stderr: c.stderr, env, signal: ac.signal, ready: (handle) => { seen = handle; }, ...extra });
  await Promise.race([until("the controller", () => seen !== undefined), done.then((code) => { throw new Error(`exited ${code} before it was up:\n${c.text}`); })]);
  try { await during(seen); } finally { ac.abort(); }
  return { code: await done, log: c.text };
}

test("arguments are strict: an unknown option, a stray word, a missing or empty value are refused (entry)", () => {
  assert.deepEqual(parseControllerArgs(["--serve", "--data", "/d", "--config=/c.json", "--local-host-environments"]), { serve: true, data: "/d", config: "/c.json", "local-host-environments": true });
  for (const bad of [["--frobnicate"], ["start"], ["--data"], ["--data", "--serve"], ["--data="], ["--serve=yes"], ["--release-root"], ["--"], ["--dat", "/d"]]) assert.throws(() => parseControllerArgs(bad), Error, bad.join(" "));
  // Review: a repeated option used to be last-wins, silently ignoring the first value.
  for (const twice of [["--data", "/a", "--data", "/b"], ["--data=/a", "--data", "/a"], ["--serve", "--serve"]]) assert.throws(() => parseControllerArgs(twice), /more than once/, twice.join(" "));
});

test("under the launcher a relative path, or a release root or pointer kind that contradicts the launcher's, is refused (entry review)", () => {
  const launcherEnv = { NIMBLENEWT_RELEASE_ROOT: "/r", NIMBLENEWT_RELEASE_SWITCHER: "pointer", NIMBLENEWT_RUNNING_RELEASE: RELEASE };
  assert.throws(() => controllerSettings({ data: "data" }, launcherEnv), /--data is the relative path "data"/);
  assert.throws(() => controllerSettings({}, { ...launcherEnv, NIMBLENEWT_DATA: "./data" }), /NIMBLENEWT_DATA is the relative path/);
  assert.throws(() => controllerSettings({ data: "/d", config: "c.json" }, launcherEnv), /--config is the relative path/);
  assert.throws(() => controllerSettings({ data: "/d", "release-root": "/elsewhere" }, launcherEnv), /--release-root differs from the launcher's NIMBLENEWT_RELEASE_ROOT/);
  assert.throws(() => controllerSettings({ data: "/d", "release-switcher": "symlink" }, launcherEnv), /--release-switcher differs/);
  // The root is resolved (path.resolve): "/r" on POSIX, "<current drive>:\\r" on Windows.
  assert.deepEqual(controllerSettings({ data: "/d", "release-root": "/r/", "release-switcher": "pointer" }, launcherEnv).release, { root: resolve("/r"), switcher: "pointer", runningRelease: RELEASE }, "the same settings again are fine");
  assert.equal(controllerSettings({ data: "rel" }, {}).dataDir, resolve("rel"), "by hand a relative path is the current directory's, as before");
});

test("'start confirmed' is said only when this start (the open attempt) is confirmed, not because the last known good names the release from an earlier run (entry review)", () => {
  const known = { id: RELEASE, digest: "d", confirmedAt: "2026-11-11T00:00:00.000Z" };
  assert.equal(startConfirmed({ known, attempt: { id: RELEASE, digest: "d", startedAt: "2026-11-11T01:00:00.000Z" }, failed: [], log: [] }, RELEASE), false, "restarted, not confirmed yet");
  assert.equal(startConfirmed({ known, failed: [], log: [] }, RELEASE), false, "no open attempt");
  assert.equal(startConfirmed({ known, attempt: { id: RELEASE, confirmedAt: "x" }, failed: [{ id: RELEASE }], log: [] }, RELEASE), false, "judged failed");
  assert.equal(startConfirmed({ attempt: { id: RELEASE, confirmedAt: "x" }, failed: [], log: [] }, RELEASE), true);
});

test("the release wiring: the running release comes from NIMBLENEWT_RUNNING_RELEASE and needs a release root; the root and the pointer kind come from the flags or the launcher's variables (entry, K02a)", () => {
  const none = controllerSettings({}, { NIMBLENEWT_DATA: "/x/data" });
  assert.equal(none.release, undefined, "no release root: no release wiring at all");
  assert.equal(none.configFile, join(resolve("/x/data"), "nimblenewt.config.json"));
  const fromEnv = controllerSettings({}, { NIMBLENEWT_DATA: "/d", NIMBLENEWT_RELEASE_ROOT: "/r", NIMBLENEWT_RELEASE_SWITCHER: "pointer", NIMBLENEWT_RUNNING_RELEASE: RELEASE });
  assert.deepEqual(fromEnv.release, { root: resolve("/r"), switcher: "pointer", runningRelease: RELEASE });
  const byHand = controllerSettings({ "release-root": "/r2" }, { NIMBLENEWT_DATA: "/d" });
  assert.deepEqual(byHand.release, { root: resolve("/r2") }, "started by hand: releases can be staged, but this process is no release's controller");
  assert.deepEqual(controllerSettings({ "release-root": "/r2", "release-switcher": "symlink" }, { NIMBLENEWT_RUNNING_RELEASE: RELEASE }).release, { root: resolve("/r2"), switcher: "symlink", runningRelease: RELEASE }, "the flag wins");
  assert.throws(() => controllerSettings({}, { NIMBLENEWT_RUNNING_RELEASE: RELEASE }), /no release root/);
  assert.throws(() => controllerSettings({}, { NIMBLENEWT_RELEASE_ROOT: "/r", NIMBLENEWT_RUNNING_RELEASE: "latest" }), /not a release ID/);
  assert.throws(() => controllerSettings({}, { NIMBLENEWT_RELEASE_ROOT: "/r", NIMBLENEWT_RELEASE_SWITCHER: "junction" }), /pointer or symlink/);
  assert.throws(() => controllerSettings({}, { NIMBLENEWT_RELEASE_SWITCHER: "pointer" }), /no release root/);
});

test("environment changes are off unless asked for, by the flag or the variable; a typo is refused (entry, A09b)", () => {
  assert.equal(controllerSettings({}, {}).environments, false);
  assert.equal(controllerSettings({}, { NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS: "" }).environments, false);
  assert.equal(controllerSettings({}, { NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS: "0" }).environments, false);
  assert.equal(controllerSettings({}, { NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS: "1" }).environments, true);
  assert.equal(controllerSettings({ "local-host-environments": true }, {}).environments, true);
  assert.throws(() => controllerSettings({}, { NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS: "yes please" }), /must be 1, true, on/);
  assert.equal(environmentsRequested(undefined, undefined), false);
  assert.equal(environmentsRequested(undefined, "TRUE"), true);
  // Review: nimblenewt.mjs keeps the text of `--local-host-environments=VALUE`; such a value used to leave the switch silently off.
  assert.equal(environmentsRequested("1", undefined), true);
  assert.equal(environmentsRequested("off", "1"), false, "the flag wins over the variable");
  assert.throws(() => environmentsRequested("yes", undefined), /--local-host-environments=VALUE must be/);
  assert.throws(() => environmentsRequested("", undefined), /--local-host-environments=VALUE must be/);
});

test("a restart can be requested only under the launcher and only when a database move is configured (entry)", () => {
  const withTargets = { controller: { databaseTransfer: { targets: [{ name: "a" }] } } };
  const reasons = [];
  const underLauncher = controllerSettings({}, { NIMBLENEWT_RELEASE_ROOT: "/r", NIMBLENEWT_RUNNING_RELEASE: RELEASE });
  const o = controllerStartOptions(underLauncher, withTargets, (why) => reasons.push(why));
  assert.deepEqual(o.releases, underLauncher.release);
  o.transfer.restart.run({ reason: "switched", transferId: "t", to: "x" });
  assert.equal(reasons.length, 1);
  assert.equal(controllerStartOptions(underLauncher, { controller: {} }, () => undefined).transfer, undefined, "no database move configured: no transfer option at all");
  assert.equal(controllerStartOptions(controllerSettings({ "release-root": "/r" }, {}), withTargets, () => undefined).transfer, undefined, "nobody would start it again");
  assert.deepEqual(controllerStartOptions(controllerSettings({}, {}), withTargets, () => undefined), {}, "nothing wired by default");
});

test("secrets: the store first, the environment for a name the store lacks, never the owner's credential from the environment, set writes the store only (entry)", async () => {
  const held = new Map([["db", "from-store"]]);
  const wrote = [];
  const store = { resolve: async (n) => held.get(n), set: async (n, v) => { wrote.push(n); held.set(n, v); } };
  const { environmentSecrets } = await dist("config", "index.js");
  const env = { NIMBLENEWT_SECRET_DB: "from-env", NIMBLENEWT_SECRET_KEY__DASH__X: "env-key", "NIMBLENEWT_SECRET_NIMBLENEWT__DASH__OWNER__DASH__TOKEN__DASH__AB": "forged" };
  const s = composeSecrets(store, env, "nimblenewt-owner-token", environmentSecrets);
  assert.equal(await s.resolve("db"), "from-store");
  assert.equal(await s.resolve("key-x"), "env-key");
  assert.equal(await s.resolve("nimblenewt-owner-token-ab"), undefined);
  assert.equal(await s.resolve("NIMBLENEWT-OWNER-TOKEN-AB"), undefined, "letter case does not open the environment to the owner's name");
  assert.equal(await s.resolve("absent"), undefined);
  await s.set("new", "v");
  assert.deepEqual(wrote, ["new"]);
});

test("a missing configuration, an invalid one and a bad option are refused with exit 1 and nothing is created (entry)", async () => {
  const inst = installation();
  try {
    const empty = join(inst.base, "empty");
    const c = capture();
    assert.equal(await main(["--data", empty], { stderr: c.stderr, env: {} }), 1);
    assert.match(c.text, /there is no configuration/);
    assert.equal(existsSync(empty), false, "no starter configuration is written by a supervised program");
    writeFileSync(inst.configFile, JSON.stringify({ configVersion: 1 }));
    const bad = capture();
    assert.equal(await main(["--data", inst.dataDir], { stderr: bad.stderr, env: {} }), 1);
    assert.match(bad.text, /is not valid/);
    const flag = capture();
    assert.equal(await main(["--data", inst.dataDir, "--wat"], { stderr: flag.stderr, env: {} }), 1);
    assert.match(flag.text, /unknown option --wat/);
    const help = capture();
    assert.equal(await main(["--help"], { stderr: help.stderr, env: {} }), 0);
    assert.match(help.text, /controller entry/);
    const lost = capture();
    assert.equal(await main(["--data", inst.dataDir], { stderr: lost.stderr, env: { NIMBLENEWT_RUNNING_RELEASE: RELEASE } }), 1);
    assert.match(lost.text, /no release root/);
    // Under the launcher a configuration with a relative data directory would put the installation inside the release directory.
    writeFileSync(inst.configFile, JSON.stringify({ ...inst.config, installation: { ...inst.config.installation, dataDir: "data" }, controller: { storage: { kind: "sqlite", path: "controller.sqlite" } } }));
    const rel = capture();
    assert.equal(await main(["--data", inst.dataDir], { stderr: rel.stderr, env: { NIMBLENEWT_RELEASE_ROOT: join(inst.base, "rel"), NIMBLENEWT_RUNNING_RELEASE: RELEASE } }), 1);
    assert.match(rel.text, /installation\.dataDir is the relative path "data"/);
    assert.equal(existsSync(join(inst.base, "rel")), false, "nothing was started");
  } finally { inst.cleanup(); }
});

test("a real controller starts from the entry, makes the owner, keeps every secret out of the log and stops on the signal with exit 0 (entry)", async () => {
  const inst = installation((c) => ({ ...c, models: { providers: { primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:9/v1", credential: { secret: "primary-key" }, enabled: true, paid: false, models: ["m"] } }, difficulty: {} } }));
  try {
    const SECRET = "sk-TESTSECRET-do-not-print-0123456789";
    const r = await runEntry(["--data", inst.dataDir], { NIMBLENEWT_SECRET_PRIMARY__DASH__KEY: SECRET }, async ({ controller }) => {
      assert.equal(typeof controller.api.handle, "function");
      assert.equal((await controller.storage.getAggregate({ kind: "installation", id: "installation" })) !== undefined, true, "the owner exists");
    });
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /started \(secrets are kept in: /);
    assert.match(r.log, /closed; stopped on purpose/);
    assert.doesNotMatch(r.log, /TESTSECRET/);
    assert.equal(existsSync(join(inst.dataDir, "controller.sqlite")), true);
    const again = await runEntry(["--data", inst.dataDir], {});
    assert.equal(again.code, 0, "a second start finds the owner's credential in the store");
    assert.doesNotMatch(again.log, /You are now the owner/);
  } finally { inst.cleanup(); }
});

test("a restart request closes the controller and exits 75; a signal already given before the start ends it with 0 (entry)", async () => {
  const inst = installation();
  try {
    const r = await runEntry(["--data", inst.dataDir], {}, async ({ requestRestart }) => { requestRestart("a test"); });
    assert.equal(r.code, 75, r.log);
    assert.match(r.log, /exiting 75/);
    const c = capture();
    const ac = new AbortController();
    ac.abort();
    assert.equal(await main(["--data", inst.dataDir, "--allow-unsupported-environment"], { stderr: c.stderr, env: {}, signal: ac.signal }), 0, c.text);
  } finally { inst.cleanup(); }
});

test("a database move under the launcher ends with exit 75, and the entry started again from the SAME configuration comes up on the new database by itself (entry, F04m)", async () => {
  const base = mkdtempSync(join(tmpdir(), "nn-entry-"));
  const moved = join(base, "elsewhere", "moved.sqlite");
  const inst = installation((c) => ({ ...c, controller: { ...c.controller, databaseTransfer: { targets: [{ name: "moved", kind: "sqlite", path: moved }] } } }));
  try {
    const { ownerSecretName } = await dist("controller", "index.js");
    const env = { NIMBLENEWT_RELEASE_ROOT: join(inst.base, "rel"), NIMBLENEWT_RELEASE_SWITCHER: "pointer", NIMBLENEWT_RUNNING_RELEASE: RELEASE };
    const c = capture();
    let seen;
    const done = main(["--allow-unsupported-environment", "--data", inst.dataDir], { stderr: c.stderr, env, ready: (handle) => { seen = handle; } });
    await Promise.race([until("the controller", () => seen !== undefined), done.then((code) => { throw new Error(`exited ${code} before it was up:\n${c.text}`); })]);
    const token = await (await fileStore(inst.dataDir)).resolve(ownerSecretName(inst.dataDir));
    const call = (op, args, commandId) => seen.controller.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args });
    assert.equal((await call("project.create", { name: "Garden" }, "p1")).ok, true);
    const preview = await call("database.transfer.preview", { target: "moved" });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await call("database.transfer.apply", { target: "moved", confirm: preview.result.item.token }, "move-1");
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(await done, 75, c.text);
    assert.match(c.text, /exiting 75/);
    assert.equal(existsSync(moved), true, "the new database file exists");
    // The same configuration (it still names controller.sqlite) and no hand edit: the start follows the authority file.
    // The same configuration (it still names controller.sqlite) and no hand edit: the start follows the authority file. The rollback (also asked for under the launcher) leads back by the same road.
    const c2 = capture();
    let seen2;
    const done2 = main(["--allow-unsupported-environment", "--data", inst.dataDir], { stderr: c2.stderr, env, ready: (handle) => { seen2 = handle; } });
    await Promise.race([until("the second controller", () => seen2 !== undefined), done2.then((code) => { throw new Error(`exited ${code} before it was up:\n${c2.text}`); })]);
    assert.match(c2.text, /The controller database was moved to moved \(sqlite\) by a database transfer; this start uses it\./);
    const t2 = await (await fileStore(inst.dataDir)).resolve(ownerSecretName(inst.dataDir));
    const call2 = (op, args, commandId) => seen2.controller.api.handle(t2, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args });
    assert.match(JSON.stringify(await call2("project.list", {})), /Garden/, "the data is on the database it started on");
    assert.match(JSON.stringify(await call2("database.transfer.status", {})), /moved/);
    const back = await call2("database.transfer.rollback", {}, "back-1");
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(await done2, 75, c2.text);
    const third = await runEntry(["--data", inst.dataDir], {}, async ({ controller }) => {
      const t = await (await fileStore(inst.dataDir)).resolve(ownerSecretName(inst.dataDir));
      assert.match(JSON.stringify(await controller.api.handle(t, { v: 1, op: "project.list", args: {} })), /Garden/);
    });
    assert.equal(third.code, 0, third.log);
    assert.doesNotMatch(third.log, /was moved to/, "back on the configured database: nothing to follow");
  } finally { inst.cleanup(); rmSync(base, { recursive: true, force: true }); }
});

test("a close that does not finish is given up after the timeout and the entry exits 1, not 0 (entry review)", async () => {
  const inst = installation();
  let real;
  let controllerSeen;
  try {
    const r = await runEntry(["--data", inst.dataDir], {}, async ({ controller }) => {
      controllerSeen = controller;
      real = controller.close.bind(controller);
      controller.close = () => new Promise(() => undefined);
    }, { closeTimeoutMs: 300 });
    assert.equal(r.code, 1, r.log);
    assert.match(r.log, /closing failed: it did not finish within 0 s/);
    assert.doesNotMatch(r.log, /stopped on purpose/);
  } finally { if (real !== undefined) { controllerSeen.close = real; await real().catch(() => undefined); } inst.cleanup(); }
});

test("a secret name that is the owner's credential's is never resolved for a database, a provider or a transfer target (launch review)", async () => {
  const inst = installation((c) => ({ ...c, controller: { storage: { kind: "postgres", url: { secret: "NimbleNewt-Owner-Token-0123" }, maxConnections: 2 } } }));
  try {
    const { launch } = await dist("controller", "index.js");
    const { loadConfig } = await dist("config", "index.js");
    const loaded = loadConfig(readFileSync(inst.configFile, "utf8"));
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
    const asked = [];
    const secrets = { resolve: async (n) => { asked.push(n); return "postgres://owner-token-would-go-here"; }, set: async () => undefined };
    await assert.rejects(launch({ config: loaded.config, secrets, argv: [], env: {}, print: () => undefined }), /reserved for the owner's credential/);
    assert.deepEqual(asked, [], "the store was not even asked");
  } finally { inst.cleanup(); }
});

test("the release wiring starts a real controller: as the running release it asks the activation record, and says so when the record does not name it (entry, K02a)", async () => {
  const inst = installation();
  const root = join(inst.base, "rel");
  try {
    const first = await runEntry(["--data", inst.dataDir], { NIMBLENEWT_RELEASE_ROOT: root, NIMBLENEWT_RELEASE_SWITCHER: "pointer", NIMBLENEWT_RUNNING_RELEASE: RELEASE });
    assert.equal(first.code, 0, first.log);
    assert.match(first.log, /start NOT confirmed for rcn-0123456789abcdef01234567/);
    // By hand with the root only: no release is "running", so nothing is said about confirming.
    const byHand = await runEntry(["--data", inst.dataDir], { NIMBLENEWT_RELEASE_ROOT: root, NIMBLENEWT_RELEASE_SWITCHER: "pointer" });
    assert.equal(byHand.code, 0, byHand.log);
    assert.doesNotMatch(byHand.log, /start (NOT )?confirmed/);
  } finally { inst.cleanup(); }
});

test("environment changes: off by default, on with the flag or the variable, through the entry and through nimblenewt.mjs (A09b)", async () => {
  const inst = installation();
  const envDir = `${inst.dataDir}.environments`;
  try {
    // The owner turns the worker host on (it counts from the next start).
    const { ownerSecretName } = await dist("controller", "index.js");
    const first = await runEntry(["--data", inst.dataDir], {}, async ({ controller }) => {
      const token = await (await fileStore(inst.dataDir)).resolve(ownerSecretName(inst.dataDir));
      const set = await controller.api.handle(token, { v: 1, op: "host.local.set", commandId: "host-on", args: { enabled: true } });
      assert.equal(set.ok, true, JSON.stringify(set));
    });
    assert.equal(first.code, 0, first.log);
    const off = await runEntry(["--data", inst.dataDir], {});
    if (/was not started/.test(off.log)) {
      // The local worker host runs agents in bubblewrap and says it is Linux only (scripts/local-host.mjs): a required sandbox makes its start required on Linux alone.
      assert.equal(required && process.platform === "linux", false, `NIMBLENEWT_REQUIRE_SANDBOX=1 but the worker host could not start:\n${off.log}`);
      if (process.platform !== "linux") assert.match(off.log, /bubblewrap, which is Linux only so far/, "off Linux the host says why it did not start");
      return;
    }
    assert.match(off.log, /running agents in a sandbox/);
    assert.equal(existsSync(envDir), false, "off by default: no environment store is made");
    const flag = await runEntry(["--data", inst.dataDir, "--local-host-environments"], {});
    assert.match(flag.log, /running agents in a sandbox/);
    assert.equal(existsSync(join(envDir, "mirror")), true, "the flag turns the runtime on");
    rmSync(envDir, { recursive: true, force: true });
    const viaEnv = await runEntry(["--data", inst.dataDir], { NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS: "1" });
    assert.equal(existsSync(join(envDir, "mirror")), true, "the variable turns it on too");
    rmSync(envDir, { recursive: true, force: true });
    // The interactive launcher takes the same switch.
    const io = (env) => { let t = ""; return { io: { stdin: { isTTY: false }, stdout: { write: (x) => { t += x; } }, stderr: { write: (x) => { t += x; } }, env }, get text() { return t; } }; };
    const plain = io({});
    assert.equal(await startMain(["status", "--data", inst.dataDir, "--allow-unsupported-environment"], plain.io), 0, plain.text);
    assert.equal(existsSync(envDir), false, "nimblenewt.mjs: off by default");
    const withFlag = io({});
    assert.equal(await startMain(["status", "--data", inst.dataDir, "--allow-unsupported-environment", "--local-host-environments"], withFlag.io), 0, withFlag.text);
    assert.equal(existsSync(join(envDir, "mirror")), true, "nimblenewt.mjs: the flag turns it on");
    assert.equal(viaEnv.code, 0, viaEnv.log);
  } finally { inst.cleanup(); }
});

test("the host refuses to claim any tool can run when the script runner says it cannot (hostScriptRunner problem, T02d follow-up)", async () => {
  const stopped = [];
  const fake = {
    controller: {},
    "pi-adapter": {},
    worker: {
      SandboxLauncher: { create: async () => ({ capacity: { available: true, backend: "bubblewrap" }, stop: async () => { stopped.push("launcher"); } }) },
      hostScriptBase: (d) => `${d}.scripts`,
      hostScriptRunner: async () => ({ problem: () => "no interpreter is offered", stop: async () => { stopped.push("scripts"); } }),
    },
  };
  const inst = installation();
  try {
    const build = localHostBuilder({ root: repo, load: async (pkg) => fake[pkg] });
    const made = await build({ dataDir: inst.dataDir, print: () => undefined });
    if (process.platform === "linux") {
      assert.match(made.problem, /no tool could run on this host \(no interpreter is offered\)/);
      assert.deepEqual(stopped, ["scripts", "launcher"], "what was made is freed");
    }
  } finally { inst.cleanup(); }
});

test("the configuration's workspace folders reach the start-up file system check, a relative one from the data directory (launch, F04k wiring)", async () => {
  const inst = installation((c) => ({ ...c, installation: { ...c.installation, workspaces: { main: { path: "checkouts" }, abs: { path: join(tmpdir(), "nn-ws-elsewhere") } } } }));
  try {
    const { launch } = await dist("controller", "index.js");
    const { loadConfig } = await dist("config", "index.js");
    const loaded = loadConfig(readFileSync(inst.configFile, "utf8"));
    assert.equal(loaded.ok, true);
    const asked = [];
    const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
    const start = (detect) => ({ facts, filesystem: detect, features: [], harnesses: [] });
    const printed = [];
    const l = await launch({ config: loaded.config, secrets: (await fileStore(inst.dataDir)), argv: [], env: {}, print: (t) => printed.push(t), start: start(async (path) => { asked.push(path); return { type: "ext4", network: false }; }) });
    await l.close();
    assert.ok(asked.includes(join(inst.dataDir, "checkouts")), `asked: ${asked.join(", ")}`);
    assert.ok(asked.includes(join(tmpdir(), "nn-ws-elsewhere")));
    assert.doesNotMatch(printed.join("\n"), /installation\.workspaces/, "nothing extra is said when the folders are fine");
    // A workspace on a file system that is not supported refuses the start, as the data directory's would, and the refusal says where the folder came from and what to do.
    const refused = [];
    await assert.rejects(launch({ config: loaded.config, secrets: (await fileStore(inst.dataDir)), argv: [], env: {}, print: (t) => refused.push(t), start: start(async (path) => (path.endsWith("checkouts") ? { type: "nfs", network: true } : { type: "ext4", network: false })) }), /workspace/);
    assert.ok(refused.join("\n").includes(`come from the configuration (installation.workspaces: main = ${join(inst.dataDir, "checkouts")}, abs = `), refused.join("\n"));
    assert.match(refused.join("\n"), /remove it from the configuration, or start with --allow-unsupported-environment/);
    // An explicit start.workspaceRoots wins: the configuration's folders are then not checked.
    const only = [];
    const l2 = await launch({ config: loaded.config, secrets: (await fileStore(inst.dataDir)), argv: [], env: {}, print: () => undefined, start: { ...start(async (path) => { only.push(path); return { type: "ext4", network: false }; }), workspaceRoots: [] } });
    await l2.close();
    assert.equal(only.includes(join(inst.dataDir, "checkouts")), false);
    // `~` is not expanded, and that is said.
    const tilde = loadConfig(JSON.stringify({ ...loaded.config, installation: { ...loaded.config.installation, workspaces: { home: { path: "~/code" } } } }));
    assert.equal(tilde.ok, true);
    const said = [];
    const l3 = await launch({ config: tilde.config, secrets: (await fileStore(inst.dataDir)), argv: [], env: {}, print: (t) => said.push(t), start: start(async () => ({ type: "ext4", network: false })) });
    await l3.close();
    assert.match(said.join("\n"), /The workspace folder ~\/code \(installation\.workspaces\.home\) starts with ~, which is not expanded/);
  } finally { inst.cleanup(); }
});

// ---- as a child of the release launcher -------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A release root with one release staged, approved and activated through the real state API (the activation record names it current, the launcher's pointer points at it). The release's controller.js is a
 * one-line program that runs this repository's entry; `restartOnce` makes its first run ask for a restart.
 */
async function activatedRelease(inst, { restartOnce = false } = {}) {
  const root = join(inst.base, "rel");
  const { launch } = await dist("controller", "index.js");
  const { loadConfig } = await dist("config", "index.js");
  const loaded = loadConfig(readFileSync(inst.configFile, "utf8"));
  assert.equal(loaded.ok, true);
  const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
  const cell = { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" };
  const marker = join(inst.base, "restarted-once");
  const entryUrl = pathToFileURL(join(repo, "scripts", "nimblenewt-controller.mjs")).href;
  const files = {
    "controller.js": restartOnce
      ? `import { existsSync, writeFileSync } from "node:fs";\nimport { main } from ${JSON.stringify(entryUrl)};\nconst first = !existsSync(${JSON.stringify(marker)});\nif (first) writeFileSync(${JSON.stringify(marker)}, "x");\nprocess.exitCode = await main(process.argv.slice(2), { stderr: process.stderr, env: process.env, ready: ({ requestRestart }) => { if (first) setTimeout(() => requestRestart("the release asked"), 300); } });\n`
      : `import { main } from ${JSON.stringify(entryUrl)};\nprocess.exitCode = await main(process.argv.slice(2));\n`,
    "compat.json": JSON.stringify({ protocol: { min: 1, max: 1 } }),
  };
  const l = await launch({
    config: loaded.config, secrets: (await fileStore(inst.dataDir)), argv: [], env: {}, print: () => undefined,
    start: { facts, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [], releases: { root, switcher: "pointer", platform: cell } },
  });
  try {
    const call = (token, op, args, commandId) => l.controller.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args });
    const owner = (op, args, id) => call(l.ownerToken, op, args, id);
    await l.controller.services.principals.enroll(await l.controller.services.principals.authenticate(l.ownerToken), { commandId: "e1", kind: "agent", name: "builder", grants: [{ action: "release.report", project: "*" }] });
    const builderToken = (await l.controller.services.principals.issueCredential(await l.controller.services.principals.authenticate(l.ownerToken), "agent:builder")).token;
    const builder = await l.controller.services.principals.authenticate(builderToken);
    assert.ok((await owner("release.host", { hostId: "lx", ...cell }, "h1")).ok);
    const artifacts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
    const manifest = { sourceCommit: "c".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: [cell] };
    const id = (await owner("release.submit", { manifest }, "sub")).result.candidateId;
    const att = (await owner("release.issue", { candidateId: id, cell, hostId: "lx", workerId: builder.id, timeoutSeconds: 600, memoryMb: 2048 }, "iss")).result.attemptId;
    const rep = await call(builderToken, "release.report", { attemptId: att, sourceCommit: "c".repeat(40), suiteRevision: "s1", artifactHashes: artifacts, dependencyLockHashes: { lock: sha("lock") }, environment: cell, outcome: "pass", counts: { passed: 1, failed: 0, skipped: 0 }, logDigest: sha("log"), summary: "ok" }, "rep");
    assert.ok(rep.ok, JSON.stringify(rep));
    for (const [k, v] of Object.entries(files)) { const p = join(root, "incoming", id, k); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v); }
    const staged = await owner("release.stage", { candidateId: id }, "st");
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.ok((await owner("release.approve", { candidateId: id }, "ap")).ok);
    const act = await owner("release.activate", { candidateId: id, digest: staged.result.digest, expectedRevision: 0 }, "act");
    assert.ok(act.ok, JSON.stringify(act));
    return { root, id };
  } finally { await l.close(); }
}

const launcherChild = (inst, root) => {
  const child = spawn(process.execPath, [join(repo, "scripts", "nimblenewt-launcher.mjs"), "--root", root, "--switcher", "pointer", "--poll-ms", "50", "--grace-seconds", "5", "--backoff-initial-ms", "50", "--", "--allow-unsupported-environment"],
    { env: { ...process.env, NIMBLENEWT_DATA: inst.dataDir }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (d) => { log += d; });
  const ended = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, ended, get log() { return log; } };
};

test("launcher -> entry -> startController -> confirmation -> SIGTERM stops it cleanly and the launcher exits 0 (real child processes, K02a)", { skip: process.platform === "win32" }, async () => {
  const inst = installation();
  let run;
  try {
    const { root, id } = await activatedRelease(inst);
    run = launcherChild(inst, root);
    await until("the confirmed start", () => /start confirmed: /.test(run.log), 60_000).catch((e) => { throw new Error(`${e.message}\n${run.log}`); });
    assert.match(run.log, new RegExp(`started ${id}`));
    assert.match(run.log, new RegExp(`start confirmed: ${id} is the last known good release`));
    const { Launcher, PointerSwitcher } = await dist("controller", "release/index.js");
    assert.equal((await new Launcher({ root, switcher: new PointerSwitcher(root) }).read()).known?.id, id, "the launcher's own record names the release as confirmed");
    const beat = readdirSync(join(root, "run")).filter((f) => f.startsWith("heartbeat-"));
    assert.equal(beat.length, 1, "the launcher's heartbeat file for this start exists: the entry passed the heartbeat variables on to startController");
    const counter = () => readFileSync(join(root, "run", beat[0]), "utf8");
    const first = counter();
    await until("the heartbeat to move", () => counter() !== first, 30_000);
    run.child.kill("SIGTERM");
    const end = await run.ended;
    assert.deepEqual(end, { code: 0, signal: null }, run.log);
    assert.match(run.log, /controller: SIGTERM received, stopping/);
    assert.match(run.log, /controller: closed; stopped on purpose/);
    assert.match(run.log, new RegExp(`${id} exited \\(code 0, signal none\\)`));
    assert.doesNotMatch(run.log, /NOT confirmed|failed|crash/i);
  } finally { if (run !== undefined && run.child.exitCode === null) run.child.kill("SIGKILL"); inst.cleanup(); }
});

test("a controller that exits 75 is started again by the launcher, confirmed again, and then stopped cleanly (real child processes, K02a)", { skip: process.platform === "win32" }, async () => {
  const inst = installation();
  let run;
  try {
    const { root, id } = await activatedRelease(inst, { restartOnce: true });
    run = launcherChild(inst, root);
    await until("the second confirmed start", () => (run.log.match(/start confirmed: /g) ?? []).length >= 2, 90_000).catch((e) => { throw new Error(`${e.message}\n${run.log}`); });
    assert.match(run.log, /exiting 75/);
    assert.match(run.log, new RegExp(`${id} asked to be restarted`));
    run.child.kill("SIGTERM");
    assert.deepEqual(await run.ended, { code: 0, signal: null }, run.log);
    assert.equal((run.log.match(new RegExp(`started ${id} `, "g")) ?? []).length, 2);
  } finally { if (run !== undefined && run.child.exitCode === null) run.child.kill("SIGKILL"); inst.cleanup(); }
});
