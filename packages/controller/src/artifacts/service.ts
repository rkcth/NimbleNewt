import { BlobError, FileBlobStore, isDigest, type BlobProblem } from "./blobs.js";
import { canonicalJson } from "../storage/json.js";
import type { JsonObject } from "../storage/types.js";
import { LIMITS as STORAGE_LIMITS } from "../storage/types.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { artifactId as checkArtifactId, onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type CommandMeta, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import type { TaskBody } from "../domain/model.js";
import { MANIFEST_LIMITS, checkEntries, checkPath, manifestDigest, type ManifestEntry } from "./manifest.js";

export interface PublishArtifact extends CommandMeta {
  /** A human label. Not identity: the artifact's identity is derived from the command ID. */
  readonly name: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly files: readonly { readonly path: string; readonly content: Uint8Array | AsyncIterable<Uint8Array> }[];
}

export interface ArtifactBody {
  readonly name: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly entries: readonly ManifestEntry[];
  /** `manifestDigest(entries)`, recorded at publication; verification recomputes it. */
  readonly manifestDigest: string;
  readonly totalBytes: number;
  readonly createdBy: string;
}

export interface ArtifactProblem {
  readonly path: string;
  readonly digest: string;
  readonly problem: BlobProblem | "manifest_mismatch";
}

/** The result of checking an artifact against its blobs. `ok` is false if anything is missing, changed or truncated: the artifact must not be used. */
export interface Verification {
  readonly artifactId: string;
  readonly ok: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly problems: readonly ArtifactProblem[];
}

export interface OrphanReport {
  readonly dryRun: boolean;
  /** Blobs in the store when cleanup began. */
  readonly examined: number;
  /** Blobs some artifact refers to: never touched, however old. */
  readonly referenced: number;
  /** Unreferenced blobs newer than the cutoff, kept in case a publication is about to record them. */
  readonly keptRecent: number;
  /** Unreferenced blobs older than the cutoff: deleted, or only listed on a dry run. */
  readonly orphans: readonly string[];
  readonly tempRemoved: number;
}

const NAME_LIMIT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_PAGE = 500;

/**
 * Immutable, verified artifacts (card S06): sets of files whose bytes live in a content-addressed blob store and whose manifest is a
 * record in controller storage.
 *
 * - **Order.** A publication stores and flushes every blob first and commits the manifest last, as one idempotent command. A crash between
 *   the two leaves unreferenced blobs and no record, never a record that points at bytes that were not stored: nothing is accepted until
 *   its manifest has committed. Repeating the command (same command ID) finishes the job.
 * - **Immutable.** An artifact record is never updated and blobs are named by their content; a change is a new artifact.
 * - **Verified.** `verify` recomputes the manifest digest and hashes every blob; `checkResumable` and `assertResumable` are what resuming
 *   work must call: a missing, truncated or altered blob blocks it. `readFile` returns only bytes that match their recorded hash.
 * - **Orphan cleanup** deletes only blobs no artifact refers to, older than a grace period, while no publication in this process is in
 *   flight (a lock, shared by publications and exclusive for cleanup), and never under a stale epoch. It lists blobs before it reads the
 *   references, so a manifest committed meanwhile is seen.
 *
 * One controller process owns a blob store at a time (the primary, by epoch); nothing enforces that on the disk (no file lock or lease).
 * The lock is per blob directory within a process, so every service that shares a store excludes the others. Across processes, and for a
 * controller deposed mid-cleanup (the epoch is re-checked before each delete, but a delete already under way completes), the only
 * protection is the grace period: with the default of one day such a process can delete only blobs untouched for a day, and a small
 * `olderThanMs` removes that margin. Publications also store their blobs before checking the replay record, so a repeat uploads again and a
 * command ID reused for a different command leaves its blobs behind: both are ordinary orphans.
 */
export class ArtifactService {
  readonly #runner: CommandRunner;
  readonly #blobs: FileBlobStore;

