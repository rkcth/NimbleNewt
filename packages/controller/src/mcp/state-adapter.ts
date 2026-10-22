import { OPERATIONS, StateApi, API_VERSION, type ApiOperation, type ApiResponse } from "../api/index.js";
import { MCP_SUPPORT } from "./mcp.js";

/** A JSON-RPC 2.0 message as MCP uses it. */
export interface RpcRequest { readonly jsonrpc: "2.0"; readonly id?: string | number; readonly method: string; readonly params?: unknown }
export type RpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: string | number | null; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: string | number | null; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

const CODES = { parse: -32700, invalidRequest: -32600, method: -32601, params: -32602, internal: -32603, resource: -32002 } as const;
const URI = /^nimblenewt:\/\/(project|task)\/([a-z]+-[a-z2-7]{20})$/;
const toolName = (op: string): string => op.replace(/\./g, "_");

const reply = (id: string | number | null, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: string | number | null, code: number, message: string, data?: unknown): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

/**
 * The controller's state through MCP (card T04). An MCP client that speaks to NimbleNewt is given the same door as every other client: each request is authenticated by its credential and goes to
 * the state API, so admission, scoping and privacy are the native ones and nothing is decided here. Projects and tasks are resources (`nimblenewt://project/<id>`, `nimblenewt://task/<id>`); the
 * operations are tools (`project_get`, `task_transition`, …) with a schema made from the operation table. A command carries a `commandId` that the client supplies and keeps across a reconnect, so
 * repeating it after a dropped connection is answered from the record and never changes state twice. A client that asks for a protocol revision this release has not been checked against is told which
 * ones it can use. Transport (the HTTP or stdio framing) is not here.
 */
export class McpStateAdapter {
  readonly #api: StateApi;
  readonly #tools: ReadonlyMap<string, ApiOperation>;

  constructor(api: StateApi) {
    this.#api = api;
    this.#tools = new Map(OPERATIONS.map((o) => [toolName(o.name), o]));
  }

