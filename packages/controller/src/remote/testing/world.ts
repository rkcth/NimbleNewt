import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactService, FileBlobStore } from "../../artifacts/index.js";
import { buildWorld, type DispatchWorld } from "../../dispatch/testing/world.js";
import type { DispatcherService } from "../../dispatch/dispatcher.js";
import type { RecipeSummary, ToolGateway, WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../../dispatch/ports.js";
import type { Capabilities } from "../../hosts/index.js";
import type { Principal } from "../../security/index.js";
import type { ControllerStorage, JsonObject } from "../../storage/types.js";
import { RemoteWorkerClient, type RemoteWorkerClientOptions } from "../client.js";
import type { VersionRange } from "../protocol.js";
import { WorkerTransport, type WorkerTransportOptions } from "../server.js";
import { RemoteWorkerService, type PlacementPolicyFor, type RelocationPolicyFor, type Requirements } from "../service.js";

export const REMOTE_CAPS: Capabilities = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: ["garden"] };

/**
 * What a remote worker host looks like to the dispatcher: the dispatch contract's `WorkerHost`, backed by the remote service. The card that carries the dispatch contract over this transport (H12a) builds the
 * product version of this; here it is the smallest thing that lets the tests drive a real `DispatcherService` over the real transport.
 */
export class RemoteTestHost implements WorkerHost {
  readonly starts: WorkOrder[] = [];
  readonly handles: RemoteTestHandle[] = [];
  requirements: (order: WorkOrder) => Requirements = () => ({ data: "cloud-allowed", harness: "pi" });
  inputs: (order: WorkOrder) => readonly string[] = () => [];
  /** When set, the host does not answer a request for a checkpoint (a partition). */
  silent = false;
  /** When set, a request for a checkpoint never returns (a host that is unreachable and does not even refuse). */
  hang = false;
  /** How the worker answers a request for a checkpoint: it sends one itself, over the wire, as a real worker does. Set when the host connects. */
  respond: ((attemptId: string, placement: number) => Promise<void>) | undefined;
  constructor(readonly hostId: string, private readonly remote: RemoteWorkerService, private readonly by: Principal, readonly resources = { cpus: 1, memoryMb: 1024 }) {}
  async start(order: WorkOrder): Promise<WorkerHandle> {
    this.starts.push(order);
    const placed = await this.remote.place(this.by, { hostId: this.hostId, order, requirements: this.requirements(order), inputs: this.inputs(order) });
    const handle = new RemoteTestHandle(this, this.remote, this.by, order.attemptId, placed.placement);
    this.handles.push(handle);
    return handle;
  }
}

export class RemoteTestHandle implements WorkerHandle {
  readonly workerVersion = "remote-1.0.0";
  stopped = 0;
  constructor(private readonly host: RemoteTestHost, private readonly remote: RemoteWorkerService, private readonly by: Principal, readonly attemptId: string, readonly placement: number) {}
  run(_gateway: ToolGateway): Promise<WorkerTurnResult> { void _gateway; return this.remote.waitForResult(this.by, this.attemptId, this.placement) as Promise<WorkerTurnResult>; }
  async checkpoint(): Promise<JsonObject> {
    if (this.host.hang) await new Promise<never>(() => undefined);
    if (this.host.silent) throw new Error("the worker did not answer");
    await this.remote.control(this.by, this.attemptId, { kind: "checkpoint" });
    await this.host.respond?.(this.attemptId, this.placement);
    const latest = await this.remote.latestCheckpoint(this.by, this.attemptId);
    if (latest === undefined) throw new Error("the worker has sent no checkpoint");
    return latest.checkpoint;
  }
  async restart(recipe: RecipeSummary, from: JsonObject): Promise<void> { await this.remote.control(this.by, this.attemptId, { kind: "restart", recipe, checkpoint: from }); }
  async tell(text: string): Promise<void> { await this.remote.control(this.by, this.attemptId, { kind: "tell", text }); }
  async stop(): Promise<void> { this.stopped++; await this.remote.end(this.by, this.attemptId, "the dispatcher stopped the worker", this.placement); }
}

export interface RemoteHost {
  readonly name: string;
  readonly id: string;
  readonly token: string;
  principal: Principal;
  client: RemoteWorkerClient;
  readonly worker: RemoteTestHost;
  /** A heartbeat of the host (increasing sequence) over the wire. */
  beat(): Promise<void>;
}

export interface RemoteWorld extends DispatchWorld {
  readonly remote: RemoteWorkerService;
  readonly artifacts: ArtifactService;
  readonly blobs: FileBlobStore;
  readonly transport: WorkerTransport;
  /** The dispatcher in use (replaced when hosts are added). */
  readonly current: DispatcherService;
  /** Enrols a host, connects it over the real transport, makes it fresh and gives it capacity; adds its worker to the dispatcher. */
  host(name: string, o?: { caps?: Capabilities; protocol?: VersionRange; connect?: boolean; clientOptions?: Partial<RemoteWorkerClientOptions>; dispatcher?: boolean }): Promise<RemoteHost>;
  /** Another transport over the same service (a second listener), with its own options. */
  listen(options?: Partial<WorkerTransportOptions>): Promise<WorkerTransport>;
  /** One tick, without waiting for the turns it started (a remote turn ends when the worker says so). */
  tick(): ReturnType<DispatcherService["tick"]>;
  /** The dispatcher tries this host first from now on (it still skips one that is stale or lacks the harness). */
  prefer(host: RemoteHost): void;
  /** The mode the remote service re-accepts by (card H09b); change `mode` in a test. */
  readonly reaccept: { mode: "auto" | "owner" };
  done(): Promise<void>;
}

