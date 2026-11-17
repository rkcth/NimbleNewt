import { DomainError } from "../domain/errors.js";
import { onlyKnown, taskId as checkTaskId } from "../domain/model.js";
import type { NoActor, Principal } from "../security/principals.js";
import { dependencyEntryId, type DependencyService, type ManifestBody, type NewDependency, type Observation } from "./dependencies.js";
import type { ResourceReading } from "./resource-read.js";

/** How many dependencies one note names (card L04g); a longer list is refused, so a note is one bounded look. */
export const NOTE_LIMITS = { entries: 20 } as const;
/** The kinds an agent notes this way. Tool versions, environments and negative lookups are recorded with `resume.dependencies.record`. */
export const NOTE_KINDS = ["file", "directory", "search", "record", "decision", "external", "mcp-resource"] as const;

/** What an agent names: the kind and the key (a path, a record ID, a URL or a resource URI, a search's words), and what it saw if it wants that checked. */
export interface NoteItem {
  readonly kind: string;
  readonly key: string;
  /** A search's words (default: the key). */
  readonly query?: string;
  readonly hash?: string;
  readonly etag?: string;
  readonly members?: readonly string[];
  /** An external or MCP resource: how it can be checked later (default `conditional-read`). */
  readonly freshness?: "conditional-read" | "authoritative-query" | "none";
  /** An MCP resource: the server's registered name, and the protocol revision (default: the server's pinned one). */
  readonly server?: string;
  readonly protocol?: string;
}

export interface DependencyNotePorts {
  readonly dependencies: Pick<DependencyService, "record" | "searchDependency" | "recordHash" | "mayRecord">;
  /** The controller's look at files and directories of the task now (`entriesLook`): absent, it cannot look, and only what the agent says is recorded. */
  look?(task: { readonly taskId: string; readonly projectId: string }, entries: readonly { readonly id: string; readonly kind: "file" | "directory"; readonly key: string }[]): Promise<Readonly<Record<string, Observation>>>;
  /** The text of a file the look just read, for that hash (`RecentTexts.at`). */
  textAt?(taskId: string, entryId: string, hash: string): string | undefined;
  /** The read of external and MCP resources now (`resourceReader`, `note` mode), under the owner's allowance. */
  resources?(manifest: ManifestBody, attemptId: string, mode: "note"): Promise<ResourceReading>;
}

