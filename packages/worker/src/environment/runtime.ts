import { lstatSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep, basename } from "node:path";
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, digestOf, validPackageName, validPackageVersion, type ArchiveLimits } from "./archive.js";
import { AgentEnvironments, EnvironmentStoreError, manifestDigestOf, type InstallScriptPort, type PackageRef } from "./agent-environments.js";
import type { ArtifactSource } from "./sources.js";
import { ContentStore, DIGEST_FORM, StoreError } from "./store.js";
import { makeTemp, removeAll, scanTree, type FileIo } from "./tree.js";

// The shapes below restate the controller's `EnvironmentRuntime` port (the worker package depends on no other package of the product); the integration tests assign a value of this class to the controller's type, which fails to compile if they drift.
export interface RuntimeManifest {
  readonly base: { readonly name: string; readonly version: string; readonly digest: string };
  readonly packages: readonly { readonly name: string; readonly version: string; readonly digest: string }[];
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly diskMb: number; readonly processes: number };
  readonly protectedExtensions: readonly { readonly name: string; readonly digest: string }[];
}
export interface RuntimeApproved { readonly name: string; readonly version: string; readonly digest: string; readonly source: string }
export interface RuntimeTrialInput { readonly requestId: string; readonly agentId: string; readonly kind: "package" | "extension"; readonly artifact: RuntimeApproved; readonly installScripts: boolean; readonly candidate: RuntimeManifest }
export type RuntimeTrialResult =
  | { readonly ok: true; readonly digestVerified: boolean; readonly scriptsDeclared: boolean; readonly scriptsRan: boolean; readonly notes?: string }
  | { readonly ok: false; readonly reason: string };
export interface RuntimeReloadInput { readonly requestId: string; readonly agentId: string; readonly revision: number; readonly manifest: RuntimeManifest; readonly checkpointId: string; readonly change?: RuntimeApproved & { readonly installScripts: boolean } }
export type RuntimeReloadResult = { readonly ok: true; readonly observed: Readonly<Record<string, string>> } | { readonly ok: false; readonly reason: string };
export type RuntimeValidateResult = { readonly ok: true; readonly sessionIntact: boolean; readonly compactionIntact: boolean } | { readonly ok: false; readonly reason: string };

/** What the host does with a revision that became the agent's environment. */
export interface WorkerHooks {
  /** Starts (or points) the agent's worker on the active revision, restoring its session from the checkpoint. `directory` is the revision's real path; `packages` the part to mount read-only. A throw undoes the switch. May be absent when the host relaunches the worker at the next attempt from the `active` link. */
  restart?(event: { readonly agentId: string; readonly revision: number; readonly directory: string; readonly checkpointId: string }): Promise<void>;
  /** Whether the worker found the session and the compaction state it had at the checkpoint. */
  session(event: { readonly agentId: string; readonly revision: number; readonly checkpointId: string }): Promise<{ readonly sessionIntact: boolean; readonly compactionIntact: boolean }>;
}

export interface LocalEnvironmentRuntimeOptions {
  /** The host's environments directory (absolute, outside the controller's data directory, private). */
  readonly root: string;
  readonly worker: WorkerHooks;
  /** Where approved artifacts are fetched from. Absent: a request whose artifact is not already in the store fails (nothing is fetched). */
  readonly source?: ArtifactSource;
  /** Runs install scripts, in a sandbox. Absent: a request approved with scripts fails, one without never needs it. */
  readonly scripts?: InstallScriptPort;
  /** Where the controller-owned (protected) extensions live: `<directory>/<name>` is a file or directory whose digest is reported as what the worker found. */
  readonly extensions?: { readonly directory: string };
  readonly limits?: ArchiveLimits;
  readonly io?: FileIo;
  readonly failpoint?: (name: string) => void;
  readonly lockWaitMs?: number;
}

const EXTENSION_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/[\u0000-\u001f]+/g, " ").slice(0, 300);

/** A directory for the runtime: absolute, made private (0700), not a link. Returns its real path. */
export function privateRoot(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("the environments directory must be an absolute path");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("the environments directory must be a real directory, not a link");
  chmodSync(path, 0o700);
  return realpathSync(path);
}
/** Where a host keeps its agents' environments: a directory BESIDE the controller's data directory (`<data>.environments`), never inside it (the data directory is a protected path no sandbox mount may reach). */
export const hostEnvironmentsBase = (dataDirectory: string): string => join(dirname(resolve(dataDirectory)), `${basename(resolve(dataDirectory))}.environments`);

