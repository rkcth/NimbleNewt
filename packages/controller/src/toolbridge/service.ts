import { createHash } from "node:crypto";
import { parseName } from "@nimblenewt/registry";
import type { AgentMessageService } from "../messaging/index.js";
import type { StateApi } from "../api/index.js";
import { catalogFacts } from "../dispatch/local-worker.js";
import { checkHost, runAction, type CatalogService, type HostFacts, type VersionBody } from "../catalog/index.js";
import type { DeskService } from "../context/index.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL, type ToolIdentity } from "../dispatch/model.js";
import type { ToolGateway, ToolResult } from "../dispatch/ports.js";
import type { AdmissionService } from "../admission/index.js";
import type { AssignmentService } from "../domain/assignments.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import type { HostService } from "../hosts/index.js";
import type { PauseGuard } from "../lifecycle/index.js";
import { allows } from "../security/access.js";
import type { TaskCredentialService } from "../security/task-credentials.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { JsonObject } from "../storage/types.js";
import { checkValue, schemaProblems } from "./schema.js";

/**
 * The controller side of the protected agent tool bridge (card T06). The extension loaded into the worker (`@nimblenewt/pi-adapter`, `bridge.ts`) exposes a small, fixed set of tools; each call is
 * one `BridgeRequest` sent with the worker's own task credential. Everything is decided here: the credential is authenticated and must be the one issued for the very attempt whose gateway carries
 * the call, the attempt must be running and current, and the operation is one of a closed list. No request carries a principal, an actor, a project or a task: they come from the credential and the
 * attempt record. Invoking a catalogued tool goes through the dispatcher's tool path (`ToolGateway.call`), so permission, budget, pause, decisions, policy, approval and the durable operation record
 * are the dispatcher's, not repeated here.
 */

export const BRIDGE_OPERATIONS = ["desk.read", "desk.write", "task.get", "task.update", "task.transition", "message.send", "tool.register", "tool.discover", "tool.describe", "tool.invoke"] as const;
export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number];

/** What the extension sends: the operation, its arguments, and the model's call ID (so asking again after a restart is the same request). Nothing about who is asking. */
export interface BridgeRequest { readonly op: string; readonly callId: string; readonly args?: JsonObject }
export type BridgeResponse =
  | { readonly ok: true; readonly result: JsonObject }
  | { readonly ok: false; readonly code: string; readonly message: string };

export const BRIDGE_LIMITS = { args: 64 * 1024, output: 64 * 1024, instructions: 16 * 1024, page: 100, defaultPage: 50, query: 100, access: 50 } as const;

/** Runs an approved script (the sandbox of H12b/A03 implements it). It is handed argv and stdin as data: nothing here builds, and nothing there may build, a shell command line. */
export interface ScriptLaunch {
  /** The program to start: the manifest's interpreter name. Never a shell line. */
  readonly program: string;
  /** The program's arguments: the entry point and nothing else. The model's arguments are not here. */
  readonly argv: readonly string[];
  /** The model's structured arguments as canonical JSON, delivered on standard input. */
  readonly stdin: string;
  /** The exact bytes of the executable source of the pinned version, so a changed desk record cannot change a run in progress. */
  readonly source: string;
  readonly tool: { readonly name: string; readonly version: string; readonly digest: string };
  readonly interpreterVersion: string;
  /** The most standard output the run may produce; the sandbox cuts it off there (the service checks the result again). */
  readonly maxOutputBytes: number;
  /** The limits the manifest declared; the sandbox enforces them (A08b). */
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
  /** No variable of the controller or the worker is passed on. */
  readonly env: Readonly<Record<string, string>>;
}
export interface ScriptRunner { run(launch: ScriptLaunch, signal: AbortSignal): Promise<{ readonly text: string; readonly cpuMs?: number; readonly memoryMb?: number }> }

