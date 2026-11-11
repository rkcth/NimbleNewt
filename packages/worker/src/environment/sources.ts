import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** Where an approved artifact's bytes come from: given the request's `source` (an https URL) and the most bytes accepted, the bytes. It is the only part of the runtime that may touch the network, and a host that gives none fetches nothing. */
export interface ArtifactSource { fetch(source: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> }

export class SourceError extends Error { constructor(message: string) { super(message); this.name = "SourceError"; } }

function parse(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new SourceError("the source is not a URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") throw new SourceError("the source must be an https URL without credentials");
  return url;
}

/**
 * An offline mirror: `https://host/a/b.tgz` is read from `<directory>/host/a/b.tgz` (query and fragment ignored). Nothing leaves the machine. A part of the path that is `.`, `..`, empty, percent-encoded into one of those, or has a backslash or NUL is refused,
 * and the file found must really lie inside the mirror once links are resolved, so a link placed in the mirror cannot name another file.
 */
export function directoryArtifactSource(directory: string): ArtifactSource {
  return {
    async fetch(source, maxBytes) {
      const url = parse(source);
      const parts = [url.hostname, ...url.pathname.split("/").slice(1)];
      const decoded = parts.map((p) => { try { return decodeURIComponent(p); } catch { throw new SourceError("the source path is not valid"); } });
      // eslint-disable-next-line no-control-regex
      if (decoded.some((p) => p === "" || p === "." || p === ".." || /[\\/\u0000-\u001f]/.test(p))) throw new SourceError("the source path has a part that is not allowed");
      const root = await realpath(directory);
      const wanted = join(root, ...decoded);
      let real: string;
      try { real = await realpath(wanted); } catch { throw new SourceError("the mirror has no such artifact"); }
      if (!real.startsWith(root + sep)) throw new SourceError("the artifact lies outside the mirror");
      const info = await stat(real);
      if (!info.isFile()) throw new SourceError("the mirror entry is not a file");
      if (info.size > maxBytes) throw new SourceError(`the artifact is ${info.size} bytes; the most accepted is ${maxBytes}`);
      return new Uint8Array(await readFile(real));
    },
  };
}

export interface HttpsSourceOptions {
  /** The fetch function (the platform's by default). The host decides whether this process may reach the network at all. */
  readonly fetch?: typeof fetch;
  /** The hosts that may be fetched from. Required: a source outside the list is refused before any request. */
  readonly hosts: readonly string[];
  readonly timeoutMs?: number;
}
/** Fetches exactly the approved URL over https from an allowed host: no redirect is followed, the size is checked against the declared length and counted while it is read. */
export function httpsArtifactSource(options: HttpsSourceOptions): ArtifactSource {
  const f = options.fetch ?? fetch;
  return {
    async fetch(source, maxBytes, signal) {
      const url = parse(source);
      if (!options.hosts.includes(url.hostname)) throw new SourceError(`${url.hostname} is not a host this installation may fetch from`);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
      const response = await f(url, { redirect: "error", signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), headers: { accept: "application/octet-stream" } });
      if (!response.ok) throw new SourceError(`the source answered ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new SourceError(`the artifact is ${declared} bytes; the most accepted is ${maxBytes}`);
      if (response.body === null) throw new SourceError("the source sent nothing");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) throw new SourceError(`the artifact is larger than the ${maxBytes} bytes accepted`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  };
}
