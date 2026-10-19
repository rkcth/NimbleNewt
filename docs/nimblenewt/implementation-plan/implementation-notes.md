# Implementation notes and known limitations

Running record of limitations found while implementing task cards. Each entry names the card that should resolve it.

- **Install scripts (resolved in F03):** `.npmrc` sets `ignore-scripts=true`; `@google/genai` (a no-op preinstall) and `protobufjs` (postinstall) never run their scripts and all tests pass. Enabling any install script needs a reviewed change; the license inventory marks affected packages.
- **Minimum Node (F03):** `engines` requires Node >=22.19.0 and `@types/node` is pinned to 22.x. CI runs 22.19.0 and 24.21.0 on Linux, macOS and Windows. 
- **Database isolation is convention (F01):** the boundary check restricts package dependencies and imports, but does not forbid built-ins such as `node:sqlite` inside `pi-adapter`.
- **Offline guarantee (F03):** `scripts/offline-guard.mjs` is preloaded into every package test process and blocks non-loopback `fetch`, sockets, DNS and UDP; Worker threads and Node child processes inherit it. It is a tripwire, not a sandbox: non-Node child processes and native code are not covered. The Linux CI job therefore reruns the suite inside a network namespace (`unshare --net`).  A Node child started with an explicit `env` that omits `NODE_OPTIONS` runs unguarded; when F05 adds tool tests, check how Pi Durable spawns tool processes (the Linux namespace rerun covers it there).
- **Test-only dependencies (before the first test-only package):** the boundary check requires every imported package to be a runtime dependency. F05 added none; fix it so test files may import `devDependencies` when one is first needed.

## F03 acceptance evidence

GitHub Actions run 39341276543 on commit `bfbaeb2` passed all six matrix cells (ubuntu, macOS, Windows × Node 22.19.0, 24.21.0), including the Linux network-namespace rerun. The first run (commit `10b12c5`) failed on Windows because the guard tests passed a drive-letter path to `node --import`; fixed in `bfbaeb2`.

## F05 notes and limitations

- **Results are recorded once, durably.** The first time a request's result is built it is stored in an adapter-owned Pi document (`nimblenewt.requests`, committed with the transcript) keyed by request ID; every later call returns that record. Results are built from an ID-range scan of the conversation history, not the active view, because compaction removes older entries from the view but not from storage. An unanswered request owns the entries up to the next user input.
- **Request-ID reuse is detected from a payload fingerprint** (SHA-256) stored before admission, so it works while the original is still queued and after compaction. A crash between recording and admission leaves a record for the same payload, so a retry with that payload succeeds and one with different content is conservatively rejected.
- **Growth:** the document holds one record per request, including tool outputs, in a single conversation-scoped document. Revisit (size limits, pruning, per-request storage) before long-lived installations.
- **Commands:** the adapter supports no commands yet, so every command request is rejected with `UnknownCommandError`. F06 adds branch, checkpoint and abort commands. `abort()` and `compact()` are minimal placeholders (whole-conversation) that F06 refines.
- **Unknown-tool detection depends on a Pi Durable 1.3.0 diagnostic code** (`tool_unavailable`). The runtime pin makes this safe; G03/upgrade qualification must re-check it. The code is also produced for tools that exist but are not offered to the model, so `unknown_tool` means "unavailable". It marks the request `failed` after the fact; Pi lets the run continue and later tool calls still execute. If F06/G02 need the run stopped, end it from the adapter's tool layer.
- **Tool errors are normal feedback:** a throwing tool yields an `error` outcome on a `completed` request.
- **Tool API:** tools receive `{ signal, callId }` and may declare `replay: "safe"` (default: interrupted calls are not re-run). F06's restoration tests must cover both.
- **F06 prerequisites decided now:** `submit` is bound to the root conversation and always queues follow-ups. Inquiry branches, selective updates and steering need a per-conversation handle (for example `adapter.conversation(id).submit(...)`) and a `whenBusy` option; introduce them in F06 before other packages depend on the current shape. Command `args` are in the contract but unused.
- **Not covered here (F06/G02):** fresh-process restoration, queued-input retention across cancellation, checkpoints. Tests so far use in-memory storage.
