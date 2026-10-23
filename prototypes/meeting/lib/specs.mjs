// Route specs: pi:<model> = ChatGPT subscription via pi-ai; or:<model> = OpenRouter (key read by the provider from its own env file).
import { makeProvider } from "./provider.mjs";

export async function fromSpec(spec, args = {}) {
  const [route, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (route === "pi") { const { piProvider } = await import("./pi-provider.mjs"); return piProvider({ model, reasoningEffort: args.effort ?? "low", sessionId: args.session }); }
  if (route === "or") return makeProvider({ kind: "openai", model, baseUrl: "https://openrouter.ai/api/v1", envFile: "~/.config/nimblenewt/openrouter.env", apiKeyEnv: "OPENROUTER_API_KEY", maxTokensParam: "max_tokens", extraBody: { reasoning: { effort: args.effort ?? "low" } } });
  throw new Error(`unknown route in ${spec}`);
}
