import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { RemoteWorkerClient, WorkerRequestError } from "./client.js";
import { type CommandSuiteConfig } from "./release-command-suite.js";
import { ReleaseHostRunner, type ReleaseHostRunnerOptions } from "./release-runner.js";

/**
 * The release-test host as a program (card X09b finish): `node dist/remote/release-host-main.js <config.json>`. This file holds what is testable without a process: reading the configuration, keeping a session with the
 * controller (connect, heartbeat, connect again after the controller forgot it) and running `ReleaseHostRunner` over it until told to stop.
 *
 * The configuration is a JSON file the operator writes on the test machine; it never holds the credential:
 * `{ "controllerUrl": "https://...", "caFile"?: path, "tokenFile"?: path, "tokenEnv"?: name (default NIMBLENEWT_HOST_TOKEN), "concurrency"?: 1-4, "intervalSeconds"?: 1-3600, "suite": { "command", "args"?, "cwd"?, "env"?, "maxOutputBytes"? } }`.
 * The credential is the host's own (issued by the owner for this host) and reaches the program in an environment variable or a file only the operator can read.
 */
export interface ReleaseHostConfig {
  readonly controllerUrl: string;
  readonly ca?: string;
  readonly token: string;
  /** The environment variable the credential was read from (absent when it came from `tokenFile`): the program removes it from its own environment before any test runs. */
  readonly tokenEnv?: string;
  readonly concurrency?: number;
  readonly intervalSeconds?: number;
  readonly suite: CommandSuiteConfig;
}

const text = (v: unknown, what: string, max = 4096): string => { if (typeof v !== "string" || v.length === 0 || v.length > max || /[\0\r\n]/.test(v)) throw new Error(`${what} must be one line of text`); return v; };
const own = (o: Record<string, unknown>, allowed: readonly string[], what: string): void => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${what}: unknown setting ${JSON.stringify(k.slice(0, 40))}`); };

/** Reads the configuration text. Relative paths in it are relative to the file. A credential written into the file is refused: it belongs in `tokenFile` or the environment. */
export async function readReleaseHostConfig(source: string, file: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<ReleaseHostConfig> {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error("the configuration is not JSON"); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the configuration must be a JSON object");
  const c = raw as Record<string, unknown>;
  if ("token" in c) throw new Error("the credential must not be written in the configuration: use tokenFile or the environment variable named by tokenEnv");
  own(c, ["controllerUrl", "caFile", "tokenFile", "tokenEnv", "concurrency", "intervalSeconds", "suite"], "the configuration");
  const base = dirname(resolve(file));
  const path = (v: unknown, what: string): string => { const t = text(v, what); return isAbsolute(t) ? t : resolve(base, t); };
  const url = text(c["controllerUrl"], "controllerUrl");
  const s = c["suite"];
  if (s === null || typeof s !== "object" || Array.isArray(s)) throw new Error("suite must be an object with a command");
  const so = s as Record<string, unknown>;
  own(so, ["command", "args", "cwd", "env", "maxOutputBytes"], "suite");
  const command = text(so["command"], "suite.command");
  // A command with a folder in it is relative to the configuration file; a bare name is looked up on PATH.
  const resolvedCommand = /[\\/]/.test(command) && !isAbsolute(command) ? resolve(base, command) : command;
  const args = so["args"] === undefined ? [] : Array.isArray(so["args"]) && so["args"].length <= 200 ? so["args"].map((a) => { if (typeof a !== "string" || a.length > 4096 || a.includes("\0")) throw new Error("suite.args must be a list of text"); return a; }) : (() => { throw new Error("suite.args must be a list of at most 200 texts"); })();
  const senv = so["env"];
  if (senv !== undefined && (senv === null || typeof senv !== "object" || Array.isArray(senv) || Object.entries(senv).some(([k, v]) => typeof v !== "string" || k.length === 0 || /[=\0]/.test(k) || v.includes("\0")))) throw new Error("suite.env must map names to text");
  const num = (v: unknown, what: string, min: number, max: number): number | undefined => { if (v === undefined) return undefined; if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`); return v; };
  const name = c["tokenEnv"] === undefined ? "NIMBLENEWT_HOST_TOKEN" : text(c["tokenEnv"], "tokenEnv", 100);
  let token: string | undefined;
  if (c["tokenFile"] !== undefined) token = (await readFile(path(c["tokenFile"], "tokenFile"), "utf8")).trim();
  else token = env[name]?.trim();
  if (token === undefined || token === "") throw new Error(`no credential: set ${name} or give tokenFile`);
  const ca = c["caFile"] === undefined ? undefined : await readFile(path(c["caFile"], "caFile"), "utf8");
  const concurrency = num(c["concurrency"], "concurrency", 1, 4);
  const intervalSeconds = num(c["intervalSeconds"], "intervalSeconds", 1, 3600);
  const maxOutputBytes = num(so["maxOutputBytes"], "suite.maxOutputBytes", 1, 1024 * 1024 * 1024);
  return {
    controllerUrl: url, token, ...(c["tokenFile"] === undefined ? { tokenEnv: name } : {}), ...(ca === undefined ? {} : { ca }), ...(concurrency === undefined ? {} : { concurrency }), ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    suite: { command: resolvedCommand, args, ...(so["cwd"] === undefined ? {} : { cwd: path(so["cwd"], "suite.cwd") }), ...(senv === undefined ? {} : { env: senv as Record<string, string> }), ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) },
  };
}

