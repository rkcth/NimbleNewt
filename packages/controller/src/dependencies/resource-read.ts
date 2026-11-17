import { createHash } from "node:crypto";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { JsonObject } from "../storage/types.js";
import type { DependencyEntry, ManifestBody, Observation } from "./dependencies.js";

/**
 * What a resume check may spend reading a task's recorded external and MCP resources again (card L04g).
 * - `reads`: resources one observation reads; the rest stay unknown, with that reason.
 * - `bytes`: the largest answer read; a longer one is not hashed (unknown).
 * - `ms`: how long all the reads of one observation may take together; a read still out then is given up (unknown).
 * - `text`: the longest text kept for the reviewer's view of what changed (it is redacted first).
 */
export const RESOURCE_READ_LIMITS = { reads: 10, bytes: 1024 * 1024, ms: 10_000, text: 64 * 1024 } as const;

/** The one request a check makes of an external resource: the web tool's guarded, logged read (`WebFetch.conditionalRead`), under the task's own grant. */
export interface ExternalRead {
  conditionalRead(ctx: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }, url: string, condition: { readonly etag?: string }, maxBytes: number, signal?: AbortSignal): Promise<{ readonly status: number; readonly etag?: string; readonly hash?: string; readonly body?: Uint8Array; readonly tooBig: boolean }>;
}

/** The one request a check makes of an MCP resource: whether the owner allows it (`McpService.resumeReadable`) and the read itself over the checked connection (`RemoteMcpClient.readResource`, bounded). */
export interface McpRead {
  readable(read: { readonly server: string; readonly projectId: string; readonly uri: string; readonly protocol?: string }): Promise<{ readonly serverId: string; readonly protocol: string } | { readonly refused: string }>;
  read(serverId: string, uri: string): Promise<readonly unknown[]>;
}

export interface ResourceReaderPorts {
  /** Whether the owner allows a resume check to read external and MCP resources at all (setting `resume.externalReads`). Read at every observation; a failure to read it is "not allowed". */
  allowed(): Promise<boolean>;
  /** Absent: an installation without the network route reads no external resource (unknown, with that reason). */
  readonly external?: ExternalRead | undefined;
  /** Absent: an installation without remote MCP servers reads no MCP resource. */
  readonly mcp?: McpRead | undefined;
  /** Bounds; defaults `RESOURCE_READ_LIMITS`. */
  readonly limits?: Partial<Record<keyof typeof RESOURCE_READ_LIMITS, number>>;
  /** Told of every read that did not answer, for the log (already redacted and cut). */
  onFault?(detail: string): void;
}

/** What a reading found: the observations by entry ID, and the text of each resource read whole that is text (redacted, bounded), for the reviewer's view. */
export interface ResourceReading { readonly observations: Record<string, Observation>; readonly texts: Record<string, string>; /** The protocol revision each MCP resource was read at (the server's pinned one). */ readonly protocols: Record<string, string> }

const one = (v: string): string => redactText(v.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 200);

/** Text a reviewer may be shown: UTF-8 that decodes cleanly, with no NUL, redacted, of at most `max` characters; else nothing. */
export function keptText(bytes: Uint8Array, max: number = RESOURCE_READ_LIMITS.text): string | undefined {
  if (bytes.byteLength > max * 4) return undefined;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  if (text.includes("\u0000")) return undefined;
  const clean = redactText(text);
  return clean.length > max ? undefined : clean;
}

/** The digest of an MCP resource as a check compares it (card L04g): sha-256 of the canonical JSON of the `contents` list the server answered `resources/read` with. */
export const mcpContentsHash = (contents: readonly unknown[]): string => createHash("sha256").update(canonicalJson({ contents } as unknown as JsonObject)).digest("hex");

/** The text of an MCP answer, when every item of it is text: joined by blank lines. */
const mcpText = (contents: readonly unknown[], max: number): string | undefined => {
  const parts: string[] = [];
  for (const c of contents) {
    const t = (c as { text?: unknown } | null)?.text;
    if (typeof t !== "string") return undefined;
    parts.push(t);
  }
  return keptText(Buffer.from(parts.join("\n\n"), "utf8"), max);
};

/**
 * Reads again, for a resume check, the `external` and `mcp-resource` dependencies a task recorded (card L04g), so the check says `changed` or `unchanged` (or `deleted`) instead of `unknown`. Nothing is read unless the owner allowed it:
 * the owner's switch (`allowed`) for any read at all, then for an external resource a live network grant of the task for its host and port (the web tool's admission, which also decides private addresses and logs the read), and for an
 * MCP resource an approved remote server whose audience holds the project and whose allowed resources name the URI. One request per resource: a conditional GET (with the recorded ETag) or one `resources/read`. Each answer is bounded
 * in size and time; a redirect is not followed; no credential reaches a log (refusal texts are redacted). A resource that is not read is `{ unread: why }`, which the check shows as `unknown` with the reason. It never throws.
 */
