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
- **Commands:** the adapter supports no commands yet, so every command request is rejected with `UnknownCommandError`. F06 adds branch, checkpoint and abort commands. `abort()` and `compact()` are minimal whole-conversation placeholders; F06c replaces `abort()`.
- **Unknown-tool detection depends on a Pi Durable 1.3.0 diagnostic code** (`tool_unavailable`). The runtime pin makes this safe; G03/upgrade qualification must re-check it. The code is also produced for tools that exist but are not offered to the model, so `unknown_tool` means "unavailable". It marks the request `failed` after the fact; Pi lets the run continue and later tool calls still execute. If F06/G02 need the run stopped, end it from the adapter's tool layer.
- **Tool errors are normal feedback:** a throwing tool yields an `error` outcome on a `completed` request.
- **Tool API:** tools receive `{ signal, callId }` and may declare `replay: "safe"` (default: interrupted calls are not re-run). F06's restoration tests must cover both.
- **Command `args`** are in the contract but unused until F06d.

## F06 split

F06 (checkpoints and cancellation mapping) has several independently verifiable units, so it is delivered as four pieces, each separately reviewed and committed. F06 is complete when all four pass; G02 follows.

- **F06a:** conversation handles, `whenBusy`, restart and fresh-process restoration, F05 review follow-ups.
- **F06b:** inquiry branch that leaves the parent context unchanged; selective update applied exactly once.
- **F06c:** cancellation: abort during streaming and partial tool arguments, incomplete tool calls never execute, adapter-owned queued input survives cancellation.
- **F06d:** checkpoints and the typed controller boundary (retained commands require later controller readmission).

## F06a notes

- **API shape:** `PiAdapter.root()` and `PiAdapter.conversation(id)` return an `AdapterConversation` with `submit`, `recorded`, `abort` and `compact`. `submit`, `abort` and `compact` moved off `PiAdapter`. `recorded(requestId)` reads a stored result without waiting.
- **Busy policy:** `whenBusy` (`followUp` default, `steer`, `reject`) is part of a request's identity (fingerprint `v1:sha256:`, covering content and busy policy; extend it, and bump the version, when branch or entry options are added). `reject` on a busy conversation throws `ConversationBusyError`; the request was not admitted and the ID stays reusable.
- **Reopening storage does not run interrupted work, but almost any progress call does.** Pi's scheduler is harness-wide: besides `resume()`, `submit`, `abort`, `compact`, `Submission.wait` (so `result()`), `waitForTask` and `waitForIdle` on any conversation start it, which resumes every interrupted run in every conversation. `lookup(requestId)` is the read-only alternative: it returns a settled request's result (recording it the first time) or `undefined`, never waits, and never starts the scheduler. A controller recovering after a crash must use `lookup()` until it has decided what to do with interrupted work.
- **F06c acceptance item (hold):** provide a real hold. For example, list interrupted runs at open (Pi's `harness.inspect()` is read-only) and refuse progress calls until the controller chooses resume or abandon for each one. Decide the scope of `abort()` and `compact()` (hold versus resume) together with this.
- **Attribution rule:** a request owns the tool calls after its input and before the next input in the transcript, so a steered input starts a new segment and each call is counted once (the steered-in request owns calls after the steer). Requests merged into one run share the final answer text.
- **Crash semantics verified with a real SIGKILL** (Pi JSONL storage, child process): an interrupted tool declared unsafe is not re-run and the model is told it was interrupted; a `replay: "safe"` tool runs again. External effects remain at-least-once for safe tools; exactly-once is not claimed.
- **Fingerprint on old records:** a record without a fingerprint matches any payload. Records written by the F05 commit (24019e5) hold an unprefixed SHA-256 and would conflict with `v1:` fingerprints; no data has been deployed. The rule going forward: compare only fingerprints with the same version prefix, and treat unknown formats as legacy.
- **No storage lock:** Pi's JSONL storage does not stop two processes opening one directory (for example a hung process plus its replacement). Worker ownership and leases (H cards, F06d) must provide fencing.
- **Branch requests (F06b):** inquiry-branch creation must be idempotent by request ID, and branch options belong in the fingerprint.
- **Open from the F05 review (non-blocking):** the single results document grows by about 6 KB per request in Opus's measurement (linear); move to per-request documents (`defineDocFamily`) and decide on bounded stored outputs before G02 long-run tests. `settings` exposes Pi's own settings type from the adapter package; consider narrowing it. G02 repeats the kill test on macOS and Windows; this piece's kill test runs on whichever OS CI uses (Windows detects death by non-zero status, not by signal).
