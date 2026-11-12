import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PI_FOLDER, PI_INDEX } from "../backup/format.js";
import { PI_LIMITS, copyPiState, parsePiIndex, validStoreId, writePiState, type PiStateSource, type PiStateStore } from "../backup/pi-state.js";
import { DomainError } from "../domain/errors.js";
import { PI_TRANSFER_FILE, PI_TRANSFER_ID, REMOTE_LIMITS, type RemoteWorkspaceAnswer, type WorkspaceAsk } from "./protocol.js";
import type { PiTransferChunk, PiTransferPort } from "./service.js";

/**
 * The conversation stores of remote hosts in backups and restores (card K01i).
 *
 * A remote host keeps the agents' own conversation stores on its own disk. The controller cannot read them, so it ASKS the host (the workspace request channel, operation `pi-state-send`): the host copies its stores with the
 * same hardened copy a backup uses (`copyPiState`: links, special files, changing files and limits are dealt with there) and uploads the result in chunks under a transfer ID; the controller checks every file's digest against the
 * index and writes each store out under a name that carries the host (`remoteStoreId`), so the stores of two hosts, and of this machine, can never meet in one backup. A restore puts every store back on the controller's own
 * disk first (that is the existing staged restore, which knows nothing of hosts); once the restarted controller sees the host again it asks it to FETCH them (`pi-state-restore`): the host checks every digest, stages each store
 * beside its place and swaps it in, keeping what was there. A host that is busy with the attempt, or not connected, is asked again later; nothing is lost meanwhile (the stores wait in the controller's data directory).
 */