  /** Handles one JSON-RPC message from a client with this credential. Notifications (no `id`) get no reply. A batch is refused. */
  async handle(token: unknown, message: unknown): Promise<RpcResponse | undefined> {
    if (Array.isArray(message)) return fail(null, CODES.invalidRequest, "batches are not supported; send one message at a time");
    if (typeof message !== "object" || message === null) return fail(null, CODES.invalidRequest, "a message is a JSON object");
    const m = message as Partial<RpcRequest>;
    const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || (m.id !== undefined && id === null)) return fail(id, CODES.invalidRequest, "not a JSON-RPC 2.0 request");
    if (m.id === undefined) return undefined; // a notification: nothing to say
    const rid = id as string | number;
    try {
      switch (m.method) {
        case "initialize": return this.#initialize(rid, m.params);
        case "ping": return reply(rid, {});
        case "tools/list": return reply(rid, { tools: [...this.#tools].map(([name, o]) => ({ name, description: `${o.summary} ${o.kind === "command" ? "Needs a commandId; repeating the same commandId never repeats the change." : ""}`.trim(), inputSchema: this.#schema(o) })) });
        case "tools/call": return await this.#call(token, rid, m.params);
        case "resources/list": return await this.#listResources(token, rid, m.params);
        case "resources/templates/list": return reply(rid, { resourceTemplates: [{ uriTemplate: "nimblenewt://project/{id}", name: "project", mimeType: "application/json" }, { uriTemplate: "nimblenewt://task/{id}", name: "task", mimeType: "application/json" }] });
        case "resources/read": return await this.#read(token, rid, m.params);
        case "prompts/list": return reply(rid, { prompts: [] });
        default: return fail(rid, CODES.method, `unknown method ${m.method.slice(0, 60)}`);
      }
    } catch { return fail(id, CODES.internal, "the request could not be handled"); }
  }

  #initialize(id: string | number, params: unknown): RpcResponse {
    const wanted = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (typeof wanted !== "string" || !MCP_SUPPORT.revisions.includes(wanted)) {
      return fail(id, CODES.params, `unsupported protocol version ${typeof wanted === "string" ? wanted.slice(0, 30) : "(none given)"}; this server speaks ${MCP_SUPPORT.revisions.join(", ")}`, { supported: MCP_SUPPORT.revisions });
    }
    return reply(id, { protocolVersion: wanted, capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } }, serverInfo: { name: "nimblenewt", version: `state-api-${API_VERSION}` } });
  }

  #schema(o: ApiOperation): object {
    const properties: Record<string, object> = {}; const required: string[] = [];
    for (const [key, description] of Object.entries(o.args)) {
      const optional = key.endsWith("?"); const name = optional ? key.slice(0, -1) : key;
      properties[name] = { description };
      if (!optional) required.push(name);
    }
    if (o.kind === "command") { properties["commandId"] = { type: "string", description: "A key you choose and keep: repeating it repeats the answer, never the change." }; required.push("commandId"); }
    return { type: "object", properties, required, additionalProperties: false };
  }

  async #call(token: unknown, id: string | number, params: unknown): Promise<RpcResponse> {
    const p = params as { name?: unknown; arguments?: unknown } | undefined;
    const op = typeof p?.name === "string" ? this.#tools.get(p.name) : undefined;
    if (op === undefined) return fail(id, CODES.params, "unknown tool");
    const args = p?.arguments === undefined ? {} : p.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, CODES.params, "arguments must be an object");
    const { commandId, ...rest } = args as Record<string, unknown>;
    if (op.kind === "command" && (typeof commandId !== "string" || commandId.length === 0)) return fail(id, CODES.params, `${p!.name as string} changes state, so it needs a commandId that you keep across a reconnect`);
    if (op.kind === "query" && commandId !== undefined) return fail(id, CODES.params, `${p!.name as string} only reads, so it takes no commandId`);
    const response = await this.#api.handle(token, { v: API_VERSION, op: op.name, ...(op.kind === "command" ? { commandId } : {}), args: rest });
    return reply(id, this.#toolResult(response));
  }

  #toolResult(r: ApiResponse): object {
    if (r.ok) return { content: [{ type: "text", text: JSON.stringify(r.result) }], structuredContent: r.result, isError: false, ...(r.accepted === true ? { _meta: { accepted: true, completed: r.completed === true, ...(r.awaits === undefined ? {} : { awaits: r.awaits }) } } : {}) };
    return { content: [{ type: "text", text: JSON.stringify({ code: r.error.code, message: r.error.message, ...(r.error.field === undefined ? {} : { field: r.error.field }) }) }], isError: true };
  }

  async #listResources(token: unknown, id: string | number, params: unknown): Promise<RpcResponse> {
    const cursor = (params as { cursor?: unknown } | undefined)?.cursor;
    const r = await this.#api.handle(token, { v: API_VERSION, op: "project.list", args: typeof cursor === "string" ? { after: cursor } : {} });
    if (!r.ok) return fail(id, CODES.params, r.error.message);
    const items = (r.result as { items?: { id: string; name?: string }[] }).items ?? [];
    return reply(id, { resources: items.map((p) => ({ uri: `nimblenewt://project/${p.id}`, name: p.name ?? p.id, mimeType: "application/json" })), ...((r.result as { next?: string }).next === undefined ? {} : { nextCursor: (r.result as { next: string }).next }) });
  }

  async #read(token: unknown, id: string | number, params: unknown): Promise<RpcResponse> {
    const uri = (params as { uri?: unknown } | undefined)?.uri;
    const match = typeof uri === "string" ? URI.exec(uri) : null;
    if (match === null) return fail(id, CODES.resource, "no such resource");
    const r = await this.#api.handle(token, { v: API_VERSION, op: `${match[1]}.get`, args: { [`${match[1]}Id`]: match[2] } });
    // A resource that is not there and one the caller may not read look the same.
    if (!r.ok) return r.error.code === "unauthenticated" ? fail(id, CODES.params, "the credential was not accepted") : fail(id, CODES.resource, "no such resource");
    return reply(id, { contents: [{ uri: uri as string, mimeType: "application/json", text: JSON.stringify((r.result as { item?: unknown }).item ?? r.result) }] });
  }
}
void CODES.parse;
