import { Type, type TSchema } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { agentNamespace, canonicalFromWire, isAgentId, parseName, wireName } from "@nimblenewt/registry";
import { InvalidToolError } from "./errors.js";
import type { AdapterTool } from "./adapter.js";

/** A provider's tool-call ID may hold characters the controller refuses (OpenAI's Responses IDs hold `|`) or be long; such an ID becomes a digest of itself, the same ID always giving the same digest. */
const safeCallId = (id: string): string => (/^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : `h:${createHash("sha256").update(id).digest("hex").slice(0, 40)}`);

/**
 * The protected NimbleNewt tool bridge (card T06), loaded into the worker when it starts. It gives the model a small fixed set of tools under the reserved `nimblenewt` namespace (desk access, task
 * updates, messages, and tool registration, discovery, description and invocation). Scripts are never installed here: a new script is registered in the controller's catalogue and found, described and invoked
 * through the same stable tools, so creating and using one needs no change of this extension and no reload.
 *
 * What the extension holds is a `BridgeTransport` and nothing else: one function that sends a request to the controller's execution service, already bound to the worker's own scoped credential and the
 * attempt's gateway. It has no service object, no admin method and no way to name a principal; everything is checked by the controller, so a tampered extension can only send requests the controller
 * would refuse or answer exactly as it would for the worker. The extension never says whether a call is replay-safe: the tools it declares carry no such flag, and the controller takes it from the
 * approved manifest.
 */

export interface BridgeRequest { readonly op: string; readonly callId: string; readonly args?: Record<string, unknown> }
export type BridgeReply =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };
export interface BridgeTransport { send(request: BridgeRequest): Promise<BridgeReply> }

/** Binds a delivery function (the controller's execution service for this attempt, or a wire to it) to a credential. The returned object has `send` and nothing else, and cannot be changed. */
export function boundTransport(token: string, deliver: (token: string, request: BridgeRequest) => Promise<BridgeReply>): BridgeTransport {
  if (typeof token !== "string" || token.length === 0) throw new InvalidToolError("the bridge needs the worker's credential");
  return Object.freeze({ send: (request: BridgeRequest) => deliver(token, request) });
}

const obj = (properties: Record<string, TSchema>, required: readonly string[] = []): TSchema => Type.Object(Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, required.includes(k) ? v : Type.Optional(v)])), { additionalProperties: false });
const text = (description: string): TSchema => Type.String({ description });
const json = (description: string): TSchema => Type.Object({}, { additionalProperties: true, description });

