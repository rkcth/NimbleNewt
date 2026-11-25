# G10: llama.cpp and vLLM, measured on a rented GPU (2026-11-25)

What this is: the same kind of measurement the Radiance runs made (a shared head read again in other conversations, after idle gaps, after other conversations may have pushed it out, and with several at once), run against two open engines.
The raw figures are in `g10-vllm-run1.json`, `g10-llamacpp-run1.json` and `g10-llamacpp-run2.json` (usage, timing and counter fields only). The code is `packages/integration/src/g10-engines-live.ts`; the run command is in `g10-engines-live-bench.ts`.

**These are not comparable with the Radiance numbers as such.** Radiance ran `qwen3.8-flash-next-iq4r` (a hybrid model) on the owner's hardware; these runs used Qwen3-8B (a plain transformer) on one rented RTX 3090. Where a quantity corresponds it is named; no equivalence is claimed.

## Setup

| | vLLM | llama.cpp (runs 1 and 2) |
|---|---|---|
| Engine | `vllm/vllm-openai:v0.34.0` (Docker Hub, tag pinned; digest prefix sha256:20fdb089454a) | `ghcr.io/ggml-org/llama.cpp@sha256:2855fd7d0f5781e289a8108c3abd0744d19621314641b97421c038be836ed373` (`server-cuda` as of 2026-11-25; the build number is not recorded by the run) |
| Model | `Qwen/Qwen3-8B` (bf16, public) | `Qwen/Qwen3-8B-GGUF:Q8_0` (public) |
| Flags | `--max-model-len 16384 --enable-prompt-tokens-details --max-num-seqs 16 --gpu-memory-utilization 0.90` | `-ngl 99 -c 32768 -np 4 --metrics --cache-reuse 256 --jinja --slot-save-path /tmp`; run 2 adds `--cache-ram 0` |
| Cache size seen | `num_gpu_blocks=520`, block size 64: 33,280 tokens | 4 slots of 8,192 tokens; the default host-memory prompt cache (`--cache-ram`, documented default 8192 MiB; the size was not read back) in run 1, none in run 2 |
| GPU, cloud, price | RTX 3090 24 GB, RunPod community cloud, $0.22 per hour; host CUDA 13.0 | same type; run 2 asked for a host with CUDA 12.8 or newer |
| Data centre | not shown by the RunPod CLI | not shown |
| Head size | 200 synthetic ledger rules, about 6,470 tokens; thinking off; 24 reply tokens | same |
| Pod minutes | 12.9 | run 1: 7.7, run 2: 3.1 |

