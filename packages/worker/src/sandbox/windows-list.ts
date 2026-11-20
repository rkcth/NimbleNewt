import { redactAndCut, type RedactionNames } from "./windows-redact.js";
import type { ProcessResult, WindowsHost, WindowsListContext } from "./windows-host.js";

/**
 * `wsb list --raw` with diagnostics and a bounded retry. The first call after the Sandbox server has been idle may need to start it, so it gets a longer limit; a call that fails
 * or times out is repeated at most twice. The answer stays fail-closed: when no attempt gives a list, the caller must treat it as "no sandbox capacity" and start nothing.
 * The detail records how long each call took, the Sandbox server process (id and start time) before and after, and which environment variables are present, by name only.
 * When every call failed, it also records the context (token elevation and integrity, session ids, the server's elevation and session, the process chain's names from a fixed
 * list) and the outcome of one diagnostic call through `cmd.exe /c` with a minimal environment. That call is marked as such and never changes the result.
 */
export const LIST_TIMEOUTS_MS: readonly number[] = [120_000, 60_000, 60_000];
export const LIST_PAUSE_MS = 2_000;
/** The diagnostic call's limit (one call, after the normal ones failed). */
export const DIAGNOSTIC_TIMEOUT_MS = 60_000;
/** Process names that are shown as themselves in the process chain (compared without `.exe`, case aside); any other name is shown as "other". */
export const CHAIN_NAMES: readonly string[] = ["node", "pwsh", "powershell", "cmd", "Runner.Worker", "bash"];
/** Names whose presence can change how a local gRPC call behaves; only present or absent is recorded, never a value. */
export const LIST_ENV_NAMES: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SESSIONNAME"];

export interface ListOptions {
  /** One limit per attempt: the first is the long one, the others are the retries (at most two). */
  readonly timeoutsMs?: readonly number[];
  readonly pauseMs?: number;
  /** The limit of the one diagnostic call made after every normal call failed. */
  readonly diagnosticTimeoutMs?: number;
  readonly names?: RedactionNames;
}

export interface ListOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly attempts: number;
  /** One redacted line; names and numbers only, no values of environment variables. */
  readonly detail: string;
}

const present = (host: WindowsHost, name: string): boolean => { const v = host.env(name); return v !== undefined && v !== ""; };

/** The environment, as names with present or absent (any GRPC_* variable is listed by its name). */
export function envPresence(host: WindowsHost): string {
  const grpc = (host.envNames?.() ?? []).filter((n) => /^GRPC_[A-Za-z0-9_]*$/i.test(n)).sort();
  const parts = LIST_ENV_NAMES.map((n) => `${n}=${present(host, n) ? "present" : "absent"}`);
  parts.push(grpc.length === 0 ? "GRPC_*=absent" : grpc.map((n) => `${n.toUpperCase()}=present`).join(" "));
  return parts.join(" ");
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;

async function servers(host: WindowsHost): Promise<string> {
  if (host.serverProcesses === undefined) return "not available";
  try {
    const list = await host.serverProcesses();
    // Only a whole process id and an ISO time are copied, whatever the host returned: the line goes to logs of a public repository.
    const shown = list.slice(0, 8).map((p) => `pid ${Number.isSafeInteger(p.pid) ? String(p.pid) : "unknown"} started ${p.started !== undefined && ISO_TIME.test(p.started) ? p.started : "unknown"}`);
    return list.length === 0 ? "none" : `${shown.join(", ")}${list.length > 8 ? ` and ${String(list.length - 8)} more` : ""}`;
  } catch { return "not readable"; }
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const sessionText = (v: unknown): string => (v === 0xffffffff ? "none" : isId(v) && v < 0xffffffff ? String(v) : "unknown");
const yesNo = (v: unknown): string => (v === 1 || v === true ? "yes" : v === 0 || v === false ? "no" : "unknown");

/** The integrity level's word from its RID (the last part of the label SID): low, medium (medium plus too), high or system; other numbers "other", none "unknown". */
export function integrityWord(rid: unknown): string {
  if (!isId(rid)) return "unknown";
  return rid >= 0x1000 && rid < 0x2000 ? "low" : rid >= 0x2000 && rid < 0x3000 ? "medium" : rid >= 0x3000 && rid < 0x4000 ? "high" : rid >= 0x4000 && rid < 0x5000 ? "system" : "other";
}

/** A process name from the fixed list (its own spelling), else "other". */
export function chainName(name: unknown): string {
  if (typeof name !== "string") return "other";
  const bare = name.replace(/\.exe$/i, "").toLowerCase();
  return CHAIN_NAMES.find((n) => n.toLowerCase() === bare) ?? "other";
}

/** The context as fixed words and numbers only: whatever text the host returned is never copied (the line goes to logs of a public repository). */
export function contextText(raw: WindowsListContext): string {
  // Windows PowerShell 5.1 can write a list as {"value":[...],"Count":n}, and a list of one as the item itself.
  const asList = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v === null || typeof v !== "object") return [];
    const wrapped = (v as { value?: unknown }).value;
    return Array.isArray(wrapped) ? wrapped : [v];
  };
  const servers = asList(raw.servers);
  const shownServers = servers.slice(0, 8).map((s) => {
    const o = (s !== null && typeof s === "object" ? s : {}) as { sessionId?: unknown; elevated?: unknown; integrity?: unknown };
    return `session ${sessionText(o.sessionId)} elevated ${yesNo(o.elevated)} integrity ${integrityWord(o.integrity)}`;
  });
  const chain = asList(raw.chain).slice(0, 8).map(chainName);
  return [
    `this process elevated ${yesNo(raw.elevated)} integrity ${integrityWord(raw.integrity)}`,
    `session ${sessionText(raw.processSessionId)}, console session ${sessionText(raw.consoleSessionId)}`,
    `server ${servers.length === 0 ? "none" : `${shownServers.join(", ")}${servers.length > 8 ? ` and ${String(servers.length - 8)} more` : ""}`}`,
    `process chain (this process first) ${chain.length === 0 ? "unknown" : chain.join(" < ")}`,
  ].join(", ");
}

