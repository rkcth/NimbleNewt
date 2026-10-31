import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeReplyMessage, ChannelContext, ChannelModel, JsonValue } from "@nimblenewt/contracts";
import { attemptSandbox, type AttemptSandboxPlan } from "../sandbox/attempt.js";
import type { SandboxLauncher } from "../sandbox/launcher.js";
import type { LimitEnforcement, ResourceLimits } from "../sandbox/limits.js";
import { GUEST, normalizeRecipe, type ReadOnlyMount } from "../sandbox/recipe.js";
import { PROCESS_LIMITS, WorkerProcess, type RelayRequest, type RelayResponse } from "./process.js";

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
}

export interface HostTurnResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly text?: string;
  readonly error?: string;
  readonly checkpoint?: JsonObj;
  readonly usage?: { readonly turnSeq?: number; readonly cache?: CacheFigures };
}
export interface CacheFigures { readonly backend: string; readonly route: string; readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number }

/** What the first call of an attempt carries, as far as the host can tell (the controller's `FirstCall`, restated): the process says how big its tools are; the prompt is counted at three characters to a token. */
export interface HostFirstCall { readonly systemPromptChars: number; readonly toolSchemaChars: number; readonly startupTokens: number; readonly replyReserveTokens: number }

/** The size of the conversation stored in a checkpoint of this host, in tokens, when it says (the resume decision of card C07b asks for it before a runtime is opened). */
export function storedTokensOf(from: JsonObj | undefined): number | undefined {
  const tokens = (from?.["nn"] as JsonObj | undefined)?.["contextTokens"];
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
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
export interface HostSandboxSession { readonly revision: string; close(): Promise<void> }

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
}
/** The three options that connect a host to the owner's limits, best-effort setting and launch record, from the services the controller gave `build`. Spread into `localWorkerParts` options. */
export function ownerPolicyOptions(services: OwnerPolicyServices): Pick<LocalHostOptions<unknown>, "limits" | "bestEffort" | "onLaunch"> {
  return { limits: () => services.currentLimits(), bestEffort: () => services.bestEffortAllowed(), onLaunch: (record) => services.recordLaunch(record) };
}
/** What one named reach of the sandbox adds to the recipe: read-only inputs (under /inputs or /opt) and environment. Nothing else can be added by a name: not a writable path, not a network. */
export interface ReachGrant { readonly readOnly?: readonly ReadOnlyMount[]; readonly env?: Readonly<Record<string, string>> }
const REACH_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_REACH = 32;

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
  /** The context limits for the process (card C07b): stream timeout and retries, tool output limits, and how a compaction is done when the model has no room. */
  readonly context?: (order: HostOrder) => ChannelContext | undefined;
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
  /**
   * How the sandbox shows what it mounts. `private` (default; bubblewrap): its own view, so the program is at `/opt/node/...` and the conversation store at `/home/agent/pi`. `host` (Seatbelt on macOS, which confines by what a process may touch and has no private filesystem
   * view): every path is the host's own, so the program, its entry file and the store are given by their host paths. The mounts are still checked and still the only things the profile lets the process read.
   */
  readonly guestPaths?: "private" | "host";
  /** The address the process uses for model calls (default `http://relay.invalid`). */
  readonly relayBase?: string;
  readonly clock?: () => number;
}

/** Pi's own system prompt is not visible to the process; until it is measured the first call is counted with this many characters for it, so the check errs on the side of refusing. */
const UNKNOWN_SYSTEM_PROMPT_CHARS = 8000;
const RELAY_BASE = "http://relay.invalid";
const DEFAULT_REFRESH = "The owner's decisions changed. Read the decisions that apply to this task again before you act on anything you had planned.";
const MAX_RUN_MS = 24 * 60 * 60 * 1000;

interface Reserved { readonly order: HostOrder; readonly workspace: AttemptWorkspace; readonly recipe: ReturnType<typeof attemptSandbox>["recipe"]; readonly limits: ResourceLimits | undefined; process?: WorkerProcess; closed: boolean }

