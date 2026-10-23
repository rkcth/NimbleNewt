import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

type Writable = ReturnType<typeof createModels>;
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";

/** A model request as the scripted provider received it, kept so a test can ask pi-ai to build the real provider request from it. */
export interface Seen { readonly context: { readonly messages: readonly unknown[] }; readonly options: Record<string, unknown> | undefined; readonly model: Record<string, unknown> & { readonly api: string; readonly provider: string; readonly id: string } }

export type WireApi = "anthropic-messages" | "openai-completions" | "openai-responses";
const BUILDERS: Record<WireApi, (model: never, context: never, options: never) => AsyncIterable<unknown>> = {
  "anthropic-messages": anthropicStream as never,
  "openai-completions": completionsStream as never,
  "openai-responses": responsesStream as never,
};

/**
 * The exact request body pi-ai would send for a request the scripted provider received. pi-ai builds it (cache markers, tool order, thinking blocks, cache key) and hands it to `onPayload`; the test stops it there, so
 * nothing is sent anywhere. The options the harness gave the provider (including a cache policy's `onPayload`) are the ones used.
 */
export async function wireBody(seen: Seen): Promise<Record<string, unknown>> {
  const options = { ...(seen.options ?? {}), signal: undefined, apiKey: "test-key" } as { onPayload?: (p: unknown, m: unknown) => unknown };
  const shaped = options.onPayload;
  let body: Record<string, unknown> | undefined;
  options.onPayload = async (payload, model) => {
    const replaced = shaped === undefined ? undefined : await shaped(payload, model);
    body = JSON.parse(JSON.stringify(replaced ?? payload)) as Record<string, unknown>;
    throw new Error("captured");
  };
  const build = BUILDERS[seen.model.api as WireApi];
  if (build === undefined) throw new Error(`no builder for ${seen.model.api}`);
  for await (const event of build(seen.model as never, seen.context as never, options as never)) void event;
  if (body === undefined) throw new Error("pi-ai did not build a request");
  return body;
}

export interface Rig {
  readonly models: Writable;
  readonly ref: { readonly provider: string; readonly modelId: string };
  readonly seen: Seen[];
  /** The next requests are answered by these, in order; every request is recorded first. */
  reply(...steps: (string | ReturnType<typeof fauxAssistantMessage>)[]): void;
}

/** A scripted provider that claims to speak `api` (so pi-ai's real request builder for that API can be applied to what it receives). */
export function rig(api: WireApi, provider = "anthropic", modelId = "claude-x", models: Writable = createModels()): Rig {
  const faux = fauxProvider({ api, provider, models: [{ id: modelId, reasoning: true }] });
  models.setProvider(faux.provider);
  const seen: Seen[] = [];
  return {
    models, ref: { provider, modelId }, seen,
    reply: (...steps) => faux.setResponses(steps.map((step) => (context, options, _state, model) => {
      seen.push({ context: context as never, options: options as never, model: model as never });
      return typeof step === "string" ? fauxAssistantMessage(step) : step;
    })),
  };
}

/** A second scripted provider on the same `Models`, for a model change. */
export function addRig(existing: Rig, api: WireApi, provider: string, modelId: string): Rig {
  return rig(api, provider, modelId, existing.models);
}
