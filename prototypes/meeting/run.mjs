#!/usr/bin/env node
// Throwaway meeting prototype runner (card M00).
//   node prototypes/meeting/run.mjs --scenario tool-adoption --variant open-two-rounds --provider fake
//   node prototypes/meeting/run.mjs --scenario tool-adoption --variant blind-first --provider pi --model gpt-6.1-sol --cap-tokens 400000
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProvider } from "./lib/provider.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { runMeeting } from "./lib/meeting.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : acc), []));
const load = (dir, name) => JSON.parse(readFileSync(join(here, dir, `${name}.json`), "utf8"));
const scenario = load("scenarios", args.scenario ?? "tool-adoption");
const variant = load("variants", args.variant ?? "open-two-rounds");
const kind = args.provider ?? (args.chair ? "mixed" : "fake");

let provider;
if (kind === "mixed") provider = undefined;
else if (kind === "pi") {
  const { piProvider } = await import("./lib/pi-provider.mjs");
  provider = await piProvider({ model: args.model ?? "gpt-6.1-sol", reasoningEffort: args.effort ?? "low", sessionId: args.session });
} else if (kind === "openai") {
  provider = makeProvider({ kind: "openai", model: args.model, baseUrl: args["base-url"], noAuth: args["no-auth"] === "true", maxTokensParam: args["max-param"], extraBody: args["extra-body"] ? JSON.parse(args["extra-body"]) : undefined });
} else provider = makeProvider({ kind: "fake" });

// Mixed roster: --chair pi:gpt-6.1-sol --members a1=pi:gpt-6-astra,a2=or:z-ai/glm-5.3-prime,a3=or:qwen/qwen3.8-max-prime
// (pi: = ChatGPT subscription route via pi-ai; or: = OpenRouter, key from ~/.config/nimblenewt/openrouter.env)
async function fromSpec(spec) {
  const [route, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (route === "pi") { const { piProvider } = await import("./lib/pi-provider.mjs"); return piProvider({ model, reasoningEffort: args.effort ?? "low", sessionId: args.session }); }
  if (route === "or") return makeProvider({ kind: "openai", model, baseUrl: "https://openrouter.ai/api/v1", envFile: "~/.config/nimblenewt/openrouter.env", apiKeyEnv: "OPENROUTER_API_KEY", maxTokensParam: "max_tokens", extraBody: { reasoning: { effort: args.effort ?? "low" } } });
  throw new Error(`unknown route in ${spec}`);
}
const providers = {};
if (args.chair) providers.chair = await fromSpec(args.chair);
if (args.members) {
  providers.byAgent = {};
  const cache = new Map();
  for (const pair of args.members.split(",")) {
    const [id, spec] = pair.split("=");
    if (!cache.has(spec)) cache.set(spec, await fromSpec(spec));
    providers.byAgent[id] = cache.get(spec);
  }
}
if (providers.chair && !args.provider) provider = providers.chair;
if (!provider) throw new Error("a mixed roster needs --chair");
const ledger = new Ledger({ capTokens: Number(args["cap-tokens"] ?? 300000), capUsd: Number(args["cap-usd"] ?? Infinity), prices: { in: Number(args["price-in"] ?? 0), cachedIn: Number(args["price-cached"] ?? 0), out: Number(args["price-out"] ?? 0) } });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = join(here, "runs", `${stamp}-${slug(scenario.title.split(" ")[0])}-${variant.name}-${kind}`);
const headroom = Number(args.headroom ?? (kind === "pi" || kind === "mixed" ? 800 : 0));
const summary = await runMeeting({ scenario, variant, provider, providers, ledger, outDir, headroom, log: args.quiet ? () => {} : (m) => console.log(m) });
console.log(`\nResult: ${JSON.stringify(summary.result)}\nCalls: ${summary.metrics.calls}  Tokens: ${ledger.tokens}  Cache hit ratio: ${(summary.metrics.cacheHitRatio * 100).toFixed(1)}%\nStance agreement with previous speaker (round 1): ${summary.metrics.round1StanceAgreementWithPrevious}\nOutput: ${outDir}`);
// pi-ai keeps a pooled connection open after the last call; end the process once the outputs are written.
process.exit(0);
