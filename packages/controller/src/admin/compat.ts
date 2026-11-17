import { SCRIPT_PROTOCOL, WORKER_PROTOCOL } from "../remote/protocol.js";
import { compareVersions } from "../environment/check.js";
import { SUPPORTED_ENVIRONMENT } from "../environment/supported.js";
import { redactText } from "../security/redact.js";

/**
 * Compatibility and migration status for the administration pages (card U08: "compatibility and migration status shows affected agents and operations", runtime-compatibility-and-namespaces.md).
 * Everything here is a pure function of records the caller read: what this controller speaks and needs (the worker protocol range and the Node.js floor), what each host's worker last announced, which agents
 * work where, and which database migrations wait. It writes nothing and names no secret.
 */
export const COMPAT_LIMITS = { hosts: 100, agents: 10, operations: 10, note: 300 } as const;

/** What a worker protocol version brings that an older one lacks: a host that speaks less cannot do these (card T02d: version 2 carries the run order for catalogue tools). */
export const PROTOCOL_FEATURES: readonly { readonly since: number; readonly operations: readonly string[] }[] = [
  { since: SCRIPT_PROTOCOL, operations: ["running a catalogue tool on the host (script run)", "stopping or revoking a running script on the host"] },
];

/** What a host's last announcement says, as the controller's records hold it. */
export interface HostRuntimeInput {
  readonly hostId: string;
  readonly identity: string;
  readonly freshness: string;
  readonly os?: string;
  readonly protocol?: number;
  readonly workerVersion?: string;
  /** Set while the controller's latest word to this worker was a refusal (no common protocol), cleared when a connection succeeds. */
  readonly refusal?: { readonly at: string; readonly reason: string };
  /** True for a host that runs inside this controller (the local host): it is this build's own worker and opens no remote session, so it speaks this version's protocol (card U08d second review). */
  readonly inProcess?: boolean;
}

/** An active agent, where its conversation store lives and the attempt it is running now, when it is running one. */
export interface AgentWorkInput { readonly agentId: string; readonly name?: string; readonly hostId?: string; readonly attemptId?: string }

export interface PendingMigrationInput { readonly version: number; readonly name: string; readonly kind: string; readonly state: string }

export interface CompatInputs {
  readonly node: string;
  readonly hosts: readonly HostRuntimeInput[];
  readonly work: readonly AgentWorkInput[];
  readonly migration?: { readonly schemaVersion: number; readonly latestKnown: number; readonly migrations: readonly PendingMigrationInput[] };
}

export type HostCompat = "current" | "older" | "refused" | "not connected" | "revoked";

export interface Affected {
  readonly agents: readonly string[];
  readonly agentsMore: number;
  readonly operations: readonly string[];
  readonly operationsMore: number;
}

export interface CompatHost extends Affected {
  readonly hostId: string;
  readonly state: HostCompat;
  readonly protocol?: number;
  readonly workerVersion?: string;
  readonly os?: string;
  readonly note: string;
}

export interface CompatView {
  /** `attention` when anything below is not current; `compatible` when every runtime in use is one this version supports and nothing waits. */
  readonly status: "compatible" | "attention";
  readonly runtime: {
    readonly node: { readonly running: string; readonly minimum: string; readonly supported: boolean };
    readonly protocol: { readonly min: number; readonly max: number };
  };
  readonly hosts: readonly CompatHost[];
  readonly migration?: Affected & {
    readonly schemaVersion: number;
    readonly latestKnown: number;
    readonly pending: readonly PendingMigrationInput[];
    readonly note: string;
  };
  readonly truncated: boolean;
}

const cap = <T>(list: readonly T[], n: number): { shown: T[]; more: number } => ({ shown: list.slice(0, n), more: Math.max(0, list.length - n) });
const agentLabel = (a: AgentWorkInput): string => `${redactText(a.name ?? a.agentId).slice(0, 60)}${a.name === undefined ? "" : ` (${a.agentId})`}`;

function affected(agents: readonly AgentWorkInput[], operations: readonly string[]): Affected {
  const a = cap(agents.map(agentLabel).sort(), COMPAT_LIMITS.agents);
  const o = cap(operations, COMPAT_LIMITS.operations);
  return { agents: a.shown, agentsMore: a.more, operations: o.shown, operationsMore: o.more };
}

