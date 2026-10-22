import { createHash, randomBytes } from "node:crypto";
import { collisionKey, splitRelative } from "./names.js";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceError } from "./errors.js";
import { NOFOLLOW, resolveSafe, sameFile } from "./paths.js";

/** The version of a file: a digest of its bytes, or `absent` when there is no such file. Whoever writes must name the version it read. */
export const ABSENT = "absent";
export const versionOf = (content: Buffer): string => `sha256:${createHash("sha256").update(content).digest("hex")}`;

export interface PendingChange {
  readonly id: string;
  readonly path: string;
  readonly author: string;
  readonly reason: string;
  readonly at: string;
  /** What the writer saw, and what was there when the write was refused. */
  readonly expectedVersion: string;
  readonly foundVersion: string;
  /** `write` carries the proposed content (base64); `delete` has none. */
  readonly operation: "write" | "delete";
  readonly content?: string;
  readonly state: "pending" | "applied" | "discarded";
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export type WriteResult =
  | { readonly status: "written"; readonly version: string }
  | { readonly status: "rejected"; readonly pendingId: string; readonly foundVersion: string };

export const BRIDGE_LIMITS = { fileBytes: 8 * 1024 * 1024, pending: 1000, lockMs: 5_000, staleLockMs: 60_000, reasonChars: 500 } as const;

/**
 * Where an agent's changes reach shared files (card A04, mediated workspace editing): the agent edits only its own host-side checkout, and a change to the shared workspace goes through here as a
 * write that names the version of the file it was based on. The check and the write are one step under a lock held outside the shared tree. If the file is no longer at that version, nothing is written
 * and the change is kept, whole, for review; nothing is merged, overwritten or dropped. Git's own data (`.git`, whatever its spelling) is refused for every operation, links and junctions are never
 * followed, and a file is replaced by renaming a new file into place, never written through.
 */
export class WorkspaceBridge {
  readonly #shared: string;
  readonly #state: string;
  readonly #clock: () => string;