interface Spec { readonly op: string; readonly description: string; readonly parameters: TSchema }
/** The operations and their declarations. Fixed text and fixed order: the declarations are part of every prompt's head, so they never change while the extension is loaded. */
const SPECS: readonly Spec[] = [
  { op: "desk.read", description: "Read one record from your desk (or a shared record you may read) by its ID.", parameters: obj({ recordId: text("the desk record ID") }, ["recordId"]) },
  { op: "desk.write", description: "Write a record to your desk for this task. Use visibility shared and status accepted for work others should use, such as a script and its notes.", parameters: obj({ kind: text("note, plan, result or another desk kind"), title: text("a short title"), body: text("the text"), visibility: text("shared or private"), status: text("draft or accepted"), supersedes: text("an earlier record of yours this replaces"), sources: Type.Array(Type.String()) }, ["kind", "title", "body", "visibility"]) },
  { op: "message.send", description: "Send a message to another agent about this task.", parameters: obj({ to: text("the agent, such as agent:ben"), class: text("informational, advice, blocking-dependency or urgent-control"), purpose: text("why"), text: text("the message"), expectsReply: Type.Boolean(), replyTo: text("a message ID"), coalesceKey: text("replaces a waiting update with this key") }, ["class", "purpose", "text"]) },
  { op: "task.get", description: "Read this task.", parameters: obj({}) },
  { op: "task.transition", description: "Move this task to another state (only the lifecycle's allowed moves).", parameters: obj({ expectedRevision: Type.Number(), to: text("the new state") }, ["expectedRevision", "to"]) },
  { op: "task.update", description: "Change this task's title or description (read it first for its revision).", parameters: obj({ expectedRevision: Type.Number(), title: text("the title"), description: text("the description") }, ["expectedRevision"]) },
  { op: "tool.discover", description: "List the catalogue tools and skills you may use: names and versions only. Fetch a description with tool-describe.", parameters: obj({ query: text("part of a name"), limit: Type.Number(), after: text("the next value of the previous answer") }) },
  { op: "tool.describe", description: "Fetch what a catalogue tool or skill is for: purpose, input and output schemas, access it asks for, limits and instructions.", parameters: obj({ tool: text("the canonical name, such as toolbox.run-tests"), version: text("major.minor.patch; the latest live version when omitted") }, ["tool"]) },
  { op: "tool.invoke", description: "Run a catalogue tool at an exact version with structured input that matches its schema. The controller checks the arguments, your permissions, the budget, the host and revocation, and may ask for approval first; if it says awaiting-approval, make the same call again later with the same input.", parameters: obj({ tool: text("the canonical name"), version: text("major.minor.patch; the latest live version when omitted"), input: json("the arguments, as the tool's input schema says") }, ["tool"]) },
  { op: "tool.register", description: "Register a script as a tool in your own namespace from two of your accepted desk records: the instructions and the executable.", parameters: obj({ name: text("the short name"), kind: text("tool or skill"), version: text("major.minor.patch, higher than any before"), manifest: json("the manifest: purpose, input and output schemas, entry point, interpreter, os, arch, dependencies, requested access, limits, cancellation, recovery"), instructionsRecordId: text("desk record ID"), executableRecordId: text("desk record ID") }, ["name", "kind", "version", "manifest", "instructionsRecordId"]) },
];

/** The wire name of an operation: `nimblenewt__desk-read`. */
export const bridgeToolName = (op: string): string => wireName(`nimblenewt.${op.replace(".", "-")}`);
export const BRIDGE_TOOL_NAMES: readonly string[] = Object.freeze(SPECS.map((s) => bridgeToolName(s.op)));

const render = (reply: BridgeReply): string => (reply.ok ? JSON.stringify(reply.result) : `refused (${reply.code}): ${reply.message}`);

/** One snapshot of the catalogue's declarations: what a request in flight was shown. Frozen. */
export interface Declarations { readonly revision: string; readonly tools: readonly { readonly name: string; readonly kind: string; readonly version: string }[]; readonly complete: boolean }

/**
 * The declarations offered at a model request. A snapshot is taken when the request opens and never changes: a tool registered while the request is in flight appears in the snapshot of the next one.
 * Only names and versions are listed (a description costs a `tool-describe` call), at most `maxTools`; a longer catalogue is said to be longer (`complete: false`), never cut silently.
 */
export class DeclarationBoard {
  readonly #transport: BridgeTransport;
  readonly #max: number;
  readonly #open = new Map<string, Declarations>();
  #n = 0;

  constructor(transport: BridgeTransport, options: { maxTools?: number } = {}) {
    this.#transport = transport;
    this.#max = options.maxTools ?? 50;
  }

