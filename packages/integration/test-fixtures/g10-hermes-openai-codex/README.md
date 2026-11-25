# Hosted OpenAI route responses captured by G10 (through Hermes)

Captured on 2026-11-25 with `packages/integration/src/g10-hermes-bench.js` (the `r*-*.json` files) and one manual two-call
session (`resume-first.json`, `resume-second.json`), all through the owner's `hermes` command in one-shot mode
(`--provider openai-codex`, model gpt-6.1-sol, reasoning low, no rules or memory loaded, an empty working folder).

Each file holds only what Hermes's usage report states (token counts, model, provider, completion flag, number of
provider calls) plus the short answer. The session id, cost and billing fields were dropped; no account name, address,
organisation or token is in them. The prompts are synthetic ledger rules (see `syntheticHead`); `wallMs` appears only in
the resume files. Hermes counts `input_tokens` as the part of the prompt not served from cache; the provider's total is
input plus `cache_read_tokens`. Never edit these files.
