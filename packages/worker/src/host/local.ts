import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANCHOR_CHANNEL_MAX, endKindOf, findAnchors, verifyAnchor, type ThinkingReport, type BridgeReplyMessage, type ChannelContext, type ChannelModel, type HostEndKind, type JsonValue } from "@nimblenewt/contracts";
import { attemptSandbox, type AttemptSandboxPlan } from "../sandbox/attempt.js";
import type { SandboxLauncher } from "../sandbox/launcher.js";
import type { LimitEnforcement, ResourceLimits } from "../sandbox/limits.js";
import { GUEST, normalizeRecipe, type ReadOnlyMount } from "../sandbox/recipe.js";
import { MAX_RUN_PROCESSES, splitRunTree, type RunProcess } from "../sandbox/proc.js";
import { removeTree } from "../sandbox/script.js";
import { PROCESS_LIMITS, ProcessNotEnded, WorkerProcess, type RelayRequest, type RelayResponse } from "./process.js";

/**
 * The local worker host's two ports, bound to the real sandbox launcher and the real worker process (card H12b). The controller's `LocalWorker` takes a `SandboxPort` and a `RuntimeFactory`; the worker package depends on no other package of the
 * product, so the shapes it needs of the controller's types are restated here and the composer's types fit them structurally (the integration tests are where that is checked).
 *
 * One attempt: `sandbox.open` checks the attempt's workspace against the rules of card A03 (only the checkout, the agent's home and scratch and the read-only inputs are mounted; the agent's git directory is not reachable) and reserves the sandbox;
 * `runtimes.open` starts the worker process in it (the Pi conversation, with no network) and speaks to it over the channel. Closing the sandbox, the runtime, or losing the process ends the whole process tree.
 */

type JsonObj = { readonly [key: string]: JsonValue };

/** What the host needs of the dispatcher's work order. */
export interface HostOrder {
  readonly attemptId: string;
  readonly agentId: string;
  readonly route: string;
  readonly credential: string;
  readonly recipe: { readonly revision: string; readonly reach: readonly string[]; readonly limits?: ResourceLimits };
  readonly expiresAt?: string;
  readonly resumeFrom?: JsonObj;
  /** The dispatch contract (card H12a) as far as the host reads it: the limits the dispatcher worked out for this launch (card A08d: the agent's environment cut by the installation's), applied on top of the host's own and the owner's, never instead of them. */
  readonly contract?: { readonly limits?: ResourceLimits; /** Card W12: the digest of the goal anchor block the controller put at the top of `content` (the contract's digest covers it). */ readonly anchorDigest?: string };
  /** The order's first prompt (the dispatcher's `WorkOrder.content`); read here only to find the goal anchor the contract names. */
  readonly content?: string;
}

/**
 * The goal anchor this order's process re-inserts after every context cut (W12 follow-up, remote workers): the block in the order's own content whose digest the dispatch contract names, exactly as the controller's local path
 * (`dispatch-compose.ts` `contextFor`) picks it. Nothing new travels: a remote worker already receives the content and the sealed contract in its offer, and the controller's placement check (`checkContract` in `RemoteService.place`) has refused an order whose named block is not there (the worker's `honorContract` does not look; a missing block here simply gives no anchor).
 * Only the named block is taken (a task text may carry a block of its own that checks out; it is not the controller's), it must check out on its own and fit the channel's bound. `undefined` otherwise: the process then starts as before.
 */
export function orderAnchor(order: Pick<HostOrder, "content" | "contract">): string | undefined {
  const named = (order.contract as { readonly anchorDigest?: unknown } | undefined)?.anchorDigest;
  if (typeof named !== "string" || !/^[0-9a-f]{64}$/.test(named) || typeof order.content !== "string") return undefined;
  const found = findAnchors(order.content).find((a) => a.digest === named);
  return found === undefined || found.text.length > ANCHOR_CHANNEL_MAX || verifyAnchor(found.text) !== named ? undefined : found.text;
}

/**
 * The channel context with the order's goal anchor (W12 follow-up): a context that already carries an anchor (the controller's local path hands it in) is kept as it is; otherwise the anchor the order's contract names is added with
 * the extractive fallback the channel requires for it (only that summary puts the block back). An order without an anchor leaves the context exactly as given.
 */
export function withOrderAnchor(context: ChannelContext | undefined, order: Pick<HostOrder, "content" | "contract">): ChannelContext | undefined {
  if (context?.compaction?.anchor !== undefined) return context;
  const text = orderAnchor(order);
  if (text === undefined) return context;
  return { ...(context ?? {}), compaction: { ...(context?.compaction ?? {}), fallback: "extractive", anchor: { text } } };
}

/**
 * The limits the dispatch contract carries for this launch (card A08d), checked: an object of known figures that are whole numbers (wall time from 1000 ms to a week). Throws on anything else, so the launch is refused (and recorded as
 * refused) rather than made with a figure nobody can read. `undefined` when the contract states none.
 */
export function contractLimitsOf(order: Pick<HostOrder, "contract">): ResourceLimits | undefined {
  const l = order.contract?.limits as unknown;
  if (l === undefined) return undefined;
  if (l === null || typeof l !== "object" || Array.isArray(l)) throw new Error("the dispatch contract's limits are not an object");
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(l)) {
    if (value === undefined) continue;
    if (!(["cpus", "memoryMb", "diskMb", "processes", "wallTimeMs"] as readonly string[]).includes(key)) throw new Error(`the dispatch contract limits ${key.slice(0, 30)}, which is not a limit`);
    const [lo, hi] = key === "wallTimeMs" ? [1000, 604_800_000] : [1, Number.MAX_SAFE_INTEGER];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < lo || value > hi) throw new Error(`the dispatch contract's ${key} (${String(value).slice(0, 30)}) must be a whole number from ${lo} to ${hi}`);
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export interface HostTurnResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly text?: string;
  readonly error?: string;
  readonly checkpoint?: JsonObj;
  readonly usage?: { readonly turnSeq?: number; readonly cache?: CacheFigures };
  /**
   * How the turn ended (card W02), as the worker process classified its last reply; `unknown` when it did not say (a worker from before W02, a turn that failed or was cancelled, a process that ended). Never defaulted to `normal`.
   * Recorded on the attempt; nothing acts on it yet (W03).
   */
  readonly endKind: HostEndKind;
  /** The length of the last reply's visible text (trimmed), when the process said. */
  readonly visibleChars?: number;
  /** Card W04: how many times the process continued the turn after it yielded without a tool call or work.end, when it said (any status). */
  readonly nudges?: number;
}
export interface CacheFigures { readonly backend: string; readonly route: string; readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number }

