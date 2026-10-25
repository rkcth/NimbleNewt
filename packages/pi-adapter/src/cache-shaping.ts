import { createHash } from "node:crypto";
import type { Model, Models } from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";

/**
 * Cache shaping for the model calls Pi makes (card C06b). Pi gives the provider one session ID per conversation (a random UUID) and derives Anthropic cache breakpoints and OpenAI's `prompt_cache_key` from it, so two agents
 * that share their first ten thousand tokens never share a cache entry. The wrapper below sits between Pi and the real `Models` and does three things, none of which changes what the model is asked:
 *
 *   - replaces the per-conversation session ID with the key the controller derived for the *shared prefix* (a project, a meeting) and sets the cache retention the backend profile (C06) wants;
 *   - measures, for every request, how much of it is the same bytes as an earlier request under the same key (`PrefixReport`), so a prefix that stopped being shared shows up as a number, not as a bill;
 *   - notices stored thinking that the target model cannot accept (pi-ai leaves such blocks out of the request; the wrapper reports that it did, and how many) so the controller can record it.
 *
 * The wrapper never edits messages, tools or system text. Whatever it does not understand passes through untouched.
 */

export type Retention = "none" | "short" | "long";

export interface ModelInfo { readonly provider: string; readonly api: string; readonly id: string }

/** What the controller wants for one model: the cache key of the shared prefix and the retention its backend profile supports. Both optional; absent leaves Pi's own value. */
export interface ModelCachePolicy {
  /** Opaque, derived per scope (C06 `deriveKey(secret, "share", ...)`): never a project or task ID. Every agent that can share a prefix gets the same key. */
  readonly key?: string;
  readonly retention?: Retention;
  /** Applied to the provider's request body just before it is sent (C06's `profile.prepare`: `id_slot`, `cache_salt`, `prompt_cache_key`, breakpoints). Must return the body to send; it never sees the model's output. */
  readonly payload?: (payload: unknown) => unknown;
  /**
   * Wraps the `fetch` the provider SDK uses for this model's HTTP calls (card H12e). The controller hands the call to its per-endpoint cache state here (slot turns, holder checks, markers and pins, hit figures), which a payload
   * edit cannot do because it happens around the call, not in it. `inner` is the fetch Pi would have used (the caller's own, or the global one); the wrapper must return a standard `Response`. It applies to the one-shot compaction
   * call too. Absent leaves Pi's own fetch.
   */
  readonly fetch?: (inner: typeof globalThis.fetch) => typeof globalThis.fetch;
}

export interface PrefixReport {
  /** Pi's own session ID for the conversation making the request. */
  readonly session: string;
  /** The key sent to the provider in its place (absent when none was configured). */
  readonly key: string | undefined;
  readonly model: string;
  /** Messages of the request, the leading system message (with the tool declarations) counted as the first. */
  readonly segments: number;
  readonly chars: number;
  /** How many leading segments (and characters) equal an earlier request under the same key, and where that request came from. Zero with `source: "none"` for the first request of a key. */
  readonly sharedSegments: number;
  readonly sharedChars: number;
  readonly source: "none" | "same-conversation" | "other-conversation";
  /** The index of the first segment that differs from that request (0 is the system message and tools), absent when the request only extends it. */
  readonly firstChanged: number | undefined;
}

export interface ThinkingDropReport {
  readonly session: string;
  readonly model: string;
  /** Thinking blocks left out of the request because another model produced them. They stay in the conversation. */
  readonly dropped: number;
  /** Thinking blocks the target model receives, in order. */
  readonly kept: number;
}

export interface CacheShaping {
  /**
   * The leading system text every agent of the project has in common (the rendered preamble and project sections). On the Anthropic API the wrapper then sends it as a system block of its own, ahead of the block
   * with the agent's instructions, so a cache breakpoint can sit between them and agents share the cached prefix. Other APIs reuse by position and need no split.
   */
  readonly sharedSystem?: () => string | undefined;
  readonly policy?: (model: ModelInfo) => ModelCachePolicy | undefined;
  readonly onRequest?: (report: PrefixReport) => void;
  readonly onThinkingDropped?: (report: ThinkingDropReport) => void;
  /** Told when an observer throws. The request is sent unchanged either way. */
  readonly onReport?: (error: unknown) => void;
}