export async function buildRemoteWorld(storage: ControllerStorage, o: { policy?: RelocationPolicyFor; /** The placement policy; absent: every host of the world may hold local-only data; null: no policy hook at all (the product default). */ placement?: PlacementPolicyFor | null; protocol?: VersionRange; fileBytes?: number; settleMs?: number; transport?: Partial<WorkerTransportOptions>; /** How a reconnected worker is re-accepted (card H09b); default auto, and a test may change it with `world.reaccept.mode`. */ reaccept?: "auto" | "owner" } = {}): Promise<RemoteWorld> {
  const w = await buildWorld(storage);
  const dir = mkdtempSync(join(tmpdir(), "nn remote-"));
  const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
  const artifacts = ArtifactService.withEpoch(storage, w.epoch, blobs, w.options);
  const holder: { dispatcher: DispatcherService } = { dispatcher: w.dispatcher };
  const workers: RemoteTestHost[] = [];
  const workerIds = (): string[] => workers.map((x) => x.hostId);
  const reaccept: { mode: "auto" | "owner" } = { mode: o.reaccept ?? "auto" };
  const remote = RemoteWorkerService.withEpoch(storage, w.epoch, {
    principal: w.dispatcherPrincipal, hosts: w.hosts, artifacts,
    dispatch: { gateway: (id) => holder.dispatcher.gateway(id), get: (by, id) => holder.dispatcher.get(by, id), relocate: (by, id, m) => holder.dispatcher.relocate(by, id, m), quiesce: (by, id, r, opt) => holder.dispatcher.quiesce(by, id, r, opt), release: (by, id) => holder.dispatcher.release(by, id) },
    reaccept: async () => reaccept.mode,
    ...(o.policy === undefined ? {} : { relocationPolicy: o.policy }),
    ...(o.placement === null ? {} : { placementPolicy: o.placement ?? (async () => ({ dataHosts: workerIds() })) }),
  }, { ...w.options, ...(o.protocol === undefined ? {} : { protocol: o.protocol }), ...(o.fileBytes === undefined ? {} : { fileBytes: o.fileBytes }), ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }) });
  const transports: WorkerTransport[] = [];
  const listen = async (options: Partial<WorkerTransportOptions> = {}): Promise<WorkerTransport> => { const t = await WorkerTransport.listen({ remote, principals: w.principals, ...o.transport, ...options }); transports.push(t); return t; };
  const transport = await listen();
  let n = 0;
  const world: RemoteWorld = Object.assign(w, {
    remote, artifacts, blobs, transport, reaccept,
    current: holder.dispatcher,
    listen,
    prefer: (host: RemoteHost) => { const i = workers.indexOf(host.worker); if (i > 0) { workers.splice(i, 1); workers.unshift(host.worker); } },
    tick: () => holder.dispatcher.tick(),
    host: async (name: string, hostOptions: { caps?: Capabilities; protocol?: VersionRange; connect?: boolean; clientOptions?: Partial<RemoteWorkerClientOptions>; dispatcher?: boolean } = {}): Promise<RemoteHost> => {
      const id = `host:${name}`;
      await w.principals.enroll(w.owner, { commandId: `rh-e-${name}-${n++}`, kind: "host", name, grants: [] });
      const token = (await w.principals.issueCredential(w.owner, id)).token;
      const principal = await w.principals.authenticate(token);
      await w.admission.setCapacity({ commandId: `rh-cap-${name}-${n++}`, actor: w.owner.id, host: id, capacity: { cpus: 8, memoryMb: 16_384 } });
      const worker = new RemoteTestHost(id, remote, w.dispatcherPrincipal);
      // A host the dispatcher never places on (idle hosts in a load test) is not added to it, which would rebuild the dispatcher for each one.
      if (hostOptions.dispatcher !== false) {
        workers.push(worker);
        holder.dispatcher = w.restart({ workers, storeOwner: (agentId, attemptId) => remote.storeOwner(w.dispatcherPrincipal, agentId, attemptId) });
        (w as { dispatcher: DispatcherService }).dispatcher = holder.dispatcher;
        (world as { current: DispatcherService }).current = holder.dispatcher;
      }
      const client = new RemoteWorkerClient({ url: transport.url, token, workerVersion: "worker-9.1.0", ...(hostOptions.protocol === undefined ? {} : { protocol: hostOptions.protocol }), ...(hostOptions.clientOptions ?? {}) });
      let seq = 0;
      const host: RemoteHost = { name, id, token, principal, client, worker, beat: async () => { await client.heartbeat(++seq); } };
      worker.respond = async (attemptId, placement) => {
        const stored = await remote.placement(w.dispatcherPrincipal, attemptId);
        const sequence = (stored?.checkpoint?.sequence ?? 0) + 1;
        await client.attempt(attemptId, placement).putCheckpoint(sequence, { turn: sequence, fresh: true });
      };
      if (hostOptions.connect !== false) { await client.connect({ ...(hostOptions.caps ?? REMOTE_CAPS) } as never); await host.beat(); }
      return host;
    },
    done: async () => { remote.close(); for (const t of transports) await t.close(); await blobs.lock.exclusive(async () => undefined); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  });
  return world;
}

export interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: any; raw: Buffer }
/** One plain HTTP request, for the tests that look at the wire itself (headers, status codes, bodies the client would not send). */
export function rawRequest(base: string, method: string, path: string, init: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; ca?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const data = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    const headers: Record<string, string> = { ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }), ...(init.headers ?? {}) };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers, ...(url.protocol === "https:" ? { ...(init.ca === undefined ? {} : { ca: init.ca }), servername: "localhost" } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => { const raw = Buffer.concat(chunks); let body: unknown; try { body = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8")); } catch { body = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body, raw }); });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
