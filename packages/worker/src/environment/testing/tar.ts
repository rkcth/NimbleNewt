import { gzipSync } from "node:zlib";
import { METADATA_FILE, digestOf } from "../archive.js";

export interface TarEntry {
  readonly path: string; readonly data?: string | Buffer; readonly mode?: number;
  /** '0' file (default), '5' directory, '2' symlink, '1' hard link, '3' character device, 'x' pax header, ... */
  readonly type?: string; readonly linkname?: string;
  /** Written as given instead of being computed. */
  readonly size?: number; readonly corruptChecksum?: boolean;
}
const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, "0") + "\0";

export function header(e: TarEntry): Buffer {
  const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
  const b = Buffer.alloc(512);
  let name = e.path, prefix = "";
  if (Buffer.byteLength(name) > 100) { const cut = name.lastIndexOf("/", 155 + 1 + 99); prefix = name.slice(0, cut); name = name.slice(cut + 1); }
  b.write(name, 0, "utf8"); b.write(octal(e.mode ?? (e.type === "5" ? 0o755 : 0o644), 8), 100, "latin1");
  b.write(octal(0, 8), 108, "latin1"); b.write(octal(0, 8), 116, "latin1");
  b.write(octal(e.size ?? (e.type === "5" || e.type === "2" || e.type === "1" ? 0 : data.length), 12), 124, "latin1"); b.write(octal(0, 12), 136, "latin1");
  b.fill(0x20, 148, 156); b.write(e.type ?? "0", 156, "latin1"); if (e.linkname !== undefined) b.write(e.linkname, 157, "utf8");
  b.write("ustar\0", 257, "latin1"); b.write("00", 263, "latin1"); b.write(prefix, 345, "utf8");
  let sum = 0; for (const x of b) sum += x;
  b.write(e.corruptChecksum === true ? "000001\0 " : sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return b;
}
export function tar(entries: readonly TarEntry[], options: { readonly trailing?: Buffer; readonly noEnd?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e));
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    if (e.type === undefined || e.type === "0" || e.type === "x") { parts.push(data); parts.push(Buffer.alloc((512 - (data.length % 512)) % 512)); }
  }
  if (options.noEnd !== true) parts.push(Buffer.alloc(1024));
  if (options.trailing !== undefined) parts.push(options.trailing);
  return Buffer.concat(parts);
}
export const gz = (b: Buffer): Buffer => gzipSync(b);

export interface FixturePackage { readonly name: string; readonly version: string; readonly files?: Record<string, string>; readonly scripts?: Record<string, string>; readonly extra?: readonly TarEntry[] }
/** A well-formed package archive (gzip) and its digest. */
export function fixture(p: FixturePackage): { readonly bytes: Buffer; readonly digest: string; readonly name: string; readonly version: string } {
  const meta = JSON.stringify({ name: p.name, version: p.version, ...(p.scripts === undefined ? {} : { scripts: p.scripts }) });
  const entries: TarEntry[] = [{ path: METADATA_FILE, data: meta }, ...Object.entries(p.files ?? { "index.js": "module.exports = 1;\n" }).map(([path, data]) => ({ path, data })), ...(p.extra ?? [])];
  const bytes = gz(tar(entries));
  return { bytes, digest: digestOf(bytes), name: p.name, version: p.version };
}
