import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PostgresStorage, SqliteStorage, SqliteWorkerStorage,
  type BridgeResult, type ControllerStorage, type ConversationSubmitter, type JsonObject,
} from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { openAdapter, piConversation } from "./conversation.js";
import type { PiAdapter } from "@nimblenewt/pi-adapter";

// Card G04. Glue only: this file wires the production slice (the controller's services over a real database, `@nimblenewt/controller/testing`) to the
// production Pi adapter, starts and kills processes, and counts what happened. It keeps no state machine of its own: every answer about a task, an
// attempt, an effect or a wait comes from the services and the database.

export const { ANSWER, Chaos, Clock, Crash, check, runPath, signature, startProcess } = harness;
/**
 * The default run (CI, the normal suite) samples the boundaries, operations and cuts: the key ones plus a spread. NIMBLENEWT_G04_EXHAUSTIVE=1 runs every one
 * (the QA workflow does, on the hosted runners). Nothing else differs between the two.
 */
/** The heavy files (worker-thread real kills, the worker-process tests) run only when asked: exhaustive, or NIMBLENEWT_G04_HEAVY=1. Otherwise they are skipped with this message. */
export const HEAVY_SKIP: string | false = (process.env["NIMBLENEWT_G04_EXHAUSTIVE"] === "1" || process.env["NIMBLENEWT_G04_HEAVY"] === "1") ? false : "heavy G04 test: set NIMBLENEWT_G04_HEAVY=1 (or NIMBLENEWT_G04_EXHAUSTIVE=1) to run it; the QA workflow does";

/** True for the crash the chaos seam throws, or any error that carries it as its cause (services wrap storage errors). */
export function isCrash(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 8; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof Crash) return true;
  return false;
}

export const EXHAUSTIVE = process.env["NIMBLENEWT_G04_EXHAUSTIVE"] === "1";

/** Indexes 0..count-1 to run: all when exhaustive, else the `key` ones, every `stride`th and the last. */
export function pickIndexes(count: number, key: readonly number[], stride: number): number[] {
  if (EXHAUSTIVE) return Array.from({ length: count }, (_, i) => i);
  const keep = new Set<number>([...key.filter((i) => i >= 0 && i < count), count - 1]);
  for (let i = 0; i < count; i += stride) keep.add(i);
  return [...keep].sort((a, b) => a - b);
}

export type SliceWorld = harness.SliceWorld;
export type Slice = harness.Slice;
export type Clock = InstanceType<typeof harness.Clock>;
export { openAdapter, piConversation };

const guard = pathToFileURL(fileURLToPath(new URL("../../../scripts/offline-guard.mjs", import.meta.url))).href;

/** Where a controller database lives, so that a child process can open the same one. */
export type StoreSpec =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "sqlite-worker"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: string; readonly schema: string };

export function openStore(spec: StoreSpec): Promise<ControllerStorage> {
  if (spec.kind === "sqlite") return SqliteStorage.open({ path: spec.path, busyTimeoutMs: 20_000 });
  if (spec.kind === "sqlite-worker") return SqliteWorkerStorage.open({ path: spec.path });
  return PostgresStorage.open({ connectionString: spec.url, schema: spec.schema });
}

let serverPromise: Promise<harness.TestServer> | undefined;
export const server = (): Promise<harness.TestServer> => (serverPromise ??= harness.startTestServer());
export async function stopServer(): Promise<void> { if (serverPromise !== undefined) await (await serverPromise).stop(); }

/** The real controller databases. (The reference store is not one: it is the in-memory model of the contract.) */
export interface Engine { readonly name: string; prepare(directory: string): Promise<{ spec: StoreSpec; dispose(): Promise<void> }> }
let schemas = 0;
export const engines: Engine[] = [
  { name: "SQLite", prepare: async (dir) => ({ spec: { kind: "sqlite", path: join(dir, "db.sqlite") }, dispose: async () => undefined }) },
  { name: "SQLite on a worker thread", prepare: async (dir) => ({ spec: { kind: "sqlite-worker", path: join(dir, "db.sqlite") }, dispose: async () => undefined }) },
  { name: "PostgreSQL", prepare: async () => {
    const s = await server();
    const schema = `g04_${process.pid}_${schemas++}`;
    const url = s.url();
    const spec: StoreSpec = { kind: "postgres", url, schema };
    return { spec, dispose: () => harness.withClient(url, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }) };
  } },
];