/** What the first call of an attempt carries, as far as the host can tell (the controller's `FirstCall`, restated): the process says how big its tools are; the prompt is counted at three characters to a token. */
export interface HostFirstCall { readonly systemPromptChars: number; readonly toolSchemaChars: number; readonly startupTokens: number; readonly replyReserveTokens: number }

/** The size of the conversation stored in a checkpoint of this host, in tokens, when it says (the resume decision of card C07b asks for it before a runtime is opened). */
export function storedTokensOf(from: JsonObj | undefined): number | undefined {
  const tokens = (from?.["nn"] as JsonObj | undefined)?.["contextTokens"];
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
}

/**
 * What to ask of the process about work an earlier process left unfinished: to recover (release Pi's hold, abandoning nothing) only when the controller's review says nothing is waiting; otherwise undefined, so the hold stays and `onHeld` says so.
 * No answer, or an answer that throws, is "not reviewed".
 */
export async function recoveryFor(options: Pick<LocalHostOptions<unknown>, "heldForReview" | "onHeld">, order: HostOrder, restarted: boolean): Promise<{ readonly reason: string } | undefined> {
  let held = true;
  try { held = options.heldForReview === undefined ? true : (await options.heldForReview(order)) !== false; } catch { held = true; }
  if (held) { try { options.onHeld?.(order, "interrupted work of this attempt is held until it has been reviewed"); } catch { /* the hold itself is the safe side */ } return undefined; }
  return { reason: restarted ? "the controller restarted the sandbox of this attempt" : "the controller resumed this attempt from a checkpoint" };
}

/** A rough size, in tokens, of the conversation stored under `dir` (three bytes to a token, the budget's own estimate); undefined when nothing is stored there. Bounded: it looks at most at 20,000 files. */
export function estimateStoredTokens(dir: string): number | undefined {
  let bytes = 0; let files = 0; let found = false;
  const walk = (at: string): void => {
    let names: string[];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      if (files >= 20_000) return;
      const path = join(at, name);
      try { const st = statSync(path); if (st.isDirectory()) walk(path); else if (st.isFile()) { files++; bytes += st.size; found = true; } } catch { /* a file that went away is not counted */ }
    }
  };
  walk(dir);
  return found ? Math.ceil(bytes / 3) : undefined;
}

export interface HostRuntime {
  /** The first call this runtime will make for `content`. */
  firstCall(content: string): HostFirstCall;
  run(content: string, requestId: string): Promise<HostTurnResult>;
  checkpoint(): Promise<JsonObj>;
  tell(text: string): Promise<void>;
  /** Compacts the stored conversation once (card H12f); absent on a runtime that cannot. */
  compact?(): Promise<void>;
  refreshContext(): Promise<void>;
  /** Model calls open right now (the controller does not call the attempt paused while one is). */
  activeModelCalls?(): number;
  close(): Promise<void>;
}
/**
 * The attempt's lease as the controller hands it to the runtime (card H08b): its length, as a duration, and the renewal (the controller's heartbeat for the attempt). The renewal throws an error whose `code` is `fenced` when the attempt is no longer
 * this worker's; any other throw means the controller could not be asked.
 */
export interface HostLease { readonly leaseMs: number; renew(): Promise<{ readonly leaseMs: number }> }

/** One thing a sandbox still holds (card L02d): the controller's `SandboxSession.work` entry, restated. */
export interface HostHeldProcess { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }
export interface HostSandboxSession {
  readonly revision: string;
  close(): Promise<void>;
  /**
   * What this sandbox still holds and what winding it down has cost (card L02d), asked by Stop also after `close`. The worker process itself is listed only once it has been asked to end and has not; a process the agent started
   * (below the worker process) is listed while it runs. `computeMs`: the time, summed over the sandbox's processes, from the request to end each until it ended (or until now), left out while it is 0.
   */
  work(): Promise<{ readonly processes: readonly HostHeldProcess[]; readonly computeMs?: number }>;
  /** Force Stop (card L02d): kills every process this sandbox started (what outlived its run too) and waits a moment for them to go. */
  end(): Promise<void>;
}

/** Where the worker process's program and everything it loads live on this machine, mounted read-only into the sandbox. */
export interface WorkerApp {
  /** The Node installation that runs it: its directory, and the executable inside it. */
  readonly node: { readonly root: string; readonly executable: string };
  /** The package folders and `node_modules` the process loads, laid out as they are in the repository (`packages/<name>` and `node_modules` under one root, so the workspace links resolve). Never the controller or the worker package. */
  readonly mounts: readonly ReadOnlyMount[];
  /** The process's entry file, as the sandbox sees it. */
  readonly entry: string;
  /** The same file on this machine, for a launcher whose sandbox shows the host's own paths (`guestPaths: "host"`). */
  readonly hostEntry?: string;
}

/** The mounts and entry of a source checkout that has been built: the worker process lives in `packages/pi-adapter` and needs `contracts` and `registry` beside it. */
export function appFromRepository(repository: string, node: { readonly root: string; readonly executable: string }): WorkerApp {
  const mounts: ReadOnlyMount[] = [{ host: join(repository, "node_modules"), guest: "/opt/app/node_modules" }];
  for (const name of ["pi-adapter", "contracts", "registry"]) mounts.push({ host: join(repository, "packages", name), guest: `/opt/app/packages/${name}` });
  return { node, mounts, entry: "/opt/app/packages/pi-adapter/dist/worker/main.js", hostEntry: join(repository, "packages", "pi-adapter", "dist", "worker", "main.js") };
}

export interface AttemptWorkspace extends AttemptSandboxPlan { readonly limits?: ResourceLimits }

