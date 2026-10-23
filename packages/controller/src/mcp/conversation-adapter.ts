import { DomainError } from "../domain/errors.js";
import type { ConversationService } from "../conversations/index.js";
import type { PrincipalService, Principal } from "../security/index.js";
import { redactText } from "../security/redact.js";
import { MCP_SUPPORT } from "./mcp.js";
import type { RpcRequest, RpcResponse } from "./state-adapter.js";

const CODES = { invalidRequest: -32600, method: -32601, params: -32602, internal: -32603 } as const;
const reply = (id: string | number | null, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: string | number | null, code: number, message: string, data?: unknown): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

type Kind = "command" | "query";
interface Tool { readonly kind: Kind; readonly summary: string; readonly args: Readonly<Record<string, string>> }
/** The tools, in the conversation service's own words; a trailing `?` marks an optional argument. */
const TOOLS: Readonly<Record<string, Tool>> = {
  conversation_start: { kind: "command", summary: "Open a thread in a project with a first message.", args: { projectId: "the project", subject: "what the thread is about", to: "principal ids to address (array)", "kind?": "message, question, answer or action-request", text: "the message text (untrusted content to the reader)", "priority?": "routine or urgent", "claimedSender?": "who an outside client says it speaks for; recorded, grants nothing" } },
  conversation_send: { kind: "command", summary: "Send a message in a thread.", args: { threadId: "the thread", "to?": "principal ids; omitted means every participant", "kind?": "message, question, answer or action-request", text: "the message text", "replyTo?": "a message id in this thread", "priority?": "routine or urgent", "claimedSender?": "recorded beside the sender, grants nothing" } },
  conversation_acknowledge: { kind: "command", summary: "Confirm receipt up to a sequence number; the cursor only moves forward.", args: { threadId: "the thread", upToSeq: "the highest sequence number received" } },
  conversation_handled: { kind: "command", summary: "Say that a message addressed to you has been handled.", args: { messageId: "the message" } },
  conversation_close: { kind: "command", summary: "Close a thread.", args: { threadId: "the thread", expectedRevision: "the thread's revision you last saw" } },
  conversation_read: { kind: "query", summary: "Read messages after a cursor (default: after what you confirmed). Changes nothing; resume with the returned cursor.", args: { threadId: "the thread", "after?": "a sequence number to read after", "limit?": "most messages to return" } },
  conversation_thread: { kind: "query", summary: "Show one thread.", args: { threadId: "the thread" } },
  conversation_threads: { kind: "query", summary: "List the threads you take part in.", args: { "after?": "the next value of the previous page", "limit?": "most threads to return" } },
  conversation_unread: { kind: "query", summary: "How many messages wait for you, by thread.", args: {} },
};

/**
 * The durable conversation through MCP (card T05). An MCP client, whether it is an agent or an outside client, starts threads, sends, reads from a cursor and confirms receipt by calling tools
 * that go straight to the conversation service, so the records, the sender, scoping, limits and idempotency are the service's and nothing is decided here. The adapter keeps no state: there is
 * no session record, a connection or protocol session owns no thread, cursor or task, and a client that reconnects (or asks again under a newer protocol revision) is the same principal with the same
 * threads and cursor. Every request is authenticated afresh from its credential. A command carries a `commandId` that the client keeps across a reconnect, so a repeated send is the same
 * message. Transport framing is not here.
 */
export class McpConversationAdapter {
  readonly #conversations: ConversationService;
  readonly #principals: PrincipalService;

  constructor(conversations: ConversationService, principals: PrincipalService) {
    this.#conversations = conversations;
    this.#principals = principals;
  }

