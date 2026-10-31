import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { posix } from "node:path";
import { SandboxError } from "./errors.js";

/** What the resolver needs from the machine; every part is replaceable so the logic runs (and is tested) on any operating system. */
export interface LibraryProbe {
  /** `otool -L <file>` (flag "-L") or `otool -l <file>` (flag "-l"): the text it prints. Throws when it cannot run or the file is not a Mach-O binary. */
  readonly otool: (flag: "-L" | "-l", file: string) => string;
  readonly isSymlink: (path: string) => boolean;
  readonly readlink: (path: string) => string;
  readonly exists: (path: string) => boolean;
  /** Identity of a file for the cache (its modification time and size). */
  readonly stamp: (path: string) => string;
}

export const realProbe: LibraryProbe = {
  otool: (flag, file) => execFileSync("/usr/bin/otool", [flag, file], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }),
  isSymlink: (p) => lstatSync(p).isSymbolicLink(),
  readlink: (p) => readlinkSync(p),
  exists: (p) => { try { statSync(p); return true; } catch { return false; } },
  stamp: (p) => { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; },
};

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

/**
 * The files outside the system a program needs to load, found with `otool` (transitively, through `@rpath`, `@loader_path` and `@executable_path`), as the exact paths to open: for every library
 * the path as named, every symbolic link on the way to it and its real path. Libraries in the system's own places, and anything in `alreadyReadable`, add nothing. A library that cannot be
 * found, or an `otool` that fails, refuses the launch naming the library, so the confined program never aborts at start with an opaque loader message.
 */
export function dependentLibraryReads(executable: string, probe: LibraryProbe, alreadyReadable: readonly string[] = []): string[] {
  const reads = new Set<string>();
  const seen = new Set<string>();
  const skip = (p: string): boolean => under(p, SYSTEM_READABLE) || under(p, alreadyReadable);
  const exeDir = posix.dirname(executable);
  const visit = (file: string): void => {
    const real = symlinkChain(file, probe).real;
    if (seen.has(real)) return;
    seen.add(real);
    if (seen.size > MAX_LIBRARIES) throw new SandboxError("invalid_recipe", `${executable} needs more than ${MAX_LIBRARIES} libraries; refusing to open that many to the sandbox`);
    let deps: string[];
    let rpaths: string[];
    try { deps = parseDependents(probe.otool("-L", real)); rpaths = parseRpaths(probe.otool("-l", real)); } catch (error) {
      throw new SandboxError("invalid_recipe", `the libraries of ${real} could not be listed (otool failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}); the sandbox cannot be given read access to them`, { cause: error });
    }
    const loaderDir = posix.dirname(real);
    const expand = (p: string, rp: string): string => rp.replace(/^@loader_path/, loaderDir).replace(/^@executable_path/, exeDir) + p;
    for (const dep of deps) {
      let candidates: string[];
      if (dep.startsWith("@rpath/")) candidates = rpaths.map((rp) => posix.normalize(expand(dep.slice(6), rp)));
      else if (dep.startsWith("@loader_path/") || dep.startsWith("@executable_path/")) candidates = [posix.normalize(expand(dep.slice(dep.indexOf("/")), dep.slice(0, dep.indexOf("/"))))];
      else candidates = [dep];
      candidates = candidates.filter((c) => posix.isAbsolute(c));
      // System libraries are in the dyld shared cache and may not exist as files at all: never required to be found.
      if (candidates.length > 0 && candidates.every(skip)) continue;
      const found = candidates.find((c) => !skip(c) && probe.exists(c));
      if (found === undefined) {
        if (candidates.some(skip)) continue;
        throw new SandboxError("invalid_recipe", `the library ${dep} that ${real} needs could not be found (${candidates.length === 0 ? "no search path" : `looked at ${candidates.join(", ")}`}); the sandbox cannot be given read access to it`);
      }
      const { links, real: depReal } = symlinkChain(found, probe);
      reads.add(found); links.forEach((l) => reads.add(l)); reads.add(depReal);
      visit(depReal);
    }
  };
  // The program itself: its own place is a read-only mount or a system place already; only its libraries are added.
  visit(executable);
  return [...reads].filter((p) => !skip(p)).sort();
}

/** `dependentLibraryReads` remembered per program path, modification time and size, so a program is inspected once. */
export function cachedLibraryReads(probe: LibraryProbe = realProbe): (executable: string, alreadyReadable: readonly string[]) => string[] {
  const cache = new Map<string, string[]>();
  return (executable, alreadyReadable) => {
    let stamp: string;
    try { stamp = probe.stamp(executable); } catch (error) { throw new SandboxError("invalid_recipe", `${executable} cannot be read to find its libraries`, { cause: error }); }
    const key = `${executable}\0${stamp}\0${alreadyReadable.join("\0")}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const reads = dependentLibraryReads(executable, probe, alreadyReadable);
    cache.set(key, reads);
    return reads;
  };
}
