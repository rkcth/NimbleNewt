import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readlinkSync, statSync } from "node:fs";
import { posix } from "node:path";
import { SandboxError } from "./errors.js";

/** What the resolver needs from the machine; every part is replaceable so the logic runs (and is tested) on any operating system. */
export interface LibraryProbe {
  /** `otool -L <file>` (flag "-L") or `otool -l <file>` (flag "-l"): the text it prints. Throws when it cannot run or the file is not a Mach-O binary. */
  readonly otool: (flag: "-L" | "-l", file: string) => string;
  readonly isSymlink: (path: string) => boolean;
  readonly readlink: (path: string) => string;
  readonly exists: (path: string) => boolean;
  /** Identity of a file for the cache (its modification time and size). Throws when the file is gone. */
  readonly stamp: (path: string) => string;
  /** The first four bytes of a file as lower-case hex ("" when shorter or unreadable). */
  readonly magic: (path: string) => string;
}

const fsFailure = (what: string, path: string, error: unknown): SandboxError => new SandboxError("invalid_recipe", `${what} ${posix.basename(path)} failed (${(error as NodeJS.ErrnoException).code ?? "error"})`, { cause: error });

export const realProbe: LibraryProbe = {
  otool: (flag, file) => execFileSync("/usr/bin/otool", [flag, file], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }),
  // A path that is not there is not a link (the later existence check says so); any other failure is a refusal, never a raw errno.
  isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return false; throw fsFailure("looking at", p, e); } },
  readlink: (p) => { try { return readlinkSync(p); } catch (e) { throw fsFailure("reading the link", p, e); } },
  exists: (p) => { try { statSync(p); return true; } catch { return false; } },
  stamp: (p) => { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; },
  magic: (p) => {
    let fd: number | undefined;
    try { fd = openSync(p, "r"); const b = Buffer.alloc(4); const n = readSync(fd, b, 0, 4, 0); return n === 4 ? b.toString("hex") : ""; } catch { return ""; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to do */ } }
  },
};

/** Mach-O (32 and 64 bit, either byte order) and universal ("fat") file signatures. */
const MACH_O_MAGICS = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

/** Where a library may live besides the system: Homebrew's two prefixes. The program's own install root and configured extras are added per call. */
export const DEFAULT_LIBRARY_PREFIXES = ["/opt/homebrew", "/usr/local"];

/** Places the profile already lets every program read (and the dynamic linker's shared cache covers): libraries here need nothing added. */
export const SYSTEM_READABLE = ["/usr", "/bin", "/sbin", "/System", "/Library/Frameworks", "/Library/Developer/CommandLineTools"];

const MAX_LIBRARIES = 256;
const MAX_LINKS = 40;

const under = (path: string, roots: readonly string[]): boolean => roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`));

/**
 * Walks a path one component at a time as the kernel does and returns every symbolic link met on the way (each is a file the process must be able to look at) and the final real path.
 * More than 40 links, or a link that cannot be read, is a refusal.
 */
export function symlinkChain(path: string, probe: Pick<LibraryProbe, "isSymlink" | "readlink">): { readonly links: readonly string[]; readonly real: string } {
  if (!posix.isAbsolute(path)) throw new SandboxError("invalid_recipe", `library path ${path} is not absolute`);
  const links: string[] = [];
  let cur = "/";
  let queue = posix.normalize(path).split("/").filter((p) => p !== "");
  while (queue.length > 0) {
    const part = queue.shift()!;
    const next = part === ".." ? posix.dirname(cur) : posix.join(cur, part);
    if (part !== ".." && probe.isSymlink(next)) {
      if (links.length >= MAX_LINKS) throw new SandboxError("invalid_recipe", `too many symbolic links resolving ${path}`);
      links.push(next);
      const target = probe.readlink(next);
      if (posix.isAbsolute(target)) cur = "/";
      queue = [...target.split("/").filter((p) => p !== "" && p !== "."), ...queue];
    } else cur = next;
  }
  return { links, real: cur };
}

export function parseDependents(text: string): string[] {
  const out: string[] = [];
  text.split("\n").slice(1).forEach((line) => { const m = /^\s+(\S.*?) \(compatibility version/.exec(line); if (m !== null) out.push(m[1]!); });
  return out;
}

export function parseRpaths(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!/cmd LC_RPATH\s*$/.test(line)) return;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) { const m = /^\s+path (.+?) \(offset \d+\)/.exec(lines[j]!); if (m !== null) { out.push(m[1]!); break; } }
  });
  return out;
}

/** The value of `name` in the load command `cmd` of `otool -l` output (every such command). */
function loadCommandNames(text: string, cmd: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.replace(/^\s+/, "").replace(/\s+$/, "") !== `cmd ${cmd}`) return;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) { const m = /^\s+name (.+?) \(offset \d+\)/.exec(lines[j]!); if (m !== null) { out.push(m[1]!); break; } }
  });
  return out;
}
/** Libraries the program loads only if present (LC_LOAD_WEAK_DYLIB). */
export function parseWeakDependents(text: string): string[] { return loadCommandNames(text, "LC_LOAD_WEAK_DYLIB"); }
/** A dylib's own install name (LC_ID_DYLIB), which `otool -L` prints first among its dependents. */
export function parseInstallName(text: string): string | undefined { return loadCommandNames(text, "LC_ID_DYLIB")[0]; }

const hostArchs = (arch: string): readonly string[] => arch === "arm64" ? ["arm64", "arm64e"] : arch === "x64" ? ["x86_64", "x86_64h"] : [arch];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Checks that `text` really is otool's report on `file` (first line exactly `<file>:`, or `<file> (architecture <arch>):` for each slice of a universal binary; never "is not an object file") and
 * returns the part that applies to this machine: the whole report for a single-architecture file, the slice(s) of the host architecture for a universal one.
 */
export function hostSlice(text: string, file: string, arch: string = process.arch): string {
  if (text.includes("is not an object file")) throw new SandboxError("invalid_recipe", `${posix.basename(file)} is not a Mach-O file`);
  const lines = text.split("\n");
  const header = new RegExp(`^${escapeRe(file)}(?: \\(architecture (\\S+)\\))?:$`);
  if (!header.test(lines[0] ?? "")) throw new SandboxError("invalid_recipe", `otool's report on ${posix.basename(file)} is not in the expected form`);
  const slices: { arch: string | undefined; lines: string[] }[] = [];
  for (const line of lines) {
    const m = header.exec(line);
    if (m !== null) slices.push({ arch: m[1], lines: [line] }); else slices[slices.length - 1]!.lines.push(line);
  }
  if (slices.every((s) => s.arch === undefined)) return text;
  const mine = slices.filter((s) => s.arch !== undefined && hostArchs(arch).includes(s.arch));
  if (mine.length === 0) throw new SandboxError("invalid_recipe", `${posix.basename(file)} has no part for this machine's architecture (${arch})`);
  return mine[0]!.lines.join("\n");
}

