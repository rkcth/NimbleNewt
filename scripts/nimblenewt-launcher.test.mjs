// Card K02a: the release launcher's command line, against a fixture release root and a fake controller (no database, no deployment).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { main } from "./nimblenewt-launcher.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => import(pathToFileURL(join(repo, "packages", "controller", "dist", f)).href);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const capture = () => { let text = ""; return { stderr: { write: (t) => { text += t; } }, get text() { return text; } }; };

async function install(root, source) {
  const { Launcher } = await dist("release/launcher.js");
  const { PointerSwitcher } = await dist("release/activation.js");
  const id = `rcn-${sha("k02a-cli").slice(0, 24)}`;
  const dir = join(root, "releases", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "controller.js"), source);
  const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: { "controller.js": { sha256: sha(source), size: Buffer.byteLength(source) } } });
  writeFileSync(join(dir, "MANIFEST.json"), manifest);
  const sw = new PointerSwitcher(root);
  const launcher = new Launcher({ root, switcher: sw });
  await launcher.expect({ id, digest: sha(manifest), protocol: { min: 1, max: 1 } });
  await sw.write(id);
  return id;
}

test("the launcher program runs the pointer's controller with the release id and extra arguments, and stops it on shutdown with exit 0 (K02a)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-cli-"));
  try {
    const out = join(root, "seen.json");
    const id = await install(root, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ id: process.env.NIMBLENEWT_RUNNING_RELEASE, args: process.argv.slice(2), cwd: process.cwd(), hb: process.env.NIMBLENEWT_HEARTBEAT_FILE, every: process.env.NIMBLENEWT_HEARTBEAT_INTERVAL_MS })); setInterval(() => {}, 1000);`);
    const c = capture();
    const ac = new AbortController();
    const done = main(["--root", root, "--poll-ms", "20", "--grace-seconds", "1", "--heartbeat-interval-seconds", "2", "--heartbeat-stale-seconds", "60", "--", "--serve", "x"], { stderr: c.stderr, env: process.env, signal: ac.signal });
    for (let i = 0; i < 400; i++) { try { readFileSync(out); break; } catch { await new Promise((r) => setTimeout(r, 25)); } }
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(seen.id, id);
    assert.deepEqual(seen.args, ["--serve", "x"]);
    assert.equal(seen.cwd.endsWith(join("releases", id)), true);
    assert.ok(seen.hb.startsWith(join(root, "run", "heartbeat-")), "the controller is given a heartbeat file under the root");
    assert.equal(seen.every, "2000");
    ac.abort();
    assert.equal(await done, 0, c.text);
    assert.match(c.text, new RegExp(`started ${id}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("usage errors exit 1, no active release exits 3, a pointer nobody announced exits 2 (K02a)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-cli-"));
  try {
    assert.equal(await main([], { stderr: capture().stderr, env: {} }), 1);
    assert.equal(await main(["--root", root, "--entry", "../x.js"], { stderr: capture().stderr, env: {} }), 1);
    assert.equal(await main(["--root", root, "--switcher", "bogus"], { stderr: capture().stderr, env: {} }), 1);
    assert.equal(await main(["--root", root, "--give-up-after", "0"], { stderr: capture().stderr, env: {} }), 1);
    assert.equal(await main(["--root", root, "--stable-seconds", "0"], { stderr: capture().stderr, env: {} }), 1, "a zero stable time would never slow a crash loop");
    assert.equal(await main(["--root", root, "--grace-seconds", "99999999"], { stderr: capture().stderr, env: {} }), 1, "beyond what a timer can wait");
    // heartbeat thresholds below the safe minimums are refused, not quietly raised
    for (const bad of [["--heartbeat-stale-seconds", "29"], ["--heartbeat-interval-seconds", "0"], ["--heartbeat-interval-seconds", "61"], ["--heartbeat-first-beat-seconds", "299"],
      ["--heartbeat-stale-seconds", "600", "--heartbeat-first-beat-seconds", "300"], ["--heartbeat", "maybe"], ["--heartbeat", "off", "--heartbeat-stale-seconds", "60"]]) {
      const c = capture();
      assert.equal(await main(["--root", root, ...bad], { stderr: c.stderr, env: {} }), 1, bad.join(" "));
      assert.match(c.text, /heartbeat/);
    }
    assert.equal(await main(["--root", root], { stderr: capture().stderr, env: {}, signal: new AbortController().signal }), 3);
    writeFileSync(join(root, "current.json"), JSON.stringify({ release: "rcn-aaaaaaaaaaaaaaaaaaaaaaaa" }));
    const c = capture();
    assert.equal(await main(["--root", root], { stderr: c.stderr, env: {}, signal: new AbortController().signal }), 2);
    assert.match(c.text, /never announced/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what, cond, ms = 20_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); } };