/** What one note recorded: each dependency's kind and key, and whether the controller looked at it itself (`controller`) or took the recorder's word because it could not (`recorder`, with why). */
export interface NoteResult { readonly recorded: number; readonly entries: readonly { readonly kind: string; readonly key: string; readonly checkedBy: "controller" | "recorder"; readonly why?: string }[] }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sameHash = (a: string, b: string): boolean => a.replace(/^sha256:/, "") === b.replace(/^sha256:/, "");
const weak = (t: string): string => t.replace(/^W\//, "");

/**
 * An agent records what its work relied on and the controller fills in and checks what it saw (card L04g). Before this an agent had to compute hashes itself through the state API, and a Pi agent had no tool for it at all, so in a real run
 * nothing was recorded and a resume knew nothing to check. Here the agent names the kind and the key; the controller:
 * - looks at a file or directory in the task's checkout now (the same look a resume check makes, on the host that holds the checkout) and records its hash or members; a hash or members the agent gives must be what the look sees;
 * - makes a search again (`resume.dependencies.search`) and records its digest and position;
 * - hashes a desk record or decision the agent may read;
 * - reads an external or MCP resource once, only where the owner allowed a resume check to read it (the same allowance and request as at a resume), and records its hash and ETag.
 * What the controller cannot look at is recorded only when the agent gave what it saw (its word, said so in the answer), else that item is refused and nothing of the note is recorded. The text the controller read is kept beside the
 * entry (redacted, bounded) so a later resume can show its reviewer what changed. The recording itself is `DependencyService.record`, with its rights check (the agent working the task, or the owner).
 */
export class DependencyNotes {
  readonly #p: DependencyNotePorts;
  constructor(ports: DependencyNotePorts) { this.#p = ports; }

  async note(by: Principal, command: NoActor & { taskId: string; dependencies: readonly NoteItem[] }): Promise<NoteResult> {
    onlyKnown(command, ["commandId", "taskId", "dependencies"]);
    const taskId = checkTaskId(command.taskId);
    if (!Array.isArray(command.dependencies) || command.dependencies.length < 1 || command.dependencies.length > NOTE_LIMITS.entries) invalid("dependencies", `must list 1 to ${NOTE_LIMITS.entries}`);
    // The right is checked before anything is looked at or read: a caller who may not record for the task makes the controller read nothing.
    const projectId = await this.#p.dependencies.mayRecord(by, taskId);
    if (projectId === undefined) throw new DomainError("forbidden", `${by.id} may not record dependencies for that task`);
    const items = command.dependencies.map((d, i) => item(d, `dependencies[${i}]`));
    // The look at files and directories, all at once (one look of the task's checkout).
    const paths = items.flatMap((d, i) => (d.kind === "file" || d.kind === "directory" ? [{ id: dependencyEntryId(d.kind, d.key), kind: d.kind as "file" | "directory", key: d.key, i }] : []));
    const looked: Readonly<Record<string, Observation>> = paths.length === 0 || this.#p.look === undefined ? {} : await this.#p.look({ taskId, projectId }, paths.map(({ id, kind, key }) => ({ id, kind, key }))).catch(() => ({}));
    // The read of external and MCP resources, all at once, under the owner's allowance.
    const remote = items.flatMap((d) => (d.kind === "external" || d.kind === "mcp-resource" ? [d] : []));
    const read: ResourceReading = remote.length === 0 || this.#p.resources === undefined ? { observations: {}, texts: {}, protocols: {} }
      : await this.#p.resources({ taskId, projectId, entries: remote.map((d) => ({ id: dependencyEntryId(d.kind, d.key), kind: d.kind as "external", key: d.key, observedAt: "", ...(d.server === undefined ? {} : { server: d.server }), ...(d.protocol === undefined ? {} : { protocol: d.protocol }), freshness: d.freshness ?? "conditional-read" })) }, "dependency-note", "note");
    const out: NewDependency[] = []; const texts: (string | undefined)[] = []; const said: NoteResult["entries"][number][] = [];
    for (const [i, d] of items.entries()) {
      const field = `dependencies[${i}]`;
      const id = dependencyEntryId(d.kind, d.key);
      const word = (why: string): void => { said.push({ kind: d.kind, key: d.key, checkedBy: "recorder", why: why.slice(0, 200) }); };
      const mine = (): void => { said.push({ kind: d.kind, key: d.key, checkedBy: "controller" }); };
      switch (d.kind) {
        case "file": {
          const o = looked[id];
          if (o?.exists === false) invalid(field, `there is no ${d.key} in your checkout now`);
          if (o?.hash !== undefined) {
            if (d.hash !== undefined && !sameHash(d.hash, o.hash)) invalid(`${field}.hash`, "is not what the file holds now; the controller looked at it, so leave the hash out to record it as it is");
            out.push({ kind: "file", key: d.key, hash: o.hash }); texts.push(this.#p.textAt?.(taskId, id, o.hash)); mine(); break;
          }
          if (d.hash === undefined) invalid(field, "the controller could not look at that file (outside your checkout or the project's paths, too big, or on a host that did not answer); give its sha-256 hash to record it as you saw it");
          out.push({ kind: "file", key: d.key, hash: d.hash! }); texts.push(undefined); word("the controller could not look at the file"); break;
        }
        case "directory": {
          const o = looked[id];
          if (o?.exists === false) invalid(field, `there is no ${d.key} in your checkout now`);
          if (o?.members !== undefined) {
            if (d.members !== undefined && [...d.members].sort().join("\0") !== [...o.members].sort().join("\0")) invalid(`${field}.members`, "are not what the folder holds now; leave them out to record it as it is");
            out.push({ kind: "directory", key: d.key, members: o.members }); texts.push(undefined); mine(); break;
          }
          if (d.members === undefined) invalid(field, "the controller could not list that folder; give its member names to record it as you saw it");
          out.push({ kind: "directory", key: d.key, members: d.members! }); texts.push(undefined); word("the controller could not list the folder"); break;
        }
        case "search": {
          const made = await this.#p.dependencies.searchDependency(by, { projectId, query: d.query ?? d.key, ...(d.query === undefined ? {} : { key: d.key }) });
          out.push(made); texts.push(undefined); mine(); break;
        }
        case "record": case "decision": {
          const hash = await this.#p.dependencies.recordHash(by, d.key);
          if (hash !== undefined) {
            if (d.hash !== undefined && !sameHash(d.hash, hash)) invalid(`${field}.hash`, "is not the record's content as it is now; leave it out to record it as it is");
            out.push({ kind: d.kind, key: d.key, hash }); texts.push(undefined); mine(); break;
          }
          if (d.hash === undefined) invalid(field, "there is no such record you may read; give its hash to record it as you saw it");
          out.push({ kind: d.kind, key: d.key, hash: d.hash! }); texts.push(undefined); word("there is no such record the recorder may read"); break;
        }
        case "external": case "mcp-resource": {
          const o = read.observations[id];
          const freshness = d.freshness ?? "conditional-read";
          const protocol = d.protocol ?? read.protocols[id];
          if (d.kind === "mcp-resource" && (d.server === undefined || protocol === undefined)) invalid(field, "an MCP resource needs its server's name (and its protocol revision when the controller may not read it)");
          const base = { kind: d.kind, key: d.key, freshness, ...(d.kind === "mcp-resource" ? { server: d.server!, protocol: protocol! } : {}) } as const;
          if (o?.exists === false) invalid(field, "the resource is not there now (the server answered not found)");
          if (o?.exists === true && (o.hash !== undefined || o.etag !== undefined)) {
            if (d.hash !== undefined && o.hash !== undefined && !sameHash(d.hash, o.hash)) invalid(`${field}.hash`, "is not what the resource holds now; read it again, or leave the hash out to record it as it is");
            if (d.etag !== undefined && o.etag !== undefined && weak(d.etag) !== weak(o.etag)) invalid(`${field}.etag`, "is not the resource's ETag now; read it again, or leave it out to record it as it is");
            out.push({ ...base, ...(o.hash === undefined ? {} : { hash: o.hash }), ...(o.etag === undefined ? {} : { etag: o.etag }) }); texts.push(read.texts[id]); mine(); break;
          }
          const why = o?.unread ?? "the controller does not read external or MCP resources here";
          if (d.hash === undefined && d.etag === undefined) invalid(field, `the controller did not read it (${why.slice(0, 160)}); give its hash or ETag to record it as you saw it`);
          out.push({ ...base, ...(d.hash === undefined ? {} : { hash: d.hash }), ...(d.etag === undefined ? {} : { etag: d.etag }) }); texts.push(undefined); word(why); break;
        }
      }
    }
    const done = await this.#p.dependencies.record(by, { commandId: command.commandId, taskId, dependencies: out }, texts);
    return { recorded: done.recorded, entries: said };
  }
}

/** One item as given, checked for its shape (its content is checked again by `DependencyService.record`). */
function item(d: unknown, field: string): NoteItem {
  if (d === null || typeof d !== "object" || Array.isArray(d)) return invalid(field, "must be an object");
  const x = d as Record<string, unknown>;
  onlyKnown(x, ["kind", "key", "query", "hash", "etag", "members", "freshness", "server", "protocol"]);
  if (typeof x["kind"] !== "string" || !(NOTE_KINDS as readonly string[]).includes(x["kind"])) invalid(`${field}.kind`, `must be one of ${NOTE_KINDS.join(", ")}`);
  if (typeof x["key"] !== "string" || x["key"].length < 1 || x["key"].length > 300 || /[\0\r\n]/.test(x["key"])) invalid(`${field}.key`, "must be 1 to 300 characters on one line");
  for (const k of ["query", "hash", "etag", "server", "protocol"]) if (x[k] !== undefined && (typeof x[k] !== "string" || (x[k] as string).length > 2000)) invalid(`${field}.${k}`, "must be text");
  if (x["members"] !== undefined && (!Array.isArray(x["members"]) || x["members"].some((m) => typeof m !== "string"))) invalid(`${field}.members`, "must be a list of names");
  if (x["freshness"] !== undefined && !["conditional-read", "authoritative-query", "none"].includes(x["freshness"] as string)) invalid(`${field}.freshness`, "must be conditional-read, authoritative-query or none");
  return x as unknown as NoteItem;
}