/** What a launch of the worker process came to, for the record (card H12k): the figures asked for, how each was applied, and whether the owner allowed best effort. Contains no secret. */
export interface LaunchEnforcement {
  readonly attemptId: string;
  /** The agent the attempt belongs to (so records can be kept per agent). */
  readonly agentId?: string;
  readonly outcome: "started" | "refused";
  /** The limits asked for at this launch (the workspace's and the owner's setting, the smaller of each figure). */
  readonly requested: ResourceLimits;
  /** True when the owner allowed a limit the host cannot enforce in full to go ahead. */
  readonly bestEffort: boolean;
  /** One entry per limit asked for; a limit that is not `full` is a limit the agent ran without (best effort) or the reason for the refusal. */
  readonly enforcement: readonly LimitEnforcement[];
  /** The wall-clock time the process may run, enforced by the launcher's time limit. */
  readonly wallTimeMs: number;
  /** Why the launch was refused (at most 500 characters). */
  readonly reason?: string;
  /** For a refusal because limits could not be enforced in full: which limits and how far each was enforced. */
  readonly failed?: readonly { readonly limit: string; readonly enforced: "partial" | "none"; readonly detail: string }[];
  /** Where the host's own start-up figure is stricter than the figure the owner set, the figure that was applied and why. */
  readonly stricter?: readonly { readonly limit: string; readonly owner: number; readonly applied: number; readonly why: string }[];
}

/** The smaller of each figure two limit sets name; a figure only one names is kept. */
export function strictestLimits(a: ResourceLimits | undefined, b: ResourceLimits | undefined): ResourceLimits | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out: Record<string, number> = {};
  for (const key of ["cpus", "memoryMb", "diskMb", "processes", "wallTimeMs"] as const) {
    const x = a[key]; const y = b[key];
    if (x !== undefined || y !== undefined) out[key] = Math.min(x ?? Number.MAX_SAFE_INTEGER, y ?? Number.MAX_SAFE_INTEGER);
  }
  return out;
}

/** The figures where `host` (the embedder's start-up figure carried by the workspace) is stricter than the `owner`'s. */
export function stricterThanOwner(host: ResourceLimits | undefined, owner: ResourceLimits | undefined): NonNullable<LaunchEnforcement["stricter"]> {
  const out: { limit: string; owner: number; applied: number; why: string }[] = [];
  if (host === undefined || owner === undefined) return out;
  for (const key of ["cpus", "memoryMb", "diskMb", "processes", "wallTimeMs"] as const) {
    const h = host[key]; const o = owner[key];
    if (h !== undefined && o !== undefined && h < o) out.push({ limit: key, owner: o, applied: h, why: `the host's own start-up figure (${h}) is stricter than the ${o} you set, so ${h} applies` });
  }
  return out;
}

/** What the controller hands a host builder to apply the owner's policy (structural: the worker package holds no controller type). */
export interface OwnerPolicyServices {
  readonly currentLimits: () => Promise<ResourceLimits | undefined>;
  readonly bestEffortAllowed: () => Promise<boolean>;
  readonly recordLaunch: (record: LaunchEnforcement) => Promise<void>;
  /** Card C07q: keeps a compaction the attempt's process made. Optional, so a builder written before it still type-checks. The order is the controller's own (it names the task), as for the other services the builder passes through. */
  readonly recordCompaction?: (order: never, note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }) => Promise<void>;
  /** Card U09b: keeps the model's thinking the attempt's process reported (untrusted text; the controller cleans, bounds and stores it for the owner). Optional, so a builder written before it still type-checks. */
  readonly recordThinking?: (order: never, blocks: readonly ThinkingReport[]) => Promise<void>;
}
/** The three options that connect a host to the owner's limits, best-effort setting and launch record, from the services the controller gave `build`. Spread into `localWorkerParts` options. */
export function ownerPolicyOptions(services: OwnerPolicyServices): Pick<LocalHostOptions<unknown>, "limits" | "bestEffort" | "onLaunch" | "onCompaction" | "onThinking"> {
  const record = services.recordCompaction;
  const thinking = services.recordThinking;
  return { limits: () => services.currentLimits(), bestEffort: () => services.bestEffortAllowed(), onLaunch: (r) => services.recordLaunch(r), ...(record === undefined ? {} : { onCompaction: (order: HostOrder, note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }) => record(order as never, note) }), ...(thinking === undefined ? {} : { onThinking: (order: HostOrder, blocks: readonly ThinkingReport[]) => thinking(order as never, blocks) }) };
}
/** What one named reach of the sandbox adds to the recipe: read-only inputs (under /inputs or /opt) and environment. Nothing else can be added by a name: not a writable path, not a network. */
export interface ReachGrant { readonly readOnly?: readonly ReadOnlyMount[]; readonly env?: Readonly<Record<string, string>> }
const REACH_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_REACH = 32;
/** Environment a named reach may not set: anything that changes how a program starts or loads code (interpreter and loader options, git configuration, shell start-up files, search paths). The workspace's own environment is never overridden by a reach. */
export const REACH_ENV_DENIED = /^(NODE_|NPM_|npm_|BASH_|ENV$|BASH|SHELL$|IFS$|CDPATH$|PS[0-9]$|PROMPT_COMMAND$|GIT_|PYTHON|RUBY|PERL|GEM_|BUNDLE_|LD_|DYLD_|JAVA_|_JAVA_|JDK_|CLASSPATH$|GOFLAGS$|GOPATH$|GOROOT$|CARGO_|RUSTC|RUSTFLAGS$|PATH$|HOME$|USER$|LOGNAME$|TMPDIR$|TEMP$|TMP$|XDG_|LANG$|LC_|PWD$|OLDPWD$|SSH_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|all_proxy$|no_proxy$)/i;

