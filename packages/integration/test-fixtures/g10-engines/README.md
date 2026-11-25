# G10, captured responses from llama.cpp and vLLM (2026-11-25)

One cold and one shared-head response per engine, taken by `g10-engines-live-bench.ts` against Qwen3-8B on a rented RTX 3090 (see `docs/nimblenewt/implementation-plan/evidence/g10-engines-evidence.md`).
Only the `usage` and `timings` objects are kept; the reply text is not. The prompt was the synthetic ledger text of `g10-engines-live.ts`. `g10-engines-live.test.ts` re-reads these files with the same `readCache` the bench uses.

- `vllm-*`: vLLM v0.34.0, `--enable-prompt-tokens-details`; the cache figure is `usage.prompt_tokens_details.cached_tokens` (this build also adds `created_cache_tokens`).
- `llamacpp-*`: llama.cpp server-cuda image `ghcr.io/ggml-org/llama.cpp@sha256:2855fd7d...`; the cache figures are `timings.cache_n` and `timings.prompt_n` (this build also repeats the cached count in `usage.prompt_tokens_details.cached_tokens`).