const PROGRAM = /^[a-z][a-z0-9._-]{0,63}$/;
/** The launch of one version for one input. Pure: used by the service and by tests that must show model text never reaches a command line. */
export function launchOf(version: Pick<VersionBody, "name" | "version" | "digest" | "manifest">, source: string, input: JsonObject): ScriptLaunch {
  const m = version.manifest;
  if (m.entryPoint === undefined || m.interpreter === undefined) throw new DomainError("invalid_command", `${version.name} ${version.version} names no entry point and interpreter`);
  if (!PROGRAM.test(m.interpreter.name)) throw new DomainError("invalid_command", "the interpreter name is not a plain program name");
  return { program: m.interpreter.name, argv: [m.entryPoint], stdin: canonicalJson(input), source, tool: { name: version.name, version: version.version, digest: version.digest }, interpreterVersion: m.interpreter.version, maxOutputBytes: BRIDGE_LIMITS.output, limits: m.limits, env: {} };
}

export interface ToolExecutionDeps {
  /** The dispatcher's own principal: it is the only one that may ask for an attempt's agent as the attempt presents it. */
  readonly principal: Principal;
  readonly credentials: Pick<TaskCredentialService, "authenticate" | "principalOf" | "agentOf">;
  readonly dispatch: Pick<DispatcherService, "get" | "toolOperation">;
  readonly assignments: Pick<AssignmentService, "getAssignment">;
  readonly catalog: Pick<CatalogService, "get" | "list" | "register" | "content" | "authorizeRun">;
  readonly hosts: Pick<HostService, "status">;
  readonly admission: Pick<AdmissionService, "snapshot">;
  readonly runner: ScriptRunner;
  /** The pause gates (L01): while a task, its agent, its project or the installation is paused, every write through the bridge is refused (reads continue). */
  readonly pauses: PauseGuard;
  readonly desks?: Pick<DeskService, "read" | "write">;
  readonly messages?: Pick<AgentMessageService, "send">;
  readonly state?: Pick<StateApi, "handle">;
  /** The host's facts when the composer knows better than `catalogFacts` over the announcement and the declared capacity (the facts always come from the host, never the request). */
  readonly facts?: (hostId: string) => Promise<HostFacts | undefined>;
}

/** The bound gateway of the attempt the request came through. */
export type BoundGateway = Pick<ToolGateway, "attemptId" | "call">;

const WRITES: ReadonlySet<BridgeOperation> = new Set(["desk.write", "task.update", "task.transition", "message.send", "tool.register"]);
const refusal = (code: string, message: string): BridgeResponse => ({ ok: false, code, message: redactText(message).slice(0, 600) });
const ok = (result: JsonObject): BridgeResponse => ({ ok: true, result });
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
/** The name the dispatcher's tool path and the grants use: the canonical name with the namespace's underscore written as a hyphen (an action has no underscore). */
export const toolPathName = (canonical: string): string => runAction(canonical).slice("tool.".length);
const canonicalOf = (pathName: string): string => (pathName.startsWith("a-") ? `a_${pathName.slice(2)}` : pathName);

interface Context { /** The task credential's own principal, cut to the task and project (desk, messages). */ readonly scoped: Principal; /** The agent with its own grants, for installation-wide records (the catalogue). */ readonly agent: Principal; /** The agent as the attempt presents it (cut to the task, without the contract's tool ceiling). */ readonly acting: Principal; readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly hostId: string; readonly callId: string }

export class ToolExecutionService {
  readonly #deps: ToolExecutionDeps;
  /** Calls this service is handing to the gateway right now (attempt and call ID), for the replay-safe hook. */
  readonly #bridgeCalls = new Set<string>();