/** Directories still in use: removed when the process ends, however (a timeout or an abort skips the `finally` blocks). */
const temporary = new Set<string>();
process.on("exit", () => { for (const dir of temporary) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it to the system's temp cleanup */ } } });

/** A scratch directory (the outside world, the Pi storage) and a prepared database, removed together. */
export async function withEngine<T>(engine: Engine, body: (spec: StoreSpec, directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "nn g04-"));
  temporary.add(directory);
  try {
    const prepared = await engine.prepare(directory);
    try { return await body(prepared.spec, directory); } finally { await prepared.dispose(); }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    temporary.delete(directory);
  }
}

/** Every storage call that writes, in order, as the services made it. Placed under the chaos wrapper, so its order equals the order of `before applyOperation` boundaries. */
export class OperationSpy {
  readonly ids: string[] = [];
  wrap(storage: ControllerStorage): ControllerStorage {
    return new Proxy(storage, {
      get: (target, name, receiver) => {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = (value as (...a: unknown[]) => unknown).bind(target);
        if (name !== "applyOperation") return method;
        return (input: { operationId: string }) => { this.ids.push(input.operationId); return method(input); };
      },
    });
  }
}

/** The boundaries of an uncrashed run with the real adapter, with the kind of operation behind each, and the state it ends in. */
export interface Clean { readonly labels: readonly string[]; readonly operations: readonly Operation[]; readonly signature: string }
export interface Operation { readonly id: string; readonly type: string; /** Chaos index of its `before applyOperation` and `after applyOperation` boundaries. */ readonly before: number; readonly after: number }

/** The operations the services made, in order, with the audit type behind each and the chaos index of their boundaries. */
export async function operationsOf(storage: ControllerStorage, spy: OperationSpy, labels: readonly string[]): Promise<Operation[]> {
  const types = new Map<string, string>();
  for (let after = 0; ;) {
    const page = await storage.listAudit({ afterSeq: after, limit: 1000 });
    for (const r of page) { if (!types.has(r.operationId)) types.set(r.operationId, r.type); after = r.seq; }
    if (page.length < 1000) break;
  }
  const befores = labels.flatMap((l, i) => (l.startsWith("before applyOperation") ? [i] : []));
  if (befores.length !== spy.ids.length) throw new Error(`${befores.length} boundaries for ${spy.ids.length} operations`);
  return spy.ids.map((id, k): Operation => ({ id, type: types.get(id) ?? "(no audit record)", before: befores[k]!, after: befores[k]! + 1 }));
}

/** The holder is named "child", as in the killed process, so the operation IDs (the claim's contains the holder) are the same in both. */
export async function cleanRun(spec: StoreSpec, directory: string): Promise<Clean> {
  const storage = await openStore(spec);
  const { adapter } = await openAdapter(join(directory, "pi"), ANSWER);
  try {
    const spy = new OperationSpy();
    const chaos = new Chaos();
    const world: SliceWorld = { storage: spy.wrap(storage), directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter) };
    const slice = await startProcess(world, "child");
    await runPath(slice);
    const problems = await check(slice, world);
    if (problems.length > 0) throw new Error(`the uncrashed run is wrong: ${problems.join("; ")}`);
    const operations = await operationsOf(storage, spy, chaos.labels);
    return { labels: [...chaos.labels], operations, signature: await signature(world) };
  } finally { await adapter.close(); await storage.close(); }
}

/** Indexes of the boundaries before and after the operations of these audit types (`occurrence`: only that one, counted from 1). */
export function around(clean: Clean, types: readonly string[], occurrence?: number): number[] {
  const hits = clean.operations.filter((o) => types.includes(o.type));
  return (occurrence === undefined ? hits : hits.slice(occurrence - 1, occurrence)).flatMap((o) => [o.before, o.after]);
}

export function describe(clean: Clean, index: number): string {
  const op = clean.operations.find((o) => o.before === index || o.after === index);
  return op === undefined ? `${index} ${clean.labels[index]}` : `${index} ${index === op.before ? "before" : "after"} ${op.type}`;
}

/** What a restarted process finds and checks; shared by every scenario that ends with the whole path finished. */
export interface Probe {
  stats(): Promise<{ modelCalls: number; answers: number; inputs: number; recovered: number }>;
  verify(checkpoint: JsonObject): Promise<boolean>;
}
export function adapterProbe(adapter: PiAdapter): Probe {
  return {
    stats: async () => {
      const transcript = await adapter.root().transcript();
      return { modelCalls: -1, answers: transcript.filter((e) => e.text === ANSWER).length, inputs: transcript.filter((e) => e.role === "user" && e.text.includes("Order seeds")).length, recovered: -1 };
    },
    verify: async (checkpoint) => (await adapter.root().verifyCheckpoint(checkpoint as never)).valid,
  };
}

/** The finished state must equal the clean run's, the model must have answered once, and the recovery point's checkpoint must be one the runtime accepts. */
export async function verifyFinished(slice: Slice, world: SliceWorld, probe: Probe, clean: Clean, crashLabel?: string, tolerate?: RegExp): Promise<string[]> {
  const problems = await check(slice, world, crashLabel);
  const stats = await probe.stats();
  if (stats.answers !== 1) problems.push(`the transcript holds the model's answer ${stats.answers} time(s)`);
  if (stats.inputs !== 1) problems.push(`the transcript holds the task as ${stats.inputs} user message(s)`);
  const point = await slice.recovery.forAttempt(slice.ids.attemptId);
  if (point?.checkpoint === undefined || !(await probe.verify(point.checkpoint))) problems.push("the recovery point's checkpoint is missing or not accepted by the runtime");
  // `tolerate`: rows that record a failure which really happened (a delivery that failed and was retried leaves its failure counter); everything else must be identical.
  const keep = (text: string): string => (tolerate === undefined ? text : text.split("\n").filter((line) => !tolerate.test(line)).join("\n"));
  if (keep(await signature(world)) !== keep(clean.signature)) problems.push("the final state differs from the uncrashed run");
  return problems;
}

