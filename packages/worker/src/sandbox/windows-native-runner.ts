import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { runNativeJob, type NativeHost, type NativeJob } from "./windows-native-job.js";
import type { ChannelPorts } from "./windows-native-channel.js";
import { nativeRealHost } from "./windows-native-real.js";
import { EXIT_FAILED, EXIT_REFUSED, FAILURE_PREFIX } from "./windows-native-plan.js";

const MAX_STDIN_BYTES = 1024 * 1024;

/** Reads this process's standard input to its end (the controller's pipe, outside the container): the text becomes the FILE the program reads. At most 1 MiB. */
export function readAllStdin(input: NodeJS.ReadableStream, limit = MAX_STDIN_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    input.on("data", (c: Buffer | string) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); size += b.length; if (size <= limit) chunks.push(b); });
    input.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    input.on("error", reject);
  });
}

/**
 * The supervisor's runner (card A03b, native Windows): the one process the controller starts for a native job. It lives with the worker's own code, outside every folder the container can write,
 * reads the job file the backend wrote in the control directory, runs the launcher (a program outside the container, so ordinary pipes are fine here), gives the program FILES for its standard
 * handles, copies its output back to this process's own output and exits with the program's exit code. It fails closed with a typed `nn-native-failure` line and never runs anything unconfined.
 */
export interface RunnerIo { readonly out: (text: string) => void; readonly err: (text: string) => void }
const PROCESS_IO: RunnerIo = { out: (t) => { process.stdout.write(t); }, err: (t) => { process.stderr.write(t); } };

/**
 * The controller's pipes as the channel's ports (a streamed run): its lines arrive on this process's standard input and leave on its standard output, one write at a time (the write is finished before the
 * next line is taken from the worker's file, which is the backpressure toward the controller). Standard output carries nothing but relayed lines for such a run.
 */
export function processPorts(stdout: NodeJS.WritableStream = process.stdout, stdin: NodeJS.ReadableStream = process.stdin): ChannelPorts {
  stdout.on("error", () => undefined); // a closed pipe is reported by the pending write, not by an unhandled event
  return { input: stdin, output: { write: (text) => new Promise<void>((resolve, reject) => { stdout.write(text, (error?: Error | null) => { if (error) reject(error); else resolve(); }); }) } };
}

export async function main(argv: readonly string[], host: NativeHost = nativeRealHost(), stdin: () => Promise<string> = () => readAllStdin(process.stdin), io: RunnerIo = PROCESS_IO, ports?: () => ChannelPorts): Promise<number> {
  const file = argv[2];
  if (file === undefined) { io.err("usage: windows-native-runner <job file>\n"); return EXIT_FAILED; }
  const text = host.readText(file, 4 * 1024 * 1024);
  if (text === undefined) { io.err(`${FAILURE_PREFIX}: refused: job file not found\n`); return EXIT_REFUSED; }
  let job: NativeJob;
  try { job = JSON.parse(text) as NativeJob; } catch { io.err(`${FAILURE_PREFIX}: refused: job file unreadable\n`); return EXIT_REFUSED; }
  if (job.version !== 1) { io.err(`${FAILURE_PREFIX}: refused: unsupported job file\n`); return EXIT_REFUSED; }
  if (job.channel !== undefined) {
    const c = job.channel;
    const numbers = [c.maxBytes, c.maxFrames, c.maxPayload, c.windowBytes, c.heartbeatMs, c.stallMs];
    if (typeof c.dir !== "string" || typeof c.inbox !== "string" || typeof c.outbox !== "string" || numbers.some((n) => !Number.isSafeInteger(n) || n < 1)) { io.err(`${FAILURE_PREFIX}: refused: job file channel unreadable\n`); return EXIT_REFUSED; }
    // A streamed run: the controller's pipes are not read to their end; the channel relays them while the program runs, and only relayed lines go to standard output.
    const streamed = await runNativeJob(host, job, undefined, dirname(file), (ports ?? (() => processPorts()))());
    io.err(streamed.stderr);
    return streamed.exitCode;
  }
  const input = await stdin();
  const out = await runNativeJob(host, job, input, dirname(file));
  io.out(out.stdout);
  io.err(out.stderr);
  return out.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => { process.exitCode = code; }, (error: Error) => { process.stderr.write(`${FAILURE_PREFIX}: launcher: ${error.message}\n`); process.exitCode = EXIT_FAILED; });
}
