import { createHash } from "node:crypto";
import type { AdapterRequest, RequestId, SemanticResult, ToolCallOutcome, UnansweredReason } from "@nimblenewt/contracts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models, Static, TSchema } from "@earendil-works/pi-ai";
import {
  Harness, createRegistry, defineDoc, defineExtension, defineTool,
  type Conversation, type Storage, type Submission,
} from "@earendil-works/pi-durable";
import { InvalidToolError, RequestIdConflictError, UnknownCommandError } from "./errors.js";
import { assertSupportedRuntime, type RuntimeInfo } from "./runtime.js";

/** Commands the adapter accepts. None exist yet; F06 adds branch, checkpoint and abort commands. */
const SUPPORTED_COMMANDS: readonly string[] = [];

const KNOWN_REASONS: ReadonlySet<string> = new Set(["aborted", "model_error", "stale", "restart"]);

/** What a running tool call can observe about its own invocation. */
export interface AdapterToolContext {
  /** Fires when the request is aborted or the adapter closes; long-running tools should stop promptly. */
  readonly signal: AbortSignal | undefined;
  readonly callId: string;
}

/** A tool the model may call. It returns plain text, which becomes the tool result the next model step sees. */
export interface AdapterTool<T extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: T;
  /**
   * Declare "safe" only if re-running the tool after a crash cannot repeat an external effect. The default is that an
   * interrupted call is not re-run and the model is told it was interrupted.
   */
  readonly replay?: "safe";
  execute(args: Static<T>, context: AdapterToolContext): Promise<string>;
}

export interface PiAdapterOptions {
  readonly storage: Storage;
  readonly models: Models;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly tools?: readonly AdapterTool[];
  /** Pi Durable harness settings, for example compaction thresholds. */
  readonly settings?: NonNullable<Parameters<typeof Harness.open>[1]["settings"]>;
  /** Receives Pi Durable's non-fatal reports (for example a throwing listener). */
  readonly onReport?: (error: unknown) => void;
  /** Override runtime detection; for tests of the unsupported-runtime path. */
  readonly runtime?: RuntimeInfo;
}

export interface SubmissionHandle {
  readonly requestId: RequestId;
  /** Pi's durable submission ID. Equal for every submit of the same request ID. */
  readonly submissionId: number;
  /**
   * Waits for the request to settle and returns its semantic result. The result is recorded durably the first time it
   * is built and every later call, including after compaction or a restart, returns that same record.
   */
  result(): Promise<SemanticResult>;
}

/** Adapter-owned durable record per request ID, kept in a Pi document committed with the transcript. */
interface RequestRecord {
  fingerprint: string;
  result?: SemanticResult;
}
interface RequestsState {
  requests: Record<string, RequestRecord>;
}

const Requests = defineDoc<RequestsState & Record<string, never>>({
  kind: "nimblenewt.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: {} }) as unknown as RequestsState & Record<string, never>,
});