export function resourceReader(ports: ResourceReaderPorts): (manifest: ManifestBody, attemptId: string, mode?: "check" | "note") => Promise<ResourceReading> {
  const limit = (k: keyof typeof RESOURCE_READ_LIMITS): number => { const v = ports.limits?.[k]; return v === undefined || !Number.isSafeInteger(v) || v < 0 ? RESOURCE_READ_LIMITS[k] : v; };
  const fault = (detail: string): void => { try { ports.onFault?.(one(detail).slice(0, 300)); } catch { /* a failing log tells nothing */ } };
  // `note` (an agent recording what it read, card L04g): the read is not conditional and needs nothing recorded before; it answers what the resource is now.
  return async (manifest, attemptId, mode = "check") => {
    const observations: Record<string, Observation> = {};
    const texts: Record<string, string> = {};
    const protocols: Record<string, string> = {};
    const wanted = manifest.entries.filter((e) => (e.kind === "external" || e.kind === "mcp-resource") && e.freshness !== "none").sort((a, b) => (a.id < b.id ? -1 : 1));
    if (wanted.length === 0) return { observations, texts, protocols };
    let allowed = false;
    try { allowed = await ports.allowed(); } catch (error) { fault(`the owner's resume.externalReads setting could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    if (!allowed) {
      for (const e of wanted) observations[e.id] = { unread: "the owner has not allowed a resume check to read external or MCP resources (setting resume.externalReads)" };
      return { observations, texts, protocols };
    }
    const reads = limit("reads");
    // A timer of its own (not `AbortSignal.timeout`, whose timer does not keep the process waiting): the bound holds even for a read that holds nothing open.
    const ending = new AbortController();
    const timer = setTimeout(() => ending.abort(), Math.max(1, limit("ms")));
    const deadline = ending.signal;
    const late = new Promise<"late">((resolve) => { if (deadline.aborted) resolve("late"); else deadline.addEventListener("abort", () => resolve("late"), { once: true }); });
    // The text of each read is kept by the read itself and taken only for a read that answered in time.
    const read = new Map<string, string>();
    const readOne = async (e: DependencyEntry): Promise<Observation> => {
      if (e.kind === "external") return await readExternal(e);
      return await readMcp(e);
    };
    const readExternal = async (e: DependencyEntry): Promise<Observation> => {
      if (ports.external === undefined) return { unread: "this controller has no network route for a resume check to read through" };
      let got: Awaited<ReturnType<ExternalRead["conditionalRead"]>>;
      try { got = await ports.external.conditionalRead({ taskId: manifest.taskId, projectId: manifest.projectId, attemptId }, e.key, e.etag === undefined || mode === "note" ? {} : { etag: e.etag }, limit("bytes"), deadline); } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        fault(`the read of ${manifest.taskId}'s external resource ${e.id} did not answer: ${why}`);
        return { unread: deadline.aborted ? "the resource did not answer in time" : why };
      }
      if (got.status === 304) return e.etag === undefined || mode === "note" ? { unread: "the server answered 304 to a read that was not conditional" } : { exists: true, etag: e.etag };
      if (got.status === 404 || got.status === 410) return { exists: false };
      if (got.status >= 300 && got.status < 400) return { unread: `the server redirected (HTTP ${got.status}); a redirect is not followed` };
      if (got.status !== 200) return { unread: `the server answered HTTP ${got.status}` };
      if (got.tooBig) return { unread: `the resource is larger than the ${limit("bytes")} bytes a resume check reads` };
      // A 200 to a read conditional on the recorded ETag, carrying no ETag of its own, says nothing a recorded ETag alone can be compared with.
      if (mode === "check" && e.hash === undefined && got.etag === undefined) return { unread: "only an ETag was recorded and the server answered without one" };
      if (got.body !== undefined) { const t = keptText(got.body, limit("text")); if (t !== undefined) read.set(e.id, t); }
      return { exists: true, ...(got.hash === undefined ? {} : { hash: got.hash }), ...(got.etag === undefined || (mode === "check" && e.etag === undefined) ? {} : { etag: got.etag }) };
    };
    const readMcp = async (e: DependencyEntry): Promise<Observation> => {
      if (ports.mcp === undefined) return { unread: "this controller reaches no remote MCP server" };
      if (mode === "check" && e.hash === undefined) return { unread: "only an ETag was recorded, and an MCP read carries none" };
      let may: Awaited<ReturnType<McpRead["readable"]>>;
      try { may = await ports.mcp.readable({ server: e.server ?? "", projectId: manifest.projectId, uri: e.key, ...(e.protocol === undefined ? {} : { protocol: e.protocol }) }); } catch (error) { return { unread: `whether it may be read could not be told: ${error instanceof Error ? error.message : String(error)}` }; }
      if ("refused" in may) return { unread: may.refused };
      protocols[e.id] = may.protocol;
      let contents: readonly unknown[];
      try { contents = await ports.mcp.read(may.serverId, e.key); } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        fault(`the read of ${manifest.taskId}'s MCP resource ${e.id} did not answer: ${why}`);
        return { unread: why };
      }
      const t = mcpText(contents, limit("text"));
      if (t !== undefined) read.set(e.id, t);
      return { exists: true, hash: mcpContentsHash(contents) };
    };
    const chosen = wanted.slice(0, reads);
    for (const e of wanted.slice(reads)) observations[e.id] = { unread: `more than ${reads} external or MCP resources were recorded; this one was not read` };
    try {
    await Promise.all(chosen.map(async (e) => {
      const o = await Promise.race([readOne(e).catch((error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) }) as Observation), late]);
      observations[e.id] = o === "late" ? { unread: "the resource did not answer in time" } : o.unread === undefined ? o : { unread: one(o.unread) };
      const t = read.get(e.id);
      if (o !== "late" && o.exists === true && t !== undefined) texts[e.id] = t;
    }));
    } finally { clearTimeout(timer); }
    return { observations, texts, protocols };
  };
}
