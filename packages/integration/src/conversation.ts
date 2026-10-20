import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import type { ConversationSubmitter } from "@nimblenewt/controller";
import { PiAdapter } from "@nimblenewt/pi-adapter";

const PROVIDER = "offline";
const MODEL = "scripted";

/** The real Pi adapter over durable JSONL storage in `directory`, with a scripted model (no network). `answer` is what the model says to the next request it actually runs. */
export async function openAdapter(directory: string, answer: string): Promise<{ adapter: PiAdapter; script(): void }> {
  const models = createModels();
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL }] });
  models.setProvider(faux.provider);
  const script = () => faux.setResponses([fauxAssistantMessage(answer)]);
  script();
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models, model: { provider: PROVIDER, modelId: MODEL }, tools: [] });
  return { adapter, script };
}

/** The controller's conversation port over the real adapter: the request ID is passed through, interrupted work is resumed through the adapter's reviewed recovery step, and the checkpoint is kept as an opaque record. */
export function piConversation(adapter: PiAdapter): ConversationSubmitter {
  const conversation = adapter.root();
  return {
    submit: async ({ requestId: id, content }) => {
      const handle = await conversation.submit({ kind: "input", requestId: requestId(id), content });
      return { result: async () => { const r = await handle.result(); return { status: r.status, ...("text" in r && typeof r.text === "string" ? { text: r.text } : {}) }; } };
    },
    lookup: async (id) => { const r = await conversation.lookup(requestId(id)); return r === undefined ? undefined : { status: r.status, ...("text" in r && typeof r.text === "string" ? { text: r.text } : {}) }; },
    interrupted: async () => {
      const w = await adapter.interrupted();
      // Live tasks in a conversation with no request to attribute them to cannot be shown to be this attempt's.
      const unattributed = w.conversations.filter((c) => c.tasks > 0 && c.requestIds.length === 0).reduce((sum, c) => sum + c.tasks, 0);
      return { held: w.held, requestIds: w.conversations.flatMap((c) => c.requestIds), unattributed };
    },
    recover: async (reason) => adapter.recover({ abandon: [], reason, decidedBy: "controller" }),
    checkpoint: async () => JSON.parse(JSON.stringify(await conversation.checkpoint())) as never,
  };
}
