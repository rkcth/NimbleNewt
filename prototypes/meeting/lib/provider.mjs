// Model providers for the throwaway meeting prototype. A provider answers one tool-less call:
//   chat({ system, user, maxTokens }) -> { text, usage: { input, cached, output }, ms }
// "fake" needs no network and no key. "openai" speaks the OpenAI chat completions shape, so it also
// works against any compatible server (OpenRouter, llama.cpp, vLLM, Radiance, Strata) by baseUrl.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export function loadEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function makeProvider(cfg) {
  if (cfg.kind === "fake") return fakeProvider(cfg);
  if (cfg.kind === "openai") return openaiProvider(cfg);
  throw new Error(`unknown provider kind ${cfg.kind}`);
}

function openaiProvider(cfg) {
  const envFile = (cfg.envFile ?? "~/.config/nimblenewt/openai.env").replace(/^~/, homedir());
  const base = cfg.baseUrl ?? "https://api.openai.com/v1";
  // A key is sent only to the host it belongs to (OpenAI by default, or the host the caller named with its own key file), never with noAuth.
  const own = cfg.envFile !== undefined || new URL(base).hostname === "api.openai.com";
  const key = cfg.noAuth || !own ? undefined : (process.env[cfg.apiKeyEnv ?? "OPENAI_API_KEY"] ?? loadEnvFile(envFile)[cfg.apiKeyEnv ?? "OPENAI_API_KEY"]);
  if (!key && !cfg.noAuth && own) throw new Error("no API key (set the environment variable or the env file)");
  const maxParam = cfg.maxTokensParam ?? "max_completion_tokens";
  return {
    name: cfg.model,
    async chat({ system, user, maxTokens }) {
      const body = {
        model: cfg.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        [maxParam]: maxTokens,
        ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }),
        ...(cfg.seed === undefined ? {} : { seed: cfg.seed }),
        ...(cfg.extraBody ?? {}),
      };
      const started = Date.now();
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`provider error ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
      const choice = json.choices?.[0];
      const u = json.usage ?? {};
      return {
        text: choice?.message?.content ?? "",
        finish: choice?.finish_reason,
        usage: {
          input: u.prompt_tokens ?? 0,
          cached: u.prompt_tokens_details?.cached_tokens ?? json.timings?.cache_n ?? 0,
          output: u.completion_tokens ?? 0,
        },
        ms: Date.now() - started,
      };
    },
  };
}

// A deterministic stand-in so the controller can be tested without a model. It reads the agent's
// declared lean from the persona line ("[lean: for|against|mixed]") and answers in the same format a
// real model is asked to use.
function fakeProvider(cfg) {
  let n = 0;
  return {
    name: "fake",
    async chat({ system, user, maxTokens, hint }) {
      n += 1;
      const all = `${system}\n${user}`;
      const lean = hint?.lean ?? "mixed";
      const stance = lean === "mixed" ? (n % 2 ? "for" : "against") : lean;
      const task = hint?.task ?? "statement";
      const words = (k) => Array.from({ length: k }, (_, i) => `word${(n + i) % 7}`).join(" ");
      let text;
      if (task === "ballot") text = `VOTE: ${stance === "for" ? "yes" : stance === "against" ? "no" : "abstain"}\nREASON: ${words(12)}`;
      else if (task === "objection") text = `OBJECT: ${n % 11 === 0 ? "yes" : "no"}\nREASON: ${words(8)}`;
      else if (task === "chair-ruling") text = `RULING: proceed\nREASON: ${words(6)}`;
      else if (task === "chair-questions") text = JSON.stringify({ questions: [{ to: hint?.agents?.[0] ?? "a1", topic: "experience with the tool", experience_sought: "how long and with what result" }] });
      else text = `STANCE: ${stance}\nSTATEMENT: ${words(Math.min(40, Math.floor(maxTokens / 6)))}\nTLDR: ${stance} because ${words(5)}`;
      const input = Math.ceil(all.length / 4);
      return { text, finish: "stop", usage: { input, cached: 0, output: Math.ceil(text.length / 4) }, ms: 1 };
    },
  };
}