/**
 * The concrete `EnvironmentRuntime` for the local worker host (card A09 follow-up). `trial` fetches the approved artifact, checks its digest before unpacking anything, unpacks it under the safety rules of `unpack`, and builds the candidate
 * environment in a disposable directory (running install scripts there only when the request was approved with them, only in the sandbox). `reload` builds the revision in the agent's own environment directory from digest-verified
 * store entries, switches the agent's `active` link atomically and tells the worker (and undoes the switch if the worker cannot take it). `validate` checks that the revision on disk is whole and asks the worker about its session.
 * It never starts anything outside the sandbox, never fetches in `reload` what the trial did not already verify (a fetch there is checked against the same digest), and keeps every file under its own root.
 */
export class LocalEnvironmentRuntime {
  readonly store: ContentStore;
  readonly environments: AgentEnvironments;
  readonly #root: string;
  readonly #opts: LocalEnvironmentRuntimeOptions;
  readonly #limits: ArchiveLimits;
  constructor(options: LocalEnvironmentRuntimeOptions) {
    this.#opts = options; this.#limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
    this.#root = privateRoot(options.root);
    this.store = new ContentStore({ root: this.#root, limits: this.#limits, ...(options.io === undefined ? {} : { io: options.io }), ...(options.failpoint === undefined ? {} : { failpoint: options.failpoint }) });
    this.environments = new AgentEnvironments({ root: this.#root, store: this.store, ...(options.scripts === undefined ? {} : { scripts: options.scripts }), ...(options.io === undefined ? {} : { io: options.io }), ...(options.failpoint === undefined ? {} : { failpoint: options.failpoint }), ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }) });
  }
  get root(): string { return this.#root; }

  /** Cleans up what a crashed process left (working directories, half-made links). Call once at start. */
  async recover(): Promise<number> { return this.environments.recover(); }

  /** Gets the approved artifact into the store: already there and intact, or fetched from the source and checked against the digest before anything is unpacked. */
  async #ensure(artifact: RuntimeApproved): Promise<void> {
    if (!DIGEST_FORM.test(artifact.digest) || !validPackageName(artifact.name) || !validPackageVersion(artifact.version)) throw new StoreError("invalid", "the approved name, version or digest is not in an accepted form");
    try { const have = await this.store.get(artifact.digest); if (have.name === artifact.name && have.version === artifact.version) return; } catch (error) { if (!(error instanceof StoreError) || (error.code !== "missing" && error.code !== "corrupt")) throw error; }
    if (this.#opts.source === undefined) throw new StoreError("missing", "this host has no way to fetch the artifact and it is not in the local store");
    let bytes: Uint8Array;
    try { bytes = await this.#opts.source.fetch(artifact.source, this.#limits.maxArchiveBytes); } catch (error) { throw new StoreError("missing", `the artifact could not be fetched: ${say(error)}`); }
    await this.store.put(bytes, artifact);
  }

  async trial(input: RuntimeTrialInput): Promise<RuntimeTrialResult> {
    let work: string | undefined;
    try {
      this.environments.agentDir(input.agentId);
      if (input.candidate.packages.some((p) => p.name === input.artifact.name && (p.version !== input.artifact.version || p.digest !== input.artifact.digest))) return { ok: false, reason: "the candidate environment does not list the approved artifact" };
      if (!input.candidate.packages.some((p) => p.name === input.artifact.name)) return { ok: false, reason: "the candidate environment does not list the approved artifact" };
      // The digest is checked before anything is unpacked, whether the bytes were fetched now or are already stored: a store hit is itself a verified, intact entry for this digest.
      await this.#ensure(input.artifact);
      const stored = await this.store.get(input.artifact.digest);
      const declared = stored.scripts.length > 0;
      work = await makeTemp(join(this.#root, "trials"), "trial");
      const refs: PackageRef[] = input.candidate.packages.map((p) => ({ name: p.name, version: p.version, digest: p.digest }));
      const run = input.installScripts && declared;
      if (run && !this.environments.hasScripts) return { ok: false, reason: "install scripts were approved but this host has no sandbox to run them in; nothing was run" };
      // The other packages come as the agent has them (with what their install scripts made), so the trial tries the environment the reload will build.
      const reuse = await this.environments.reuseOrder(input.agentId);
      const built = await this.environments.build(join(work, "env"), refs, { ...(run ? { runScriptsFor: input.artifact.digest } : {}), diskMb: input.candidate.limits.diskMb, reuse });
      const mine = built.find((b) => b.name === input.artifact.name);
      return { ok: true, digestVerified: true, scriptsDeclared: declared, scriptsRan: mine?.scriptsRan === true && run, ...(run ? { notes: "install scripts ran in the sandbox" } : {}) };
    } catch (error) {
      return { ok: false, reason: this.#why(error) };
    } finally { if (work !== undefined) await removeAll(work); }
  }

  #why(error: unknown): string {
    if (error instanceof StoreError && error.code === "digest_mismatch") return `digest mismatch: ${error.message}`;
    if (error instanceof StoreError || error instanceof EnvironmentStoreError || error instanceof ArchiveError) return say(error);
    if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") return "the disk is full; nothing was installed";
    return `unexpected failure: ${say(error)}`;
  }

  async reload(input: RuntimeReloadInput): Promise<RuntimeReloadResult> {
    try {
      this.environments.agentDir(input.agentId);
      const refs: PackageRef[] = input.manifest.packages.map((p) => ({ name: p.name, version: p.version, digest: p.digest }));
      if (input.change !== undefined) {
        const c = input.change;
        if (!refs.some((p) => p.name === c.name && p.version === c.version && p.digest === c.digest)) return { ok: false, reason: "the manifest does not list the approved artifact, so nothing was installed" };
        await this.#ensure(c);
      }
      const runScriptsFor = input.change !== undefined && input.change.installScripts === true ? input.change.digest : undefined;
      const expected = manifestDigestOf(refs);
      await this.environments.stage(input.agentId, input.revision, refs, { ...(runScriptsFor === undefined ? {} : { runScriptsFor }), diskMb: input.manifest.limits.diskMb });
      const { links } = await this.environments.activate(input.agentId, input.revision, expected);
      try {
        const directory = realpathSync(this.environments.revisionDir(input.agentId, input.revision));
        await this.#opts.worker.restart?.({ agentId: input.agentId, revision: input.revision, directory, checkpointId: input.checkpointId });
      } catch (error) {
        // The worker could not take the revision: the links go back to exactly what they were (no active revision when there was none), so the agent's environment is the one it had.
        let undo = "";
        try { await this.environments.restore(input.agentId, links); } catch (problem) { undo = `; the switch could not be undone (${say(problem)}), revision ${input.revision} may still be active`; }
        return { ok: false, reason: `the worker could not be restarted on revision ${input.revision}: ${say(error)}${undo}` };
      }
      return { ok: true, observed: await this.#observe(input.manifest.protectedExtensions.map((e) => e.name)) };
    } catch (error) { return { ok: false, reason: this.#why(error) }; }
  }

  async #observe(names: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const base = this.#opts.extensions?.directory;
    if (base === undefined) return out;
    for (const name of names) {
      if (!EXTENSION_NAME.test(name)) continue;
      const path = join(base, name);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) continue; // a link is not where the controller put an extension
        out[name] = info.isDirectory() ? (await scanTree(path, this.#limits)).digest : digestOf(await readFile(path));
      } catch { /* not found where it loads: left out, and the controller then refuses to activate */ }
    }
    return out;
  }

  async validate(input: RuntimeReloadInput): Promise<RuntimeValidateResult> {
    try {
      const refs = input.manifest.packages.map((p) => ({ name: p.name, version: p.version, digest: p.digest }));
      const live = await this.environments.active(input.agentId);
      if (live !== input.revision) return { ok: false, reason: `revision ${String(live)} is active here, not ${input.revision}` };
      await this.environments.verify(input.agentId, input.revision, manifestDigestOf(refs));
      const seen = await this.#opts.worker.session({ agentId: input.agentId, revision: input.revision, checkpointId: input.checkpointId });
      return { ok: true, sessionIntact: seen.sessionIntact === true, compactionIntact: seen.compactionIntact === true };
    } catch (error) { return { ok: false, reason: this.#why(error) }; }
  }

  /** The real path of the agent's active packages directory, for a read-only mount into the agent's sandbox; undefined when it has no active revision. Never follows a link out of the environments directory. */
  async activePackages(agentId: string): Promise<string | undefined> {
    const revision = await this.environments.active(agentId);
    if (revision === undefined) return undefined;
    const real = realpathSync(join(this.environments.revisionDir(agentId, revision), "packages"));
    if (!real.startsWith(this.#root + sep)) throw new Error("the active environment is not inside the environments directory");
    await this.environments.verify(agentId, revision);
    return real;
  }
}
