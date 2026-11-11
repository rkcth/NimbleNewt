// Card K02a: the release launcher's command line, against a fixture release root and a fake controller (no database, no deployment).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const id = await install(root, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ id: process.env.NIMBLENEWT_RUNNING_RELEASE, args: process.argv.slice(2), cwd: process.cwd() })); setInterval(() => {}, 1000);`);
    const c = capture();
    const ac = new AbortController();
    const done = main(["--root", root, "--poll-ms", "20", "--grace-seconds", "1", "--", "--serve", "x"], { stderr: c.stderr, env: process.env, signal: ac.signal });
    for (let i = 0; i < 400; i++) { try { readFileSync(out); break; } catch { await new Promise((r) => setTimeout(r, 25)); } }
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(seen.id, id);
    assert.deepEqual(seen.args, ["--serve", "x"]);
    assert.equal(seen.cwd.endsWith(join("releases", id)), true);
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
    assert.equal(await main(["--root", root], { stderr: capture().stderr, env: {}, signal: new AbortController().signal }), 3);
    writeFileSync(join(root, "current.json"), JSON.stringify({ release: "rcn-aaaaaaaaaaaaaaaaaaaaaaaa" }));
    const c = capture();
    assert.equal(await main(["--root", root], { stderr: c.stderr, env: {}, signal: new AbortController().signal }), 2);
    assert.match(c.text, /never announced/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
