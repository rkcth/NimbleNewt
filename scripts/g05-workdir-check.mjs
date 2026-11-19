// Card G05: the controller working-directory check, for the `windows` block of a containment report (scripts/containment-evidence.mjs run --workdir-check FILE).
//   node scripts/g05-workdir-check.mjs --out FILE
// It generates the real service unit for this platform (packages/controller/src/release/service-units.ts: on Windows the scheduled task), reads the working directory the unit gives the
// launcher, starts the real release launcher (scripts/nimblenewt-launcher.mjs) from that directory against a disposable release root holding one installed release, and checks the working
// directory the controller of that release really has: the release's own folder (never the checkout, never the system folder a scheduled task starts in by default).
// The release's controller entry is a stand-in that records its working directory and process id, not the packaged controller: a packaged controller release is built by the release
// pipeline (card K03), which this check does not have. So the result says `packaged: false`, and the release gate keeps asking for the check on a packaged controller.
// The output holds booleans and fixed problem texts only (no paths: the repository is public). Exit 0 when the check passed, 1 when it did not, 2 on bad usage. Needs `npx tsc --build` first.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (v) => createHash("sha256").update(v).digest("hex");
export const WORKDIR_SCHEMA = "nimblenewt.g05-workdir/1";

const xmlUnescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The working directory a generated unit gives the launcher, or undefined when the unit names none. Pure. */
export function unitWorkingDirectory(platform, content) {
  if (platform === "win32") { const m = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(content); return m === null ? undefined : xmlUnescape(m[1]); }
  if (platform === "darwin") { const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(content); return m === null ? undefined : xmlUnescape(m[1]); }
  const m = /^WorkingDirectory=(.*)$/m.exec(content);
  if (m === null) return undefined;
  const v = m[1].trim();
  // systemd quotes a path with spaces; a leading '-' means "ignore if missing", which the unit never writes.
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : v;
}

const normPath = (p, platform) => { let s = String(p).replace(/[\\/]+/g, "/").replace(/\/$/, ""); if (platform === "win32") s = s.toLowerCase(); return s; };
/** Two paths name the same folder: separators and a trailing separator ignored, and on Windows letter case too. Pure. */
export const samePath = (a, b, platform) => normPath(a, platform) === normPath(b, platform);
/** Whether `child` is `parent` or lies below it (same spelling rules as samePath). Pure. */
export function insidePath(child, parent, platform) {
  const c = normPath(child, platform); const p = normPath(parent, platform);
  return c === p || c.startsWith(`${p}/`);
}
const inside = insidePath;

/** Judges what was seen. Pure: the inputs are the unit's working directory, the release root, the release's folder, the folder the controller reported, the checkout and the system folder. */
export function judgeWorkdir({ platform, unitDir, root, releaseDir, seenCwd, checkout, systemDir }) {
  const problems = [];
  // systemd units name none (systemd then starts in "/"); the launcher sets the controller's directory itself. Task Scheduler (System32 otherwise) and launchd units must name the root.
  if (unitDir === undefined) { if (platform !== "linux") problems.push("the service unit names no working directory"); }
  else if (!samePath(unitDir, root, platform)) problems.push("the service unit's working directory is not the release root");
  if (seenCwd === undefined) problems.push("the controller of the release did not start or did not report its working directory");
  else {
    if (!samePath(seenCwd, releaseDir, platform)) problems.push("the controller's working directory is not its release folder");
    if (checkout !== undefined && inside(seenCwd, checkout, platform)) problems.push("the controller's working directory is inside the checkout");
    if (systemDir !== undefined && inside(seenCwd, systemDir, platform)) problems.push("the controller's working directory is the system folder");
  }
  return { passed: problems.length === 0, problems };
}

async function controller(file) { return import(pathToFileURL(join(repo, "packages", "controller", "dist", file)).href); }

/** Installs one release whose controller entry records its working directory and process id, and points the root at it (as the launcher tests do). Returns the release folder. */
async function installStandIn(root, out) {
  const { Launcher } = await controller("release/launcher.js");
  const { PointerSwitcher } = await controller("release/activation.js");
  const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), pid: process.pid })); setTimeout(() => process.exit(0), 120000);`;
  const id = `rcn-${sha("g05-workdir").slice(0, 24)}`;
  const dir = join(root, "releases", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "controller.js"), source);
  const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: { "controller.js": { sha256: sha(source), size: Buffer.byteLength(source) } } });
  writeFileSync(join(dir, "MANIFEST.json"), manifest);
  const sw = new PointerSwitcher(root);
  await new Launcher({ root, switcher: sw }).expect({ id, digest: sha(manifest), protocol: { min: 1, max: 1 } });
  await sw.write(id);
  return dir;
}

export async function runCheck({ platform = process.platform, timeoutMs = 60_000 } = {}) {
  const { generateServiceUnit } = await controller("release/service-units.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-g05-wd-")));
  const out = join(root, "seen.json");
  let launcher;
  let seen;
  try {
    const unit = generateServiceUnit({ platform, node: process.execPath, launcher: join(repo, "scripts", "nimblenewt-launcher.mjs"), root, ...(platform === "win32" ? { windowsUser: "nimblenewt-check" } : {}) });
    const unitDir = unitWorkingDirectory(platform, unit.content);
    const releaseDir = realpathSync(await installStandIn(root, out));
    // Started from where the service manager would start it: the unit's directory, or systemd's default "/" when a Linux unit names none.
    const startIn = unitDir ?? (platform === "linux" ? "/" : undefined);
    if (startIn !== undefined) {
      launcher = spawn(process.execPath, [join(repo, "scripts", "nimblenewt-launcher.mjs"), "--root", root, "--poll-ms", "50", "--grace-seconds", "1"], { cwd: startIn, stdio: "ignore", windowsHide: true });
      for (let waited = 0; waited < timeoutMs && seen === undefined; waited += 100) {
        try { seen = JSON.parse(readFileSync(out, "utf8")); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
    }
    const systemDir = platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32") : undefined;
    const verdict = judgeWorkdir({ platform, unitDir, root, releaseDir, seenCwd: seen?.cwd, checkout: repo, systemDir });
    return { schema: WORKDIR_SCHEMA, platform, packaged: false, standInEntry: true, passed: verdict.passed, problems: verdict.problems };
  } finally {
    try { launcher?.kill(); } catch { /* gone */ }
    if (seen?.pid !== undefined) { try { process.kill(seen.pid); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  if (i < 0 || args[i + 1] === undefined || args.length !== 2) { console.error("usage: g05-workdir-check.mjs --out FILE"); process.exit(2); }
  const result = await runCheck();
  mkdirSync(dirname(resolve(args[i + 1])), { recursive: true });
  writeFileSync(resolve(args[i + 1]), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`working-directory check (${result.platform}, stand-in controller entry, packaged: false): ${result.passed ? "passed" : `FAILED: ${result.problems.join("; ")}`}`);
  process.exit(result.passed ? 0 : 1);
}
