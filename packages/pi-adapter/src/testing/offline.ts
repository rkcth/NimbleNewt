import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";

export const OFFLINE_PROVIDER = "offline";
export const OFFLINE_MODEL = "scripted";
export const OFFLINE_MODEL_REF = { provider: OFFLINE_PROVIDER, modelId: OFFLINE_MODEL } as const;

type Faux = ReturnType<typeof fauxProvider>;

export interface OfflineModels {
  readonly models: Models;
  /** The scripted provider; queue replies with `faux.setResponses`. */
  readonly faux: Faux;
}

/** A scripted model provider with no network or credentials. Test processes also run under scripts/offline-guard.mjs. */
export function createOfflineModels(): OfflineModels {
  const models = createModels();
  const faux = fauxProvider({ provider: OFFLINE_PROVIDER, models: [{ id: OFFLINE_MODEL }] });
  models.setProvider(faux.provider);
  return { models, faux };
}

export interface OfflineHarness {
  harness: Harness;
  /** Queue the scripted model replies, in order. */
  respondWith(...replies: string[]): void;
  close(): Promise<void>;
}

/** A real Pi Durable harness over in-memory storage with a scripted model. */
export async function createOfflineHarness(): Promise<OfflineHarness> {
  const { models, faux } = createOfflineModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  return {
    harness,
    respondWith: (...replies) => faux.setResponses(replies.map((text) => fauxAssistantMessage(text))),
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