  constructor(deps: ToolExecutionDeps) { this.#deps = deps; }

  /**
   * Handles one request from the extension of an attempt. `token` is the worker's task credential; `gateway` is the dispatcher's gateway bound to the attempt. A refusal is an answer (`ok: false`
   * with a code), never an exception, and says nothing the caller could not already see.
   */
  async handle(token: unknown, gateway: BoundGateway, request: BridgeRequest): Promise<BridgeResponse> {
    try {
      if (request === null || typeof request !== "object") return refusal("invalid_command", "request: must be an object");
      onlyKnown(request, ["op", "callId", "args"]);
      if (typeof request.callId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(request.callId)) return refusal("invalid_command", "callId: must be 1 to 120 letters, digits or . _ : -");
      if (!(BRIDGE_OPERATIONS as readonly string[]).includes(request.op)) return refusal("invalid_command", `op: ${String(request.op).slice(0, 40)} is not an operation of the bridge`);
      const args = request.args ?? {};
      if (!isObject(args)) return refusal("invalid_command", "args: must be a JSON object");
      if (canonicalJson(args).length > BRIDGE_LIMITS.args) return refusal("invalid_command", `args: must be at most ${BRIDGE_LIMITS.args} characters when written out`);
      const context = await this.#bind(token, gateway, request.callId);
      // A pause stops everything the agent writes through the bridge; reading goes on.
      if (WRITES.has(request.op as BridgeOperation)) {
        const paused = await this.#deps.pauses.guard(context.taskId);
        if (paused.blockedBy.length > 0) return refusal("paused", `the task is paused (${paused.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}); ${request.op} is refused until it is resumed`);
      }
      switch (request.op as BridgeOperation) {
        case "desk.read": return await this.#deskRead(context, args);
        case "desk.write": return await this.#deskWrite(context, args);
        case "task.get": case "task.update": case "task.transition": return await this.#task(token, context, request.op as BridgeOperation, args);
        case "message.send": return await this.#message(context, args);
        case "tool.register": return await this.#register(context, args);
        case "tool.discover": return await this.#discover(context, args);
        case "tool.describe": return await this.#describe(context, args);
        case "tool.invoke": return await this.#invoke(context, gateway, args);
      }
    } catch (error) {
      if (isDomainError(error, "unauthenticated")) return refusal("unauthenticated", "the credential was not accepted");
      if (error instanceof DomainError) return refusal(error.code, error.message);
      return refusal("internal", "the request could not be handled");
    }
  }

  /**
   * Whether the approved manifest of this exact catalogue version says a call may be run again from the start after a restart (`recovery: "restart"`). This is the dispatcher's `replaySafe`
   * hook: the answer is the controller's, from the immutable manifest, never a flag the worker or the model passes. Anything not in the catalogue, revoked or unreadable is not replay-safe.
   */
  readonly replaySafe = async (tool: ToolIdentity, _agent: Principal, attemptId: string, callId: string): Promise<boolean> => {
    try {
      // Only a call this service is making counts: a worker that calls the gateway itself with a catalogue name gets no flag.
      if (tool.kind !== "catalog" || !this.#bridgeCalls.has(`${attemptId}\0${callId}`)) return false;
      const canonical = canonicalOf(tool.name);
      if (parseName(canonical) === null) return false;
      const agent = await this.#deps.credentials.agentOf(this.#deps.principal, attemptId);
      const v = await this.#deps.catalog.get(agent, canonical, tool.version);
      return v !== undefined && v.revoked === undefined && v.kind === "tool" && v.manifest.recovery === "restart";
    } catch { return false; }
  };

  // ---- who is asking --------------------------------------------------------------------------------------------------------

  /** The credential proves the agent and the task; the attempt record says the attempt is running, current and not frozen; the two must agree and the gateway must be the attempt's. */
  async #bind(token: unknown, gateway: BoundGateway, callId: string): Promise<Context> {
    const presented = await this.#deps.credentials.authenticate(token);
    if (presented.kind !== "agent" || presented.taskScope === undefined) throw new DomainError("unauthenticated", "the credential was not accepted");
    const attempt = await this.#deps.dispatch.get(this.#deps.principal, gateway.attemptId);
    if (attempt === undefined || attempt.state !== "running") throw new DomainError("fenced", "the attempt is not running; its requests are refused");
    if (attempt.agentId !== presented.id || attempt.taskId !== presented.taskScope.taskId || attempt.projectId !== presented.taskScope.projectId) throw new DomainError("unauthenticated", "the credential was not accepted");
    const current = await this.#deps.assignments.getAssignment(attempt.taskId);
    if (current === undefined || current.generation !== attempt.generation) throw new DomainError("fenced", "the attempt has been replaced; its requests are refused");
    if (attempt.frozen !== undefined) throw new DomainError("fenced", `the attempt is frozen: ${attempt.frozen.reason}`);
    // The agent as the attempt presents it right now (grants re-read), without the contract's tool ceiling: the tool path judges a call beyond the ceiling by asking, not by refusing.
    const acting = await this.#deps.credentials.principalOf(this.#deps.principal, gateway.attemptId, { limit: false });
    const agent = await this.#deps.credentials.agentOf(this.#deps.principal, gateway.attemptId);
    return { scoped: presented, agent, acting, attemptId: attempt.attemptId, taskId: attempt.taskId, projectId: attempt.projectId, hostId: attempt.hostId, callId };
  }

  // ---- the desk, the task, messages -----------------------------------------------------------------------------------------

  async #deskRead(c: Context, args: JsonObject): Promise<BridgeResponse> {
    if (this.#deps.desks === undefined) return refusal("unavailable", "the desk is not available");
    onlyKnown(args, ["recordId"]);
    if (typeof args["recordId"] !== "string") return invalid("recordId", "must be a desk record ID");
    const record = await this.#deps.desks.read(c.scoped, args["recordId"]);
    return ok({ record: record as unknown as JsonObject });
  }

  async #deskWrite(c: Context, args: JsonObject): Promise<BridgeResponse> {
    if (this.#deps.desks === undefined) return refusal("unavailable", "the desk is not available");
    onlyKnown(args, ["kind", "title", "body", "visibility", "status", "supersedes", "sources"]);
    // The project and task are the attempt's; the call ID makes asking again the same write.
    const made = await this.#deps.desks.write(c.scoped, { ...args, commandId: `bridge:${c.attemptId}:${c.callId}`, projectId: c.projectId, taskId: c.taskId } as never);
    return ok({ id: made.id, revision: made.revision, replayed: made.replayed });
  }

  async #task(token: unknown, c: Context, op: BridgeOperation, args: JsonObject): Promise<BridgeResponse> {
    if (this.#deps.state === undefined) return refusal("unavailable", "the state API is not available");
    // Only the attempt's own task, through the same door every client uses (its checks are the native ones).
    const name = op;
    onlyKnown(args, name === "task.get" ? [] : name === "task.update" ? ["expectedRevision", "title", "description"] : ["expectedRevision", "to"]);
    const response = await this.#deps.state.handle(token, { v: 1, op: name, ...(name === "task.get" ? {} : { commandId: `bridge:${c.attemptId}:${c.callId}` }), args: { ...args, taskId: c.taskId } });
    return response.ok ? ok(response.result) : refusal(response.error.code, response.error.message);
  }

  async #message(c: Context, args: JsonObject): Promise<BridgeResponse> {
    if (this.#deps.messages === undefined) return refusal("unavailable", "messaging is not available");
    onlyKnown(args, ["to", "class", "purpose", "text", "expectsReply", "replyTo", "coalesceKey"]);
    const sent = await this.#deps.messages.send(c.scoped, { ...args, commandId: `bridge:${c.attemptId}:${c.callId}`, taskId: c.taskId } as never);
    return ok(sent as unknown as JsonObject);
  }

  // ---- the catalogue --------------------------------------------------------------------------------------------------------

  async #register(c: Context, args: JsonObject): Promise<BridgeResponse> {
    onlyKnown(args, ["name", "kind", "version", "manifest", "instructionsRecordId", "executableRecordId"]);
    // The manifest's schemas must be enforceable here, or the tool could never be called with checked arguments: refused at registration, not at the first use.
    const manifest = args["manifest"];
    if (isObject(manifest)) {
      for (const field of ["input", "output"] as const) {
        const problems = isObject(manifest[field]) ? schemaProblems(manifest[field] as JsonObject) : [];
        if (problems.length > 0) return refusal("invalid_command", `manifest.${field}: ${problems[0]}`);
      }
    }
    const made = await this.#deps.catalog.register(c.agent, { ...args, commandId: `bridge:${c.attemptId}:${c.callId}` } as never);
    return ok({ name: made.name, versionId: made.versionId, digest: made.digest });
  }