export interface LocalHostOptions<Call> {
  readonly launcher: Pick<SandboxLauncher, "launch">;
  readonly app: WorkerApp;
  /** Paths the launcher must keep out of any mount besides its own list (the controller's data and the git directories); used for the checks made before a launch. */
  readonly protectedPaths: readonly string[];
  /** The attempt's checkout, git directory, home and scratch (card A04's workspace). */
  readonly workspace: (order: HostOrder) => Promise<AttemptWorkspace> | AttemptWorkspace;
  /**
   * What a named reach of a recipe stands for on this machine (card H12b): the dispatcher's recipe names the tools and servers the sandbox lets the agent reach, the host knows which read-only inputs and which environment that means. A name it does not know
   * refuses the launch (fail closed: a recipe is never applied in part). Narrowing a recipe drops names and widening adds them; the sandbox is started again with the result, so the mounts change for real.
   */
  readonly reach?: (name: string, order: HostOrder) => Promise<ReachGrant | undefined> | ReachGrant | undefined;
  /** The model the attempt uses, as the process addresses it. */
  readonly model: (order: HostOrder) => Promise<ChannelModel> | ChannelModel;
  /** The id part of the agent's own tool namespace. */
  readonly namespaceId: (order: HostOrder) => string;
  /** Answers one bridge request of the attempt: the controller's execution service, bound to the attempt's gateway (`call`). */
  readonly bridge: (order: HostOrder, call: Call, token: string, request: { readonly op: string; readonly callId: string; readonly args?: { readonly [key: string]: unknown } }) => Promise<BridgeReplyMessage>;
  /** Makes the model call of the attempt: the relay (the controller's, with the route's endpoint, the provider's credential and the cache policy). It refuses by throwing. */
  readonly relay: (order: HostOrder, request: RelayRequest) => Promise<RelayResponse>;
  /** The cache key and retention for the attempt's route, and the figures since the last look (reported with each turn). */
  readonly cache?: (order: HostOrder) => Promise<{ readonly key?: string; readonly retention?: "none" | "short" | "long"; takeUsage?(): Promise<CacheFigures | undefined> }> | { readonly key?: string; readonly retention?: "none" | "short" | "long"; takeUsage?(): Promise<CacheFigures | undefined> };
  /** The context limits for the process (card C07b): stream timeout and retries, tool output limits, and how a compaction is done when the model has no room (with the owner's decisions it keeps, card C07q). Read once per process start. */
  readonly context?: (order: HostOrder) => ChannelContext | undefined | Promise<ChannelContext | undefined>;
  /** What to put before the agent after the owner's decisions changed. */
  readonly refreshText?: (order: HostOrder) => Promise<string> | string;
  /** Whether a limit the host cannot enforce in full refuses the launch (default true, as for scripts). Used when `bestEffort` is not given. */
  readonly requireEnforced?: boolean;
  /**
   * The owner's limits for an agent launched now (card H12k), read at each launch of the process and combined with `workspace(...).limits` by taking the smaller figure. It may throw (the setting is unreadable): the launch is then refused,
   * never made without limits.
   */
  readonly limits?: (order: HostOrder) => Promise<ResourceLimits | undefined> | ResourceLimits | undefined;
  /** Whether the owner allowed best effort: true lets a limit this OS cannot enforce in full go ahead (and be recorded as such); false or absent refuses it. Read at each launch; a throw refuses the launch. */
  readonly bestEffort?: (order: HostOrder) => Promise<boolean> | boolean;
  /** Told what each launch came to, started or refused, before the launch is used. If it throws, a started process is ended and the launch refused: nothing runs unrecorded. */
  readonly onLaunch?: (record: LaunchEnforcement) => Promise<void> | void;
  /** Told when an attempt's process compacted its own conversation (card C07q): how much and the summary's digest. A failure is dropped; it never changes the attempt. */
  readonly onCompaction?: (order: HostOrder, note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }) => Promise<void> | void;
  /** Told when an attempt's process reported the model's thinking (card U09b): untrusted text. A failure is dropped; it never changes the attempt. */
  readonly onThinking?: (order: HostOrder, blocks: readonly ThinkingReport[]) => Promise<void> | void;
  /**
   * How the sandbox shows what it mounts. `private` (default; bubblewrap): its own view, so the program is at `/opt/node/...` and the conversation store at `/home/agent/pi`. `host` (Seatbelt on macOS, which confines by what a process may touch and has no private filesystem
   * view): every path is the host's own, so the program, its entry file and the store are given by their host paths. The mounts are still checked and still the only things the profile lets the process read.
   */
  readonly guestPaths?: "private" | "host";
  /**
   * Whether the controller's review says work an earlier process of this attempt left unfinished still awaits review (the ledger holds an unsettled call). Pi holds such work until it is reviewed; the host asks the process to recover (abandon nothing, release the hold) only
   * when this answers false. Absent, or throwing: not reviewed, so the hold stays in force and the turn is refused by it (fails closed).
   */
  readonly heldForReview?: (order: HostOrder) => Promise<boolean> | boolean;
  /** Told when the host left the hold on interrupted work in force because it is not reviewed (so the owner can be told); a throw is ignored. */
  readonly onHeld?: (order: HostOrder, why: string) => void;
  /** How long a process that lost its lease may take to wind down before it is ended (card H08b), in ms. Default 10,000. Used only when the controller hands the runtime a lease. */
  readonly leaseGraceMs?: number;
  /** The address the process uses for model calls (default `http://relay.invalid`). */
  readonly relayBase?: string;
  readonly clock?: () => number;
  /** Where a contract check (card W05) gets its own empty home and scratch for the run, removed afterwards (an absolute directory this host owns; default the system's temporary directory). */
  readonly checkBase?: string;
}

/** One check command as the controller asks it to be run (card W05): the program and its arguments as the sandbox sees them, its time and the cap on each stream. */
export interface HostCheck { readonly run: readonly string[]; readonly timeoutMs: number; readonly maxOutputBytes: number }
/** How it ended. `not-run`: it could not be started (no sandbox open for the attempt, a launch refused, a program that does not start); `output` is the end of what it wrote, standard output then standard error. */
export interface HostCheckResult { readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly signal?: string | null; readonly timedOut?: boolean; readonly output?: string; readonly reason?: string; readonly ms?: number }
/** How much of a check's output is handed back (its end). */
export const CHECK_OUTPUT_CHARS = 8000;

/** Pi's own system prompt is not visible to the process; until it is measured the first call is counted with this many characters for it, so the check errs on the side of refusing. */
const UNKNOWN_SYSTEM_PROMPT_CHARS = 8000;
const RELAY_BASE = "http://relay.invalid";
const DEFAULT_REFRESH = "The owner's decisions changed. Read the decisions that apply to this task again before you act on anything you had planned.";
const MAX_RUN_MS = 24 * 60 * 60 * 1000;
const LEASE_GRACE_MS = 10_000;