type SessionClient = Pick<RemoteWorkerClient, "connect" | "heartbeat" | "session" | "forgetSession" | "releaseWork" | "releasePickUp" | "releaseReport">;

export interface RunReleaseHostOptions {
  readonly client: SessionClient;
  readonly suite: ReleaseHostRunnerOptions["suite"];
  readonly signal: AbortSignal;
  readonly platform?: ReleaseHostRunnerOptions["platform"];
  readonly concurrency?: number;
  /** The gap between looks at the controller, in ms (default 15 000, at least 1 000 unless injected `wait` is given). */
  readonly everyMs?: number;
  /** The gap between heartbeats, in ms (default 15 000). */
  readonly heartbeatMs?: number;
  readonly onTrouble?: (attemptId: string | undefined, what: string, error?: unknown) => void;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Runs until the signal aborts, then stops running suites and waits for them to end. Returns nothing; trouble is told through `onTrouble`. */
export async function runReleaseHost(o: RunReleaseHostOptions): Promise<void> {
  const platform = o.platform ?? { os: process.platform as "linux" | "darwin" | "win32", arch: process.arch as "x64" | "arm64" };
  const trouble = (id: string | undefined, what: string, e?: unknown): void => { try { o.onTrouble?.(id, what, e); } catch { /* a listener never stops the host */ } };
  const now = o.now ?? Date.now;
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  let beat = Number.NEGATIVE_INFINITY;
  let sequence = 0;
  // A call that says the session is gone makes the next look connect again; the runner keeps what it has not been able to report and sends it again.
  const lost = (e: unknown): void => { if (e instanceof WorkerRequestError && (e.code === "fenced" || e.code === "not_connected" || e.status === 401)) o.client.forgetSession(); };
  const guard = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { try { return await f(...a); } catch (e) { lost(e); throw e; } };
  const client = {
    releaseWork: guard(() => o.client.releaseWork()),
    releasePickUp: guard((id: string, key?: string) => o.client.releasePickUp(id, key)),
    releaseReport: guard((id: string, r: { readonly [k: string]: never }, key?: string) => o.client.releaseReport(id, r, key)),
  } as unknown as ReleaseHostRunnerOptions["client"];
  const runner = new ReleaseHostRunner({
    client, suite: o.suite, platform, ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }), onTrouble: trouble, ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
  });
  const everyMs = Number.isFinite(o.everyMs) ? Math.max(o.wait === undefined ? 1000 : 1, o.everyMs as number) : 15_000;
  const wait = o.wait ?? ((ms: number, s: AbortSignal): Promise<void> => new Promise((r) => {
    if (s.aborted) { r(); return; }
    const done = (): void => { clearTimeout(t); s.removeEventListener("abort", done); r(); };
    const t = setTimeout(done, ms);
    s.addEventListener("abort", done, { once: true });
  }));
  while (!o.signal.aborted) {
    try {
      if (o.client.session === undefined) {
        await o.client.connect({ os: platform.os, arch: platform.arch, harnesses: [], isolation: [], tools: [], workspaces: [] } as never, undefined, o.signal);
        beat = now();
      } else if (now() - beat >= heartbeatMs) {
        await o.client.heartbeat(++sequence, undefined, o.signal);
        beat = now();
      }
      await runner.tick();
    } catch (e) {
      if (o.signal.aborted) break;
      lost(e);
      trouble(undefined, o.client.session === undefined ? "could not connect to the controller" : "a look at the controller failed", e);
    }
    await wait(everyMs, o.signal);
  }
  runner.stop();
  await runner.settled();
}