  private constructor(runner: CommandRunner, blobs: FileBlobStore) {
    this.#runner = runner;
    this.#blobs = blobs;
  }

  /** Takes a new primary epoch (deposing earlier services) and returns the service that writes under it. */
  static async open(storage: ConstructorParameters<typeof CommandRunner>[0], blobs: FileBlobStore, options: RunnerOptions & { holder: string }): Promise<ArtifactService> {
    return new ArtifactService(await CommandRunner.acquire(storage, options.holder, options), blobs);
  }

  /** A service that writes under an epoch the controller already took, shared with its other services. */
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, blobs: FileBlobStore, options: RunnerOptions = {}): ArtifactService {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new DomainError("invalid_command", "epoch: must be a whole number of at least 1", { field: "epoch" });
    return new ArtifactService(new CommandRunner(storage, epoch, options), blobs);
  }

  get epoch(): number { return this.#runner.epoch; }

  /** Stores the files, then records the manifest. Idempotent by command ID; a repeat with the same files returns the recorded result. */
  publish(command: PublishArtifact): Promise<CommandResult> {
    return this.#blobs.lock.shared(() => this.#runner.command("artifact.publish", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "name", "projectId", "taskId", "files"]);
      const name = text(command.name, "name", { min: 1, max: NAME_LIMIT });
      const project = command.projectId === undefined ? undefined : checkProjectId(command.projectId);
      const task = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      if (!Array.isArray(command.files)) throw new DomainError("invalid_command", "files: must be a list", { field: "files" });
      const files = command.files as PublishArtifact["files"];
      // Check every path, and the set of paths, before a byte is stored.
      const named = files.map((file, i) => {
        if (file === null || typeof file !== "object") throw new DomainError("invalid_command", `files[${i}]: must be an object`, { field: `files[${i}]` });
        onlyKnown(file, ["path", "content"]);
        return { path: checkPath(file.path, `files[${i}].path`), content: file.content };
      });
      checkEntries(named.map((f) => ({ path: f.path, digest: "0".repeat(64), size: 0 })));
      const entries: ManifestEntry[] = [];
      let total = 0;
      for (const [i, file] of named.entries()) {
        if (!(file.content instanceof Uint8Array) && !(file.content !== null && typeof file.content === "object" && Symbol.asyncIterator in file.content)) throw new DomainError("invalid_command", `files[${i}].content: must be bytes or an async iterable of bytes`, { field: `files[${i}].content` });
        try {
          const stored = await this.#blobs.put(file.content);
          entries.push({ path: file.path, digest: stored.digest, size: stored.size });
          total += stored.size;
        } catch (error) {
          throw blobFailure(error, `files[${i}]`);
        }
      }
      const sorted = checkEntries(entries);
      const digest = manifestDigest(sorted);
      const body: ArtifactBody = { name, ...(project === undefined ? {} : { projectId: project }), ...(task === undefined ? {} : { taskId: task }), entries: sorted, manifestDigest: digest, totalBytes: total, createdBy: meta.actor };
      if (Buffer.byteLength(canonicalJson(body), "utf8") > STORAGE_LIMITS.bodyBytes - 4096) throw new DomainError("invalid_command", "files: the manifest is too large; publish fewer or shorter-named files, or an archive", { field: "files" });
      return {
        payload: { name, ...(project === undefined ? {} : { projectId: project }), ...(task === undefined ? {} : { taskId: task }), manifestDigest: digest, entries: sorted as unknown as JsonObject[] },
        build: async () => {
          if (project !== undefined && (await this.#runner.get("project", project)) === undefined) throw new DomainError("not_found", `project ${project} does not exist`);
          if (task !== undefined) {
            const found = await this.#runner.get("task", task);
            if (found === undefined) throw new DomainError("not_found", `task ${task} does not exist`);
            const owner = (found.body as unknown as TaskBody).projectId;
            if (project !== undefined && owner !== project) throw new DomainError("invalid_command", `task ${task} belongs to project ${owner}, not ${project}`, { field: "taskId" });
          }
          // The bytes must still be there at the moment the record is made. (Within this process nothing can remove them meanwhile.)
          for (const entry of sorted) if (!(await this.#blobs.has(entry.digest))) throw new DomainError("integrity", `blob ${entry.digest} for ${entry.path} is no longer in the store`);
          const id = derivedId("art", meta.commandId);
          return { ref: { kind: "artifact", id }, creates: true, changes: [{ type: "create", ref: { kind: "artifact", id }, body: body as unknown as JsonObject }], detail: { name, manifestDigest: digest, files: sorted.length, bytes: total } };
        },
      };
    }));
  }

  async get(id: string): Promise<View<ArtifactBody> | undefined> {
    const found = await this.#runner.get("artifact", checkArtifactId(id));
    return found === undefined ? undefined : view<ArtifactBody>(found);
  }

  async list(page: { afterId?: string; limit: number }): Promise<View<ArtifactBody>[]> {
    return (await this.#runner.list("artifact", page)).map((a) => view<ArtifactBody>(a));
  }

  /** Checks the artifact against its manifest digest and every one of its blobs. Never throws for damage: damage is the answer. */
  async verify(id: string): Promise<Verification> {
    const artifact = await this.#existing(id);
    const problems: ArtifactProblem[] = [];
    if (manifestDigest(artifact.entries) !== artifact.manifestDigest) problems.push({ path: "", digest: artifact.manifestDigest, problem: "manifest_mismatch" });
    const checked = new Map<string, string>();
    let bytes = 0;
    for (const entry of artifact.entries) {
      const key = `${entry.digest}:${entry.size}`;
      if (!checked.has(key)) {
        try { checked.set(key, await this.#blobs.verify(entry.digest, entry.size)); } catch (error) { if (error instanceof BlobError) checked.set(key, "corrupt"); else throw blobFailure(error, entry.path); }
      }
      const status = checked.get(key)!;
      if (status === "ok") bytes += entry.size; else problems.push({ path: entry.path, digest: entry.digest, problem: status as BlobProblem });
    }
    return { artifactId: id, ok: problems.length === 0, files: artifact.entries.length, bytes, problems };
  }

  /** What resuming work that depends on these artifacts must call: `ok` is false, and `blocked` says why, if any of them is damaged. */
  async checkResumable(ids: readonly string[]): Promise<{ ok: boolean; blocked: Verification[] }> {
    const blocked: Verification[] = [];
    for (const id of new Set(ids)) {
      const result = await this.verify(id);
      if (!result.ok) blocked.push(result);
    }
    return { ok: blocked.length === 0, blocked };
  }

  /** Like `checkResumable`, but throws an `integrity` error naming the first damaged artifact and file. */
  async assertResumable(ids: readonly string[]): Promise<void> {
    const { ok, blocked } = await this.checkResumable(ids);
    if (ok) return;
    const first = blocked[0]!;
    const problem = first.problems[0]!;
    throw new DomainError("integrity", `artifact ${first.artifactId} cannot be used: ${problem.problem}${problem.path === "" ? "" : ` (${problem.path})`}${blocked.length > 1 || first.problems.length > 1 ? ` and ${blocked.reduce((n, b) => n + b.problems.length, 0) - 1} more problem(s)` : ""}`);
  }

  /** One file's verified bytes. A missing or altered blob is an `integrity` error, never data. */
  async readFile(id: string, path: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const artifact = await this.#existing(id);
    const entry = artifact.entries.find((e) => e.path === path);
    if (entry === undefined) throw new DomainError("not_found", `artifact ${id} has no file ${JSON.stringify(path.slice(0, 80))}`);
    try {
      const bytes = await this.#blobs.read(entry.digest, options);
      if (bytes.byteLength !== entry.size) throw new BlobError("corrupt", `blob ${entry.digest} has the wrong size`);
      return bytes;
    } catch (error) {
      if (error instanceof BlobError && (error.code === "missing" || error.code === "corrupt")) throw new DomainError("integrity", `${path} of artifact ${id} cannot be used: ${error.message}`, { cause: error });
      throw blobFailure(error, path);
    }
  }

  /**
   * Deletes blobs that no artifact refers to and that are older than `olderThanMs` (default one day), and stray temporary files from
   * writes that never finished. Refuses to run unless this service still holds the primary epoch. `dryRun` only reports.
   */
  async collectOrphans(options: { olderThanMs?: number; dryRun?: boolean; now?: number } = {}): Promise<OrphanReport> {
    const olderThanMs = options.olderThanMs ?? DAY_MS;
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new DomainError("invalid_command", "olderThanMs: must be a whole number of at least 0", { field: "olderThanMs" });
    const dryRun = options.dryRun === true;
    return this.#blobs.lock.exclusive(async () => {
      if ((await this.#runner.storage.currentEpoch().catch(() => -1)) !== this.#runner.epoch) throw new DomainError("stale_epoch", "this controller is no longer the primary, so it does not delete anything");
      const cutoff = (options.now ?? Date.now()) - olderThanMs;
      let listed;
      try { listed = await this.#blobs.list(); } catch (error) { throw blobFailure(error, "blob store"); }
      // Listing first, references second: an artifact committed after the listing is still seen, and a blob stored after it is not examined.
      const referenced = new Set<string>();
      for (let after: string | undefined;;) {
        const page = await this.#runner.list("artifact", { ...(after === undefined ? {} : { afterId: after }), limit: SCAN_PAGE });
        for (const aggregate of page) for (const entry of (aggregate.body as unknown as ArtifactBody).entries) referenced.add(entry.digest);
        if (page.length < SCAN_PAGE) break;
        after = page[page.length - 1]!.id;
      }
      const orphans: string[] = [];
      let keptRecent = 0;
      let referencedCount = 0;
      for (const blob of listed) {
        if (referenced.has(blob.digest)) referencedCount += 1;
        else if (blob.modifiedMs >= cutoff) keptRecent += 1;
        else orphans.push(blob.digest);
      }
      let tempRemoved = 0;
      if (!dryRun) {
        try {
          for (const digest of orphans) {
            // A controller deposed while it works stops at once rather than finishing its list.
            if ((await this.#runner.storage.currentEpoch().catch(() => -1)) !== this.#runner.epoch) throw new DomainError("stale_epoch", "this controller lost the primary epoch while cleaning up, so it stopped deleting");
            await this.#blobs.remove(digest);
          }
          tempRemoved = await this.#blobs.sweepTemp(cutoff);
        } catch (error) { throw blobFailure(error, "blob store"); }
      }
      return { dryRun, examined: listed.length, referenced: referencedCount, keptRecent, orphans, tempRemoved };
    });
  }

  async #existing(id: string): Promise<ArtifactBody> {
    const found = await this.#runner.get("artifact", checkArtifactId(id));
    if (found === undefined) throw new DomainError("not_found", `artifact ${id} does not exist`);
    const body = found.body as unknown as ArtifactBody;
    if (!Array.isArray(body.entries) || body.entries.some((e) => !isDigest(e.digest) || !Number.isSafeInteger(e.size))) throw new DomainError("integrity", `artifact ${id} has a malformed manifest`);
    return body;
  }
}

/** A failure of the blob store, in the domain's terms: bad input stays bad input, anything else is the store being unavailable. */
function blobFailure(error: unknown, where: string): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof BlobError && (error.code === "too_large" || error.code === "invalid")) return new DomainError("invalid_command", `${where}: ${error.message}`, { field: where, cause: error });
  return new DomainError("unavailable", `the blob store could not complete the request (${where}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export { MANIFEST_LIMITS };
