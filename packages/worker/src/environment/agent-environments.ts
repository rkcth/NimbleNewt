import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf, validPackageName, validPackageVersion } from "./archive.js";
import { ContentStore, StoreError, type StoredPackage } from "./store.js";
import { abandoned, makeTemp, readTree, realIo, removeAll, scanTree, writeTree, type FileIo } from "./tree.js";

export interface PackageRef { readonly name: string; readonly version: string; readonly digest: string }
export interface BuiltPackage extends PackageRef { /** The digest of the package's tree as it is in this revision (after an install script, if one ran). */ readonly treeDigest: string; readonly scriptsRan: boolean; readonly bytes: number }
export interface RevisionRecord { readonly agentId: string; readonly revision: number; readonly manifestDigest: string; readonly packages: readonly BuiltPackage[]; readonly createdAt: string }

/** Runs one install or lifecycle script of a package, inside a boundary, in the package's own directory. It throws when the script fails. */
export interface InstallScriptPort {
  run(run: { readonly dir: string; readonly entry: string; readonly phase: "preinstall" | "install" | "postinstall"; readonly packageName: string }): Promise<void>;
}

export class EnvironmentStoreError extends Error {
  constructor(readonly code: "invalid" | "busy" | "disk" | "corrupt" | "active" | "scripts" | "missing" | "unsafe", message: string) { super(message); this.name = "EnvironmentStoreError"; }
}

export interface AgentEnvironmentsOptions {
  readonly root: string; readonly store: ContentStore;
  readonly scripts?: InstallScriptPort; readonly io?: FileIo;
  readonly failpoint?: (name: string) => void;
  /** How long a second writer waits for an agent's lock before it gives up (default 20 s). */
  readonly lockWaitMs?: number;
}

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A directory name for an id or package name that cannot collide with another and holds no separator. */
export const encodeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
export const manifestDigestOf = (packages: readonly PackageRef[]): string => digestOf(Buffer.from(JSON.stringify([...packages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => [p.name, p.version, p.digest]))));
const MIB = 1024 * 1024;

/**
 * The per-agent environments (card A09 follow-up): `<root>/agents/<agent>/revisions/<n>/{packages/<name>/...,record.json}`, with `active` (and `previous`) as relative links to a revision. A revision is built in a private
 * working directory and moved into `revisions` with one rename, so every revision there is whole; `activate` verifies it and switches `active` with one atomic rename of a link, so a reader sees the old revision or the new one,
 * never a mixture and never a dangling link. Writers to one agent are serialised (a lock directory with the owner's process id, a dead owner's lock is taken over).
 */
