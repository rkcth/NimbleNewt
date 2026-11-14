// The controller-down watchdog's own program (scripts/nimblenewt-watchdog.mjs, card U11d): where the webhook address may come from (never the command line), what it prints, the record it writes, and that a
// stop request ends it without waiting out the interval. Loopback only; the channel's secret is made at run time.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { WEBHOOK_ENV, main } from "./nimblenewt-watchdog.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(join(repo, "packages", "controller", "dist", "notifications", "watchdog.js")).href);
const sink = () => { const out = []; return { out, write: (s) => { out.push(String(s)); return true; } }; };
const io = () => { const stderr = sink(); const stdout = sink(); return { stderr, stdout, text: () => stderr.out.join("") + stdout.out.join("") }; };

async function channel() {
  const got = [];
  const server = createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { got.push({ path: req.url, text: JSON.parse(b).text }); res.statusCode = 204; res.end(); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { got, server, base: `http://127.0.0.1:${server.address().port}` };
}

test("the webhook address never comes from the command line, and what is refused does not repeat it", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wdcli-"));
  try {
    const secret = randomBytes(16).toString("hex");
    const hook = `https://hooks.invalid/${secret}`;
    for (const argv of [["--record", join(d, "r.json"), "--url", "http://127.0.0.1:9/", "--webhook", hook], [hook]]) {
      const o = io();
      assert.notEqual(await main(argv, o, lib, {}), 0);
      assert.ok(!o.text().includes(secret), o.text());
    }
    const o = io();
    assert.equal(await main(["--record", "r.json", "--url", "http://127.0.0.1:9/"], o, lib, { [WEBHOOK_ENV]: hook }), 1);
    assert.match(o.text(), /--record needs an absolute file path/);
    // Plain http to another machine would send the secret in clear text: refused before anything is sent.
    const plain = io();
    assert.equal(await main(["--record", join(d, "r.json"), "--url", "http://127.0.0.1:9/", "--once"], plain, lib, { [WEBHOOK_ENV]: `http://hooks.invalid/${secret}` }), 1);
    assert.match(plain.text(), /must use https/);
    assert.ok(!plain.text().includes(secret));
    assert.ok(!existsSync(join(d, "r.json")), "nothing was recorded");
    if (process.platform !== "win32") {
      const file = join(d, "hook.txt"); writeFileSync(file, `${hook}\n`); chmodSync(file, 0o644);
      const open = io();
      assert.equal(await main(["--record", join(d, "r.json"), "--url", "http://127.0.0.1:9/", "--webhook-file", file, "--once"], open, lib, {}), 1);
      assert.match(open.text(), /readable by its owner only/);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("one look at a controller that does not answer tells the owner's channel from the environment or a private file, records the outage, and prints neither address nor secret", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wdcli-"));
  const ch = await channel();
  try {
    const secret = randomBytes(16).toString("hex");
    const record = join(d, "r.json");
    const o = io();
    // Port 9 (discard) on this machine: nothing listens, so the controller "does not answer".
    assert.equal(await main(["--record", record, "--url", "http://127.0.0.1:9/", "--failures", "1", "--once"], o, lib, { [WEBHOOK_ENV]: `${ch.base}/hook/${secret}` }), 0);
    assert.equal(o.stdout.out.join(""), "down (told)\n");
    assert.equal(ch.got.length, 1);
    assert.equal(ch.got[0].path, `/hook/${secret}`);
    assert.match(ch.got[0].text, /controller is not answering/);
    assert.ok(!o.text().includes(secret));
    const saved = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(saved.tells, 1);
    assert.ok(!JSON.stringify(saved).includes(secret) && !JSON.stringify(saved).includes("127.0.0.1"), "the record holds times and counts only");
    // A second look by a new process goes on with the record: no second message.
    const file = join(d, "hook.txt"); writeFileSync(file, `${ch.base}/hook/${secret}\n`, { mode: 0o600 }); if (process.platform !== "win32") chmodSync(file, 0o600);
    const again = io();
    assert.equal(await main(["--record", record, "--url", "http://127.0.0.1:9/", "--failures", "1", "--webhook-file", file, "--once"], again, lib, {}), 0);
    assert.equal(again.stdout.out.join(""), "down\n");
    assert.equal(ch.got.length, 1);
  } finally { ch.server.close(); rmSync(d, { recursive: true, force: true }); }
});

test("a stop request ends the watchdog at once, not after the interval; and a long interval still lets the heartbeat probe judge", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wdcli-"));
  try {
    const signals = new EventEmitter();
    let probeOptions;
    const spy = { ...lib, heartbeatProbe: (file, o) => { probeOptions = o; return lib.heartbeatProbe(file, o); }, DownWatchdog: class extends lib.DownWatchdog { async tick() { const r = await super.tick(); setImmediate(() => signals.emit("SIGTERM")); return r; } } };
    const started = Date.now();
    const code = await main(["--record", join(d, "r.json"), "--heartbeat-file", join(d, "hb.json"), "--every-seconds", "3600"], io(), spy, { [WEBHOOK_ENV]: "https://hooks.invalid/x" }, signals);
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 60_000, "not held for the hour between looks");
    // The probe reads a gap of more than half its limit between two looks as a pause of this process; with an hour between looks the limit must be over two hours, or it would never judge.
    assert.ok(probeOptions.staleMs > 2 * 3_600_000, JSON.stringify(probeOptions));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
