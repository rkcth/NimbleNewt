import { readFileSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StorageError } from "../errors.js";

/** Linux `statfs` magic numbers of network and shared-memory-less file systems on which SQLite locking is not reliable. */
const NETWORK_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"], [0x517b, "SMB"], [0xff534d42, "CIFS"], [0xfe534d42, "SMB2"], [0x5346414f, "AFS"], [0x00c36400, "Ceph"],
  [0x01021997, "9p"], [0x0bd00bd0, "Lustre"], [0x47504653, "GPFS"], [0x73757245, "Coda"],
]);
const NETWORK_TYPES = /^(nfs\d?|cifs|smb3?|smbfs|afs|ceph|9p|lustre|gpfs|glusterfs|fuse\.(sshfs|s3fs|gcsfuse|davfs2?|rclone|glusterfs)|davfs|webdav)$/;

/**
 * Refuses a database location on a network file system, where SQLite's locking cannot be trusted (the design forbids sharing
 * a SQLite file over a network). Best effort and honest about it: on Linux it checks the file system type of the directory
 * and the mount table; on every platform it rejects UNC paths (`\\server\share`, `//server/share`). It cannot see a mapped
 * network drive on Windows or a network mount on macOS, and a FUSE mount that hides its backing store looks local; the
 * operator remains responsible for those. Returns the problem, or `undefined` if nothing suspicious was found.
 */
export function networkFilesystemProblem(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  // `\\server\share` is a UNC path everywhere. `//server/share` is one only on Windows; on POSIX, `//var/lib` is an ordinary path.
  if (/^\\\\[^\\/?]/.test(path) && !/^\\\\\?\\[A-Za-z]:/.test(path)) return `${path} is a network (UNC) path`;
  if (platform === "win32" && /^\/\/[^\\/?]/.test(path) && !/^\/\/\?\/[A-Za-z]:/.test(path)) return `${path} is a network (UNC) path`;
  if (platform !== "linux") return undefined;
  const directory = dirname(resolve(path));
  try {
    const type = statfsSync(directory).type;
    const named = NETWORK_MAGIC.get(type >>> 0);
    if (named !== undefined) return `${directory} is on a ${named} file system`;
  } catch {
    /* an unreadable directory is reported when the database is opened */
  }
  try {
    let best: { mount: string; type: string } | undefined;
    for (const line of readFileSync("/proc/self/mounts", "utf8").split("\n")) {
      const [, mount, type] = line.split(" ");
      if (mount === undefined || type === undefined) continue;
      const point = mount.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if ((directory === point || directory.startsWith(point.endsWith("/") ? point : `${point}/`)) && (best === undefined || point.length >= best.mount.length)) best = { mount: point, type };
    }
    if (best !== undefined && NETWORK_TYPES.test(best.type)) return `${directory} is on a ${best.type} mount (${best.mount})`;
  } catch {
    /* no mount table on this system */
  }
  return undefined;
}

export function assertLocalFilesystem(path: string, find: (path: string) => string | undefined = networkFilesystemProblem): void {
  const problem = find(path);
  if (problem !== undefined) throw new StorageError("unavailable", `refusing to put a SQLite controller database on a network file system: ${problem}. Use local storage, or the PostgreSQL backend.`);
}