  /** The names the agent may see with their latest live versions. Names and versions only: a description is fetched with `tool.describe`, on demand. */
  async #discover(c: Context, args: JsonObject): Promise<BridgeResponse> {
    onlyKnown(args, ["query", "limit", "after"]);
    const query = args["query"] === undefined ? undefined : typeof args["query"] === "string" && args["query"].length <= BRIDGE_LIMITS.query ? args["query"].toLowerCase() : invalid("query", `must be text of at most ${BRIDGE_LIMITS.query} characters`);
    const limit = args["limit"] === undefined ? BRIDGE_LIMITS.defaultPage : Number.isSafeInteger(args["limit"]) && (args["limit"] as number) >= 1 && (args["limit"] as number) <= BRIDGE_LIMITS.page ? (args["limit"] as number) : invalid("limit", `must be 1 to ${BRIDGE_LIMITS.page}`);
    const after = args["after"] === undefined ? undefined : typeof args["after"] === "string" ? args["after"] : invalid("after", "must be the `next` of a previous answer");
    const all = (await this.#deps.catalog.list(c.agent)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // The revision says whether the visible set changed: a new declaration appears at the next model-request boundary because the extension compares this.
    const revision = digest(canonicalJson({ items: all.map((x) => [x.name, x.kind, x.latest]) } as never)).slice(0, 24);
    const matching = all.filter((x) => (query === undefined || x.name.includes(query)) && (after === undefined || x.name > after));
    const page = matching.slice(0, limit);
    return ok({ revision, tools: page.map((x) => ({ name: x.name, kind: x.kind, layer: x.layer, version: x.latest })), ...(matching.length > page.length ? { next: page[page.length - 1]!.name } : {}) });
  }