export function localWorkerParts<Call>(options: LocalHostOptions<Call>): {
  readonly sandbox: { open(recipe: HostOrder["recipe"], order: HostOrder): Promise<HostSandboxSession> };
  readonly runtimes: { open(order: HostOrder, call: Call, from: JsonObj | undefined): Promise<HostRuntime> };
  /** True when the owner's limits, best-effort setting and launch record are all connected (`limits`, `bestEffort`, `onLaunch` given); pass it to the `LocalWorker` so the controller can tell. */
  readonly ownerPolicy: boolean;
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
      const planned = attemptSandbox({ ...workspace, ...(reach.env === undefined ? {} : { env: { ...workspace.env, ...reach.env } }) }, { protectedPaths: options.protectedPaths });
      const recipe = { ...planned.recipe, readOnly: [...(planned.recipe.readOnly ?? []), { host: options.app.node.root, guest: "/opt/node" }, ...options.app.mounts, ...reach.readOnly] };
      // Checked against the host now, so a bad workspace refuses the attempt before any process starts; the launcher checks again at the launch.
      const normalized = normalizeRecipe(recipe, planned.protectedPaths);
      // The recipe's own limits, when it states some, are the sandbox's limits (narrower or wider than the host's default); otherwise the workspace's.
      const entry: Reserved = { order, workspace, recipe, limits: summary.limits ?? workspace.limits, closed: false };
      reserved.set(order.attemptId, entry);
      return {
        revision: normalized.revision,
        close: async () => {
          entry.closed = true;
          if (reserved.get(order.attemptId) === entry) reserved.delete(order.attemptId);
          await entry.process?.close().catch(() => undefined);
        },
      };
    },
  };

  const runtimes = {
    async open(order: HostOrder, call: Call, from: JsonObj | undefined): Promise<HostRuntime> {
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
        requested = strictestLimits(entry.limits, ownerLimits) ?? {};
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
        });
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
        await process.start({
          attemptId: order.attemptId, agentId: order.agentId, namespaceId: options.namespaceId(order), credential: order.credential,
          storeDir: hostPaths ? join(entry.workspace.home, "pi") : `${GUEST.home}/pi`, model, ...(goesOn ? { recover: { reason: entry.process !== undefined ? "the controller restarted the sandbox of this attempt" : "the controller resumed this attempt from a checkpoint" } } : {}), relayBase: options.relayBase ?? RELAY_BASE,
          ...(options.context?.(order) === undefined ? {} : { context: options.context(order)! }),
          ...(cache === undefined || (cache.key === undefined && cache.retention === undefined) ? {} : { cache: { ...(cache.key === undefined ? {} : { key: cache.key }), ...(cache.retention === undefined ? {} : { retention: cache.retention }) } }),
        }, PROCESS_LIMITS.readyMs);
      } catch (error) {
        await process.close().catch(() => undefined);
        throw error;
      }
      let contextTokens: number | undefined = typeof nn?.["contextTokens"] === "number" ? (nn["contextTokens"] as number) : undefined;
      const wrapCheckpoint = (taken: { readonly checkpoint: JsonObj; readonly contextTokens?: number }): JsonObj => {
        if (taken.contextTokens !== undefined) contextTokens = taken.contextTokens;
        return { pi: taken.checkpoint, nn: { turnSeq, ...(lastRequest === undefined ? {} : { lastRequest }), ...(contextTokens === undefined ? {} : { contextTokens }) } };
      };
      return {
        firstCall: (content) => ({ systemPromptChars: process.info.systemPromptChars ?? UNKNOWN_SYSTEM_PROMPT_CHARS, toolSchemaChars: process.info.toolSchemaChars ?? 0, startupTokens: Math.ceil(content.length / 3) + (contextTokens ?? 0), replyReserveTokens: model.maxTokens }),
        async run(content, requestId) {
          let result;
          try { result = await process.run(requestId, content); } catch (error) { return { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 2000) }; }
          // The same request again (a replay after a restart, answered from the store) is the same turn: it keeps its number, so its usage is charged once.
          if (requestId !== lastRequest) { turnSeq += 1; lastRequest = requestId; }
          const figures = await cache?.takeUsage?.().catch(() => undefined);
          let checkpoint: JsonObj | undefined;
          try { checkpoint = wrapCheckpoint(await process.checkpoint()); } catch { checkpoint = undefined; }
          return { status: result.status, ...(result.text === undefined ? {} : { text: result.text }), ...(result.error === undefined ? {} : { error: result.error }), ...(checkpoint === undefined ? {} : { checkpoint }), usage: { turnSeq, ...(figures === undefined ? {} : { cache: figures }) } };
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

  return { sandbox, runtimes, ownerPolicy: options.limits !== undefined && options.bestEffort !== undefined && options.onLaunch !== undefined };
}
