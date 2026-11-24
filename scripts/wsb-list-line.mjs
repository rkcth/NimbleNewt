// Own-hardware diagnostic (card wsb-repair, 2026-11-24): ONE line saying what the product's own launcher tried for `wsb list` and how it ended, printed by the workflow right after the
// launch variants. It uses the product's code path (sandboxRunning -> listSandboxes -> the host's runWsb), with the host wrapped to note each `wsb` call: how it was launched (the
// scheduled-task strategy or the direct call, and why the direct call was used), how it ended and how long it took. Fixed words and numbers only (never wsb's output), through the
// shared credential scanner; the workflow also pipes it through scripts/redact-log.mjs. It always exits 0. Off Windows it says so and tries nothing. Needs `npm run build` first.
//   node scripts/wsb-list-line.mjs
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

export const PREFIX = "wsb list (product launcher): ";

/** The outcome of one noted call, in words. */
export function callText(c) {
  const how = c.via === undefined ? "directly" : c.via;
  const end = c.timedOut === true ? "timed out" : c.code === 0 ? "answered, exit code 0" : `failed, exit code ${Number.isInteger(c.code) ? c.code : "none"}`;
  return `${c.verb} ${how}: ${end} after ${Math.round(c.ms)} ms`;
}

/** The one line: every call that was made, then the verdict (`none`, `running` or `unknown`: the list could not be had). */
export function lineFor(calls, state) {
  const tried = calls.length === 0 ? "no wsb call was made (the client could not be verified)" : calls.map(callText).join("; then ");
  const outcome = state === "none" ? "OK: the list answered, no sandbox is running" : state === "running" ? "OK: the list answered, a sandbox is running" : "FAILED: no list could be had";
  return `${PREFIX}tried ${tried}; outcome: ${outcome}`;
}

async function main() {
  if (process.platform !== "win32") return `${PREFIX}not Windows; nothing tried`;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);
  const real = worker.windowsRealHost();
  const calls = [];
  const host = Object.create(real);
  host.runWsb = async (file, args, options) => {
    const t0 = performance.now();
    const r = await (real.runWsb ?? real.run).call(real, file, args, options);
    calls.push({ verb: `wsb ${args[0] ?? ""}`.trim(), via: r.via, code: r.code, timedOut: r.timedOut, ms: performance.now() - t0 });
    return r;
  };
  const identity = worker.evidenceIdentity(process.env, await worker.windowsConsoleUser());
  const state = await worker.sandboxRunning(host, identity);
  return lineFor(calls, state);
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] !== undefined && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  let line;
  try { line = await main(); } catch { line = `${PREFIX}stopped early: an unexpected error (not shown)`; }
  process.stdout.write(`${safeMessage(line, 1500)}\n`, () => process.exit(0));
}