async function context(host: WindowsHost): Promise<string> {
  if (host.listContext === undefined) return "not available";
  try { return contextText(await host.listContext()); } catch { return "not readable"; }
}

const outcome = (r: ProcessResult): string => (r.timedOut ? "timed out" : r.code === 0 ? "ok" : `exit ${String(r.code)}`);

/** One call through cmd.exe with a minimal environment, after the normal calls failed. Recorded only: whatever it gives, the list stays failed. */
async function diagnosticCall(host: WindowsHost, client: { readonly wsb: string; readonly cwd: string }, timeoutMs: number): Promise<string> {
  if (host.runMinimalEnv === undefined) return "not available";
  const t0 = Date.now();
  let how: string;
  try { how = outcome(await host.runMinimalEnv(client.wsb, ["list", "--raw"], { cwd: client.cwd, timeoutMs })); } catch { how = "could not run"; }
  return `${how} after ${String(Date.now() - t0)} ms (limit ${String(timeoutMs)} ms)`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function listSandboxes(host: WindowsHost, client: { readonly wsb: string; readonly cwd: string }, options: ListOptions = {}): Promise<ListOutcome> {
  const timeouts = (options.timeoutsMs ?? LIST_TIMEOUTS_MS).slice(0, 3);
  const pauseMs = options.pauseMs ?? LIST_PAUSE_MS;
  const before = await servers(host);
  const calls: string[] = [];
  let result: ProcessResult | undefined;
  for (let i = 0; i < timeouts.length; i++) {
    if (i > 0) await sleep(pauseMs);
    const t0 = Date.now();
    let current: ProcessResult | undefined;
    let how: string;
    try {
      current = await host.run(client.wsb, ["list", "--raw"], { cwd: client.cwd, timeoutMs: timeouts[i]! });
      how = outcome(current);
    } catch { how = "could not run"; }
    calls.push(`call ${String(i + 1)}: ${how} after ${String(Date.now() - t0)} ms (limit ${String(timeouts[i])} ms)`);
    if (current !== undefined && current.code === 0 && !current.timedOut) { result = current; break; }
  }
  const after = await servers(host);
  // Only when every call failed: the context and one diagnostic call, both recorded and never used for the answer.
  const failure = result !== undefined ? "" : `; context: ${await context(host)}; diagnostic call through cmd with a minimal environment (recorded only, the list stays failed): ${await diagnosticCall(host, client, options.diagnosticTimeoutMs ?? DIAGNOSTIC_TIMEOUT_MS)}`;
  const detail = redactAndCut(`wsb list: ${calls.join("; ")}; server before: ${before}; server after: ${after}; env: ${envPresence(host)}${failure}`, options.names ?? {}, 2500);
  return { ok: result !== undefined, stdout: result?.stdout ?? "", attempts: calls.length, detail };
}