interface Reserved {
  readonly order: HostOrder; readonly workspace: AttemptWorkspace; readonly recipe: ReturnType<typeof attemptSandbox>["recipe"]; readonly limits: ResourceLimits | undefined; process?: WorkerProcess; closed: boolean;
  /** Every worker process launched in this sandbox (a restart of the runtime launches another), for Stop (card L02d). Bounded: past 16, the oldest ended one goes, its winding-down time kept in `foldedMs`. */
  readonly launched: WorkerProcess[];
  foldedMs: number;
  /** Contract checks running in this sandbox now (card W05): ended with it. */
  readonly checkRuns: Set<{ kill(): void }>;
}

/** What a sandbox still holds (card L02d), from its worker processes' run trees: see `HostSandboxSession.work`. */
async function heldBy(launched: readonly WorkerProcess[], foldedMs: number): Promise<{ processes: HostHeldProcess[]; computeMs?: number }> {
  const items: HostHeldProcess[] = [];
  let computeMs = foldedMs;
  // The name is the program's own (it can rename itself): printable ASCII, and quoted so that no name can pass for more of the line (another process, a state, a cut marker) where it is shown (review of L02d).
  const named = (p: RunProcess): string => `pid ${p.pid} ${JSON.stringify(p.name)}`;
  for (const p of launched) {
    const spent = p.windDownMs();
    computeMs += spent;
    // Asked to end and not gone after the grace a close gives it: it did not obey, and was (or is being) killed. Within the grace it is simply still ending.
    const ignored = p.endAsked && spent > PROCESS_LIMITS.closeGraceMs;
    const listed = await p.processes();
    if (listed === undefined) {
      // This system cannot list a run's processes: the worker process itself is known, what it started is not (nothing is claimed about it).
      if (p.alive && p.endAsked) items.push({ ref: "worker process (asked to end)", kind: "process", state: ignored ? "uncooperative" : "running" });
      continue;
    }
    // The run has ended: whatever is still listed outlived it.
    if (!p.alive) { for (const x of listed.processes) items.push({ ref: named(x), kind: "process", state: "uncooperative" }); continue; }
    const tree = splitRunTree(listed.processes);
    // The worker process (and the confinement above it) is the attempt itself while it runs: it is quiesced and checkpointed through the attempt, not waited for as a process. Once it was asked to end it is listed until it has gone.
    const head = tree.program ?? tree.own[0];
    if (p.endAsked && head !== undefined) items.push({ ref: `worker process ${named(head)}`, kind: "process", state: ignored ? "uncooperative" : "running" });
    for (const x of tree.started) items.push({ ref: named(x), kind: "process", state: ignored ? "uncooperative" : "running" });
    if (listed.truncated) items.push({ ref: "processes:truncated", kind: "process", state: "unknown" });
  }
  return { processes: items.slice(0, MAX_RUN_PROCESSES), ...(computeMs > 0 ? { computeMs } : {}) };
}