/** Fields of a stored message that no provider puts in a request (clock times, usage, ids of the response). Left out so two requests with the same wire content compare equal. */
const NOT_ON_THE_WIRE = new Set(["timestamp", "usage", "responseId", "durationMs", "details", "stopReason", "errorMessage"]);
const onTheWire = (message: unknown): string => {
  if (message === null || typeof message !== "object") return JSON.stringify(message) ?? "";
  return JSON.stringify(Object.fromEntries(Object.entries(message).filter(([key]) => !NOT_ON_THE_WIRE.has(key)))) ?? "";
};

const REMEMBERED_PER_KEY = 8;
const REMEMBERED_KEYS = 256;

interface Remembered { readonly session: string; readonly hashes: readonly string[]; readonly sizes: readonly number[] }

/** Tracks the last few requests of each key (hashes only, so memory is bounded and no prompt text is held). */
export class PrefixTracker {
  readonly #byKey = new Map<string, Remembered[]>();

  /** Compares the request with what the key has seen, remembers it, and says how much of it was shared. */
  observe(session: string, key: string | undefined, model: string, messages: readonly unknown[]): PrefixReport {
    const serialized = messages.map(onTheWire);
    const hashes = serialized.map((s) => createHash("sha1").update(s).digest("base64url"));
    const sizes = serialized.map((s) => s.length);
    const bucket = key ?? `session:${session}`;
    const earlier = this.#byKey.get(bucket) ?? [];
    let best: { shared: number; from: Remembered } | undefined;
    for (const candidate of earlier) {
      let n = 0;
      while (n < hashes.length && n < candidate.hashes.length && hashes[n] === candidate.hashes[n]) n++;
      if (best === undefined || n > best.shared || (n === best.shared && candidate.session === session && best.from.session !== session)) best = { shared: n, from: candidate };
    }
    const shared = best?.shared ?? 0;
    const chars = sizes.reduce((a, b) => a + b, 0);
    const report: PrefixReport = {
      session, key, model, segments: hashes.length, chars,
      sharedSegments: shared,
      sharedChars: sizes.slice(0, shared).reduce((a, b) => a + b, 0),
      source: best === undefined ? "none" : best.from.session === session ? "same-conversation" : "other-conversation",
      firstChanged: best === undefined ? undefined : best.shared >= Math.min(hashes.length, best.from.hashes.length) ? undefined : best.shared,
    };
    const next = [...earlier, { session, hashes, sizes }];
    this.#byKey.delete(bucket);
    this.#byKey.set(bucket, next.slice(-REMEMBERED_PER_KEY));
    while (this.#byKey.size > REMEMBERED_KEYS) this.#byKey.delete(this.#byKey.keys().next().value as string);
    return report;
  }
}

/**
 * The messages as the provider will see them. Pi appends a later change of a section or a tool as another system message, so its log only ever grows; pi-ai then folds every system message into the one at the head unless the
 * model says it takes system messages mid-conversation (`compat.supportsMidConvoSystemMessages`, off for most). On those models a change rewrites the head of the request, and this view shows it as such.
 */
function onTheWireMessages(model: Model<never>, messages: readonly unknown[]): readonly unknown[] {
  const compat = (model as { compat?: { supportsMidConvoSystemMessages?: boolean } }).compat;
  return compat?.supportsMidConvoSystemMessages === true ? messages : collapseSystemMessages({ messages } as never).messages;
}

/** Thinking blocks in the messages and how many the model can take back: only those the same provider, API and model produced (the rule pi-ai applies before it builds the request). */
export function thinkingFor(messages: readonly unknown[], model: ModelInfo): { readonly kept: number; readonly dropped: number } {
  let kept = 0; let dropped = 0;
  for (const m of messages) {
    const message = m as { role?: string; provider?: string; api?: string; model?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
    for (const block of message.content as { type?: string; thinking?: string; thinkingSignature?: string; redacted?: boolean }[]) {
      if (block?.type !== "thinking") continue;
      // A block with nothing in it (no text, no signature, not redacted) is left out of every request and is neither kept nor dropped.
      if (!(block.redacted === true || (typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0) || (typeof block.thinking === "string" && block.thinking.trim() !== ""))) continue;
      if (same) kept++; else dropped++;
    }
  }
  return { kept, dropped };
}

/** Splits the first system block of an Anthropic request after `shared`, keeping any cache marker on both halves. Anything that does not match exactly is returned as it was. */
export function splitSharedSystem(payload: unknown, shared: string): unknown {
  const body = payload as { system?: unknown } | null;
  if (body === null || typeof body !== "object" || !Array.isArray(body.system) || shared.length === 0) return payload;
  const first = body.system[0] as { type?: string; text?: string; cache_control?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string" || !first.text.startsWith(shared) || first.text.length === shared.length) return payload;
  const rest = first.text.slice(shared.length).replace(/^\n\n/, "");
  if (rest.length === 0) return payload;
  const mark = first.cache_control === undefined ? {} : { cache_control: first.cache_control };
  return { ...body, system: [{ type: "text", text: shared, ...mark }, { ...first, text: rest }, ...body.system.slice(1)] };
}

/** The model calls of `models`, shaped. Every other member of `Models` passes through. */
export function shapeModels(models: Models, shaping: CacheShaping): Models {
  const tracker = new PrefixTracker();
  const reported = new Map<string, string>();
  return new Proxy(models, {
    get(target, property) {
      // Compaction summaries come through here: one-shot calls that nobody continues, so they carry no cache settings of any kind. (`streamDeferred` only fetches a result already requested and is left alone.)
      if (property === "completeSimple") {
        return (model: Model<never>, context: unknown, options?: { fetch?: typeof globalThis.fetch }) => {
          // The call still has no cache key or retention, but on a server whose cache needs state around the call (llama.cpp slots) it goes through the same wrapper as every other call, so it can neither land in another project's slot nor leave the holders unknown.
          let wrap: ModelCachePolicy["fetch"];
          try { wrap = shaping.policy?.({ provider: model.provider, api: model.api, id: model.id })?.fetch; } catch (error) { try { shaping.onReport?.(error); } catch { /* ignored */ } }
          return (target.streamSimple as (m: unknown, c: unknown, o: unknown) => { result(): Promise<unknown> }).call(target, model, context, { ...(options ?? {}), cacheRetention: "none", ...(wrap === undefined ? {} : { fetch: wrap(options?.fetch ?? globalThis.fetch) }) }).result();
        };
      }
      if (property !== "streamSimple") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (model: Model<never>, context: { readonly messages: readonly unknown[] }, options?: { sessionId?: string; cacheRetention?: Retention }) => {
        const info: ModelInfo = { provider: model.provider, api: model.api, id: model.id };
        const decided = shaping.policy?.(info);
        const session = options?.sessionId ?? "";
        try {
          shaping.onRequest?.(tracker.observe(session, decided?.key, `${info.provider}/${info.id}`, onTheWireMessages(model, context.messages)));
          if (shaping.onThinkingDropped !== undefined) {
            const t = thinkingFor(context.messages, info);
            const signature = `${info.provider}/${info.id}:${t.dropped}:${t.kept}`;
            if (t.dropped > 0 && reported.get(session) !== signature) {
              if (reported.size >= REMEMBERED_KEYS) reported.delete(reported.keys().next().value as string);
              reported.set(session, signature);
              shaping.onThinkingDropped({ session, model: `${info.provider}/${info.id}`, dropped: t.dropped, kept: t.kept });
            }
          }
        } catch (error) { try { shaping.onReport?.(error); } catch { /* a failing report must not change the request either */ } }
        const earlier = (options as { onPayload?: (payload: unknown, model: unknown) => unknown } | undefined)?.onPayload;
        const wantsPayload = decided?.payload !== undefined || (shaping.sharedSystem !== undefined && info.api === "anthropic-messages");
        const shaped = {
          ...(options ?? {}),
          ...(!wantsPayload ? {} : {
            onPayload: async (payload: unknown, m: unknown) => {
              let body = payload;
              const shared = info.api === "anthropic-messages" ? shaping.sharedSystem?.() : undefined;
              if (shared !== undefined) body = splitSharedSystem(body, shared);
              if (decided?.payload !== undefined) body = decided.payload(body);
              const after = earlier === undefined ? undefined : await earlier(body, m);
              return after ?? body;
            },
          }),
          ...(decided?.key === undefined ? {} : { sessionId: decided.key }),
          ...(decided?.retention === undefined ? {} : { cacheRetention: decided.retention }),
          ...(decided?.fetch === undefined ? {} : { fetch: decided.fetch((options as { fetch?: typeof globalThis.fetch } | undefined)?.fetch ?? globalThis.fetch) }),
        };
        return (target.streamSimple as (m: unknown, c: unknown, o: unknown) => unknown).call(target, model, context, shaped);
      };
    },
  });
}