  async #describe(c: Context, args: JsonObject): Promise<BridgeResponse> {
    onlyKnown(args, ["tool", "version"]);
    const { canonical, version } = this.#target(args);
    const v = await this.#deps.catalog.get(c.agent, canonical, version);
    if (v === undefined) throw new DomainError("not_found", `no tool ${canonical.slice(0, 80)} is available to you`);
    const text = await this.#deps.catalog.content(c.agent, canonical, v.version, "instructions");
    return ok({
      name: v.name, kind: v.kind, version: v.version, digest: v.digest, purpose: v.manifest.purpose, input: v.manifest.input, output: v.manifest.output, requestedAccess: [...v.manifest.requestedAccess],
      limits: v.manifest.limits, os: [...v.manifest.os], arch: [...v.manifest.arch], recovery: v.manifest.recovery, replaySafe: v.kind === "tool" && v.manifest.recovery === "restart" && v.revoked === undefined,
      ...(v.revoked === undefined ? {} : { revoked: { reason: v.revoked.reason, at: v.revoked.at } }),
      instructions: clip(text, BRIDGE_LIMITS.instructions), ...(text.length > BRIDGE_LIMITS.instructions ? { instructionsTruncated: true } : {}),
    });
  }

  #target(args: JsonObject): { canonical: string; version?: string } {
    const name = args["tool"];
    if (typeof name !== "string" || parseName(name) === null) return invalid("tool", "must be a canonical tool name, such as toolbox.run-tests");
    const version = args["version"];
    if (version !== undefined && (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))) invalid("version", "must be major.minor.patch");
    return { canonical: name, ...(version === undefined ? {} : { version: version as string }) };
  }

  /**
   * Invokes an exact version. The version is the one asked for, or the latest live one at this moment; asking again with the same call ID after a restart keeps the version the call began with, whatever
   * has been published since. The arguments are checked against the manifest's input schema, the requested access against what the agent holds, the host against the manifest, and revocation against
   * the catalogue as it is now; then the dispatcher's tool path judges the call and runs it, and the run records its use again at the moment it starts.
   */
  async #invoke(c: Context, gateway: BoundGateway, args: JsonObject): Promise<BridgeResponse> {
    onlyKnown(args, ["tool", "version", "input"]);
    const target = this.#target(args);
    const input = args["input"] ?? {};
    if (!isObject(input)) return invalid("input", "must be a JSON object");
    const pathName = toolPathName(target.canonical);
    // A call that already has a record keeps its version.
    const recorded = await this.#deps.dispatch.toolOperation(this.#deps.principal, c.attemptId, c.callId);
    const pinned = recorded !== undefined && recorded.tool.name === pathName ? recorded.tool.version : undefined;
    // A call that already ended is answered from its record, whatever has happened to the tool since (a revocation does not rewrite what was done).
    if (recorded !== undefined && pinned !== undefined && TERMINAL.has(recorded.state)) {
      const settled = await gateway.call({ callId: c.callId, tool: { name: pathName, version: pinned, kind: "catalog" }, args: input }, { kind: "local", run: async () => { throw new Error("the call has already ended"); } });
      return ok({ ...(settled as unknown as JsonObject), tool: target.canonical, version: pinned });
    }
    const asked = pinned ?? target.version;
    const v = await this.#deps.catalog.get(c.agent, target.canonical, asked);
    if (v === undefined) throw new DomainError("not_found", `no tool ${target.canonical.slice(0, 80)} is available to you`);
    if (v.revoked !== undefined) throw new DomainError("forbidden", `${v.name} ${v.version} was revoked (${redactText(v.revoked.reason).slice(0, 120)})`);
    if (v.kind !== "tool" || v.executable === undefined) throw new DomainError("forbidden", `${v.name} is a skill: it carries instructions and cannot run anything`);
    const problems = checkValue(v.manifest.input, input);
    if (problems.length > 0) throw new DomainError("invalid_command", `the arguments do not match ${v.name} ${v.version}: ${problems.slice(0, 5).join("; ")}`, { field: "input" });
    // What the tool asks for is checked against what this agent holds in this task: asking grants nothing, and a tool that wants more than the worker has is not run.
    const missing = v.manifest.requestedAccess.filter((action) => !allows(c.acting, action, c.projectId, { resource: { kind: "task", id: c.taskId } }));
    if (missing.length > 0) throw new DomainError("forbidden", `${v.name} asks for access this task's credential does not hold: ${missing.slice(0, BRIDGE_LIMITS.access).join(", ")}`);
    const facts = await this.#facts(c.hostId);
    if (facts === undefined) throw new DomainError("unavailable", "the facts of the host this attempt runs on are not known, so the tool cannot be checked against it");
    const fit = checkHost(v.manifest, facts);
    if (!fit.ok) throw new DomainError("forbidden", `${v.name} ${v.version} cannot run on this host: ${fit.reasons.slice(0, 5).join("; ")}`);
    // The exact bytes, read now: a call in progress finishes on this version whatever is published next.
    const source = await this.#deps.catalog.content(c.agent, v.name, v.version, "executable");
    const launch = launchOf(v, source, input);
    const key = `${c.attemptId}\0${c.callId}`;
    this.#bridgeCalls.add(key);
    try {
    const result = await gateway.call(
      { callId: c.callId, tool: { name: pathName, version: v.version, kind: "catalog" }, args: input },
      {
        kind: "local",
        run: async (signal) => {
          // Recorded at the moment it starts: revocation, the grants and the host are asked again, and the version must still be the one that was checked.
          // The access the tool asks for is asked again with the grants as they are now.
          const now = await this.#deps.credentials.principalOf(this.#deps.principal, c.attemptId, { limit: false });
          const lost = v.manifest.requestedAccess.filter((action) => !allows(now, action, c.projectId, { resource: { kind: "task", id: c.taskId } }));
          if (lost.length > 0) throw new Error(`the task's credential no longer holds ${lost.slice(0, BRIDGE_LIMITS.access).join(", ")}`);
          const ready = await this.#deps.catalog.authorizeRun(c.agent, { commandId: `bridge-run:${c.attemptId}:${c.callId}`, name: v.name, version: v.version, taskId: c.taskId, projectId: c.projectId, host: facts });
          if (!ready.ready) throw new Error(ready.reasons.join("; "));
          if (ready.digest !== v.digest) throw new Error(`${v.name} ${v.version} changed after it was checked`);
          const out = await this.#deps.runner.run(launch, signal);
          if (Buffer.byteLength(out.text, "utf8") > BRIDGE_LIMITS.output) throw new Error(`the tool wrote more than ${BRIDGE_LIMITS.output} bytes`);
          let parsed: unknown;
          try { parsed = JSON.parse(out.text); } catch { throw new Error("the tool's output is not JSON, as its manifest declares"); }
          const bad = checkValue(v.manifest.output, parsed);
          if (bad.length > 0) throw new Error(`the tool's output does not match its manifest: ${bad.slice(0, 3).join("; ")}`);
          return out;
        },
      },
    );
    return ok({ ...(result as unknown as JsonObject), tool: v.name, version: v.version });
    } finally { this.#bridgeCalls.delete(key); }
  }

  async #facts(hostId: string): Promise<HostFacts | undefined> {
    if (this.#deps.facts !== undefined) return this.#deps.facts(hostId);
    const status = await this.#deps.hosts.status(this.#deps.principal, hostId);
    const capacity = (await this.#deps.admission.snapshot()).capacity[hostId];
    return catalogFacts(status?.capabilities, capacity);
  }
}

export type { ToolResult };
