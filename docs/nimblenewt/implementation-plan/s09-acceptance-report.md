# S09 acceptance report: the durable vertical slice

Status: **implemented and passing; first report.** This is the evidence for card S09 ("Verify the durable vertical slice"). It does not accept the QA checkpoint Y01, which also needs the cross-OS runs and the owner's real-hardware run (see [Y01 and what this does not show](#y01-and-what-this-does-not-show)).

## What was built

- **The path** (`packages/controller/src/slice/pipeline.ts`, `runPath`): a chat-command stub creates a project and a task, makes it ready and assigns it to a worker; the controller delivers the assignment event to the worker's inbox, which admits an attempt (S02, S03, S04, S07); the worker, under its fence, starts the task, runs its **model step through the controller's inbox bridge** (`ConversationBridge`: the admitted attempt's work is submitted to a conversation once, with the controller's operation ID of the admission as the request ID), performs an outside effect through the ledger (S05) with a target that honours its key and can be asked, publishes a result artifact of two files (S06), records the **recovery point** (the conversation's checkpoint with the artifact manifest and the request IDs, kept as one controller record), completes the task and finishes the attempt; the controller delivers what is left. Every step is a fixed command, so running the path again after a crash completes it exactly once.
- **The boundaries** (`chaos.ts`): every storage call that writes (`applyOperation`, `claimDeliveries`, `retryDelivery`, `claimDueTimers`, `acquireEpoch`) is a boundary before and after it; so are the blob steps (written to a temporary file, named), the outside steps (before the effect is applied, after it is applied and before the target answers), the conversation's steps and the bridge's three (before submitting, request submitted and result not yet read, result read and not yet recorded). A clean run has **129 boundaries**. `retryDelivery` and `claimDueTimers` are wrapped but the path never reaches them (no delivery fails and no wait with a deadline is on the path), so they contribute no boundary.
- **The crash.** At a chosen boundary the process "dies": that call and every later one fails, including the blob folder, the conversation and every storage call, so error handlers, other steps and reconcile passes cannot do anything. Then time passes (leases end), a **new process starts under a new primary epoch** and runs the same path again. The result is compared with a clean run.

## What is checked after every crash

(`check` and `signature` in `pipeline.ts`.) The recovered state must have: the task done; exactly one project, one task, one generation of ownership (generation 1, owner the worker) and one attempt (number 1, succeeded, in generation 1); the effect confirmed in the ledger, **reached at the target exactly once** (a raw log of every call that reached it, not just the target's deduplicated record) and applied once; the conversation holding exactly the one request; one artifact that verifies byte for byte and whose file holds the model's answer; one recovery point naming that request, that artifact and that answer; no stray temporary blob file (except when the crash was in the middle of writing one); every expected event delivered, no unexpected extra one, and the worker's inbox holding the assignment message once, admitted with that attempt; no open blocker. The compared state must also equal a clean run's: every aggregate the path touches (body and revision, timestamps left out, the runtime's opaque checkpoint left out, scan cursors left out, and the effect's revision and claim left out because a crash during execution legitimately adds claim cycles), the count of each one-per-command audit record, and the blob files.

## Results

| Run | Boundaries crashed and recovered | Result |
| --- | --- | --- |
| Reference store, in-process crash | all 129 | every one recovered, state equal to the clean run |
| SQLite (file), in-process crash | all 129 | every one recovered |
| SQLite on a worker thread, in-process crash | 20 of 129 (every 7th, first and last) | every one recovered |
| PostgreSQL, in-process crash | 20 of 129 (every 7th, first and last) | every one recovered |
| SQLite, **real SIGKILL** of a child process | 10 of 129, spread over the run | every one recovered, state equal to the clean run |
| **Real Pi adapter** (durable JSONL storage, scripted model), real SIGKILL | 18 of 127, spread over the run and including the bridge's three boundaries | every one recovered: the model answered once (the transcript holds its answer once), the stored checkpoint verifies, state equal to the clean run; when the process was killed with the model's request in flight, the restarted adapter held the interrupted work and the bridge resumed it through the adapter's reviewed recovery step |

Run with `npm test` (the controller package's `dist/slice/*.test.js` and the integration package's `dist/real-adapter.test.js`). The harness has teeth: with the push target made non-idempotent and unable to answer truthfully it names exactly the boundaries where the effect would be applied twice, and the raw count of calls that reached the target would catch a second execution even when the target itself deduplicated it.

## What the harness found

- **S05 loop (fixed).** When a target kept failing and also kept saying "not applied", `EffectService.run` retried forever. It now executes at most twice per call and then returns `pending` (tested in `effects.test.ts`).

## Obligations from earlier cards that this card carries

- **Controller inbox bridge (F06):** done here. The bridge is `ConversationBridge` in the controller (structural, so the controller depends on neither Pi nor the contracts). It submits an attempt's work only while that attempt is still the current one (otherwise `fenced`, unless the runtime already holds the finished result, which is returned), resumes the runtime's interrupted work only when it is all this request's own (anything else leaves the runtime held and opens a `runtime_hold` blocker for the owner), and its test seam is available as `@nimblenewt/controller/testing`, not from the main entry point; the integration package (`packages/integration`, tests only, the one package allowed to depend on both the controller and the Pi adapter) wires it to the real adapter.
- **Recovery point `{ checkpoint, artifactManifest, requestIds }` (F06d2):** done here as the controller's `recovery-point` record (`RecoveryPoints`).
- **`wait-by-request-id` (G02):** not added to the port. The bridge relies on what the port already guarantees (submitting the same request ID again returns the original, and a request left in flight by a crash is resumed through `recover`), and this card proves that across kills. A progress and event stream, and waiting by request ID without resubmitting, remain with the event cards (H06).

## Y01 and what this does not show

- This report is the **automated part** of QA checkpoint Y01 on one machine, plus the same suites running in the repeated cross-platform `QA` workflow. Y01 also requires the owner's real-hardware run (waivable, recorded) and is recorded separately.
- Crashes are one per run. A second crash during recovery is covered only indirectly (recovery is the same idempotent path).
- Waits with deadlines, timers, blockers and delivery retries (S07, S08) are **not on this path**; they have their own tests, but no crash enumeration. `retryDelivery` and `claimDueTimers` are never reached here.
- The Pi side is thinner than the controller side: the wrapper uses the root conversation (not a per-task conversation from `createTask`, F06e), the model is scripted with no tools, so interrupted tool calls that are **not replay-safe** are never exercised, and the check on the Pi side is that the transcript holds the answer once and the task text once.
- The worker is a stub inside the test process (it does what a worker would, through the same services); there is no remote worker, sandbox, tool execution by the model, real model provider or network in the path. The "chat command" is a function call, not the chat API (U-cards). The model is scripted.
- PostgreSQL and the worker-thread SQLite are sampled, not exhaustive; the PostgreSQL crash is a simulated death of the controller process, not of the database server (that is covered by the F04c/F04d suites).
- Power loss and disk-full are not simulated; SQLite uses `synchronous=FULL` and PostgreSQL `synchronous_commit=on` (F04 qualification). The real-adapter runs sample 18 boundaries, not all.
- The reconciler runs only when the process calls it; there is no timer yet.