  /** `shared` is the shared workspace. `state` is where locks and kept changes live: outside `shared` and out of every sandbox's reach. */
  constructor(options: { shared: string; state: string; clock?: () => string }) {
    this.#shared = options.shared;
    this.#state = options.state;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  /** A file's content and version (`absent` if it is not there). Reading never writes anything. */
  async read(path: string): Promise<{ content: Buffer | undefined; version: string }> {
    const safe = await resolveSafe(this.#shared, path);
    if (safe.exists === "missing") return { content: undefined, version: ABSENT };
    if (safe.exists === "directory") throw new WorkspaceError("invalid_path", "that is a directory");
    const content = await this.#readNoFollow(safe.absolute);
    return { content, version: versionOf(content) };
  }

  /** Writes `content` if the file is still at `expectedVersion`; otherwise keeps the change for review. */
  async write(request: { path: string; expectedVersion: string; content: Buffer; author: string; reason: string }): Promise<WriteResult> {
    this.#check(request.expectedVersion, request.author, request.reason);
    if (!Buffer.isBuffer(request.content) || request.content.length > BRIDGE_LIMITS.fileBytes) throw new WorkspaceError("invalid_path", `a file is at most ${BRIDGE_LIMITS.fileBytes} bytes`);
    await resolveSafe(this.#shared, request.path, { forWrite: true }).catch((e: unknown) => { if (!(e instanceof WorkspaceError && e.code === "not_found")) throw e; }); // the path is judged (and Git's data named as such) before any lock is taken
    return this.#locked(request.path, async () => {
      // A directory on the way that is not there yet means the file is not there either; it is made only when the write is going to happen.
      let safe = await resolveSafe(this.#shared, request.path, { forWrite: true }).catch((e: unknown) => { if (e instanceof WorkspaceError && e.code === "not_found") return undefined; throw e; });
      if (safe?.exists === "directory") throw new WorkspaceError("invalid_path", "that is a directory");
      const found = safe === undefined || safe.exists === "missing" ? ABSENT : versionOf(await this.#readNoFollow(safe.absolute));
      if (found !== request.expectedVersion) return this.#keep(request.path, "write", request, found);
      if (safe === undefined) safe = await resolveSafe(this.#shared, request.path, { forWrite: true, createParents: true });
      await this.#replace(safe.absolute, request.content, safe.exists === "file");
      return { status: "written" as const, version: versionOf(request.content) };
    });
  }

  /** Deletes a file if it is still at `expectedVersion`; otherwise keeps the request for review. */
  async remove(request: { path: string; expectedVersion: string; author: string; reason: string }): Promise<WriteResult> {
    this.#check(request.expectedVersion, request.author, request.reason);
    if (request.expectedVersion === ABSENT) throw new WorkspaceError("not_found", "there is nothing to delete at version absent");
    await resolveSafe(this.#shared, request.path, { forWrite: true });
    return this.#locked(request.path, async () => {
      const safe = await resolveSafe(this.#shared, request.path, { forWrite: true });
      if (safe.exists === "directory") throw new WorkspaceError("invalid_path", "a directory is not deleted through the bridge");
      const found = safe.exists === "missing" ? ABSENT : versionOf(await this.#readNoFollow(safe.absolute));
      if (found !== request.expectedVersion) return this.#keep(request.path, "delete", { ...request, content: undefined }, found);
      await rm(safe.absolute, { force: true });
      return { status: "written", version: ABSENT };
    });
  }

  /** The changes kept for review, oldest first: those still waiting by default, or those already `applied` or `discarded`. */
  async pending(state: PendingChange["state"] = "pending"): Promise<PendingChange[]> {
    const out: PendingChange[] = [];
    const dir = join(this.#state, state === "pending" ? "pending" : "decided");
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    for (const name of names.filter((n) => /^[0-9a-f]{32}\.json$/.test(n)).sort()) {
      try { const c = JSON.parse(await readFile(join(dir, name), "utf8")) as PendingChange; if (c.state === state) out.push(c); } catch { /* an unreadable entry is not listed */ }
    }
    return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }

  /**
   * The owner's decision on a kept change (the caller, the owner API, authenticates `decidedBy`). `apply` carries it out if the file is at `reviewedVersion` (the version the owner looked at; the change
   * itself is never merged into other content); `discard` records that it was turned down. One decision per change: both take the change's lock and look at its state inside it. The record stays either
   * way, moved to the decided records.
   */
  async decide(id: string, decision: { decision: "apply" | "discard"; decidedBy: string; reviewedVersion?: string }): Promise<{ status: "applied" | "discarded" | "stale"; foundVersion?: string }> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new WorkspaceError("invalid_path", "that is not a kept change");
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length < 1 || decision.decidedBy.length > 120) throw new WorkspaceError("invalid_path", "a decision names who made it");
    return this.#locked(`decision/${id}`, async () => {
      const file = join(this.#state, "pending", `${id}.json`);
      let change: PendingChange;
      try { change = JSON.parse(await readFile(file, "utf8")) as PendingChange; } catch { throw new WorkspaceError("not_found", "no such kept change waiting for a decision"); }
      const decided = { decidedBy: decision.decidedBy, decidedAt: this.#clock() };
      if (decision.decision === "discard") { await this.#settle({ ...change, state: "discarded", ...decided }); return { status: "discarded" as const }; }
      if (decision.reviewedVersion === undefined) throw new WorkspaceError("invalid_path", "applying a kept change names the version of the file the owner reviewed it against");
      const result = await this.#locked(change.path, async () => {
        let safe = await resolveSafe(this.#shared, change.path, { forWrite: true }).catch((e: unknown) => { if (e instanceof WorkspaceError && e.code === "not_found") return undefined; throw e; });
        if (safe?.exists === "directory") throw new WorkspaceError("invalid_path", "that is a directory");
        const found = safe === undefined || safe.exists === "missing" ? ABSENT : versionOf(await this.#readNoFollow(safe.absolute));
        if (found !== decision.reviewedVersion) return { status: "stale" as const, foundVersion: found };
        if (change.operation === "write") {
          if (safe === undefined) safe = await resolveSafe(this.#shared, change.path, { forWrite: true, createParents: true });
          await this.#replace(safe.absolute, Buffer.from(change.content ?? "", "base64"), safe.exists === "file");
        } else if (safe !== undefined) await rm(safe.absolute, { force: true });
        return { status: "applied" as const };
      });
      if (result.status === "applied") await this.#settle({ ...change, state: "applied", ...decided });
      return result;
    });
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #check(expected: string, author: string, reason: string): void {
    if (typeof expected !== "string" || !(expected === ABSENT || /^sha256:[0-9a-f]{64}$/.test(expected))) throw new WorkspaceError("invalid_path", "expectedVersion is a version from read(), or 'absent'");
    if (typeof author !== "string" || author.length < 1 || author.length > 120) throw new WorkspaceError("invalid_path", "a change names its author");
    if (typeof reason !== "string" || reason.length < 1 || reason.length > BRIDGE_LIMITS.reasonChars) throw new WorkspaceError("invalid_path", `a change gives a reason of 1 to ${BRIDGE_LIMITS.reasonChars} characters`);
  }

  async #readNoFollow(absolute: string): Promise<Buffer> {
    const before = await lstat(absolute);
    const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW).catch(() => { throw new WorkspaceError("link_refused", "the file could not be opened without following a link"); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || !sameFile(before, info)) throw new WorkspaceError("link_refused", "the file changed while it was being opened");
      if (info.size > BRIDGE_LIMITS.fileBytes) throw new WorkspaceError("invalid_path", `a file is at most ${BRIDGE_LIMITS.fileBytes} bytes`);
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  /** Puts new content in place by writing a new file beside the old one and renaming it over: the old file's inode (and so any link to it) is never written through. */
  async #replace(absolute: string, content: Buffer, exists: boolean): Promise<void> {
    const temporary = `${absolute}.nn-${randomBytes(8).toString("hex")}.tmp`;
    let mode = 0o644;
    if (exists) mode = (await lstat(absolute)).mode & 0o777;
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
      created = true;
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      if (process.platform !== "win32") await chmod(temporary, mode);
      await rename(temporary, absolute);
    } catch (error) {
      if (created) await rm(temporary, { force: true });
      throw error instanceof WorkspaceError ? error : new WorkspaceError("unavailable", "the file could not be written");
    }
  }

  async #keep(path: string, operation: "write" | "delete", request: { expectedVersion: string; author: string; reason: string; content?: Buffer | undefined }, found: string): Promise<WriteResult> {
    const waiting = await readdir(join(this.#state, "pending")).then((names) => names.filter((n) => n.endsWith(".json")).length, () => 0);
    if (waiting >= BRIDGE_LIMITS.pending) throw new WorkspaceError("unavailable", `${BRIDGE_LIMITS.pending} changes are already waiting for review; the file was not written and this change could not be kept`);
    const id = randomBytes(16).toString("hex");
    const change: PendingChange = { id, path, author: request.author, reason: request.reason, at: this.#clock(), expectedVersion: request.expectedVersion, foundVersion: found, operation, ...(request.content === undefined ? {} : { content: request.content.toString("base64") }), state: "pending" };
    await this.#store(change);
    return { status: "rejected", pendingId: id, foundVersion: found };
  }

  /** Moves a decided change from the waiting records to the decided ones, whole. */
  async #settle(change: PendingChange): Promise<void> {
    await this.#store(change, "decided");
    await rm(join(this.#state, "pending", `${change.id}.json`), { force: true });
  }

  async #store(change: PendingChange, dirName: "pending" | "decided" = "pending"): Promise<void> {
    await mkdir(join(this.#state, dirName), { recursive: true, mode: 0o700 });
    const file = join(this.#state, dirName, `${change.id}.json`);
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(change, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }

  /**
   * One holder at a time per key, under a lock directory outside the shared tree. The lock carries a token of its holder and its modification time is refreshed while the body runs; a lock not touched for a
   * minute (a holder that died) is taken over by renaming it away first, so two waiters cannot both clear it and both take it, and a holder only ever removes a lock that still carries its own token.
   * A path key is the collision key of the path, so every spelling a filesystem treats as one file shares one lock.
   */
  async #locked<T>(key: string, body: () => Promise<T>): Promise<T> {
    const id = createHash("sha256").update(key.startsWith("decision/") ? key : `path/${collisionKey(splitRelative(key))}`).digest("hex").slice(0, 32);
    const dir = join(this.#state, "locks");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, `${id}.lock`);
    const token = randomBytes(12).toString("hex");
    const until = Date.now() + BRIDGE_LIMITS.lockMs;
    for (;;) {
      try { await mkdir(lock); await writeFile(join(lock, "owner"), token); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new WorkspaceError("unavailable", "the lock could not be taken");
        const age = await lstat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > BRIDGE_LIMITS.staleLockMs && (await this.#clearStale(lock))) continue;
        if (Date.now() > until) throw new WorkspaceError("unavailable", "another change to this file is in progress");
        await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
      }
    }
    const beat = setInterval(() => { const now = new Date(); void utimes(lock, now, now).catch(() => undefined); }, Math.floor(BRIDGE_LIMITS.staleLockMs / 4));
    try { return await body(); } finally {
      clearInterval(beat);
      const mine = await readFile(join(lock, "owner"), "utf8").then((t) => t === token, () => false);
      if (mine) await rm(lock, { recursive: true, force: true });
    }
  }

  /**
   * Clears a lock whose holder is gone. Only one waiter at a time may do so (a second lock, taken with `mkdir`, serialises thieves), and the thief looks at the lock again once it holds that lock, so a
   * lock another waiter took a moment ago (fresh) is never removed. Returns whether it is worth trying the lock again.
   */
  async #clearStale(lock: string): Promise<boolean> {
    const steal = `${lock}.steal`;
    try { await mkdir(steal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // A thief that died leaves its lock behind; one that has held it far longer than any removal takes is cleared the plain way.
      const held = await lstat(steal).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (held > BRIDGE_LIMITS.staleLockMs * 3) await rm(steal, { recursive: true, force: true });
      return false;
    }
    try {
      const age = await lstat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => undefined);
      if (age !== undefined && age > BRIDGE_LIMITS.staleLockMs) await rm(lock, { recursive: true, force: true });
      return true;
    } finally { await rm(steal, { recursive: true, force: true }); }
  }
}
