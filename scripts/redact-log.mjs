// Copies standard input to standard output line by line with personal data replaced (packages/worker/src/sandbox/windows-redact.ts: account, machine and home names, SIDs,
// addresses; a line that still looks personal is withheld whole). For the console output of the Windows evidence steps of own-hardware.yml: the job log of a public repository
// is public, and an error message or a failing test's output can name the runner account's home or temporary folder, or the account at the console.
//   some-command 2>&1 | tee local.log | node scripts/redact-log.mjs
// Besides the running machine's own names it hides, on Windows, the account signed in at the console.
// If the redaction code cannot be loaded (the build failed), nothing of the input is shown: one fixed line says so. Always exits 0 so it never decides a step's outcome
// (with `set -o pipefail` the command before it still does).
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let scrub;
const names = { users: [] };
try {
  const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);
  scrub = worker.scrub;
  const consoleUser = await worker.windowsConsoleUser();
  if (typeof consoleUser === "string") names.users.push(consoleUser);
} catch { scrub = undefined; }

let withheld = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (scrub === undefined) { withheld++; continue; }
  process.stdout.write(`${scrub(line, names, 4000)}\n`);
}
if (scrub === undefined) process.stdout.write(`<${withheld} lines withheld: the redaction code could not be loaded>\n`);
