# G10 evidence: native backend caching measured on Radiance (2026-11-16)

Card G10 asks for each running backend to be measured through the production cache code (C06 profiles and `CacheAdapter`), with cold, native and retained runs kept apart, the reused tokens checked, the answers checked for context fidelity, memory, time to first token, switch latency and the cache-miss fallback reported, the real responses kept as fixtures and the C06 profiles re-tested against them. On this machine one backend is running: the owner's Radiance server. Everything else is in the matrix below as **not measured**.

- Server: Radiance 2.1.0 on localhost:8002, model `qwen3.8-flash-next-iq4r` (the hybrid Qwen3.8 Flash-Next, tensor-parallel over two AMD Radeon AI PRO R9700 cards), already loaded and pinned. The run did not load, unload, switch or restart anything, never called a cache reset, and sent one request at a time (46 requests in about 7 minutes; the server's request counter went from 40 to 86, 2026-11-17 04:16 to 04:23 UTC).
- The server was shared: an image model (`krea-2-raw-fp8`) became resident during the run and the machine's load average was about 50. Timings vary by up to about four and a half times between repeats for that reason; the cached-token counts do not vary.
- Code: `packages/integration/src/g10-radiance-bench.ts` (the bench; not a test, never run by CI) and `packages/integration/src/c06b-scenario.ts` (C06b's two-agent conversation, now shared by the C06b simulator test and the bench). Fixtures: `packages/controller/test-fixtures/g10-radiance/`, read by `packages/controller/src/inference-cache/g10-captured.test.ts`.
- Raw results: `evidence/g10-radiance-run1.json` (every request's figures, the server's `/stats` before and after, the `/sessions` entries of the bench's conversations, and the captured responses).
- Reproduce: `npx tsc --build`, then `node packages/integration/dist/g10-radiance-bench.js --out <file> --repeats 3 --idle 90`. The key is read from Pi's own configuration (provider `radiance`) and only put in the Authorization header.

## Part A: one conversation and its neighbours, through `CacheAdapter` with the Radiance profile

Each repeat uses a new random head of about 13,470 tokens (400 synthetic ledger rules with a code word and an on-call team hidden in them), so every repeat starts cold. The question is answered with thinking off and at most 24 tokens. Three repeats; the figures are per repeat.

| Step | What is sent | Cached of prompt (tokens) | Prompt time (server, ms) | Time to first token (client, ms) | Outcome (adapter) | Answer right |
|---|---|---|---|---|---|---|
| cold | new head + question A | 0 of 13,471 / 13,474 / 13,471 | 8,316 / 12,286 / 2,769 | 8,324 / 12,290 / 2,782 | cold | 3 of 3 |
| repeat | the same request again | 12,288 of 13,471 / 13,474 / 13,471 | 1,314 / 1,066 / 395 | 1,319 / 1,191 / 400 | hit | 3 of 3 |
| fork | same head, a different question (a second conversation) | 12,288 of 13,471 / 13,474 / 13,471 | 1,215 / 850 / 404 | 1,227 / 1,017 / 411 | hit | 3 of 3 |
| switch back | the first conversation continued after the fork | 12,288 of 13,500 / 13,503 / 13,500 | 1,220 / 820 / 403 | 1,231 / 927 / 410 | hit | 3 of 3 |
| no label | the repeat with no `session_id` | 12,288 of 13,471 / 13,474 / 13,471 | 1,220 / 671 / 402 | 1,227 / 819 / 408 | hit | 3 of 3 |
| changed head | one word put in front of the head | 0 of 13,473 / 13,476 / 13,473 | 8,356 / 2,921 / 2,760 | 8,364 / 3,075 / 2,764 | miss | 3 of 3 |
| after 90 s idle | the repeat after 90 seconds of nothing from the bench | 12,288 of 13,471 / 13,474 / 13,471 | 1,210 / 397 / 517 | 1,223 / 410 / 541 | hit | 3 of 3 |

What this shows:

1. **Reuse is real and large.** A reused head cut the time to the first token by 5 to 30 times against the cold step of the same repeat: 6.3 to 6.8 times in repeat 1 (8.3 s to about 1.2 s), 5.1 to 7.0 times in repeat 3 (2.8 s to 0.4 to 0.5 s), and 10 to 30 times in repeat 2, whose cold step (12.3 s) was slowed by other work on the machine. Hits took 0.4 to 1.3 s in every repeat. All 21 answers were right, including every one served from cache, so the reused state gives the same context.
2. **Reuse is in steps of 2,048 tokens.** Every hit was exactly 12,288 tokens (six steps of 2,048), whatever the prompt length. The hybrid model can resume only from a saved linear-layer state, and this server saves one every 2,048 tokens (`/sessions` shows `resume_tokens` 12,288 and 5 or 6 snapshots per conversation). So up to 2,047 tokens are computed again on every turn, and a prompt under 2,048 tokens is never reused at all (Part B).
3. **The hybrid caveat did not bite here.** C06 warned that `cache_n` might count attention blocks while every linear layer was re-run. The prompt time fell in proportion to the cached share every time, so the hits were real. The caveat stays in the profile because it is cheap and a different model or setting could still show it.
4. **`session_id` is only a label.** The same head without it was reused just as well. This confirms the profile (session_id is not a cache key) and confirms that Radiance cannot keep projects apart (isolation `none`): any request with the same opening tokens reuses them.
5. **A miss costs time only.** A head changed by one word got nothing from cache, the adapter judged it a miss, and the answer was still right, because every request carries its full context.
6. **Switching costs nothing extra.** Going back to the first conversation after another one used the server took the same time as a plain repeat.
7. **Kept for at least 90 seconds.** After 90 idle seconds the head was still reused. Between requests the conversations sat in the host-memory tier (`on_host` in `/sessions`) and were brought back.
8. **The two hit fields agree.** Each of the eight responses kept from repeat 1 (seven streamed, one not) carried both `timings.cache_n`/`prompt_n` and `usage.prompt_tokens_details.cached_tokens`, with the same numbers. Repeats 2 and 3 recorded only the figures the profile read, not both fields.

## Part B: C06b's two-agent conversation on the real server

Two agents of one project take turns for three rounds (six requests). Each request is the exact body pi-ai builds, once with the NimbleNewt layout and cache policy and once with the naive Pi layout (role first, a clock section, each agent's own tool order). The model's answer is capped at 8 tokens; the history uses scripted replies, as in the C06b test. `scale` multiplies the preamble and project text (scale 1 is the simulator test's size).

| Run | Tokens computed over six requests | Share served from cache | Second agent's first request |
|---|---|---|---|
| scale 1, NimbleNewt (prompts about 2,330 tokens) | 3,971 | 72% | 2,048 of 2,325 reused (the shared head) |
| scale 1, naive (prompts about 1,750 tokens) | 10,605 | 0% | nothing reused |
| scale 4, NimbleNewt (prompts about 4,800 tokens) | 8,437 | 71% | 4,096 of 4,776 reused |
| scale 4, naive (prompts about 4,180 tokens) | 8,717 | 65% | nothing reused |

For comparison, the simulator figures recorded by C06b for Radiance were 1,719 against 3,139 tokens (81% against 64%). On the real server:

- **The shared head is shared.** With the NimbleNewt layout the second agent read the first agent's head on its very first request, on both sizes. The naive layout never did, because each agent's prompt starts with its own role.
- **The naive layout's own history is reused at scale 4 but not at scale 1.** At scale 1 its prompts are under 2,048 tokens, so nothing is ever reused; the NimbleNewt prompts are longer (completion rules) and cross the first step. The scale 1 gap is therefore mostly the 2,048 step, not the layout alone.
- **At scale 4 the gap is small** (8,437 against 8,717 tokens): the naive layout's clock section sits after the first 4,096 tokens, so it did not break reuse here, and NimbleNewt's volatile status line is recomputed with the up-to-2,047-token tail on every turn. The layout's advantage on Radiance is cross-agent sharing; on Claude, where the clock changes the system block, the simulator's much larger gap still applies (not measured).
- One request (scale 1, naive, the first) took 69 s instead of about 0.5 s: the server was busy with other work at that moment (an image model was being made resident). It is an outlier of the shared machine, not of the layout.

## Memory (from `/sessions` and `/stats`)

- **KV cache:** about 203 MB for a 13,500-token conversation, about 15.1 KB a token as `/sessions` reports it (`bytes`). C06's figure is 7.32 KiB (7.5 KB) a token; the two agree if `bytes` counts both cards' halves, which is not recorded, so the host-tier size in the profile's tuning notes is left as it was.
- **Linear-state snapshots:** about 119 MB each (`/sessions`: `snap_bytes` 713,957,664 for 6 snapshots), one per 2,048 tokens, so about 714 MB for the same conversation, about four times its KV. The size of the snapshot store is not in the recorded JSON (the bench keeps only some `/stats` fields), so it is not stated here. During the run the server evicted 41 snapshots for retention (`ckpt_evictions.retention` 0 to 41), which ones is not reported; the bench's own conversations still had 5 or 6 snapshots each when listed right after their steps.
- **What this means:** on this model a resumable conversation costs about four times as much memory in snapshots as in KV (a 200,000-token transcript would need about 98 snapshots, about 11.6 GB). Whether the snapshot store or the KV pool (1.07 million tokens) is the limit was not measured, because the store's size was not recorded; the 41 retention evictions show snapshots are dropped by the server's retention rule, and none was dropped because the store was full (`ckpt_evictions.store_full` stayed 0), so the run did not show the store filling. The card's "long shared transcript not dropped" is therefore not shown; if the store turns out too small, that is a server setting for the owner, not a NimbleNewt change.
- **Time to first token** is in the table above. Cold prefill (cold and changed-head steps) ran at about 1,100 to 4,900 tokens a second depending on load; a hit at about 900 to 3,000 tokens a second over the recomputed tail.

## Capability matrix (pinned versions)

| Backend | Version | Status | Reuse | Fork (shared head) | Pin | Slot save/restore | Decoder resume | Hit fields |
|---|---|---|---|---|---|---|---|---|
| Radiance | 2.1.0, qwen3.8-flash-next-iq4r | **measured** | automatic, 2,048-token steps on this hybrid model | **qualified** | unsupported | unsupported | unsupported | `timings.cache_n`/`prompt_n` and `usage.prompt_tokens_details.cached_tokens`, both present and equal |
| Strata | 0.1.43 (C06's installed version), 0.1.47 source | not running here: unqualified | from source only | available (unmeasured) | available (unmeasured) | available (unmeasured) | unsupported | from source only |
| vLLM | none installed | not running here: unqualified | from documentation | available (unmeasured) | unsupported | unsupported | unsupported | from documentation |
| llama.cpp | none installed | not running here: unqualified | from source | available (unmeasured) | available (unmeasured) | available (unmeasured) | unsupported | from source |
| OpenAI and compatible | hosted | not measured (needs a key; see below) | from documentation | available (unmeasured) | unsupported | unsupported | unsupported | from documentation |
| Claude | hosted | not measured (needs a key; see below) | from documentation | available (unmeasured) | unsupported | unsupported | unsupported | from documentation |

## Changes made because of the measurement

- Radiance profile: `fork` is now `qualified` (the only qualified capability anywhere; a test enforces that nothing else is). Its smallest cached prefix is 2,048 tokens for a hybrid model (was 1), and the caveats and tuning notes say what the step and the snapshot memory mean. The endpoint option `minPrefixTokens` still overrides it.
- Captured Radiance responses are fixtures, and the profile is re-tested against them through the production stream reader (`responseBody`) and `CacheAdapter`: cold, hit and miss are judged as the dispatcher would see them, the two hit fields agree, and the usage-only fallback gives the same figures.

## What is NOT proven

- **Hosted OpenAI was measured through Hermes on 2026-11-25** (see the notes section "G10 hosted OpenAI route measured through Hermes"): `cache_read_tokens` is reported; a repeat in a new session showed no reuse of the head, a resumed session 99.3%; the profile's key was not carried. Claude is still not measured.
- **Only Radiance was measured locally.** Strata, vLLM and llama.cpp are not running on this machine; OpenAI and Claude need API keys, which an agent may not use or ask for on its own authority. Their profiles stay unqualified, their fixtures stay simulated, and Anthropic's treatment of a string against a one-block array user message (C06b's open question) is still open.
- **One server version, one model, one configuration.** Radiance 2.1.0 with Flash-Next on two cards; another version, model or `--checkpoint-slots` setting is a new measurement. The 2,048-token step was observed, not read from the server's settings.
- **No concurrency.** One request at a time, on purpose; the eight-sequence limit and the "cache cliff" when more conversations are live than the pool holds were not tested.
- **Retention beyond 90 seconds** was not measured, nor what happens when the snapshot store is full of other users' conversations (the run did not fill it: `ckpt_evictions.store_full` stayed 0; the 41 evictions were all for retention).
- **Timings are from a shared, busy machine** and vary up to about four and a half times between repeats; they show the size of the effect, not a stable figure.
- **The refusal fallback** (a server that refuses `session_id`) was not exercised: this server accepts it. It is covered only by the simulator tests.
- **Part B is not the full controller.** It runs the production Pi adapter, layout and cache policy, but sends the built bodies itself instead of going through the dispatcher and a worker; the history uses scripted replies.
- **The fixtures are the last two events of each stream**, parsed and written back compactly, not the raw byte stream.
- **No memory measurement of the host itself** (pinned memory, container settings); only the server's own figures.