/** A store of a remote host is named `rh.<host>.<key>` inside a backup (the host without its `host:` prefix, then the key the host gave the store). A backup's store IDs allow `.`, so this fits the backup's own rule. */
export const REMOTE_STORE_PREFIX = "rh.";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function remoteStoreId(hostId: string, key: string): string | undefined {
  if (typeof hostId !== "string" || !hostId.startsWith("host:") || !SLUG.test(hostId.slice(5)) || !validStoreId(key)) return undefined;
  const id = `${REMOTE_STORE_PREFIX}${hostId.slice(5)}.${key}`;
  return validStoreId(id) ? id : undefined;
}
export function parseRemoteStoreId(id: string): { readonly hostId: string; readonly key: string } | undefined {
  if (typeof id !== "string" || !id.startsWith(REMOTE_STORE_PREFIX)) return undefined;
  const rest = id.slice(REMOTE_STORE_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return undefined;
  const slug = rest.slice(0, dot);
  const key = rest.slice(dot + 1);
  return SLUG.test(slug) && validStoreId(key) ? { hostId: `host:${slug}`, key } : undefined;
}
export const isRemoteStoreId = (id: string): boolean => typeof id === "string" && id.startsWith(REMOTE_STORE_PREFIX);

/** `final` for the local conversation stores, with the remote hosts' stores taken out: a store of a remote host is never put back into a folder of this machine's own. */
export const localOnly = (final: ((id: string) => string | undefined) | undefined): ((id: string) => string | undefined) | undefined =>
  final === undefined ? undefined : (id: string) => (isRemoteStoreId(id) ? undefined : final(id));

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const newPiId = (prefix: "pst" | "wsr"): string => `${prefix}-${[...randomBytes(20)].map((b) => ALPHABET[b % 32]).join("")}`;

/** Where a file of a transfer is in a section laid out as a backup's own Pi state (`pi-state.jsonl` and `pi-state/f-<n>`). */
const fileOf = (dir: string, name: string): string => (name === "index.jsonl" ? join(dir, PI_INDEX) : join(dir, PI_FOLDER, name));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

// ---- the controller's side of the transfer (what the host's messages reach) ----------------------------------------------------

interface FileState { size: number; readonly hash: ReturnType<typeof createHash>; done: boolean; sha256?: string; last?: { offset: number; sha: string } }
interface Transfer { readonly hostId: string; readonly mode: "receive" | "serve"; readonly dir: string; readonly files: Map<string, FileState>; bytes: number; tail: Promise<unknown>; readonly digests: Map<string, string> }

/**
 * Receives the files a host sends and serves the files a host fetches. A transfer is opened for ONE host and one direction before the host is asked; any other host, direction or ID reads as missing. Files are made only
 * under names the section layout defines (never a name the host chose), in order (a chunk must start where the file ends; the same chunk sent again is accepted once), and are checked against the digest the host states at the
 * last chunk. Bounded in bytes and in files.
 */
export class PiStateTransfers implements PiTransferPort {
  readonly #open = new Map<string, Transfer>();
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  constructor(options: { readonly directory: string; readonly maxBytes?: number; readonly maxFiles?: number }) {
    this.#directory = options.directory; this.#maxBytes = options.maxBytes ?? REMOTE_LIMITS.piTransferBytes; this.#maxFiles = options.maxFiles ?? REMOTE_LIMITS.piTransferFiles;
  }

  /** Opens a transfer the host will send into; the section is made empty. */
  async receive(transferId: string, hostId: string): Promise<string> {
    if (!PI_TRANSFER_ID.test(transferId) || this.#open.has(transferId)) throw new Error("the transfer is not new");
    const dir = join(this.#directory, transferId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, PI_FOLDER), { recursive: true, mode: 0o700 });
    this.#open.set(transferId, { hostId, mode: "receive", dir, files: new Map(), bytes: 0, tail: Promise.resolve(), digests: new Map() });
    return dir;
  }
  /** Opens a transfer the host will fetch from: `dir` is a section laid out as a backup's Pi state, kept by the caller. */
  serve(transferId: string, hostId: string, dir: string): void {
    if (!PI_TRANSFER_ID.test(transferId) || this.#open.has(transferId)) throw new Error("the transfer is not new");
    this.#open.set(transferId, { hostId, mode: "serve", dir, files: new Map(), bytes: 0, tail: Promise.resolve(), digests: new Map() });
  }
  /** The files received completely, with their sizes and digests. */
  received(transferId: string): ReadonlyMap<string, { readonly size: number; readonly sha256: string }> {
    const t = this.#open.get(transferId);
    return new Map([...(t?.files ?? [])].filter(([, f]) => f.done).map(([name, f]) => [name, { size: f.size, sha256: f.sha256! }]));
  }
  /** Closes a transfer; a received section is removed (what was made of it is the caller's). */
  async end(transferId: string): Promise<void> {
    const t = this.#open.get(transferId);
    this.#open.delete(transferId);
    if (t !== undefined && t.mode === "receive") await t.tail.catch(() => undefined).then(() => rm(t.dir, { recursive: true, force: true }));
  }
  get openCount(): number { return this.#open.size; }

  #find(hostId: string, transferId: unknown, mode: "receive" | "serve"): Transfer {
    const t = typeof transferId === "string" && PI_TRANSFER_ID.test(transferId) ? this.#open.get(transferId) : undefined;
    if (t === undefined || t.hostId !== hostId || t.mode !== mode) throw new DomainError("not_found", "no such transfer");
    return t;
  }

  async put(hostId: string, transferId: unknown, body: unknown): Promise<{ readonly received: number }> {
    const t = this.#find(hostId, transferId, "receive");
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("body", "must be an object");
    const o = body as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["name", "offset", "data", "last", "sha256"].includes(k)) invalid("body", `${k.slice(0, 30)} is not a field of a chunk`);
    const name = o["name"];
    if (typeof name !== "string" || !PI_TRANSFER_FILE.test(name)) return invalid("name", "is not a file of a transfer");
    const offset = o["offset"];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return invalid("offset", "must be a whole number");
    const data = o["data"];
    if (typeof data !== "string" || data.length > Math.ceil(REMOTE_LIMITS.piChunkBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return invalid("data", "must be base64 of at most one chunk");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > REMOTE_LIMITS.piChunkBytes) return invalid("data", "is more than one chunk");
    const last = o["last"];
    if (last !== undefined && last !== true) return invalid("last", "is only true, on the last chunk");
    const digest = o["sha256"];
    if (last === true && (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))) return invalid("sha256", "the last chunk states the digest of the file");
    if (last !== true && digest !== undefined) return invalid("sha256", "only the last chunk states it");
    // One chunk at a time per transfer: a retry arriving beside the first is judged after it.
    const run = t.tail.then(() => this.#append(t, name, offset, bytes, last === true ? (digest as string) : undefined));
    t.tail = run.catch(() => undefined);
    return run;
  }

  async #append(t: Transfer, name: string, offset: number, bytes: Buffer, digest: string | undefined): Promise<{ readonly received: number }> {
    let f = t.files.get(name);
    const chunkSha = sha(bytes);
    // The same chunk again (an answer was lost): accepted, nothing written twice.
    if (f?.last !== undefined && f.last.offset === offset && f.last.sha === chunkSha) return { received: f.size };
    if (f?.done === true) throw new DomainError("command_conflict", `${name} was already received`);
    if (f === undefined && offset !== 0) throw new DomainError("command_conflict", `${name} starts at 0, not ${offset}`);
    if (f !== undefined && offset !== f.size) throw new DomainError("command_conflict", `${name} is at ${f.size}, not ${offset}: a chunk was missed`);
    if (f === undefined && t.files.size >= this.#maxFiles) throw new DomainError("invalid_command", "the transfer has too many files");
    if (t.bytes + bytes.length > this.#maxBytes) throw new DomainError("invalid_command", "the transfer is larger than a transfer may be");
    if (f === undefined) { f = { size: 0, hash: createHash("sha256"), done: false }; t.files.set(name, f); }
    const path = fileOf(t.dir, name);
    const h = await open(path, f.size === 0 && offset === 0 ? "w" : "a", 0o600);
    try { await h.write(bytes); } finally { await h.close(); }
    f.hash.update(bytes); f.size += bytes.length; t.bytes += bytes.length; f.last = { offset, sha: chunkSha };
    if (digest !== undefined) {
      const got = f.hash.copy().digest("hex");
      if (got !== digest) { t.bytes -= f.size; t.files.delete(name); await rm(path, { force: true }); throw new DomainError("integrity", `${name} did not arrive as the bytes the host stated`); }
      f.done = true; f.sha256 = got;
    }
    return { received: f.size };
  }

  async get(hostId: string, transferId: unknown, name: unknown, offset: unknown): Promise<PiTransferChunk> {
    const t = this.#find(hostId, transferId, "serve");
    if (typeof name !== "string" || !PI_TRANSFER_FILE.test(name)) return invalid("name", "is not a file of a transfer");
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return invalid("offset", "must be a whole number");
    const path = fileOf(t.dir, name);
    let size: number;
    try { size = (await stat(path)).size; } catch { throw new DomainError("not_found", "no such file in the transfer"); }
    const length = Math.max(0, Math.min(REMOTE_LIMITS.piChunkBytes, size - offset));
    const buf = Buffer.alloc(length);
    if (length > 0) { const h = await open(path, "r"); try { await h.read(buf, 0, length, offset); } finally { await h.close(); } }
    const eof = offset + length >= size;
    let digest: string | undefined;
    if (eof) { digest = t.digests.get(name); if (digest === undefined) { digest = sha(await readFile(path)); t.digests.set(name, digest); } }
    return { data: buf.toString("base64"), offset, size, eof, ...(digest === undefined ? {} : { sha256: digest }) };
  }
}

// ---- backups: the stores of every remote host --------------------------------------------------------------------------------

export interface RemotePiStateOptions {
  /** Where received sections and the stores made of them are kept while a backup copies them (the data directory's own folder). */
  readonly directory: string;
  readonly transfers: PiStateTransfers;
  /** Which hosts to ask and which cannot be asked now (with the reason). */
  readonly hosts: () => Promise<{ readonly ask: readonly string[]; readonly unreachable: readonly { readonly hostId: string; readonly why: string }[] }>;
  /** Carries the request to the host and waits for its answer (`RemoteWorkerService.askPiState`). */
  readonly ask: (hostId: string, operation: "pi-state-send", requestId: string, transferId: string, waitMs: number) => Promise<RemoteWorkspaceAnswer>;
  /** How long a host may take to send everything (default 10 minutes). */
  readonly waitMs?: number;
}

/**
 * A `PiStateSource` for the stores of the remote hosts: `list()` asks each host that can be asked, one after another, and returns the stores it sent, staged on this machine; `problems()` names every host or store that could not be
 * taken (so the backup's manifest says so); `release()` removes what was staged. A host that does not answer costs `waitMs` and is named in the problems, never read as having no stores.
 */
export class RemotePiState implements PiStateSource {
  readonly #o: RemotePiStateOptions;
  #problems: string[] = [];
  #listed: string[] = [];
  #lock: Promise<void> = Promise.resolve();
  #unlock: (() => void) | undefined;
  constructor(options: RemotePiStateOptions) { this.#o = options; }

  problems(): readonly string[] { return this.#problems; }

  async list(): Promise<readonly PiStateStore[]> {
    // One listing at a time: its staged stores are removed by its own release.
    const before = this.#lock;
    this.#lock = new Promise<void>((ok) => { this.#unlock = ok; });
    await before;
    this.#problems = []; this.#listed = [];
    try { return await this.#list(); } catch (error) { await this.release(); throw error; }
  }

  async release(): Promise<void> {
    const dirs = this.#listed.splice(0);
    for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    const unlock = this.#unlock; this.#unlock = undefined; unlock?.();
  }

  async #list(): Promise<readonly PiStateStore[]> {
    const { ask, unreachable } = await this.#o.hosts();
    for (const u of unreachable) this.#problems.push(`${u.hostId}: its conversation stores are not in this backup (${u.why})`);
    const stores: PiStateStore[] = [];
    for (const hostId of ask) {
      const transferId = newPiId("pst");
      const section = await this.#o.transfers.receive(transferId, hostId);
      try {
        let answer: RemoteWorkspaceAnswer;
        try { answer = await this.#o.ask(hostId, "pi-state-send", newPiId("wsr"), transferId, this.#o.waitMs ?? 600_000); } catch (error) {
          this.#problems.push(`${hostId}: its conversation stores are not in this backup (it did not answer: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`);
          continue;
        }
        if (!answer.ok) { this.#problems.push(`${hostId}: its conversation stores are not in this backup (${answer.reason.slice(0, 300)})`); continue; }
        try { stores.push(...await this.#take(hostId, transferId, section, answer.detail)); } catch (error) {
          this.#problems.push(`${hostId}: its conversation stores are not in this backup (${(error instanceof Error ? error.message : String(error)).slice(0, 300)})`);
        }
      } finally { await this.#o.transfers.end(transferId); }
    }
    return stores;
  }

  /** Checks what a host sent against its index and the count it announced, and writes each store out under its remote name. Anything that does not check out leaves the host's stores out and says why. */
  async #take(hostId: string, transferId: string, section: string, detail: unknown): Promise<PiStateStore[]> {
    const got = this.#o.transfers.received(transferId);
    const index = got.get("index.jsonl");
    if (index === undefined) throw new Error("it sent no index of its stores");
    const parsed = parsePiIndex((await readFile(join(section, PI_INDEX))).toString("utf8"), false);
    if (parsed.problems.length > 0) throw new Error(parsed.problems[0]!);
    const announced = (detail as { files?: unknown } | undefined)?.files;
    if (typeof announced !== "number" || announced !== parsed.lines.length) throw new Error(`it announced ${String(announced)} files and its index lists ${parsed.lines.length}`);
    if (parsed.lines.length > PI_LIMITS.files) throw new Error("it sent too many files");
    for (const l of parsed.lines) {
      const f = got.get(l.file!);
      if (f === undefined || f.size !== l.size || f.sha256 !== l.sha256) throw new Error(`a file of its index (${l.store}) did not arrive as listed`);
    }
    const trees = join(this.#o.directory, `${transferId}-stores`);
    this.#listed.push(trees);
    const byStore = new Map<string, typeof parsed.lines>();
    for (const l of parsed.lines) { const id = remoteStoreId(hostId, l.store); if (id === undefined) { this.#problems.push(`${hostId}: the store ${l.store.slice(0, 60)} has a name a backup cannot keep and was left out`); continue; } byStore.set(id, [...(byStore.get(id) ?? []), l]); }
    const out: PiStateStore[] = [];
    await mkdir(trees, { recursive: true, mode: 0o700 });
    for (const [id, lines] of byStore) {
      const dir = join(trees, id);
      await writePiState(section, lines.map((l) => ({ ...l })), undefined, () => dir);
      out.push({ id, dir });
    }
    const reported = (detail as { problems?: unknown; problemCount?: unknown } | undefined);
    if (Array.isArray(reported?.problems)) for (const p of reported.problems.slice(0, 5)) if (typeof p === "string") this.#problems.push(`${hostId}: ${p.slice(0, 250)}`);
    if (typeof reported?.problemCount === "number" && reported.problemCount > 5) this.#problems.push(`${hostId}: ${reported.problemCount - 5} more files could not be copied on the host`);
    return out;
  }
}

/** The local stores and the remote hosts' stores as one source. The local one is listed first; each part's problems and release are kept. */
export function combinedPiState(...parts: readonly (PiStateSource | undefined)[]): PiStateSource | undefined {
  const sources = parts.filter((p): p is PiStateSource => p !== undefined);
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0]!;
  return {
    list: async () => { const out: PiStateStore[] = []; try { for (const s of sources) out.push(...await s.list()); } catch (error) { await Promise.all(sources.map((s) => s.release?.().catch(() => undefined))); throw error; } return out; },
    problems: () => sources.flatMap((s) => s.problems?.() ?? []),
    release: async () => { await Promise.all(sources.map((s) => s.release?.().catch(() => undefined))); },
  };
}

// ---- restores: putting the stores back on each host --------------------------------------------------------------------------

export interface RemotePiRestoreOptions {
  /** The data directory: the restore left each remote store in `restored-pi-state/<id>`; delivered ones are moved to `restored-pi-state-delivered/`. */
  readonly dataDirectory: string;
  readonly transfers: PiStateTransfers;
  readonly ask: (hostId: string, operation: "pi-state-restore", requestId: string, transferId: string, waitMs: number) => Promise<RemoteWorkspaceAnswer>;
  /** True while a restore is being prepared or applied (nothing is delivered then). */
  readonly held?: () => boolean;
  readonly waitMs?: number;
  readonly now?: () => Date;
}
export interface RemotePiRestoreState {
  /** Stores waiting for their host, by host, with the last reason they were not delivered. */
  readonly waiting: readonly { readonly hostId: string; readonly stores: number; readonly reason?: string }[];
  readonly delivered: number;
}
const RESTORED = "restored-pi-state";
const DELIVERED = "restored-pi-state-delivered";

/** Delivers the stores a restore left for remote hosts (card K01i). `sweep()` is safe to call as often as wanted: one run at a time, a host that cannot be reached keeps its stores waiting. */
export class RemotePiRestore {
  readonly #o: RemotePiRestoreOptions;
  #running: Promise<RemotePiRestoreState> | undefined;
  readonly #reasons = new Map<string, string>();
  #delivered = 0;
  constructor(options: RemotePiRestoreOptions) { this.#o = options; }

  async #waiting(): Promise<Map<string, string[]>> {
    const entries = await readdir(join(this.#o.dataDirectory, RESTORED), { withFileTypes: true }).catch(() => []);
    const byHost = new Map<string, string[]>();
    for (const e of entries) {
      const parsed = e.isDirectory() ? parseRemoteStoreId(e.name) : undefined;
      if (parsed !== undefined) byHost.set(parsed.hostId, [...(byHost.get(parsed.hostId) ?? []), e.name]);
    }
    return byHost;
  }

  async state(): Promise<RemotePiRestoreState> {
    const waiting = await this.#waiting();
    return { waiting: [...waiting].sort(([a], [b]) => (a < b ? -1 : 1)).map(([hostId, ids]) => ({ hostId, stores: ids.length, ...(this.#reasons.has(hostId) ? { reason: this.#reasons.get(hostId)! } : {}) })), delivered: this.#delivered };
  }

  sweep(): Promise<RemotePiRestoreState> {
    if (this.#running !== undefined) return this.#running;
    const run = this.#sweep().finally(() => { this.#running = undefined; });
    this.#running = run;
    return run;
  }

  async #sweep(): Promise<RemotePiRestoreState> {
    if (this.#o.held?.() === true) return this.state();
    for (const [hostId, ids] of await this.#waiting()) {
      if (this.#o.held?.() === true) break;
      const transferId = newPiId("pst");
      const stage = join(this.#o.dataDirectory, "pi-remote-out", transferId);
      try {
        await mkdir(stage, { recursive: true, mode: 0o700 });
        // The section a host fetches: the stores laid out as a backup's Pi state, each under the key the host gave it.
        const stores: PiStateStore[] = ids.map((id) => ({ id: parseRemoteStoreId(id)!.key, dir: join(this.#o.dataDirectory, RESTORED, id) }));
        await copyPiState({ list: async () => stores }, stage, undefined);
        this.#o.transfers.serve(transferId, hostId, stage);
        const answer = await this.#o.ask(hostId, "pi-state-restore", newPiId("wsr"), transferId, this.#o.waitMs ?? 600_000);
        if (!answer.ok) { this.#reasons.set(hostId, answer.reason.slice(0, 300)); continue; }
        // Delivered: the host has them in place (its own aside keeps what they replaced). The copies here are moved, not deleted.
        const stamp = (this.#o.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, "");
        await mkdir(join(this.#o.dataDirectory, DELIVERED), { recursive: true, mode: 0o700 });
        for (const id of ids) await rename(join(this.#o.dataDirectory, RESTORED, id), join(this.#o.dataDirectory, DELIVERED, `${id}-${stamp}`));
        this.#delivered += ids.length;
        this.#reasons.delete(hostId);
      } catch (error) {
        this.#reasons.set(hostId, (error instanceof Error ? error.message : String(error)).slice(0, 300));
      } finally {
        await this.#o.transfers.end(transferId);
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return this.state();
  }
}

// ---- the host's side ---------------------------------------------------------------------------------------------------------

export interface PiStateHostOptions {
  readonly client: { piStatePut(transferId: string, chunk: { name: string; offset: number; data: Buffer; last?: { sha256: string } }): Promise<void>; piStateGet(transferId: string, name: string, offset: number): Promise<{ data: Buffer; offset: number; size: number; eof: boolean; sha256?: string }> };
  /** This host's own conversation stores (the worker package's `LocalConversationStores.source`). */
  readonly source: PiStateSource;
  /** Where a store goes back on this host (`LocalConversationStores.final`); undefined: the host keeps no store of that ID, and a restore containing it is refused. */
  readonly final: (id: string) => string | undefined;
  /** The attempts with a call in flight here: a restore of the store of one of them is refused (the agent is writing it). */
  readonly busy: () => readonly string[] | Promise<readonly string[]>;
  /** A folder of this host for the copies it makes while it sends and fetches (outside the agents' homes). */
  readonly scratch: string;
  readonly now?: () => Date;
}

/** The host's answer to `pi-state-send` and `pi-state-restore`. Nothing here is run on a guess: every refusal says why and changes nothing. */
export class PiStateHost {
  readonly #o: PiStateHostOptions;
  constructor(options: PiStateHostOptions) {
    for (const k of ["client", "source", "final", "busy", "scratch"] as const) if ((options as unknown as Record<string, unknown>)[k] === undefined) throw new TypeError(`a Pi state host needs ${k}`);
    this.#o = options;
  }

  async answer(ask: WorkspaceAsk): Promise<RemoteWorkspaceAnswer> {
    const transferId = ask.piState?.transferId;
    if (transferId === undefined || !PI_TRANSFER_ID.test(transferId)) return { ok: false, reason: "the request named no transfer" };
    try { return ask.operation === "pi-state-send" ? await this.#send(transferId) : await this.#restore(transferId); } catch (error) {
      return { ok: false, reason: `this host could not finish: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, failed: true };
    }
  }

  async #send(transferId: string): Promise<RemoteWorkspaceAnswer> {
    await mkdir(this.#o.scratch, { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(join(this.#o.scratch, "send-"));
    try {
      const copied = await copyPiState(this.#o.source, tmp, undefined);
      const names = (await readdir(join(tmp, PI_FOLDER))).filter((n) => /^f-[0-9]{1,9}$/.test(n)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
      await this.#upload(transferId, "index.jsonl", join(tmp, PI_INDEX));
      for (const name of names) await this.#upload(transferId, name, join(tmp, PI_FOLDER, name));
      return { ok: true, summary: "sent", detail: { stores: copied.stores, files: copied.files, bytes: copied.bytes, ...(copied.problemCount === undefined ? {} : { problemCount: copied.problemCount, problems: (copied.problems ?? []).slice(0, 5).map((p) => p.slice(0, 200)) }) } };
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => undefined); }
  }

  async #upload(transferId: string, name: string, path: string): Promise<void> {
    const size = (await stat(path)).size;
    const hash = createHash("sha256");
    const h = await open(path, "r");
    try {
      for (let at = 0; at < size;) { const b = Buffer.alloc(Math.min(REMOTE_LIMITS.piChunkBytes, size - at)); const { bytesRead } = await h.read(b, 0, b.length, at); if (bytesRead === 0) break; hash.update(b.subarray(0, bytesRead)); at += bytesRead; }
      const digest = hash.digest("hex");
      let at = 0;
      do {
        const b = Buffer.alloc(Math.min(REMOTE_LIMITS.piChunkBytes, size - at));
        const { bytesRead } = b.length === 0 ? { bytesRead: 0 } : await h.read(b, 0, b.length, at);
        const chunk = b.subarray(0, bytesRead);
        const lastOne = at + chunk.length >= size;
        await this.#o.client.piStatePut(transferId, { name, offset: at, data: chunk, ...(lastOne ? { last: { sha256: digest } } : {}) });
        at += chunk.length;
        if (!lastOne && chunk.length === 0) throw new Error(`${basename(path)} changed while it was sent`);
      } while (at < size);
    } finally { await h.close(); }
  }

  async #fetch(transferId: string, name: string, to: string, expect?: { size: number; sha256: string }): Promise<void> {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const h = await open(to, "w", 0o600);
    const hash = createHash("sha256");
    let at = 0;
    try {
      for (;;) {
        const c = await this.#o.client.piStateGet(transferId, name, at);
        if (c.offset !== at) throw new Error(`${name} came out of order`);
        if (c.data.length > 0) { await h.write(c.data); hash.update(c.data); at += c.data.length; }
        if (c.eof) {
          const got = hash.digest("hex");
          if (c.sha256 !== undefined && c.sha256 !== got) throw new Error(`${name} did not arrive as the controller holds it`);
          if (expect !== undefined && (expect.size !== at || expect.sha256 !== got)) throw new Error(`${name} did not match its entry in the index`);
          return;
        }
        if (c.data.length === 0) throw new Error(`${name} stopped coming`);
      }
    } finally { await h.close(); }
  }

  async #restore(transferId: string): Promise<RemoteWorkspaceAnswer> {
    await mkdir(this.#o.scratch, { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(join(this.#o.scratch, "restore-"));
    const stamp = (this.#o.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, "");
    const staged: { store: string; staged: string; target: string }[] = [];
    try {
      await this.#fetch(transferId, "index.jsonl", join(tmp, PI_INDEX));
      const parsed = parsePiIndex((await readFile(join(tmp, PI_INDEX))).toString("utf8"), false);
      if (parsed.problems.length > 0) return { ok: false, reason: `the index of the stores is not valid (${parsed.problems[0]}); nothing was changed` };
      const stores = [...new Set(parsed.lines.map((l) => l.store))];
      const targets = new Map<string, string>();
      for (const id of stores) {
        const t = this.#o.final(id);
        if (t === undefined) return { ok: false, reason: `this host keeps no conversation store ${id}; nothing was changed` };
        targets.set(id, t);
      }
      const busy = await this.#o.busy();
      const live = stores.filter((id) => busy.includes(id));
      if (live.length > 0) return { ok: false, reason: `the agent of ${live.slice(0, 3).join(", ")} is running on this host right now, so its store was not replaced; ask again when it is not` };
      for (const l of parsed.lines) await this.#fetch(transferId, l.file!, join(tmp, PI_FOLDER, l.file!), { size: l.size, sha256: l.sha256 });
      // Each store is written beside its place, then swapped in; what was there is kept next to it.
      for (const id of stores) {
        const target = targets.get(id)!;
        const at = `${target}.nn-restore-${stamp}`;
        await rm(at, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        staged.push({ store: id, staged: at, target });
        await writePiState(tmp, parsed.lines.filter((l) => l.store === id).map((l) => ({ ...l })), undefined, () => at);
      }
      const done: { target: string; aside?: string }[] = [];
      try {
        for (const s of staged) {
          const aside = `${s.target}.before-restore-${stamp}`;
          const had = await stat(s.target).then(() => true, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? false : Promise.reject(e)));
          if (had) await rename(s.target, aside);
          done.push({ target: s.target, ...(had ? { aside } : {}) });
          await rename(s.staged, s.target);
        }
      } catch (error) {
        // Put back what was moved: the stores swapped so far go away again and their asides come back.
        for (const d of done.reverse()) { await rm(d.target, { recursive: true, force: true }).catch(() => undefined); if (d.aside !== undefined) await rename(d.aside, d.target).catch(() => undefined); }
        throw error;
      }
      return { ok: true, summary: "restored", detail: { stores: stores.length, files: parsed.lines.length } };
    } finally {
      for (const s of staged) await rm(s.staged, { recursive: true, force: true }).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
