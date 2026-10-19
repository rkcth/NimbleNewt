import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// --import needs a file: URL on Windows; a drive-letter path is rejected as an unknown URL scheme.
const guard = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;

/** Runs `code` as an ES module in a child process with the guard preloaded; returns its stdout. */
function run(code) {
  const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const blocked = (expr) => run(`try { await (async () => { ${expr} })(); console.log("allowed"); } catch (e) { console.log(/network access is blocked/.test(String(e)) ? "blocked" : "other:" + e.code); }`);

test("fetch to an external host is blocked", () => assert.equal(blocked('await fetch("http://example.com/")'), "blocked"));
test("net.connect to an external address is blocked", () => assert.equal(blocked('(await import("node:net")).connect(80, "93.184.216.34")'), "blocked"));
test("dns lookups and resolves are blocked", () => {
  assert.equal(blocked('await (await import("node:dns")).promises.lookup("example.com")'), "blocked");
  assert.equal(blocked('(await import("node:dns")).resolve4("example.com", () => {})'), "blocked");
  assert.equal(blocked('const { lookup } = await import("node:dns"); lookup("example.com", () => {})'), "blocked");
});
test("dns Resolver instances are blocked", () => {
  assert.equal(blocked('new (await import("node:dns")).Resolver().resolve4("example.com", () => {})'), "blocked");
  assert.equal(blocked('await new (await import("node:dns")).promises.Resolver().resolve4("example.com")'), "blocked");
});
test("hostnames that merely start with 127. are not treated as loopback", () =>
  assert.equal(blocked('(await import("node:net")).connect(80, "127.0.0.1.nip.io")'), "blocked"));
test("dgram sends to an external address are blocked", () =>
  assert.equal(blocked('const s = (await import("node:dgram")).createSocket("udp4"); try { s.send("x", 9, "93.184.216.34"); } finally { s.close(); }'), "blocked"));
test("loopback connections are not blocked by the guard", () =>
  assert.equal(blocked('const net = await import("node:net"); await new Promise((res, rej) => { const s = net.connect(9, "127.0.0.1"); s.on("error", rej); s.on("connect", res); })'), "other:ECONNREFUSED"));
test("worker threads inherit the guard", () =>
  assert.equal(run('import { Worker } from "node:worker_threads"; const w = new Worker("fetch(\\"http://example.com/\\").then(() => console.log(\\"allowed\\"), (e) => console.log(/blocked/.test(String(e)) ? \\"blocked\\" : \\"other\\"))", { eval: true }); await new Promise((r) => w.on("exit", r));'), "blocked"));
test("node child processes inherit the guard", () =>
  assert.equal(run('import { execFileSync } from "node:child_process"; console.log(execFileSync(process.execPath, ["-e", "fetch(\\"http://example.com/\\").then(() => console.log(\\"allowed\\"), (e) => console.log(/blocked/.test(String(e)) ? \\"blocked\\" : \\"other\\"))"], { encoding: "utf8" }).trim());'), "blocked"));