export class AgentEnvironments {
  readonly #root: string;
  readonly #store: ContentStore;
  readonly #scripts: InstallScriptPort | undefined;
  readonly #io: FileIo;
  readonly #fail: (name: string) => void;
  readonly #wait: number;
  readonly #local = new Map<string, Promise<unknown>>();
  constructor(options: AgentEnvironmentsOptions) {
    this.#root = options.root; this.#store = options.store; this.#scripts = options.scripts; this.#io = options.io ?? realIo; this.#fail = options.failpoint ?? ((): void => undefined); this.#wait = options.lockWaitMs ?? 20_000;
  }
  get hasScripts(): boolean { return this.#scripts !== undefined; }
  agentDir(agentId: string): string { if (typeof agentId !== "string" || !AGENT.test(agentId) || agentId.includes("..")) throw new EnvironmentStoreError("invalid", "an agent id is letters, digits and . _ : - (at most 128)"); return join(this.#root, "agents", encodeName(agentId)); }
  revisionDir(agentId: string, revision: number): string { if (!Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000) throw new EnvironmentStoreError("invalid", "a revision is a whole number"); return join(this.agentDir(agentId), "revisions", String(revision)); }

  /** Runs `fn` as the only writer of the agent's environment. */
  async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const dir = this.agentDir(agentId);
    const previous = this.#local.get(dir) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(async () => {
      const lock = join(dir, "lock");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const until = Date.now() + this.#wait;
      for (;;) {
        try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, "owner"), `${process.pid}-lock`); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
          if (owner !== undefined && abandoned(owner)) { await removeAll(lock); continue; }
          if (Date.now() > until) throw new EnvironmentStoreError("busy", "another change to this agent's environment is still running");
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      try { return await fn(); } finally { await removeAll(lock); }
    });
    this.#local.set(dir, mine);
    try { return await mine; } finally { if (this.#local.get(dir) === mine) this.#local.delete(dir); }
  }

  /** The active revision number, or undefined when none was ever activated. Throws `corrupt` for a link that is not one of ours. */
  async active(agentId: string, which: "active" | "previous" = "active"): Promise<number | undefined> {
    let target: string;
    try { target = await readlink(join(this.agentDir(agentId), which)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const m = /^revisions\/(\d{1,10})$/.exec(target);
    if (m === null) throw new EnvironmentStoreError("corrupt", `the ${which} link of ${agentId} points somewhere it should not`);
    return Number(m[1]);
  }

  async record(agentId: string, revision: number): Promise<RevisionRecord | undefined> {
    try {
      const raw = await readFile(join(this.revisionDir(agentId, revision), "record.json"), "utf8");
      return JSON.parse(raw) as RevisionRecord;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new EnvironmentStoreError("corrupt", `the record of revision ${revision} cannot be read`); }
  }

  /** Checks a revision on disk against its record: every package present, nothing else, every tree exactly what was recorded. */
  async verify(agentId: string, revision: number, expectedManifest?: string): Promise<RevisionRecord> {
    const record = await this.record(agentId, revision);
    if (record === undefined) throw new EnvironmentStoreError("missing", `revision ${revision} of ${agentId} is not built here`);
    if (expectedManifest !== undefined && record.manifestDigest !== expectedManifest) throw new EnvironmentStoreError("corrupt", `revision ${revision} was built for a different set of packages`);
    if (record.agentId !== agentId || record.revision !== revision || record.manifestDigest !== manifestDigestOf(record.packages)) throw new EnvironmentStoreError("corrupt", `the record of revision ${revision} is inconsistent`);
    const dir = join(this.revisionDir(agentId, revision), "packages");
    const present = await readdir(dir).catch(() => [] as string[]);
    if (present.sort().join("\n") !== record.packages.map((p) => encodeName(p.name)).sort().join("\n")) throw new EnvironmentStoreError("corrupt", `revision ${revision} does not hold exactly its recorded packages`);
    for (const p of record.packages) {
      let scan;
      try { scan = await scanTree(join(dir, encodeName(p.name)), this.#store.limits); } catch (error) { throw new EnvironmentStoreError("corrupt", `${p.name} in revision ${revision} is not a safe tree: ${(error as Error).message}`); }
      if (scan.digest !== p.treeDigest) throw new EnvironmentStoreError("corrupt", `${p.name} in revision ${revision} was changed after it was installed`);
    }
    return record;
  }

  /**
   * Builds the packages of a manifest into `dest` (which must not exist). Each package comes from the store, verified against its digest, or from an intact copy in one of `reuse` (another revision of this agent: that keeps the result of an
   * install script that already ran). An install script runs only for `runScriptsFor` (the digest the owner approved scripts for), only if the package declares one, and only through the script port; the tree it leaves is checked again.
   */
  async build(dest: string, packages: readonly PackageRef[], options: { readonly runScriptsFor?: string; readonly reuse?: readonly { readonly agentId: string; readonly revision: number }[]; readonly diskMb?: number }): Promise<BuiltPackage[]> {
    const names = new Set<string>();
    for (const p of packages) { if (!validPackageName(p.name) || !validPackageVersion(p.version)) throw new EnvironmentStoreError("invalid", "a package has a name or version that is not accepted"); if (names.has(p.name)) throw new EnvironmentStoreError("invalid", `${p.name} is listed twice`); names.add(p.name); }
    await mkdir(join(dest, "packages"), { recursive: true, mode: 0o755 });
    const built: BuiltPackage[] = [];
    let bytes = 0;
    for (const p of packages) {
      const target = join(dest, "packages", encodeName(p.name));
      let stored: StoredPackage;
      try { stored = await this.#store.get(p.digest); } catch (error) { if (error instanceof StoreError) throw new EnvironmentStoreError(error.code === "missing" ? "missing" : "corrupt", `${p.name}@${p.version}: ${error.message}`); throw error; }
      if (stored.name !== p.name || stored.version !== p.version) throw new EnvironmentStoreError("corrupt", `the stored package ${stored.digest} is ${stored.name}@${stored.version}, not ${p.name}@${p.version}`);
      const wantScripts = options.runScriptsFor === p.digest && stored.scripts.length > 0;
      let from: { dir: string; treeDigest: string; scriptsRan: boolean } | undefined;
      if (!wantScripts) {
        for (const r of options.reuse ?? []) {
          const rec = await this.record(r.agentId, r.revision).catch(() => undefined);
          const had = rec?.packages.find((x) => x.name === p.name && x.version === p.version && x.digest === p.digest);
          if (had === undefined) continue;
          const dir = join(this.revisionDir(r.agentId, r.revision), "packages", encodeName(p.name));
          const scan = await scanTree(dir, this.#store.limits).catch(() => undefined);
          if (scan !== undefined && scan.digest === had.treeDigest) { from = { dir, treeDigest: had.treeDigest, scriptsRan: had.scriptsRan }; break; }
        }
      }
      const source = from?.dir ?? stored.dir;
      const scan = await scanTree(source, this.#store.limits);
      bytes += scan.bytes;
      if (options.diskMb !== undefined && bytes > options.diskMb * MIB) throw new EnvironmentStoreError("disk", `the packages need ${Math.ceil(bytes / MIB)} MB, more than this environment's disk limit of ${options.diskMb} MB`);
      try { await writeTree(target, await readTree(source, scan), scan.directories, this.#io); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new EnvironmentStoreError("disk", "the disk filled up while the environment was written; nothing was installed");
        throw error;
      }
      let treeDigest = from?.treeDigest ?? stored.treeDigest;
      let ran = from?.scriptsRan ?? false;
      if (wantScripts) {
        if (this.#scripts === undefined) throw new EnvironmentStoreError("scripts", `install scripts were approved for ${p.name}@${p.version} but this host has no sandbox to run them in; nothing was installed`);
        for (const s of stored.scripts) {
          try { await this.#scripts.run({ dir: target, entry: s.entry, phase: s.phase, packageName: p.name }); } catch (error) { throw new EnvironmentStoreError("scripts", `the ${s.phase} script of ${p.name}@${p.version} failed: ${(error as Error).message.slice(0, 300)}`); }
        }
        let after;
        try { after = await scanTree(target, this.#store.limits); } catch (error) { throw new EnvironmentStoreError("unsafe", `the install script of ${p.name}@${p.version} left something a package may not hold: ${(error as Error).message}`); }
        if (options.diskMb !== undefined && after.bytes > options.diskMb * MIB) throw new EnvironmentStoreError("disk", "the install script made the package larger than the environment's disk limit");
        treeDigest = after.digest; ran = true;
      }
      built.push({ name: p.name, version: p.version, digest: p.digest, treeDigest, scriptsRan: ran, bytes: scan.bytes });
    }
    return built;
  }

  /**
   * Makes revision `revision` of the agent from `packages` (inactive). A revision already built for exactly these packages and intact is reused; one built for others is replaced unless it is the active revision (then it is refused:
   * a revision number names one manifest for good). Returns the record.
   */
  async stage(agentId: string, revision: number, packages: readonly PackageRef[], options: { readonly runScriptsFor?: string; readonly diskMb?: number } = {}): Promise<{ readonly record: RevisionRecord; readonly reused: boolean }> {
    return this.withLock(agentId, async () => {
      const final = this.revisionDir(agentId, revision);
      const manifestDigest = manifestDigestOf(packages);
      const existing = await this.record(agentId, revision).catch(() => undefined);
      if (existing !== undefined) {
        if (existing.manifestDigest === manifestDigest) { try { return { record: await this.verify(agentId, revision, manifestDigest), reused: true }; } catch { /* rebuilt below */ } }
        if ((await this.active(agentId).catch(() => undefined)) === revision) throw new EnvironmentStoreError("active", `revision ${revision} is the active one and was built for other packages; it is not replaced`);
      }
      const work = await makeTemp(join(this.#root, "tmp"), "rev");
      try {
        const reuse = [] as { agentId: string; revision: number }[];
        for (const which of ["active", "previous"] as const) { const n = await this.active(agentId, which).catch(() => undefined); if (n !== undefined && n !== revision) reuse.push({ agentId, revision: n }); }
        const built = await this.build(work, packages, { ...(options.runScriptsFor === undefined ? {} : { runScriptsFor: options.runScriptsFor }), ...(options.diskMb === undefined ? {} : { diskMb: options.diskMb }), reuse });
        const record: RevisionRecord = { agentId, revision, manifestDigest, packages: built, createdAt: new Date().toISOString() };
        await this.#io.writeFile(join(work, "record.json"), Buffer.from(JSON.stringify(record)), 0o644);
        this.#fail("env:built");
        await mkdir(join(final, ".."), { recursive: true, mode: 0o700 });
        if (existing !== undefined) await removeAll(final);
        try { await rename(work, final); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new EnvironmentStoreError("disk", "the disk filled up while the environment was written; nothing was installed"); throw error; }
        return { record: await this.verify(agentId, revision, manifestDigest), reused: false };
      } finally { await removeAll(work); }
    });
  }

  /** Verifies the revision and switches `active` to it with one atomic rename of a link; `previous` keeps the revision that was active. */
  async activate(agentId: string, revision: number, expectedManifest?: string): Promise<{ readonly previous: number | undefined }> {
    return this.withLock(agentId, async () => {
      await this.verify(agentId, revision, expectedManifest);
      const dir = this.agentDir(agentId);
      const before = await this.active(agentId).catch(() => undefined);
      if (before !== undefined && before !== revision) await this.#point(dir, "previous", before);
      this.#fail("env:before-switch");
      await this.#point(dir, "active", revision);
      return { previous: before };
    });
  }

  async #point(dir: string, name: "active" | "previous", revision: number): Promise<void> {
    const temp = join(dir, `.${name}-${process.pid}-${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 12)}`);
    await symlink(`revisions/${revision}`, temp);
    try { await rename(temp, join(dir, name)); } catch (error) { await rm(temp, { force: true }); throw error; }
  }

  /** Removes the half-built leftovers of processes that died (the lock of a dead owner is taken over when the agent is next changed). */
  async recover(): Promise<number> {
    let n = await this.#store.recover();
    const agents = join(this.#root, "agents");
    for (const agent of await readdir(agents).catch(() => [] as string[])) {
      for (const name of await readdir(join(agents, agent)).catch(() => [] as string[])) {
        const m = /^\.(?:active|previous)-(\d+)-/.exec(name);
        if (m !== null && abandoned(`${m[1]}-x`)) { await rm(join(agents, agent, name), { force: true }); n++; }
      }
    }
    return n;
  }
}