Spend: about 24 pod minutes in the three measuring pods plus one pod of about 7 minutes that could not start (its host's driver was too old for the image; it ran no measurement) and a handful of creation attempts refused for lack of stock (no charge). At $0.22 an hour that is about $0.12 in total; even at the $0.60 ceiling it would be under $0.35. The CLI shows no account balance, so the balance was not read; the estimate is price times minutes.

## What was measured

Reuse is "tokens from cache / prompt tokens". "Reused" below means at least half.

**Shared head across conversations (both engines):** the cold call computed everything (llama.cpp: 0 of 6,472 cached; vLLM: 0 of 6,470). A second conversation with a different question and a third both reused the head: vLLM 6,400 and 6,464 of 6,470 (whole 64-token blocks), time to first token 190 to 220 ms against 1,820 ms cold; llama.cpp 6,454 of 6,472, 72 to 81 ms against 1,605 ms cold. An unrelated head was not reused on either. (Client times include the RunPod proxy.)

**Idle gaps 0, 15, 30, 60 and 120 s:** the head was reused after every gap on both engines (vLLM 6,400 of 6,471 each time; llama.cpp 6,451 to 6,455 of 6,471). Nothing else was sent during a gap. One vLLM call after 15 s had a slow first token (1,794 ms) despite the full reuse figure; that is one observation and not explained (proxy delay is the likely cause, not checked). Nothing past 120 s was measured.

**Other conversations pushing the head out (the cliff).** One head is read, then distinct heads of the same size, and the first head is asked again after 1, 2, 4, 8, 16 and 32 others in total. Each probe also re-reads the head, so the figure is the number of *other* heads read since the head was last used:
- vLLM (a cache of about 5 heads): kept after 1, 2, 4 and 8 others in total (4 since the previous probe for the 8), lost at 16 (8 since the previous probe). Between 4 and 8 others fit the 33,280-token cache; the exact edge was not searched.
- llama.cpp, no host cache (`--cache-ram 0`, run 2): kept after 1, 2, 4; lost at 8 others since the last probe. With 4 slots that is the slot count: once more conversations than slots have run, the oldest slot is reused.
- llama.cpp, default host cache (run 1): kept through 16 others (about 104,000 tokens read in between), lost at 32 (16 others since the last probe; about 207,000 tokens in all). So with the default settings a head survives far more conversations than slots. How much it holds depends on `--cache-ram` and on the machine's memory; only the 8 GiB default was exercised here.

**Concurrency 1, 2, 4, 8, on a head already read:**
- vLLM: every request reused the head at every level (1, 2, 4, 8 of 8). Wall time for the whole group 248, 683, 708 and 748 ms.
- llama.cpp: **only one request in a group of 2 or 4 reused the head**, the others went to another (empty) slot and computed it again (cached 4 to 6 tokens); at 8, five of eight reused it. Whole-group wall time 114, 1,670, 4,651 and 4,779 ms (the cold copies being computed one after another per slot). The same in both runs, so it is not the host cache. Caches are per slot; slots are not shared in this configuration.
- Brand-new head to n conversations at once: vLLM shared the first computation (reuse in n-1 of n, with one call computing it: 0, 1, 3, 7 of 1, 2, 4, 8). llama.cpp did not share while n was at most the slot count (0 reused at 1, 2, 4) and shared only for the requests that had to wait for a slot at 8 (4 of 8).
- No request was refused or failed; every answer was right.

**Engine extras:**
- Unknown request field (`nn_unknown_cache_setting`): **ignored with status 200 by both**. So neither engine has a refusal path to exercise the way Radiance's rejected `logit_bias` did; the adapter's refusal fallback has nothing to do here. (Radiance refused its cache setting with a 400.)
- llama.cpp `cache_prompt: false` computed everything (0 cached), `id_slot` pinned reuse to that slot, and the same head in a second slot was **not** reused (0 cached with the host cache off, 4 with it on).
- llama.cpp slot save, erase and restore (needs `--slot-save-path`): with `--cache-ram 0` erase removed the head (0 cached) and restore brought it back (6,470 of 6,474 cached). **With the default host cache the erase did not remove it**: the next call into the erased slot still reused 6,469 of 6,470 tokens (run 1). This matters for the slot-hygiene rule of C06 ("a call into a slot that last held another project first clears that slot and cannot reuse another project's KV"): with `--cache-ram` on, clearing the slot does not stop a different conversation from reusing the same prompt prefix, so cross-project isolation on a shared llama-server needs `--cache-ram 0` (or a measurement that shows otherwise). Not changed in code here (see the notes).
- vLLM `cache_salt`: the same head under the same salt was reused, under another salt or no salt it was not (0 cached). So salt isolation works on this build.
- Counters: both servers' `/metrics` moved with the calls (vLLM prefix-cache hits and queries; llama.cpp prompt tokens and seconds); `usage.prompt_tokens_details.cached_tokens` is present on both (vLLM needs the flag; this llama.cpp build repeats `timings.cache_n` there).

## Compared with Radiance (named quantities only)
Radiance's reuse came in whole 2,048-token steps of a hybrid model (6,144 of about 7,050 tokens) and its retained markers survived 0, 60 and 300 s in some runs and not in others on a busy shared server; here vLLM reused in 64-token blocks and llama.cpp to within a few tokens, and nothing was lost across 120 s on idle rented servers. The Radiance runs were on a server with other clients; these were not.

## What was not measured
Retention past 120 s; the exact edge of each cliff (the ladder is 1, 2, 4, 8, 16, 32 and each probe refreshes the head); llama.cpp with other slot counts or unified KV; vLLM host-memory or connector offload; a hybrid or other model on these engines; heads of other sizes; more than 8 concurrent requests or load that makes vLLM preempt (the preemption counter stayed 0); repeats and variance (each figure is one run); the host's memory and the actual host-cache fill; GPU speed on other cards; the build number of llama.cpp; the region. Claude, OpenAI chat and Responses and Strata are still open (see implementation-notes, G10).
The retained-marker clause is Radiance's (markers a server honours across requests); neither engine here has a marker, so the idle runs above are its counterpart.
