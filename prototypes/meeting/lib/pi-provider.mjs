// Provider that calls a model through pi-ai (the library NimbleNewt's Pi adapter is built on), using a
// file-backed credential store. This is how a ChatGPT subscription login ("openai-codex") is used, the
// same kind of login Paperclip uses, but as a separate login with its own tokens.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

class FileCredentialStore {
  constructor(path) { this.path = path; this.chain = Promise.resolve(); }
  #load() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {}; }
  async read(id) { return this.#load()[id]; }
  async list() { return Object.entries(this.#load()).map(([providerId, c]) => ({ providerId, type: c.type })); }
  modify(id, fn) {
    const run = async () => {
      const all = this.#load();
      const next = await fn(all[id]);
      if (next === undefined) delete all[id]; else all[id] = next;
      writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
      try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
      return next;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  async delete(id) { await this.modify(id, async () => undefined); }
}

export async function piProvider(cfg) {
  const authPath = (cfg.authFile ?? "~/.config/nimblenewt/pi-auth/auth.json").replace(/^~/, homedir());
  const models = createModels({ credentials: new FileCredentialStore(authPath) });
  models.setProvider(openaiCodexProvider());
  const model = models.getModel(cfg.provider ?? "openai-codex", cfg.model);
  if (!model) throw new Error(`model ${cfg.model} not found in provider ${cfg.provider ?? "openai-codex"}`);
  return {
    name: `${cfg.provider ?? "openai-codex"}/${cfg.model}`,
    async chat({ system, user, maxTokens }) {
      const started = Date.now();
      const context = { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] };
      const options = {
        reasoningEffort: cfg.reasoningEffort ?? "low",
        ...(cfg.sessionId ? { sessionId: cfg.sessionId } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      };
      let res;
      for (let attempt = 1; ; attempt++) {
        try { res = await models.complete(model, context, options); } catch (e) { res = { stopReason: "error", errorMessage: String(e?.message ?? e) }; }
        if (res.stopReason !== "error") break;
        if (attempt >= 4) throw new Error(`provider error after ${attempt} attempts: ${res.errorMessage ?? "unknown"}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return {
        text,
        finish: res.stopReason,
        usage: { input: (res.usage.input ?? 0) + (res.usage.cacheRead ?? 0), cached: res.usage.cacheRead ?? 0, output: res.usage.output ?? 0 },
        ms: Date.now() - started,
      };
    },
  };
}