export function localWorkerParts<Call>(options: LocalHostOptions<Call>): {
  readonly sandbox: { open(recipe: HostOrder["recipe"], order: HostOrder): Promise<HostSandboxSession> };
  readonly runtimes: { open(order: HostOrder, call: Call, from: JsonObj | undefined, lease?: HostLease): Promise<HostRuntime> };
  /** True when the owner's limits, best-effort setting and launch record are all connected (`limits`, `bestEffort`, `onLaunch` given); pass it to the `LocalWorker` so the controller can tell. */
  readonly ownerPolicy: boolean;
  /**
   * Runs a contract check of an attempt (card W05) in a sandbox of its own made from the attempt's: the same checkout as working directory, the same read-only inputs, environment, network (none) and limits (the owner's too), but an empty home
   * and scratch of its own, so the check cannot touch the agent's conversation. The run is ended at its time (or the owner's wall time, if smaller), each stream is cut at its cap, and nothing of it reaches the agent.
   */
  readonly checks: { run(attemptId: string, check: HostCheck): Promise<HostCheckResult> };
} {
  const reserved = new Map<string, Reserved>();
  const hostPaths = options.guestPaths === "host";
  if (hostPaths && options.app.hostEntry === undefined) throw new Error("a launcher that shows host paths needs the worker app's host entry file (appFromRepository gives it)");
  const clock = options.clock ?? Date.now;

  /** The mounts and environment the recipe's named reaches stand for. Every name must be known to this host; a name twice, a bad name or too many are refused. */
  const reachOf = async (summary: HostOrder["recipe"], order: HostOrder): Promise<{ readonly readOnly: readonly ReadOnlyMount[]; readonly env?: Record<string, string> }> => {
    const names = summary.reach;
    if (!Array.isArray(names) || names.length > MAX_REACH || names.some((n) => typeof n !== "string" || !REACH_NAME.test(n)) || new Set(names).size !== names.length) throw new Error(`the recipe's reach must be at most ${MAX_REACH} distinct names of letters, digits and . _ : -`);
    const readOnly: ReadOnlyMount[] = [];
    const env: Record<string, string> = {};
    for (const name of names) {
      const granted = await options.reach?.(name, order);
      if (granted === undefined) throw new Error(`this host cannot provide the reach "${name}" of the recipe; the sandbox is not started with part of a recipe`);
      readOnly.push(...(granted.readOnly ?? []));
      for (const [key, value] of Object.entries(granted.env ?? {})) {
        if (REACH_ENV_DENIED.test(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`the reach "${name}" sets ${key}, which a reach may not set (it changes how programs start or where they look)`);
        if (Object.hasOwn(env, key) && env[key] !== value) throw new Error(`the reaches of the recipe set ${key} to different values`);
        env[key] = value;
      }
    }
    return { readOnly, ...(Object.keys(env).length === 0 ? {} : { env }) };
  };

  const sandbox = {
    async open(summary: HostOrder["recipe"], order: HostOrder): Promise<HostSandboxSession> {
      const workspace = await options.workspace(order);
      const reach = await reachOf(summary, order);
      const planned = attemptSandbox({ ...workspace, ...(reach.env === undefined ? {} : { env: { ...reach.env, ...workspace.env } }) }, { protectedPaths: options.protectedPaths });
      const recipe = { ...planned.recipe, readOnly: [...(planned.recipe.readOnly ?? []), { host: options.app.node.root, guest: "/opt/node" }, ...options.app.mounts, ...reach.readOnly] };
      // Checked against the host now, so a bad workspace refuses the attempt before any process starts; the launcher checks again at the launch.
      const normalized = normalizeRecipe(recipe, planned.protectedPaths);
      // The recipe's own limits, when it states some, are the sandbox's limits (narrower or wider than the host's default); otherwise the workspace's.
      const entry: Reserved = { order, workspace, recipe, limits: summary.limits ?? workspace.limits, closed: false, launched: [], foldedMs: 0, checkRuns: new Set() };
      reserved.set(order.attemptId, entry);
      return {
        revision: normalized.revision,
        close: async () => {
          entry.closed = true;
          if (reserved.get(order.attemptId) === entry) reserved.delete(order.attemptId);
          for (const r of entry.checkRuns) r.kill();
          // A process the OS could not end is not taken as gone (card L02d): the close says so, and the sandbox keeps listing it.
          await entry.process?.close().catch((error: unknown) => { if (error instanceof ProcessNotEnded) throw error; });
        },
        work: () => heldBy(entry.launched, entry.foldedMs),
        end: async () => { for (const r of entry.checkRuns) r.kill(); await Promise.all(entry.launched.map((p) => p.forceEnd())); },
      };
    },
  };

  const runtimes = {
    async open(order: HostOrder, call: Call, from: JsonObj | undefined, lease?: HostLease): Promise<HostRuntime> {
      const entry = reserved.get(order.attemptId);
      if (entry === undefined || entry.closed) throw new Error("the attempt has no sandbox open");
      const model = await options.model(order);
      const cache = await options.cache?.(order);
      const nn = from?.["nn"] as JsonObj | undefined;
      let turnSeq = typeof nn?.["turnSeq"] === "number" ? (nn["turnSeq"] as number) : 0;
      let lastRequest = typeof nn?.["lastRequest"] === "string" ? (nn["lastRequest"] as string) : undefined;
      // The conversation is kept in the agent's home on this host. A checkpoint to continue from with no such store (another host, a wiped home) would silently start from nothing: refused instead.
      if ((from?.["pi"] !== undefined || nn?.["midTurn"] === true) && !existsSync(join(entry.workspace.home, "pi"))) throw new Error("the attempt resumes from a checkpoint but this host no longer holds the conversation");
      // Work an earlier process of this attempt left unfinished (this host restarted the sandbox, or the attempt resumes from a checkpoint) was reviewed by the controller before it asked: the conversation goes on from it.
      const goesOn = entry.process !== undefined || from !== undefined;
      // Pi holds unfinished work until it is reviewed. The host asks the process to release that hold only when the controller's review says nothing is waiting; otherwise the hold stays and is reported.
      const recovery = goesOn ? await recoveryFor(options, order, entry.process !== undefined) : undefined;
      await entry.process?.close().catch(() => undefined);
      const remaining = Math.min(MAX_RUN_MS, order.expiresAt === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1000, Date.parse(order.expiresAt) - clock()));
      // Everything the owner's policy needs is read inside the guard: a setting that cannot be read refuses the launch AND is recorded as refused, with the reason (never an unrecorded throw).
      let requested: ResourceLimits = {};
      let bestEffort = false;
      let stricter: NonNullable<LaunchEnforcement["stricter"]> = [];
      let wallTimeMs = remaining;
      let process: WorkerProcess;
      try {
        const ownerLimits = await options.limits?.(order);
        requested = strictestLimits(strictestLimits(entry.limits, ownerLimits), contractLimitsOf(order)) ?? {};
        stricter = stricterThanOwner(entry.limits, ownerLimits);
        bestEffort = options.bestEffort === undefined ? options.requireEnforced === false : (await options.bestEffort(order)) === true;
        if (requested.wallTimeMs !== undefined) wallTimeMs = Math.min(remaining, requested.wallTimeMs);
        const { wallTimeMs: _wall, ...processLimits } = requested;
        process = await WorkerProcess.launch(options.launcher, {
          recipe: entry.recipe,
          command: hostPaths ? [join(options.app.node.root, options.app.node.executable), options.app.hostEntry!] : [`/opt/node/${options.app.node.executable}`, options.app.entry],
          timeoutMs: wallTimeMs,
          // Standard error is kept (bounded) for the failure message; standard output is the channel.
          maxOutputBytes: 64 * 1024,
          ...(Object.keys(processLimits).length === 0 ? {} : { limits: processLimits }),
          requireEnforced: !bestEffort,
        }, {
          bridge: (token, request) => options.bridge(order, call, token, request),
          relay: (request) => options.relay(order, request),
          ...(options.onCompaction === undefined ? {} : { compacted: (note) => options.onCompaction!(order, note) }),
          ...(options.onThinking === undefined ? {} : { thinking: (blocks) => options.onThinking!(order, blocks) }),
          ...(lease === undefined ? {} : {
            renew: async () => {
              try { return { leaseMs: (await lease.renew()).leaseMs }; } catch (error) {
                if ((error as { code?: unknown } | undefined)?.code === "fenced") return { fenced: String((error as Error).message ?? "the attempt is fenced").slice(0, 500) };
                throw error;
              }
            },
          }),
        });
        // Remembered as soon as it exists (card L02d), so a Stop finds it even if what follows fails. Past 16, the oldest process that has ended goes and its winding-down time is kept in `foldedMs` (the total never goes down).
        entry.launched.push(process);
        const gone = entry.launched.length > 16 ? entry.launched.findIndex((p) => !p.alive) : -1;
        if (gone >= 0) entry.foldedMs += entry.launched.splice(gone, 1)[0]!.windDownMs();
      } catch (error) {
        const failed = (error as { limitFailures?: NonNullable<LaunchEnforcement["failed"]> }).limitFailures;
        try { await options.onLaunch?.({ attemptId: order.attemptId, agentId: order.agentId, outcome: "refused", requested, bestEffort, enforcement: [], wallTimeMs, reason: String((error as Error)?.message ?? error).slice(0, 500), ...(failed === undefined ? {} : { failed }), ...(stricter.length === 0 ? {} : { stricter }) }); } catch { /* the refusal itself is what is reported */ }
        throw error;
      }
      try {
        const wall = requested.wallTimeMs === undefined ? [] : [{ limit: "wallTimeMs" as const, value: requested.wallTimeMs, enforced: "full" as const, by: "launcher time limit", detail: "the process is ended when the time is up" }];
        await options.onLaunch?.({ attemptId: order.attemptId, agentId: order.agentId, outcome: "started", requested, bestEffort, enforcement: [...process.enforcement, ...wall], wallTimeMs, ...(stricter.length === 0 ? {} : { stricter }) });
      } catch (error) {
        await process.close().catch(() => undefined);
        throw error;
      }
      entry.process = process;
      try {
        const channelContext = withOrderAnchor(await options.context?.(order), order);
        await process.start({
          attemptId: order.attemptId, agentId: order.agentId, namespaceId: options.namespaceId(order), credential: order.credential,
          storeDir: hostPaths ? join(entry.workspace.home, "pi") : `${GUEST.home}/pi`, model, ...(recovery === undefined ? {} : { recover: recovery }), relayBase: options.relayBase ?? RELAY_BASE,
          // The lease goes as the duration the controller meant (card H08b): the process counts it on its own monotonic clock, so a wrong clock in or beside the sandbox changes nothing.
          ...(lease === undefined ? {} : { lease: { leaseMs: Math.max(1000, Math.min(3_600_000, Math.floor(lease.leaseMs))), graceMs: options.leaseGraceMs ?? LEASE_GRACE_MS } }),
          ...(channelContext === undefined ? {} : { context: channelContext }),
          ...(cache === undefined || (cache.key === undefined && cache.retention === undefined) ? {} : { cache: { ...(cache.key === undefined ? {} : { key: cache.key }), ...(cache.retention === undefined ? {} : { retention: cache.retention }) } }),
        }, PROCESS_LIMITS.readyMs);
      } catch (error) {
        await process.close().catch(() => undefined);
        throw error;
      }
      let contextTokens: number | undefined = typeof nn?.["contextTokens"] === "number" ? (nn["contextTokens"] as number) : undefined;
      // A checkpoint that did not say how big the conversation is (taken in the middle of a turn) is not an empty one: the stored conversation's own size is the estimate (it counts what the model no longer sees too, so it errs towards refusing and compacting).
      if (contextTokens === undefined) { const stored = estimateStoredTokens(join(entry.workspace.home, "pi")); if (stored !== undefined) contextTokens = stored; }
      // `nn.durable` (card L04d) is the process's read-back check of the checkpoint, as it said it: the controller captures a continuation from this checkpoint as complete only when it passed.
      const wrapCheckpoint = (taken: { readonly checkpoint: JsonObj; readonly contextTokens?: number; readonly durable?: { readonly verified: boolean; readonly error?: string } }): JsonObj => {
        if (taken.contextTokens !== undefined) contextTokens = taken.contextTokens;
        return { pi: taken.checkpoint, nn: { turnSeq, ...(lastRequest === undefined ? {} : { lastRequest }), ...(contextTokens === undefined ? {} : { contextTokens }), ...(taken.durable === undefined ? {} : { durable: { ...taken.durable } }) } };
      };
      return {
        firstCall: (content) => ({ systemPromptChars: process.info.systemPromptChars ?? UNKNOWN_SYSTEM_PROMPT_CHARS, toolSchemaChars: process.info.toolSchemaChars ?? 0, startupTokens: Math.ceil(content.length / 3) + (contextTokens ?? 0), replyReserveTokens: model.maxTokens }),
        async run(content, requestId) {
          let result;
          try { result = await process.run(requestId, content); } catch (error) {
            const failed = { status: "failed" as const, error: String((error as Error)?.message ?? error).slice(0, 2000), endKind: "unknown" as const };
            // The model calls a turn made before its process ended were real work: their cache figures are reported with the failure (card H12e), under a number of their own, or they would be lost with the attempt.
            // That holds for a process this host closed on purpose too (a stop, a restart for a recipe change): a restart that fails ends the attempt with this result, so figures left in the attempt's cache would never be taken.
            // After a restart that succeeds the local worker adds them to the continued turn's figures (the same number: the continued turn starts from the checkpoint's), and the cache hands each figure out once, so nothing is counted twice.
            const figures = await cache?.takeUsage?.().catch(() => undefined);
            if (figures === undefined) return failed;
            turnSeq += 1;
            return { ...failed, usage: { turnSeq, cache: figures } };
          }
          // The same request again (a replay after a restart, answered from the store) is the same turn: it keeps its number, so its usage is charged once.
          if (requestId !== lastRequest) { turnSeq += 1; lastRequest = requestId; }
          const figures = await cache?.takeUsage?.().catch(() => undefined);
          let checkpoint: JsonObj | undefined;
          try { checkpoint = wrapCheckpoint(await process.checkpoint()); } catch { checkpoint = undefined; }
          // Only a completed turn has an ending to classify; a worker that says nothing (one from before W02) is read as unknown, never as normal.
          const endKind = result.status === "completed" ? endKindOf(result.endKind) : "unknown";
          return { status: result.status, ...(result.text === undefined ? {} : { text: result.text }), ...(result.error === undefined ? {} : { error: result.error }), ...(checkpoint === undefined ? {} : { checkpoint }), usage: { turnSeq, ...(figures === undefined ? {} : { cache: figures }) }, endKind, ...(result.status === "completed" && result.visibleChars !== undefined ? { visibleChars: result.visibleChars } : {}), ...(result.nudges === undefined ? {} : { nudges: result.nudges }) };
        },
        async checkpoint() {
          try { return wrapCheckpoint(await process.checkpoint()); } catch (error) {
            // A turn that has not finished yet has no completed turn to checkpoint (the first turn of an attempt, a recipe change in the middle of it). The conversation is in the agent's home on this host; the restart continues it from there and the record says there was no checkpoint to restore.
            if (/has no completed turn/.test(String((error as Error)?.message ?? error))) return { nn: { turnSeq, ...(lastRequest === undefined ? {} : { lastRequest }), ...(contextTokens === undefined ? {} : { contextTokens }), midTurn: true } };
            throw error;
          }
        },
        tell: (text) => process.tell(text),
        activeModelCalls: () => process.modelCallsInFlight,
        // Over the context budget at the first call: the process compacts its stored conversation once and the controller asks again (card H12f).
        async compact() {
          // Nothing stored, nothing to make smaller. An unknown size with a stored conversation is compacted (the process tells the new size).
          if (contextTokens === undefined ? from?.["pi"] === undefined && turnSeq === 0 : contextTokens === 0) return;
          const compacted = await process.compact();
          // The size of what is stored now is what the next admission counts.
          contextTokens = compacted.contextTokens ?? (await process.checkpoint().then((c) => c.contextTokens, () => undefined)) ?? contextTokens;
        },
        async refreshContext() { await process.tell(await options.refreshText?.(order) ?? DEFAULT_REFRESH); },
        async close() { await process.close(); },
      };
    },
  };

  const checks = {
    async run(attemptId: string, check: HostCheck): Promise<HostCheckResult> {
      const entry = reserved.get(attemptId);
      if (entry === undefined || entry.closed) return { state: "not-run", reason: "the attempt has no sandbox open on this host" };
      if (!Array.isArray(check.run) || check.run.length === 0 || check.run.some((a) => typeof a !== "string" || a.includes("\0"))) return { state: "not-run", reason: "the check names no program" };
      let requested: ResourceLimits;
      let bestEffort: boolean;
      try {
        requested = strictestLimits(strictestLimits(entry.limits, await options.limits?.(entry.order)), contractLimitsOf(entry.order)) ?? {};
        bestEffort = options.bestEffort === undefined ? options.requireEnforced === false : (await options.bestEffort(entry.order)) === true;
      } catch (error) { return { state: "not-run", reason: `the owner's limits could not be read: ${String((error as Error)?.message ?? error).slice(0, 200)}` }; }
      const { wallTimeMs, ...processLimits } = requested;
      const timeoutMs = Math.max(1, Math.min(MAX_RUN_MS, check.timeoutMs, wallTimeMs ?? MAX_RUN_MS));
      const directory = realpathSync(mkdtempSync(join(options.checkBase ?? tmpdir(), "nn-check-")));
      try {
        const home = join(directory, "home"), scratch = join(directory, "scratch");
        mkdirSync(home); mkdirSync(scratch);
        let run;
        try {
          run = await options.launcher.launch({ recipe: { ...entry.recipe, home, scratch }, command: [...check.run], timeoutMs, maxOutputBytes: Math.max(1, Math.min(64 * 1024 * 1024, check.maxOutputBytes)), ...(Object.keys(processLimits).length === 0 ? {} : { limits: processLimits }), requireEnforced: !bestEffort });
        } catch (error) { return { state: "not-run", reason: `the sandbox refused the check: ${String((error as Error)?.message ?? error).slice(0, 300)}` }; }
        entry.checkRuns.add(run);
        // A sandbox closed while the launch was being made: the check is ended at once.
        if (entry.closed) run.kill();
        let result;
        try { result = await run.result; } finally { entry.checkRuns.delete(run); }
        const both = `${result.stdout}${result.stdout !== "" && result.stderr !== "" && !result.stdout.endsWith("\n") ? "\n" : ""}${result.stderr}`;
        const output = both.length > CHECK_OUTPUT_CHARS ? both.slice(both.length - CHECK_OUTPUT_CHARS) : both;
        const shown = { exitCode: result.exitCode, signal: result.signal, ms: result.durationMs, ...(output === "" ? {} : { output }) };
        if (result.releaseProblem !== undefined) return { state: "not-run", reason: `the sandbox could not be cleaned up after the check: ${result.releaseProblem.slice(0, 300)}`, ...shown };
        if (result.exitCode === null && result.signal === null && !result.timedOut && !result.killed) return { state: "not-run", reason: `the check could not be started: ${result.stderr.replace(/^could not start: /, "").trim().slice(0, 300)}`, ms: result.durationMs };
        if (result.timedOut) return { state: "failed", timedOut: true, ...shown };
        return { state: result.exitCode === 0 && !result.killed ? "passed" : "failed", ...shown };
      } finally { await removeTree(directory, undefined); }
    },
  };

  return { sandbox, runtimes, checks, ownerPolicy: options.limits !== undefined && options.bestEffort !== undefined && options.onLaunch !== undefined };
}

