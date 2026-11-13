import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { InstallScriptPort } from "./agent-environments.js";
import { INSPECT_TEXT_BYTES, LocalEnvironmentRuntime, type WorkerHooks } from "./runtime.js";
import type { ArtifactSource } from "./sources.js";
import { fixture } from "./testing/tar.js";

// Card A09 seventh slice: the reviewer reads what an artifact declares before approving it. Nothing is stored, unpacked on disk or run.
const POSIX_STORE = process.platform === "win32" && "the environment runtime is Linux only; its store's links, locks and renames are POSIX";
const top = realpathSync(mkdtempSync(join(tmpdir(), "nn-a09i-")));
after(() => rmSync(top, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => { const d = join(top, `r${n++}`); mkdirSync(d, { recursive: true }); return d; };
const hooks: WorkerHooks = { restart: async () => undefined, session: async () => ({ sessionIntact: true, compactionIntact: true }) };
const url = (name: string): string => `https://registry.example.org/${name}.tgz`;

class Source implements ArtifactSource {
  readonly files = new Map<string, Uint8Array>(); fetched: string[] = [];
  signals: (AbortSignal | undefined)[] = [];
  async fetch(source: string, _max?: number, signal?: AbortSignal): Promise<Uint8Array> { this.fetched.push(source); this.signals.push(signal); const f = this.files.get(source); if (f === undefined) throw new Error("not in the fake registry"); return f; }
}
class Scripts implements InstallScriptPort { runs = 0; async run(): Promise<void> { this.runs++; } }
function world(withSource = true) {
  const source = new Source(), scripts = new Scripts();
  const root = join(fresh(), "environments");
  const runtime = new LocalEnvironmentRuntime({ root, worker: hooks, scripts, ...(withSource ? { source } : {}) });
  const add = (name: string, version: string, extra: Partial<Parameters<typeof fixture>[0]> = {}) => { const f = fixture({ name, version, ...extra }); source.files.set(url(name), f.bytes); return { name, version, digest: f.digest, source: url(name) }; };
  const everything = (): string[] => { const out: string[] = []; const walk = (d: string, rel: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out.push(`${rel}${e.name}${e.isDirectory() ? "/" : ""}`); if (e.isDirectory()) walk(p, `${rel}${e.name}/`); } }; walk(runtime.root, ""); return out.sort(); };
  return { runtime, source, scripts, add, everything };
}

describe("a reviewer can read an artifact before it is approved", { skip: POSIX_STORE }, () => {
  test("the declared install scripts are returned with their text, digest and size; nothing is written, stored or run", async () => {
    const w = world();
    const a = w.add("tool", "1.0.0", { files: { "index.js": "module.exports = 1;\n", "setup.js": "console.log('hello from the install script');\n" }, scripts: { postinstall: "setup.js" } });
    const before = w.everything();
    const r = await w.runtime.inspect(a);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.digestVerified, true);
    assert.equal(r.name, "tool"); assert.equal(r.version, "1.0.0");
    assert.equal(r.scripts.length, 1);
    assert.equal(r.scripts[0]!.phase, "postinstall"); assert.equal(r.scripts[0]!.entry, "setup.js");
    assert.match(r.scripts[0]!.text, /hello from the install script/);
    assert.match(r.scripts[0]!.sha256, /^sha256:[0-9a-f]{64}$/); assert.equal(r.scripts[0]!.truncated, false);
    assert.deepEqual(w.everything(), before, "the runtime's directory is exactly as it was: nothing stored, unpacked or left behind");
    assert.equal(w.scripts.runs, 0, "no script ran");
  });

  test("a package without scripts says so; a long script is cut at the limit and says it was", async () => {
    const w = world();
    const plain = await w.runtime.inspect(w.add("plain", "1.0.0"));
    assert.equal(plain.ok && plain.scripts.length, 0);
    const big = w.add("big", "2.0.0", { files: { "index.js": "1", "run.js": "x".repeat(INSPECT_TEXT_BYTES + 500) }, scripts: { install: "run.js" } });
    const r = await w.runtime.inspect(big);
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.scripts[0]!.text.length, INSPECT_TEXT_BYTES); assert.equal(r.scripts[0]!.truncated, true); assert.equal(r.scripts[0]!.bytes, INSPECT_TEXT_BYTES + 500); }
  });

  test("an artifact that does not match its named digest shows none of its content", async () => {
    const w = world();
    const a = w.add("tool", "1.0.0", { files: { "index.js": "1", "setup.js": "SECRET-LOOKING-BUT-UNTRUSTED" }, scripts: { install: "setup.js" } });
    const r = await w.runtime.inspect({ ...a, digest: `sha256:${"f".repeat(64)}` });
    assert.equal(r.ok, false);
    assert.doesNotMatch(JSON.stringify(r), /SECRET-LOOKING/);
    assert.match(r.ok ? "" : r.reason, /does not match the digest/);
  });

  test("an artifact that names itself another package or version is refused without its content", async () => {
    const w = world();
    const a = w.add("tool", "1.0.0", { files: { "index.js": "1", "setup.js": "PRIVATE-TEXT" }, scripts: { install: "setup.js" } });
    const wrongName = await w.runtime.inspect({ ...a, name: "other" });
    assert.equal(wrongName.ok, false);
    const wrongVersion = await w.runtime.inspect({ ...a, version: "9.9.9" });
    assert.equal(wrongVersion.ok, false);
    assert.doesNotMatch(JSON.stringify([wrongName, wrongVersion]), /PRIVATE-TEXT/);
  });

  test("an archive an install would refuse is shown as refused; a host without a source, a failed fetch and a malformed request answer plainly", async () => {
    const w = world();
    const link = w.add("linked", "1.0.0", { extra: [{ path: "evil", type: "2", linkname: "/etc/passwd" }] });
    const refused = await w.runtime.inspect(link);
    assert.equal(refused.ok, false); assert.match(refused.ok ? "" : refused.reason, /refused/);
    const missing = await w.runtime.inspect({ name: "gone", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, source: url("gone") });
    assert.equal(missing.ok, false); assert.match(missing.ok ? "" : missing.reason, /could not be fetched/);
    const none = world(false);
    const off = await none.runtime.inspect({ name: "x", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, source: url("x") });
    assert.equal(off.ok, false); assert.match(off.ok ? "" : off.reason, /no way to fetch/);
    const bad = await w.runtime.inspect({ name: "../x", version: "latest", digest: "nope", source: url("x") });
    assert.equal(bad.ok, false);
    assert.equal(w.source.fetched.includes(url("x")), false, "a malformed request fetches nothing");
  });

  test("the caller's stop signal reaches the source, and a reading stopped meanwhile is not unpacked", async () => {
    const w = world();
    const a = w.add("tool", "1.0.0", { files: { "index.js": "1", "setup.js": "STOPPED-TEXT" }, scripts: { install: "setup.js" } });
    const stop = new AbortController();
    stop.abort();
    const r = await w.runtime.inspect(a, stop.signal);
    assert.equal(w.source.signals[0], stop.signal, "the source was handed the signal");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /stopped/);
    assert.doesNotMatch(JSON.stringify(r), /STOPPED-TEXT/);
  });
});
