// Card K02 follow-up: the updater program, end to end against temporary directories. No network, database or controller.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "./nimblenewt-updater.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (v) => createHash("sha256").update(v).digest("hex");
const capture = () => { let out = ""; let err = ""; return { stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } }, get out() { return out; }, get err() { return err; } }; };
const ID = `rcn-${sha("updater-cli").slice(0, 24)}`;
function unlock(dir) { try { chmodSync(dir, 0o700); } catch { return; } for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name)); }
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "nn-updcli-"));
  const root = join(base, "root"); const source = join(base, "src");
  mkdirSync(root); mkdirSync(source);
  const body = "console.log('c');\n";
  writeFileSync(join(source, "controller.js"), body);
  const manifest = JSON.stringify({ candidateId: ID, sourceCommit: "a".repeat(40), files: { "controller.js": { sha256: sha(body), size: Buffer.byteLength(body) } } });
  writeFileSync(join(source, "MANIFEST.json"), manifest);
  return { base, root, source, digest: sha(manifest), done: () => { unlock(base); rmSync(base, { recursive: true, force: true }); } };
}
const run = async (argv, env = {}) => { const c = capture(); const code = await main(argv, { stdout: c.stdout, stderr: c.stderr, env }); return { code, out: c.out, err: c.err }; };

test("stage installs the release; --announce and --switch tell the launcher and move the pointer (K02 updater program)", async () => {
  const f = fixture();
  try {
    const a = await run(["stage", "--root", f.root, "--source", f.source, "--digest", f.digest]);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, new RegExp(`installed ${ID}`));
    assert.ok(existsSync(join(f.root, "releases", ID, "controller.js")));
    assert.ok(!existsSync(join(f.root, "launcher-state.json")));
    const b = await run(["stage", "--root", f.root, "--source", f.source, "--digest", f.digest, "--announce"]);
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, /already installed/);
    assert.match(b.out, /pointer is unchanged/);
    assert.equal(JSON.parse(readFileSync(join(f.root, "launcher-state.json"), "utf8")).expected.id, ID);
    assert.ok(!existsSync(join(f.root, "current.json")));
    const c = await run(["stage", "--root", f.root, "--source", f.source, "--digest", f.digest, "--announce", "--switch"]);
    assert.equal(c.code, 0, c.err);
    assert.equal(JSON.parse(readFileSync(join(f.root, "current.json"), "utf8")).release, ID);
  } finally { f.done(); }
});

test("refusals exit 1 with the reason and change nothing (K02 updater program)", async () => {
  const f = fixture();
  try {
    for (const [argv, why] of [
      [["stage", "--root", f.root, "--source", f.source, "--digest", sha("wrong")], /digest_mismatch/],
      [["stage", "--root", f.root, "--source", f.source, "--digest", "abc"], /invalid_input/],
      [["stage", "--root", "rel", "--source", f.source, "--digest", f.digest], /invalid_input/],
      [["stage", "--root", f.root, "--source", join(f.base, "none"), "--digest", f.digest], /source_invalid/],
      [["stage", "--root", f.root, "--source", f.source], /required/],
      [["stage", "--root", f.root, "--source", f.source, "--digest", f.digest, "--switch"], /--switch needs --announce/],
      [["stage", "--root", f.root, "--source", f.source, "--digest", f.digest, "--switcher", "hardlink"], /pointer or symlink/],
      [["stage", "--root", f.root, "--bogus", "x"], /unknown option/],
      [["install"], /Usage|stage/i],
    ]) {
      const r = await run(argv);
      assert.equal(r.code, 1, JSON.stringify(argv));
      assert.match(r.err, why, JSON.stringify(argv));
    }
    assert.deepEqual(readdirSync(f.root), [], "nothing was written");
  } finally { f.done(); }
});

test("run as a real process with the root from the environment (K02 updater program)", () => {
  const f = fixture();
  try {
    const p = spawnSync(process.execPath, [join(here, "nimblenewt-updater.mjs"), "stage", "--source", f.source, "--digest", f.digest, "--announce"], { encoding: "utf8", env: { ...process.env, NIMBLENEWT_RELEASE_ROOT: f.root } });
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /announced/);
  } finally { f.done(); }
});
