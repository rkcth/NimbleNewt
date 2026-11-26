// Card A03b: lays out the G05 owner bundle, the folder the owner runs the ten containment cases from on his own Windows PC with no build there
// (experiments/windows-appcontainer/owner/run-g05.ps1; notes: "A03b owner bundle for the real-PC ten-case run"). Used by the CI workflows only; it runs nothing it copies.
//   node scripts/g05-owner-bundle.mjs make --out DIR --launcher EXE --record JSON --node EXE --node-sha256 HEX --commit SHA
// Layout (every path matches [A-Za-z0-9._@/-]+, which run-g05.ps1 requires):
//   bin/nn-launcher.exe, bin/nn-launcher.record.json     the product launcher CI built and its release record
//   node/node.exe                                        the runner's node, refused unless its SHA-256 is the official one given (nodejs.org SHASUMS256.txt)
//   packages/{worker,contracts}/{package.json,dist/}     the compiled code, without test files and build info
//   node_modules/@nimblenewt/contracts/                  a real copy of packages/contracts (never a link), so the worker's import resolves inside the bundle
//   scripts/{containment-evidence,offline-guard,redact-log}.mjs
//   COMMIT                                               the 40 hex digits of the commit CI built (containment-evidence.mjs --prebuilt reads it)
//   run-g05.ps1
//   SHA256SUMS                                           "<sha256>  <path>" for every other file, sorted; run-g05.ps1 checks every line and refuses any extra file
// DIR must not exist yet. A link anywhere in what is copied, a name outside the allowed characters, or a wrong node hash: nothing is left behind and the exit code is 1. Usage errors: 2.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE_SCRIPTS = ["containment-evidence.mjs", "offline-guard.mjs", "redact-log.mjs"];
export const SAFE_NAME = /^[A-Za-z0-9._@/-]+$/;
/** Compiled files that are not needed to run: the tests and the incremental build state. */
const skipped = (name) => /\.test\.(js|d\.ts)(\.map)?$/.test(name) || name.endsWith(".tsbuildinfo");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function copyFile(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`not a regular file: ${relative(root, from) || from}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyTree(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain folder: ${relative(root, from)}`);
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (skipped(e.name)) continue;
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isSymbolicLink()) throw new Error(`a link: ${relative(root, a)}`);
    if (e.isDirectory()) copyTree(a, b); else if (e.isFile()) copyFile(a, b); else throw new Error(`not a file or folder: ${relative(root, a)}`);
  }
}

/** Every file under dir as a bundle path (forward slashes), sorted by code unit. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`a link in the bundle: ${relative(base, p)}`);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

export function makeBundle({ out, launcher, record, node, nodeSha256, commit, script = join(root, "experiments", "windows-appcontainer", "owner", "run-g05.ps1"), repo = root }) {
  if (!/^[0-9a-f]{64}$/.test(nodeSha256 ?? "")) throw new Error("--node-sha256: the official SHA-256 of node.exe (64 lower-case hex digits) is required");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit: 40 lower-case hex digits");
  const got = sha256(node);
  if (got !== nodeSha256) throw new Error(`node.exe has SHA-256 ${got}, not the official ${nodeSha256}; no bundle is made`);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out); // create-new: an existing folder is refused (EEXIST)
  try {
    copyFile(launcher, join(out, "bin", "nn-launcher.exe"));
    copyFile(record, join(out, "bin", "nn-launcher.record.json"));
    copyFile(node, join(out, "node", "node.exe"));
    // the copy itself is what ships: checked again, so a file changed between the check above and the copy is never bundled
    const copied = sha256(join(out, "node", "node.exe"));
    if (copied !== nodeSha256) throw new Error(`the copied node.exe has SHA-256 ${copied}, not the official ${nodeSha256}; no bundle is made`);
    for (const p of ["worker", "contracts"]) {
      copyFile(join(repo, "packages", p, "package.json"), join(out, "packages", p, "package.json"));
      copyTree(join(repo, "packages", p, "dist"), join(out, "packages", p, "dist"));
    }
    copyFile(join(repo, "packages", "contracts", "package.json"), join(out, "node_modules", "@nimblenewt", "contracts", "package.json"));
    copyTree(join(repo, "packages", "contracts", "dist"), join(out, "node_modules", "@nimblenewt", "contracts", "dist"));
    for (const s of BUNDLE_SCRIPTS) copyFile(join(repo, "scripts", s), join(out, "scripts", s));
    copyFile(script, join(out, "run-g05.ps1"));
    writeFileSync(join(out, "COMMIT"), commit);
    const files = listFiles(out);
    const bad = files.filter((f) => !SAFE_NAME.test(f));
    if (bad.length > 0) throw new Error(`names outside [A-Za-z0-9._@/-]: ${bad.slice(0, 5).join(", ")}`);
    const sums = files.map((f) => `${sha256(join(out, ...f.split("/")))}  ${f}\n`).join("");
    writeFileSync(join(out, "SHA256SUMS"), sums);
    return { files: files.length, sumsSha256: createHash("sha256").update(sums).digest("hex") };
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw e;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const names = ["out", "launcher", "record", "node", "node-sha256", "commit"];
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const usage = "usage: g05-owner-bundle.mjs make --out DIR --launcher EXE --record JSON --node EXE --node-sha256 HEX --commit SHA";
  if (command !== "make" || rest.length !== names.length * 2 || names.some((n) => flag(n) === undefined || flag(n).startsWith("--"))) { console.error(usage); process.exit(2); }
  try {
    const r = makeBundle({ out: resolve(flag("out")), launcher: resolve(flag("launcher")), record: resolve(flag("record")), node: resolve(flag("node")), nodeSha256: flag("node-sha256"), commit: flag("commit") });
    console.log(`G05 owner bundle: ${r.files} files listed in SHA256SUMS`);
    console.log(`sums_sha256=${r.sumsSha256}`);
  } catch (e) {
    console.error(`no bundle: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