  /** Opens a model request: takes the snapshot it will carry. Opening the same request again returns the same snapshot. */
  async openRequest(requestId: string): Promise<Declarations> {
    const held = this.#open.get(requestId);
    if (held !== undefined) return held;
    const tools: { name: string; kind: string; version: string }[] = [];
    let revision = "";
    let complete = true;
    for (let after: string | undefined; ;) {
      const reply = await this.#transport.send({ op: "tool.discover", callId: safeCallId(`decl-${requestId}-${++this.#n}`), args: { limit: Math.min(100, this.#max - tools.length), ...(after === undefined ? {} : { after }) } });
      if (!reply.ok) throw new InvalidToolError(`the catalogue could not be listed: ${reply.message}`);
      revision = String(reply.result["revision"]);
      tools.push(...(reply.result["tools"] as { name: string; kind: string; version: string }[]).map(({ name, kind, version }) => ({ name, kind, version })));
      const next = reply.result["next"];
      if (typeof next !== "string") break;
      if (tools.length >= this.#max) { complete = false; break; }
      after = next;
    }
    const snapshot: Declarations = Object.freeze({ revision, tools: Object.freeze(tools.map((t) => Object.freeze(t))), complete });
    this.#open.set(requestId, snapshot);
    // A request that was never closed does not stay for ever: the oldest snapshots go first.
    while (this.#open.size > 64) this.#open.delete(this.#open.keys().next().value as string);
    return snapshot;
  }

  /** What an open request was shown (undefined once it is closed). */
  snapshotOf(requestId: string): Declarations | undefined { return this.#open.get(requestId); }
  closeRequest(requestId: string): void { this.#open.delete(requestId); }

  /** The snapshot as text for the volatile context of the request: names and versions, and a line saying so when the list is not the whole catalogue. */
  textOf(requestId: string): string {
    const s = this.#open.get(requestId);
    if (s === undefined) return "";
    const lines = s.tools.map((t) => `- ${t.name} ${t.version} (${t.kind})`);
    return `Catalogue tools you may use (names and versions; ask tool-describe for details):\n${lines.join("\n")}${s.complete ? "" : "\n(more exist: ask tool-discover with after)"}`;
  }
}

export interface Bridge {
  /** The bridge's tools: fixed names, in fixed order, shared by every agent. */
  readonly tools: readonly AdapterTool[];
  /** Declarations per model request. */
  readonly declarations: DeclarationBoard;
}

/** Builds the protected extension for one worker from its transport. The result is frozen; nothing in it can be switched off. */
export function createBridge(transport: BridgeTransport, options: { maxTools?: number } = {}): Bridge {
  const tools = SPECS.map((spec): AdapterTool => Object.freeze({
    name: bridgeToolName(spec.op),
    description: spec.description,
    parameters: spec.parameters,
    shared: true,
    // No `replay`: whether a call may be run again after a restart is the controller's decision from the approved manifest.
    execute: async (args: unknown, context: { readonly callId: string }) => render(await transport.send({ op: spec.op, callId: safeCallId(context.callId), args: args as Record<string, unknown> })),
  }));
  return Object.freeze({ tools: Object.freeze(tools), declarations: new DeclarationBoard(transport, options) });
}

/**
 * The tools a worker is started with: the bridge's, always, and the agent's personal ones. A personal tool must be named in the agent's own namespace (`a_<id>__<name>`); one that is named in the
 * `nimblenewt` or `toolbox` namespace, in another agent's, or without a namespace is refused, as is one that repeats any name. There is no way to leave a bridge tool out.
 * `agentId` is the id part of the agent's personal namespace as the catalogue derives it (`personalNamespace(principalId)` without its `a_` prefix), not the principal ID itself.
 */
export function composeTools(bridge: Bridge, personal: readonly AdapterTool[], agentId: string): readonly AdapterTool[] {
  if (!isAgentId(agentId)) throw new InvalidToolError("composeTools needs the agent's own ID");
  const own = agentNamespace(agentId);
  const seen = new Set<string>(BRIDGE_TOOL_NAMES);
  for (const tool of bridge.tools) if (!BRIDGE_TOOL_NAMES.includes(tool.name)) throw new InvalidToolError(`${tool.name} is not a bridge tool`);
  for (const name of BRIDGE_TOOL_NAMES) if (!bridge.tools.some((t) => t.name === name)) throw new InvalidToolError(`the bridge tool ${name} is missing; the bridge cannot be switched off`);
  for (const tool of personal) {
    const canonical = canonicalFromWire(tool.name);
    const parsed = canonical === null ? null : parseName(canonical);
    if (parsed === null || parsed.layer !== "agent" || parsed.namespace !== own) throw new InvalidToolError(`personal tool "${tool.name.slice(0, 80)}" must be named ${own}__<name>: the nimblenewt and toolbox namespaces, other agents' namespaces and bare names are reserved`);
    if (seen.has(tool.name)) throw new InvalidToolError(`duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
  }
  return Object.freeze([...bridge.tools, ...personal]);
}