interface EntryLike {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

function firstMessage(entry: EntryLike): { content?: unknown } {
  return (entry.model?.[0] ?? {}) as { content?: unknown };
}

function toolOutcome(entry: EntryLike): ToolCallOutcome {
  const message = firstMessage(entry) as { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
  const name = String(message.toolName ?? "");
  const callId = String(message.toolCallId ?? "");
  const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
  if (diagnostics.some((d) => d.code === "tool_unavailable")) return { callId, name, status: "unknown_tool" };
  return { callId, name, status: message.isError === true ? "error" : "ok", output: textOf(message.content) };
}

const fingerprintOf = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Maps NimbleNewt requests onto a pinned Pi Durable harness and Pi results back to semantic results. */
export class PiAdapter {
  private constructor(private readonly harness: Harness, private readonly root: Conversation) {}

  static async open(options: PiAdapterOptions): Promise<PiAdapter> {
    assertSupportedRuntime(options.runtime);
    const tools = options.tools ?? [];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (tool.name.length === 0) throw new InvalidToolError("tool name must not be empty");
      if (seen.has(tool.name)) throw new InvalidToolError(`duplicate tool name "${tool.name}"`);
      seen.add(tool.name);
    }
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "nimblenewt",
      tools: tools.map((tool) => defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.replay === undefined ? {} : { replay: tool.replay }),
        // Pi Durable 1.3.0 reads the model-visible result from `output`; the legacy `content` field is ignored.
        execute: async (args: never, api, toolContext) => ({
          output: [{ type: "text" as const, text: await tool.execute(args as Static<typeof tool.parameters>, { signal: toolContext.abortSignal, callId: api.callId }) }],
        }),
      })),
    }));
    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      },
      context,
    );
    const root = await harness.root(context, { agent: { model: options.model } });
    return new PiAdapter(harness, root);
  }

  /**
   * Admit a request. Submitting the same request ID again returns the original submission and result; reusing it with
   * different content throws RequestIdConflictError, including while the original is still queued or after compaction.
   */
  async submit(request: AdapterRequest): Promise<SubmissionHandle> {
    if (request.kind === "command") throw new UnknownCommandError(request.name, SUPPORTED_COMMANDS);
    // Record the payload fingerprint before admission: a crash in between leaves a record for the same payload to retry.
    await this.claim(request.requestId, fingerprintOf(request.content));
    const submission = await this.root.submit({ type: "input", content: request.content, requestId: request.requestId }, context);
    return { requestId: request.requestId, submissionId: submission.id, result: () => this.resultOf(request.requestId, submission) };
  }

  /**
   * Abort the running request and withdraw queued ones. Minimal for now: F06 adds scoped abort, branches and checkpoints.
   * Aborted requests settle as `unanswered` with reason `aborted`.
   */
  async abort(): Promise<void> {
    await this.root.abort(context);
  }

  /** Compact the conversation's model-visible context now. Older entries stay in storage and results stay readable. */
  async compact(instructions?: string): Promise<void> {
    const task = await this.root.compact(instructions, context);
    await this.harness.waitForTask(task, context);
  }

  async close(): Promise<void> {
    await this.harness.close(context);
  }

  private async record(id: RequestId): Promise<RequestRecord | undefined> {
    const state = (await this.harness.snapshot(Requests, this.root.id, context)) as unknown as RequestsState;
    return state.requests[id];
  }

  private async claim(id: RequestId, fingerprint: string): Promise<void> {
    let conflict = false;
    await this.root.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.root.id)) as unknown as RequestsState;
      const existing = state.requests[id];
      if (existing === undefined) state.requests[id] = { fingerprint };
      else if (existing.fingerprint !== fingerprint) conflict = true;
    }, context);
    if (conflict) throw new RequestIdConflictError(`request ID "${id}" was already used with different content`);
  }

  /** Ascending scan of the conversation's history by entry ID, which includes entries compacted out of the active view. */
  private async scan(min: number, max: number | undefined, stopAt?: (entry: EntryLike) => boolean): Promise<EntryLike[]> {
    const found: EntryLike[] = [];
    let cursor;
    for (;;) {
      const page = await this.root.entries(
        { minEntryId: min as never, ...(max === undefined ? {} : { maxEntryId: max as never }), order: "ascending" },
        100,
        cursor,
        context,
      );
      for (const entry of page.items as unknown as EntryLike[]) {
        if (stopAt?.(entry)) return found;
        found.push(entry);
      }
      if (page.next === undefined) return found;
      cursor = page.next;
    }
  }

  private async resultOf(id: RequestId, submission: Submission): Promise<SemanticResult> {
    const stored = (await this.record(id))?.result;
    if (stored !== undefined) return stored;

    const settled = await submission.wait(context);
    let toolCalls: ToolCallOutcome[] = [];
    let result: SemanticResult;
    if (settled.status === "done") {
      const start = settled.entry as number;
      const answerId = settled.answer as number;
      const entries = await this.scan(start + 1, answerId);
      toolCalls = entries.filter((e) => e.kind === "pi.tool-result").map(toolOutcome);
      const answer = entries.find((e) => e.id === answerId);
      const text = answer === undefined ? "" : textOf(firstMessage(answer).content);
      const unknown = toolCalls.filter((c) => c.status === "unknown_tool").map((c) => c.name);
      result = unknown.length > 0
        ? { status: "failed", requestId: id, code: "unknown_tool", detail: `runtime reported tool(s) unavailable: ${[...new Set(unknown)].join(", ")}`, text, toolCalls }
        : { status: "completed", requestId: id, text, toolCalls };
    } else {
      // An unanswered request owns the entries up to the next input, which belongs to a later request.
      if (settled.entry !== undefined) {
        const entries = await this.scan((settled.entry as number) + 1, undefined, (e) => e.kind === "pi.user");
        toolCalls = entries.filter((e) => e.kind === "pi.tool-result").map(toolOutcome);
      }
      const reason: UnansweredReason = KNOWN_REASONS.has(settled.reason) ? (settled.reason as UnansweredReason) : "other";
      const detail = settled.detail === undefined ? settled.reason : `${settled.reason}: ${JSON.stringify(settled.detail)}`;
      result = { status: "unanswered", requestId: id, reason, detail, toolCalls };
    }

    // First writer wins, so concurrent callers and later calls all see one recorded result.
    await this.root.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.root.id)) as unknown as RequestsState;
      const existing = state.requests[id];
      if (existing === undefined) state.requests[id] = { fingerprint: "", result };
      else if (existing.result === undefined) existing.result = result;
    }, context);
    return (await this.record(id))?.result ?? result;
  }
}
