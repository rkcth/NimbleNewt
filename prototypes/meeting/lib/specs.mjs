// Route specs: pi:<model> = ChatGPT subscription via pi-ai; or:<model> = OpenRouter (key read by the provider from its own env file);
// radiance:<model> = the owner's local server, key and base URL from Pi's own config, one fixed output cap on every call (the model
// thinks, and thinking counts against the cap; default 6000, --fixed-max) and reasoning_effort from --effort (default medium).
import { makeProvider } from "./provider.mjs";

export async function fromSpec(spec, args = {}) {
  const [route, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (route === "pi") { const { piProvider } = await import("./pi-provider.mjs"); return piProvider({ model, reasoningEffort: args.effort ?? "low", sessionId: args.session }); }
  if (route === "or") return makeProvider({ kind: "openai", model, baseUrl: "https://openrouter.ai/api/v1", envFile: "~/.config/nimblenewt/openrouter.env", apiKeyEnv: "OPENROUTER_API_KEY", maxTokensParam: "max_tokens", extraBody: { reasoning: { effort: args.effort ?? "low" } } });
  if (route === "radiance") {
    const { radianceConfig } = await import("./radiance.mjs");
    const c = radianceConfig();
    return makeProvider({ kind: "openai", model, baseUrl: c.baseUrl, apiKey: c.apiKey, maxTokensParam: "max_tokens", fixedMaxTokens: Number(args["fixed-max"] ?? 6000), extraBody: { reasoning_effort: args.effort ?? "medium" } });
  }
  throw new Error(`unknown route in ${spec}`);
}
