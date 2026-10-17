# Backend protocol audit — server source inspection

> Historical feasibility research, October 16, 2026. Statements about future research gates are superseded by the current implementation plan. These reports do not qualify NimbleNewt production code. Raw machine-local fixtures remain in the research workspace; paths below identify historical evidence, not shipped dependencies.

October 16, 2026. Read-only source inspection; no inference request, model startup, pause, cache reset, or service restart was performed.

## Conclusion

The backends share an OpenAI-compatible chat request surface, but not a standard cache-marker/fork/resume protocol. Existing native caching is useful. NimbleNewt needs a capability-based adapter for optimized switching; arbitrary mid-generation per-request branching remains unproven and may require narrowly scoped engine work. Cache files/state are backend/model/version specific, not portable between engines.

## Provenance

- llama.cpp source: `/srv/ai/strata-evaluation/source/third_party/llama.cpp`. This is a vendored tree inside Strata, not an independent Git checkout. The **parent Strata** HEAD is `a789dcb7334ab2a89938e037a942e674a06fd40a`; this must not be mislabeled an upstream llama.cpp commit. No local changes were reported for its `tools/server` subtree. Inspected server source and README are copied under `evidence/backend-source/llama.cpp`.
- `/srv/ai/lucebox/server/deps/llama.cpp` is a partial vendor tree and was not used as evidence of a complete server API. Its apparent Git HEAD belongs to the parent Lucebox repository.
- vLLM: Python source inside the **stopped** `aim-llm-current` container, image `sha256:83a9dc02a8f8e75aabe81366d36ebaa2e35fcbe181cacf8e8e0a4cef4ebccbcc` (`magiccodingman/vllm-radiance` image). Source path `/opt/vllm/lib/python3.12/site-packages/vllm`; `_version.py` reports 0.28.0 and no commit ID. Radiance version file reports `0.9.3-dev.vllm0.28.0-r4d0.5.0-mxfp4.rx4.dflash2.xgrammar.openobj.kvoffload.restore2`. This is packaged source, not a confirmed standalone Git checkout or a currently serving endpoint. API source plus relevant engine files are copied under `evidence/backend-source/vllm`.
- Earlier Strata conversation-parking evidence came from the separate Mac candidate checkout recorded in design section 6A. Do not conflate that candidate with a running server build.

## Compatibility matrix

| Capability | llama.cpp inspected source | vLLM inspected source | NimbleNewt consequence |
| --- | --- | --- | --- |
| Chat messages and streaming | `/v1/chat/completions` | OpenAI chat-completion API | Common ordinary request envelope; template/tool/reasoning details still versioned. |
| Reuse unchanged prefix | `cache_prompt` documented default true; reuse matching prefix | Automatic prefix cache; request `cache_salt` partitions reuse | Preserve stable exact token prefixes and scope. Cache presence/hit must be measured, not assumed. |
| Explicit saved cache | `/slots/{id}?action=save`, `restore`, `erase`; file under configured slot-save directory | No equivalent named slot snapshot API found in inspected entrypoint routes | Separate adapters; vLLM transfer/offload options are not automatically a named session checkpoint API. |
| Select execution context | Slot-oriented server parameters/state | Request IDs and scheduler-managed requests | IDs are not interchangeable; neither is a universal conversation-state token. |
| Mid-generation save | Server queues SLOT_SAVE/SLOT_RESTORE while slot is processing | No per-request snapshot/fork HTTP endpoint found in inspected routes | Neither establishes the exact proposed marker operation during decoding. |
| Pause/resume | Inspected live chat control supports `reasoning_end`, not general freeze/resume | `/pause?mode=keep` and `/resume` exist in development routes | vLLM pause is engine-wide; it blocks new inquiries on that engine too. |
| Request cancellation | Requires its own adapter/protocol qualification | `/abort_requests` accepts request IDs; missing IDs targets all requests | Abort is not resumable freeze. Never map one task's Pause to global abort. |
| KV movement | Slot save/restore is a backend state format | `kv_transfer_params` for disaggregated serving | Transporting cache is not the same as safe fork/retain/restore semantics. |

## Source details that affect the design

**llama.cpp:** `tools/server/README.md` documents `cache_prompt`, saved slot filenames, and save/restore timing and token counters. `server-context.cpp` checks `slot->is_processing()` in both SLOT_SAVE and SLOT_RESTORE and defers the task. Saving calls `llama_state_seq_save_file`; restoring loads sequence state and validates the token representation. This supports idle-slot persistence, not an immediate snapshot at an arbitrary point in a running decode. The `/v1/chat/completions/control` documentation describes only `reasoning_end`, which moves from reasoning to a final answer; it is not a task-pause mechanism.

**vLLM:** `entrypoints/serve/dev/rlhf/api_router.py` provides pause modes abort/wait/keep and a resume route. `v1/engine/async_llm.py` and `core.py` apply these through the scheduler. In keep mode the scheduler enters PAUSED_ALL; new requests wait until resume. Therefore pausing A this way cannot let an inquiry run on the same engine while A remains frozen. It is useful infrastructure evidence, not the desired user-facing primitive.

These vLLM routes are registered only under `VLLM_SERVER_DEV_MODE` in the inspected API server. The router bundle includes broader administrative functions and its source warns against production exposure. Do not enable the entire bundle as a shortcut; use a narrowly authenticated internal bridge or a reviewed minimal API if this mechanism is adopted.

The router says `clear_cache` is ignored for keep mode, but the inspected engine paths still contain conditional cache-reset calls when `clear_cache` is true. This is a source-level contract discrepancy to trace and test, not proof that an active request's cache is necessarily destroyed: reset behavior has its own conditions. Qualification should explicitly request cache preservation and verify actual reuse rather than trust default arguments or docstrings.

`cache_salt` is for cache-sharing isolation, not a bookmark. `kv_transfer_params` concerns configured KV transfer; it does not establish a client-controlled saved task context. No common pin/fork/restore handle was found in the inspected public routes. Internal cache blocks and copy-on-write machinery may be reusable implementation components, but exposing correct lifetime and concurrency behavior requires an explicit contract.

## Recommended integration

Keep the common chat API for baseline behavior. Define an internal TypeScript capability interface for prefix reuse, checkpoint, bounded retain, fork, resume, release and cache-status reporting. Each backend adapter reports exactly what its pinned implementation can do; unsupported operations use preserved application context and ordinary inference. A cache miss must affect latency, not correctness.

For initial baseline measurements:

1. Test exact-prefix A → inquiry → A with native caching, including eviction and rerouting.
2. Test llama.cpp idle-slot save/restore and retention without conflating it with in-flight snapshots.
3. Test vLLM engine keep/resume only in an isolated instance, verifying cache behavior and scheduler scope. Do not expose it as per-agent Pause.
4. Test Strata's existing conversation parking from the correct pinned build.
5. Only then decide whether to implement a per-request hold/fork/resume extension. The extension must let inquiries proceed while the original request remains held, preserve complete compatible state, and enforce memory/lifetime/privacy budgets.

This audit answers protocol compatibility from source. It does not establish runtime compatibility, exact decoder continuation, performance, active service configuration, or safety of enabling development endpoints.