export interface LibraryOptions {
  /** The agent's writable places: a program or library found there is refused. */
  readonly writable?: readonly string[];
  /** Further prefixes a library may live under (beyond Homebrew and the program's own install root). */
  readonly extraPrefixes?: readonly string[];
  /** Host architecture as `process.arch` names it. */
  readonly arch?: string;
  /** Total time allowed for the whole resolution. Default 30 s. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * The files outside the system a program needs to load, found with `otool` (transitively, through `@rpath` of the whole loading chain, `@loader_path` and `@executable_path`), as the exact paths to
 * open: for every library the path as named, every symbolic link on the way to it and its real path. Libraries in the system's own places, and anything in `alreadyReadable`, add nothing.
 * Safety: the program must not be in a writable place (its contents are then the agent's); every library, link and real path must lie under Homebrew's prefixes, the program's own install root or a
 * configured prefix, and must begin with a Mach-O signature; otool's report must be genuine. A library that cannot be found (other than a weak one), or an `otool` that fails, refuses the launch.
 */
export function dependentLibraryReads(executable: string, probe: LibraryProbe, alreadyReadable: readonly string[] = [], options: LibraryOptions = {}): string[] {
  const writable = options.writable ?? [];
  const arch = options.arch ?? process.arch;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30_000);
  const name = posix.basename(executable);
  const exe = symlinkChain(executable, probe);
  const exeReal = exe.real;
  if (under(executable, writable) || under(exeReal, writable) || exe.links.some((l) => under(l, writable))) throw new SandboxError("invalid_recipe", `${name} is in one of the agent's writable directories; its libraries are not looked up`);
  // The program's own install root (…/<root>/bin/<program>), only when it is a real tree and not the top of the disk.
  const rootCandidate = posix.dirname(posix.dirname(exeReal));
  const installRoot = rootCandidate.split("/").filter((p) => p !== "").length >= 2 ? [rootCandidate] : [];
  const allowed = [...DEFAULT_LIBRARY_PREFIXES, ...installRoot, ...(options.extraPrefixes ?? [])];
  const reads = new Set<string>();
  const seen = new Set<string>();
  const skip = (p: string): boolean => under(p, SYSTEM_READABLE) || under(p, alreadyReadable);
  const exeDir = posix.dirname(exeReal);
  const sub = (p: string, loaderDir: string): string => p.replace(/^@loader_path(?=\/|$)/, loaderDir).replace(/^@executable_path(?=\/|$)/, exeDir);
  const report = (flag: "-L" | "-l", file: string): string => {
    let text: string;
    try { text = probe.otool(flag, file); } catch (error) {
      throw new SandboxError("invalid_recipe", `the libraries of ${posix.basename(file)} could not be listed (otool failed); the sandbox cannot be given read access to them`, { cause: error });
    }
    return hostSlice(text, file, arch);
  };
  const visit = (file: string, parentRpaths: readonly string[]): void => {
    const real = symlinkChain(file, probe).real;
    if (seen.has(real)) return;
    seen.add(real);
    if (seen.size > MAX_LIBRARIES) throw new SandboxError("invalid_recipe", `${name} needs more than ${MAX_LIBRARIES} libraries; refusing to open that many to the sandbox`);
    if (now() > deadline) throw new SandboxError("invalid_recipe", `finding the libraries of ${name} took too long`);
    if (!MACH_O_MAGICS.has(probe.magic(real))) throw new SandboxError("invalid_recipe", `${posix.basename(real)} (needed by ${name}) is not a Mach-O file`);
    const listing = report("-L", real);
    const commands = report("-l", real);
    let deps = parseDependents(listing);
    const id = parseInstallName(commands);
    if (id !== undefined && deps[0] === id) deps = deps.slice(1);
    const weak = new Set(parseWeakDependents(commands));
    const loaderDir = posix.dirname(real);
    // Run-path entries are resolved where they are written; a library is searched along its own and all its loaders' entries.
    const chain = [...parseRpaths(commands).map((rp) => posix.normalize(sub(rp, loaderDir))), ...parentRpaths];
    for (const dep of deps) {
      let candidates: string[];
      if (dep.startsWith("@rpath/")) candidates = chain.map((rp) => posix.normalize(`${rp}/${dep.slice(7)}`));
      else if (dep.startsWith("@loader_path/") || dep.startsWith("@executable_path/")) candidates = [posix.normalize(sub(dep, loaderDir))];
      else candidates = [dep];
      candidates = candidates.filter((c) => posix.isAbsolute(c));
      // System libraries are in the dyld shared cache and may not exist as files at all: never required to be found.
      if (candidates.length > 0 && candidates.every(skip)) continue;
      const found = candidates.find((c) => !skip(c) && probe.exists(c));
      if (found === undefined) {
        if (candidates.some(skip) || weak.has(dep)) continue;
        throw new SandboxError("invalid_recipe", `the library ${posix.basename(dep)} that ${posix.basename(real)} needs could not be found; the sandbox cannot be given read access to it`);
      }
      const { links, real: depReal } = symlinkChain(found, probe);
      for (const p of [found, ...links, depReal]) {
        if (skip(p)) continue;
        if (under(p, writable) || !under(p, allowed)) throw new SandboxError("invalid_recipe", `the library ${posix.basename(dep)} needed by ${posix.basename(real)} is outside the places libraries may be read from; refusing`);
      }
      reads.add(found); links.forEach((l) => reads.add(l)); reads.add(depReal);
      visit(depReal, chain);
    }
  };
  visit(executable, []);
  return [...reads].filter((p) => !skip(p)).sort();
}