/**
 * The host side of the check of a done (card W05), for a `LocalWorker`'s `verify` option: the checkout's state from the worker package's checkout layout (`LocalWorkspaces.doneState`) and each contract check run, one after another, in the attempt's
 * sandbox (`localWorkerParts(...).checks`). A check that throws is reported `not-run` with the reason; the controller never takes it as passed.
 */
export function doneVerifier(parts: {
  readonly workspaces: { doneState(scope: { readonly taskId: string; readonly projectId: string }, paths: readonly string[]): Promise<{ uncommitted: readonly string[]; uncommittedCount: number; ahead: number; changed: number; agentCommits?: boolean; evidence: readonly { path: string; present: boolean; why?: string }[] } | undefined> };
  readonly checks: { run(attemptId: string, check: HostCheck): Promise<HostCheckResult> };
}): (attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: { readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutMs: number }[]; readonly evidence: readonly string[]; readonly maxOutputBytes: number }) => Promise<{ checkout: boolean; tree?: { uncommitted: readonly string[]; uncommittedCount: number; ahead: number; changed: number; agentCommits?: boolean }; evidence?: readonly { path: string; present: boolean; why?: string }[]; checks: ({ name: string } & HostCheckResult)[] }> {
  return async (attemptId, scope, request) => {
    const state = await parts.workspaces.doneState(scope, request.evidence);
    const ran: ({ name: string } & HostCheckResult)[] = [];
    for (const c of request.checks) {
      try { ran.push({ name: c.name, ...(await parts.checks.run(attemptId, { run: c.run, timeoutMs: c.timeoutMs, maxOutputBytes: request.maxOutputBytes })) }); }
      catch (error) { ran.push({ name: c.name, state: "not-run", reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
    }
    if (state === undefined) return { checkout: false, checks: ran };
    return { checkout: true, tree: { uncommitted: state.uncommitted, uncommittedCount: state.uncommittedCount, ahead: state.ahead, changed: state.changed, ...(state.agentCommits === undefined ? {} : { agentCommits: state.agentCommits }) }, evidence: state.evidence, checks: ran };
  };
}
