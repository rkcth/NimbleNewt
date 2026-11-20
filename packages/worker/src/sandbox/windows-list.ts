import { redactAndCut, type RedactionNames } from "./windows-redact.js";
import type { ProcessResult, WindowsHost } from "./windows-host.js";

/**
 * `wsb list --raw` with diagnostics and a bounded retry. The first call after the Sandbox server has been idle may need to start it, so it gets a longer limit; a call that fails
 * or times out is repeated at most twice. The answer stays fail-closed: when no attempt gives a list, the caller must treat it as "no sandbox capacity" and start nothing.
 * The detail records how long each call took, the Sandbox server process (id and start time) before and after, and which environment variables are present, by name only.
 */
export const LIST_TIMEOUTS_MS: readonly number[] = [120_000, 60_000, 60_000];
export const LIST_PAUSE_MS = 2_000;
/** Names whose presence can change how a local gRPC call behaves; only present or absent is recorded, never a value. */
export const LIST_ENV_NAMES: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SESSIONNAME"];

export interface ListOptions {
  /** One limit per attempt: the first is the long one, the others are the retries (at most two). */
  readonly timeoutsMs?: readonly number[];
  readonly pauseMs?: number;
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
      how = current.timedOut ? "timed out" : current.code === 0 ? "ok" : `exit ${String(current.code)}`;
    } catch { how = "could not run"; }
    calls.push(`call ${String(i + 1)}: ${how} after ${String(Date.now() - t0)} ms (limit ${String(timeouts[i])} ms)`);
    if (current !== undefined && current.code === 0 && !current.timedOut) { result = current; break; }
  }
  const after = await servers(host);
  const detail = redactAndCut(`wsb list: ${calls.join("; ")}; server before: ${before}; server after: ${after}; env: ${envPresence(host)}`, options.names ?? {}, 1500);
  return { ok: result !== undefined, stdout: result?.stdout ?? "", attempts: calls.length, detail };
}