const CACHE_SIZE = 64;

/**
 * `dependentLibraryReads` remembered per program path (an LRU of 64). The remembered answer is the one for the system alone, so per-run directories do not make new entries; it is checked against
 * the program's and every listed file's modification time and size on each use, and recomputed when any changed or is gone. The agent's directories are applied on every call.
 */
export function cachedLibraryReads(probe: LibraryProbe = realProbe, extraPrefixes: readonly string[] = [], options: Omit<LibraryOptions, "writable" | "extraPrefixes"> = {}): (executable: string, alreadyReadable: readonly string[], writable?: readonly string[]) => string[] {
  const cache = new Map<string, { reads: string[]; stamps: Map<string, string> }>();
  return (executable, alreadyReadable, writable = []) => {
    const name = posix.basename(executable);
    let exeStamp: string;
    try { exeStamp = probe.stamp(executable); } catch (error) { throw new SandboxError("invalid_recipe", `${name} cannot be read to find its libraries`, { cause: error }); }
    const key = executable;
    const hit = cache.get(key);
    const valid = (e: { stamps: Map<string, string> }): boolean => {
      try { return [...e.stamps].every(([p, s]) => probe.stamp(p) === s); } catch { return false; }
    };
    let entry = hit !== undefined && hit.stamps.get(executable) === exeStamp && valid(hit) ? hit : undefined;
    if (entry === undefined) {
      // Run with the writable list too, so a program in an agent directory is refused before anything is cached.
      const reads = dependentLibraryReads(executable, probe, [], { ...options, writable, extraPrefixes });
      const stamps = new Map<string, string>([[executable, exeStamp]]);
      try { reads.forEach((p) => stamps.set(p, probe.stamp(p))); } catch (error) { throw new SandboxError("invalid_recipe", `a library of ${name} disappeared while it was being inspected`, { cause: error }); }
      entry = { reads, stamps };
    }
    cache.delete(key); cache.set(key, entry);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    const exeChain = symlinkChain(executable, probe);
    if (under(executable, writable) || under(exeChain.real, writable)) throw new SandboxError("invalid_recipe", `${name} is in one of the agent's writable directories; its libraries are not looked up`);
    if (entry.reads.some((p) => under(p, writable))) throw new SandboxError("invalid_recipe", `a library of ${name} is in one of the agent's writable directories; refusing`);
    return entry.reads.filter((p) => !under(p, alreadyReadable));
  };
}