/** A fake controller that confirms its own start (as the real one does), then records its pid (as the real one does) and runs until killed; `stubborn` ignores SIGTERM. */
const controller = (pidFile, { stubborn = false } = {}) => `
import { appendFileSync } from "node:fs";
${stubborn ? 'process.on("SIGTERM", () => {});' : ""}
const { Launcher } = await import(${JSON.stringify(pathToFileURL(join(repo, "packages", "controller", "dist", "release", "launcher.js")).href)});
const { PointerSwitcher } = await import(${JSON.stringify(pathToFileURL(join(repo, "packages", "controller", "dist", "release", "activation.js")).href)});
const root = process.cwd() + "/../..";
await new Launcher({ root, switcher: new PointerSwitcher(root) }).confirm(process.env.NIMBLENEWT_RUNNING_RELEASE);
appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
setInterval(() => {}, 1000);
`;
const pidsIn = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number) : []);
const launch = (root, extra = []) => spawn(process.execPath, [join(repo, "scripts", "nimblenewt-launcher.mjs"), "--root", root, "--poll-ms", "20", ...extra], { stdio: ["ignore", "ignore", "pipe"] });
const exited = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r({ code: p.exitCode, signal: p.signalCode }); else p.once("exit", (code, signal) => r({ code, signal })); });

test("a launcher killed with SIGKILL leaves its controller running: a second launcher on the root exits 5 and starts nothing until that controller is gone (K02a)", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-cli-"));
  const pidFile = join(root, "pids");
  try {
    await install(root, controller(pidFile));
    const first = launch(root);
    await until("the controller", () => pidsIn(pidFile).length === 1);
    const [orphan] = pidsIn(pidFile);
    first.kill("SIGKILL");
    await exited(first);
    assert.equal(alive(orphan), true, "the controller outlives a launcher killed outright (it leads its own process group)");
    const c = capture();
    assert.equal(await main(["--root", root, "--poll-ms", "20"], { stderr: c.stderr, env: process.env, signal: new AbortController().signal }), 5, c.text);
    assert.equal(pidsIn(pidFile).length, 1, "no second controller on the same installation");
    process.kill(orphan, "SIGKILL");
    await until("the orphan gone", () => !alive(orphan));
    const ac = new AbortController();
    const c2 = capture();
    const third = main(["--root", root, "--poll-ms", "20", "--grace-seconds", "2"], { stderr: c2.stderr, env: process.env, signal: ac.signal });
    await until("the next controller", () => pidsIn(pidFile).length === 2).catch((e) => { throw new Error(e.message + " " + c2.text); });
    ac.abort();
    assert.equal(await third, 0, c2.text);
  } finally { for (const p of pidsIn(pidFile)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); }
});

test("a second SIGTERM or SIGINT while the launcher is stopping does not end it half way: it still kills a controller that ignores SIGTERM and exits 0 (K02a)", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-cli-"));
  const pidFile = join(root, "pids");
  try {
    await install(root, controller(pidFile, { stubborn: true }));
    const l = launch(root, ["--grace-seconds", "1"]);
    let log = ""; l.stderr.on("data", (d) => { log += d; });
    await until("the controller", () => pidsIn(pidFile).length === 1);
    const [pid] = pidsIn(pidFile);
    l.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    l.kill("SIGINT");
    l.kill("SIGTERM");
    const end = await exited(l);
    assert.deepEqual(end, { code: 0, signal: null }, log);
    assert.match(log, /already stopping/);
    await until("the stubborn controller gone", () => !alive(pid), 5000);
  } finally { for (const p of pidsIn(pidFile)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); }
});