  /** Handles one JSON-RPC message from a client with this credential. Notifications (no `id`) get no reply. A batch is refused. */
  async handle(token: unknown, message: unknown): Promise<RpcResponse | undefined> {
    if (Array.isArray(message)) return fail(null, CODES.invalidRequest, "batches are not supported; send one message at a time");
    if (typeof message !== "object" || message === null) return fail(null, CODES.invalidRequest, "a message is a JSON object");
    const m = message as Partial<RpcRequest>;
    const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || (m.id !== undefined && id === null)) return fail(id, CODES.invalidRequest, "not a JSON-RPC 2.0 request");
    if (m.id === undefined) return undefined;
    const rid = id as string | number;
    try {
      switch (m.method) {
        case "initialize": return this.#initialize(rid, m.params);
        case "ping": return reply(rid, {});
        case "tools/list": return reply(rid, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: `${t.summary}${t.kind === "command" ? " Needs a commandId; repeating the same commandId never repeats the change." : ""}`, inputSchema: this.#schema(t) })) });
        case "tools/call": return await this.#call(token, rid, m.params);
        case "resources/list": return reply(rid, { resources: [] });
        case "resources/templates/list": return reply(rid, { resourceTemplates: [] });
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
    // No session id is issued: nothing about the conversation is tied to this handshake.
    return reply(id, { protocolVersion: wanted, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nimblenewt-conversations", version: "conversations-1" } });
  }

  #schema(t: Tool): object {
    const properties: Record<string, object> = {}; const required: string[] = [];
    for (const [key, description] of Object.entries(t.args)) {
      const optional = key.endsWith("?"); const name = optional ? key.slice(0, -1) : key;
      properties[name] = { description };
      if (!optional) required.push(name);
    }
    if (t.kind === "command") { properties["commandId"] = { type: "string", description: "A key you choose and keep: repeating it repeats the answer, never the change." }; required.push("commandId"); }
    return { type: "object", properties, required, additionalProperties: false };
  }

  async #authenticate(token: unknown): Promise<Principal | undefined> {
    if (typeof token !== "string") return undefined;
    try {
      const principal = await this.#principals.authenticate(token);
      // Workers and the controller's own services have no business in a conversation.
      return principal.kind === "host" || principal.kind === "service" ? undefined : principal;
    } catch (error) {
      if (error instanceof DomainError && error.code === "unauthenticated") return undefined;
      throw error;
    }
  }

  async #call(token: unknown, id: string | number, params: unknown): Promise<RpcResponse> {
    const p = params as { name?: unknown; arguments?: unknown } | undefined;
    const name = typeof p?.name === "string" && Object.hasOwn(TOOLS, p.name) ? p.name : undefined;
    const tool = name === undefined ? undefined : TOOLS[name];
    if (name === undefined || tool === undefined) return fail(id, CODES.params, "unknown tool");
    const args = p?.arguments === undefined ? {} : p.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, CODES.params, "arguments must be an object");
    const { commandId, ...rest } = args as Record<string, unknown>;
    if (tool.kind === "command" && (typeof commandId !== "string" || commandId.length === 0)) return fail(id, CODES.params, `${name} changes state, so it needs a commandId that you keep across a reconnect`);
    if (tool.kind === "query" && commandId !== undefined) return fail(id, CODES.params, `${name} only reads, so it takes no commandId`);
    const who = await this.#authenticate(token);
    if (who === undefined) return reply(id, this.#error("unauthenticated", "the credential was not accepted"));
    try {
      return reply(id, this.#ok(await this.#run(who, name, commandId as string, rest)));
    } catch (error) {
      if (error instanceof DomainError) {
        // A fault of ours is described without detail: its message can name internal records.
        const ours = error.code === "integrity" || error.code === "stale_epoch";
        return reply(id, this.#error(error.code, ours ? "the request could not be completed" : redactText(error.message), ours || error.field === undefined ? undefined : redactText(error.field)));
      }
      throw error;
    }
  }

  async #run(who: Principal, name: string, commandId: string, a: Record<string, unknown>): Promise<unknown> {
    const c = this.#conversations;
    const known = (allowed: readonly string[]): void => { for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new DomainError("invalid_command", `${k}: not an argument of ${name}`, { field: k }); };
    const whole = (field: string): number | undefined => {
      const v = a[field];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new DomainError("invalid_command", `${field}: must be a whole number`, { field });
      return v;
    };
    switch (name) {
      case "conversation_start": return c.start(who, { ...a, commandId } as never);
      case "conversation_send": return c.send(who, { ...a, commandId } as never);
      case "conversation_acknowledge": return c.acknowledge(who, { ...a, commandId } as never);
      case "conversation_handled": return c.markHandled(who, { ...a, commandId } as never).then(() => ({ ok: true }));
      case "conversation_close": return c.close(who, { ...a, commandId } as never).then(() => ({ ok: true }));
      case "conversation_read": {
        known(["threadId", "after", "limit"]);
        const after = whole("after"); const limit = whole("limit");
        const r = await c.read(who, { threadId: a["threadId"] as string, ...(after === undefined ? {} : { afterSeq: after }), ...(limit === undefined ? {} : { limit }) });
        if (r === undefined) throw new DomainError("not_found", "no such thread", { field: "threadId" });
        // The cursor to ask from next time: the last message returned, else where this read started.
        const last = r.items.at(-1)?.seq;
        return { ...r, cursor: last ?? after ?? r.deliveredSeq };
      }
      case "conversation_thread": {
        known(["threadId"]);
        const t = await c.thread(who, a["threadId"] as string);
        if (t === undefined) throw new DomainError("not_found", "no such thread", { field: "threadId" });
        return t;
      }
      case "conversation_threads": {
        known(["after", "limit"]);
        const limit = whole("limit");
        if (a["after"] !== undefined && typeof a["after"] !== "string") throw new DomainError("invalid_command", "after: must be text", { field: "after" });
        return c.threads(who, { ...(a["after"] === undefined ? {} : { afterId: a["after"] as string }), ...(limit === undefined ? {} : { limit }) });
      }
      default: known([]); return c.unread(who);
    }
  }

  #ok(result: unknown): object {
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
  }

  #error(code: string, message: string, field?: string): object {
    return { content: [{ type: "text", text: JSON.stringify({ code, message, ...(field === undefined ? {} : { field }) }) }], isError: true };
  }
}
