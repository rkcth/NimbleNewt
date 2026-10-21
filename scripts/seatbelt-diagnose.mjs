// Diagnostic for the macOS Seatbelt backend (card A03): runs the backend's own probe pieces one at a time and, on macOS, prints what the sandbox denied.
// Started by hand from the Actions tab (sandbox-diagnose.yml); it changes nothing and is not part of the test suite.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeRecipe, profileFor, seatbeltBackend } from "../packages/worker/dist/sandbox/index.js";

if (process.platform !== "darwin") { console.log("macOS only"); process.exit(0); }
const run = promisify(execFile);
const probe = realpathSync(mkdtempSync(join(tmpdir(), "nn-diag-")));
for (const d of ["work", "home", "scratch", "outside"]) mkdirSync(join(probe, d));
writeFileSync(join(probe, "secret.txt"), "secret");
const recipe = normalizeRecipe({ mode: "sandboxed", workdir: join(probe, "work"), home: join(probe, "home"), scratch: join(probe, "scratch"), readOnly: [], network: "none", env: { PROBE_OUT: join(probe, "outside"), PROBE_SECRET: join(probe, "secret.txt") }, protectedSubpaths: [] }, []);
const backend = seatbeltBackend();

async function attempt(label, command) {
  const plan = backend.plan(recipe, command);
  const started = Date.now();
  try {
    const out = await run(plan.file, [...plan.args], { timeout: 20_000, env: { ...plan.env }, cwd: plan.cwd });
    console.log(`OK    ${label} (${Date.now() - started} ms) stdout=${JSON.stringify(out.stdout.trim().slice(0, 200))}`);
  } catch (e) {
    console.log(`FAIL  ${label} code=${e.code} signal=${e.signal} stdout=${JSON.stringify((e.stdout ?? "").trim().slice(0, 200))} stderr=${JSON.stringify((e.stderr ?? "").trim().slice(0, 400))}`);
  }
}

try {
console.log(`macOS ${spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim()}, sandbox-exec at ${spawnSync("which", ["sandbox-exec"], { encoding: "utf8" }).stdout.trim()}`);
console.log("--- the profile ---");
console.log(profileFor(recipe));
console.log("--- baseline: an allow-everything profile ---");
try { const o = await run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 10_000 }); console.log("OK    allow-default /usr/bin/true", JSON.stringify(o.stdout)); } catch (e) { console.log("FAIL  allow-default", e.code, e.stderr); }
console.log("--- our profile ---");
await attempt("/usr/bin/true", ["/usr/bin/true"]);
await attempt("/bin/echo hi", ["/bin/echo", "hi"]);
await attempt("/bin/sh -c 'echo hi'", ["/bin/sh", "-c", "echo hi"]);
await attempt("sh: touch in the checkout", ["/bin/sh", "-c", 'echo hi > "$PWD/ok" && echo wrote']);
await attempt("sh: write outside is denied", ["/bin/sh", "-c", '( echo hi > "$PROBE_OUT/denied" ) 2>/dev/null && echo WROTE || echo denied']);
await attempt("sh: read secret is denied", ["/bin/sh", "-c", '/bin/cat "$PROBE_SECRET" 2>/dev/null && echo READ || echo denied']);
await attempt("sh: /usr/bin/touch", ["/bin/sh", "-c", '/usr/bin/touch "$PWD/ok2" && echo touched']);
await attempt("nc is runnable", ["/usr/bin/nc", "-h"]);
console.log("--- what the sandbox denied in the last 3 minutes ---");
const log = spawnSync("sudo", ["log", "show", "--last", "3m", "--style", "compact", "--predicate", 'sender == "Sandbox" OR eventMessage CONTAINS "deny("'], { encoding: "utf8", timeout: 120_000 });
const lines = (log.stdout ?? "").split("\n").filter((l) => /deny\(|Sandbox/.test(l)).slice(-150);
console.log(lines.length === 0 ? `(no denial lines; log exit ${log.status}, stderr ${(log.stderr ?? "").slice(0, 300)})` : lines.join("\n"));
} finally {
  rmSync(probe, { recursive: true, force: true });
}