/**
 * Acknowledged means the caller got the operation's result back: its `after applyOperation` boundary was passed. Looks at the raw database, without
 * running any command: every acknowledged operation must be there, and an operation that was never started must not be. (One killed at its own
 * `after` boundary is committed but unacknowledged: present.) Returns the problems.
 */
export async function acknowledgedSurvive(storage: ControllerStorage, clean: Clean, crashAt: number): Promise<string[]> {
  const problems: string[] = [];
  for (const op of clean.operations) {
    const stored = await storage.getOperation(op.id);
    const started = op.before < crashAt;
    if (started && stored === undefined) problems.push(`${describe(clean, op.before)} was started before the kill at ${crashAt} but is not stored${op.after < crashAt ? " (it had been acknowledged)" : ""}`);
    if (!started && stored !== undefined) problems.push(`${describe(clean, op.before)} was not started before the kill at ${crashAt} yet is stored`);
  }
  return problems;
}

/** A child process that runs the whole path (controller and adapter in one process) and kills itself with SIGKILL at a boundary. */
export function runChild(spec: StoreSpec, directory: string, crashAt: number, scenario: "path" | "wait" = "path"): Promise<{ killed: boolean; out: string; err: string }> {
  const script = fileURLToPath(new URL("./g04-child.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, script, JSON.stringify(spec), directory, String(crashAt), scenario], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", reject);
    // POSIX reports the signal; Windows reports a terminated process by a non-zero exit code.
    proc.on("exit", (code, signal) => resolve({ killed: process.platform === "win32" ? signal !== null || (code !== null && code !== 0) : signal === "SIGKILL", out, err: `${err}${code === null || code === 0 ? "" : ` exit ${code}`}` }));
  });
}

/** The worker: the Pi adapter in a process of its own. `call` rejects when the process is gone. */
export class WorkerHost {
  readonly #proc: ChildProcess;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  #next = 1;
  #exit: string | undefined;
  readonly exited: Promise<string>;

  private constructor(proc: ChildProcess) {
    this.#proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as { id: number; value?: unknown; error?: string };
      const waiting = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(message.error)); else waiting?.resolve(message.value);
    });
    this.exited = new Promise((resolve) => proc.on("exit", (code, signal) => {
      this.#exit = signal ?? `exit ${code}`;
      for (const waiting of this.#pending.values()) waiting.reject(new Error(`the worker process is gone (${this.#exit})`));
      this.#pending.clear();
      resolve(this.#exit);
    }));
  }

  static async start(directory: string, mode: "normal" | "die-in-model" | "die-after-answer"): Promise<WorkerHost> {
    const script = fileURLToPath(new URL("./g04-worker.js", import.meta.url));
    const proc = spawn(process.execPath, ["--import", guard, script, directory, mode], { stdio: ["pipe", "pipe", "inherit"] });
    const host = new WorkerHost(proc);
    await new Promise<void>((resolve, reject) => { host.#pending.set(0, { resolve: () => resolve(), reject }); });
    return host;
  }

  call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.#exit !== undefined) return Promise.reject(new Error(`the worker process is gone (${this.#exit})`));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#proc.stdin!.write(`${JSON.stringify({ id, op, args })}\n`, (error) => { if (error) { this.#pending.delete(id); reject(error); } });
    });
  }

  /** The conversation port the controller's bridge uses, over the process boundary. */
  conversation(): ConversationSubmitter {
    return {
      submit: async ({ requestId, content }) => { await this.call("submit", { requestId, content }); return { result: () => this.call<BridgeResult>("result", { requestId }) }; },
      lookup: async (requestId) => (await this.call<BridgeResult | null>("lookup", { requestId })) ?? undefined,
      interrupted: () => this.call("interrupted"),
      recover: async (reason) => { await this.call("recover", { reason }); },
      checkpoint: () => this.call<JsonObject>("checkpoint"),
    };
  }

  probe(): Probe {
    return { stats: () => this.call("stats"), verify: (checkpoint) => this.call<boolean>("verify", { checkpoint }) };
  }

  /** SIGKILL, and wait until the process is really gone. */
  async kill(): Promise<void> { if (this.#exit === undefined) this.#proc.kill("SIGKILL"); await this.exited; }
  async stop(): Promise<void> {
    if (this.#exit === undefined) { try { await this.call("close"); } catch { /* already going */ } this.#proc.stdin!.end(); }
    await this.exited;
  }
}