/** Which protocol-dependent operations a host speaking `protocol` cannot do. */
export const missingOperations = (protocol: number): string[] => PROTOCOL_FEATURES.filter((f) => protocol < f.since).flatMap((f) => [...f.operations]);

export function compatibility(input: CompatInputs): CompatView {
  const node = { running: input.node, minimum: SUPPORTED_ENVIRONMENT.node.minimum, supported: compareVersions(input.node, SUPPORTED_ENVIRONMENT.node.minimum) >= 0 };
  const hosts: CompatHost[] = [];
  for (const h of input.hosts.slice(0, COMPAT_LIMITS.hosts)) {
    const here = input.work.filter((w) => w.hostId === h.hostId);
    const base = { hostId: h.hostId, ...(h.protocol === undefined ? {} : { protocol: h.protocol }), ...(h.workerVersion === undefined ? {} : { workerVersion: redactText(h.workerVersion).slice(0, 80) }), ...(h.os === undefined ? {} : { os: h.os }) };
    if (h.identity !== "active") { hosts.push({ ...base, state: "revoked", note: "This host's identity is switched off; no work is placed on it.", ...affected([], []) }); continue; }
    if (h.refusal !== undefined) {
      hosts.push({ ...base, state: "refused", note: `The controller turned this worker away on ${h.refusal.at}: ${redactText(h.refusal.reason).slice(0, COMPAT_LIMITS.note).replace(/[.!]?$/, ".")}`, ...affected(here, ["every attempt that would be placed on this host (nothing is placed on it until the worker is replaced or upgraded)"]) });
      continue;
    }
    if (h.inProcess === true) { hosts.push({ ...base, protocol: WORKER_PROTOCOL.max, state: "current", note: "It runs inside this controller, the same build, so it speaks everything this version does.", ...affected([], []) }); continue; }
    if (h.protocol === undefined) { hosts.push({ ...base, state: "not connected", note: "No worker has connected from this host since the controller recorded it; its protocol is not known.", ...affected([], []) }); continue; }
    if (h.protocol < WORKER_PROTOCOL.max) {
      const missing = missingOperations(h.protocol);
      hosts.push({ ...base, state: "older", note: `It speaks worker protocol ${h.protocol}; this version speaks ${WORKER_PROTOCOL.min} to ${WORKER_PROTOCOL.max}, so it works but not with everything${missing.length === 0 ? "" : ` (it lacks ${missing.length} operation(s))`}. Upgrade its worker to use them.`, ...affected(missing.length === 0 ? [] : here, missing) });
      continue;
    }
    hosts.push({ ...base, state: "current", note: `It speaks worker protocol ${h.protocol}, the newest this version speaks.`, ...affected([], []) });
  }
  let migration: CompatView["migration"];
  if (input.migration !== undefined) {
    const pending = input.migration.migrations.filter((m) => m.state !== "applied");
    const running = input.work.filter((w) => w.attemptId !== undefined);
    const kinds = pending.some((m) => m.kind === "destructive");
    migration = {
      schemaVersion: input.migration.schemaVersion, latestKnown: input.migration.latestKnown, pending: pending.slice(0, 50),
      note: pending.length === 0 ? "No migration waits: the database is at the newest layout this version knows." : `${pending.length === 1 ? "1 migration waits" : `${pending.length} migrations wait`}${kinds ? " (a destructive one needs your approval first)" : ""}; they run at the next start of the controller, which interrupts the attempts listed here.`,
      ...(pending.length === 0 ? affected([], []) : affected(running, running.map((w) => `attempt ${w.attemptId} of ${redactText(w.name ?? w.agentId).slice(0, 60)}`))),
    };
  }
  const attention = !node.supported || hosts.some((h) => h.state === "older" || h.state === "refused") || (migration !== undefined && migration.pending.length > 0);
  return { status: attention ? "attention" : "compatible", runtime: { node, protocol: { min: WORKER_PROTOCOL.min, max: WORKER_PROTOCOL.max } }, hosts, ...(migration === undefined ? {} : { migration }), truncated: input.hosts.length > COMPAT_LIMITS.hosts };
}
