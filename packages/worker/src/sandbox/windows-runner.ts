import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_FAILED, runWindowsJob, type WindowsJob } from "./windows-job.js";
import { windowsRealHost } from "./windows-real.js";

/**
 * The supervisor's runner (card A03b): the one process the launcher starts for a Windows job. It lives with the worker's own code, never in guest-writable staging, reads the job
 * file the backend wrote in the supervisor's control directory, runs the job and exits with the command's exit code. It never runs anything found in a shared folder.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const file = argv[2];
  if (file === undefined) { process.stderr.write("usage: windows-runner <job file>\n"); return EXIT_FAILED; }
  const host = windowsRealHost();
  const text = host.readText(file);
  if (text === undefined) { process.stderr.write(`job file not found: ${file}\n`); return EXIT_FAILED; }
  const job = JSON.parse(text) as WindowsJob;
  if (job.version !== 1) { process.stderr.write("unsupported job file\n"); return EXIT_FAILED; }
  const out = await runWindowsJob(host, job, [dirname(fileURLToPath(import.meta.url))], dirname(file));
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => { process.exitCode = code; }, (error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = EXIT_FAILED; });
}
