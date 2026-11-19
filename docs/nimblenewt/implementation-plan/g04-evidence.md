# G04 evidence: supporting durable engine integration (2026-10-22)

Card G04 asks whether the selected architecture (design proposal section 3: D2, an embedded TypeScript controller with interchangeable SQLite and PostgreSQL stores, Pi behind the conversation adapter) keeps acknowledged requests and protected effects when the worker and the controller die. Everything below runs the production code: the S09 slice (`@nimblenewt/controller/testing`: `ProjectService`, `AssignmentService`, `InboxService`, `EffectService`, `ArtifactService`, `RecoveryPoints`, `ConversationBridge`, `Reconciler`) and S08 `WaitService`, over the real controller databases, with the production Pi adapter (F05/F06, `piConversation`) on durable JSONL storage and the offline scripted model. No network (tests run under `scripts/offline-guard.mjs`). There is no state machine of the test's own: the glue (`g04-fixture.ts`, `g04-wait.ts`, `g04-worker.ts`, `g04-child.ts`) builds services, starts and kills processes, and counts.

- Code under test: implemented in the commit that adds this file (the lead appends the hash). Base before the commit: `HEAD` of `wip/G04` (main at the time of the merge) plus the working tree.
- Databases: SQLite (`SqliteStorage`), SQLite on a worker thread (`SqliteWorkerStorage`) and PostgreSQL (`PostgresStorage` on the embedded server the other tests use). The in-memory reference store is not a real database and is not used.
- Reproduce: `npx tsc --build`, then for each file `node --import ./scripts/offline-guard.mjs --test --test-timeout=600000 packages/integration/dist/<file>.test.js` (files below); add `NIMBLENEWT_G04_EXHAUSTIVE=1` in the environment for the exhaustive run.

## Default coverage and exhaustive coverage (read this first)

Two kinds of run exist. The numbers in this document (127 kill and crash boundaries, 126 wait boundaries, 41 operations x 4 fault kinds, 218 connection cuts) come from the **exhaustive run** (`NIMBLENEWT_G04_EXHAUSTIVE=1`) made on the development machine (Linux, Node 22.23.0) only. It passed on all files; per-file times there: kill-sqlite 85 s, kill-postgres 100 s, kill-sqlite-worker 196 s, process files 73 to 115 s, connection 68 s, faults 20 to 26 s, waits under 15 s (at least 14 minutes for all 13 files in sequence).

What the normal CI run (the full suite on every push, six cells) exercises is a **sample**, and the heavy files are skipped:
- `g04-kill-sqlite` and `g04-kill-postgres` (real SIGKILL of controller plus Pi): 38 of 127 boundaries. These are the first operation of each kind around admission (task assign, inbox receive, attempt admit, inbox admit), the model request (the bridge's three boundaries), the outside effect (the target's two, effect intend and claim) and the result (effect settle, artifact publish, recovery-point record, attempt finish), before and after, plus every eighth boundary (the same stride on all databases).
- `g04-faults-*`: 19 of the 41 operations for each of the 4 fault kinds, on all three databases.
- `g04-wait-*`: the restart narrative and the real kill in full; the crash enumeration at the wait operations' boundaries plus every fifth.
- `g04-connection-postgres`: 50 of the 218 cuts (every fourth COMMIT, before and after, plus one other statement in 55).
- **Skipped by default** (with the message "heavy G04 test"): `g04-kill-sqlite-worker` and all three `g04-process-*` files. They run when `NIMBLENEWT_G04_HEAVY=1` or `NIMBLENEWT_G04_EXHAUSTIVE=1` is set. So the worker-process evidence (worker SIGKILLed in flight and after the answer; the controller crashed at the boundaries with the worker alive) comes from this machine's runs and from the QA job, not from normal CI.
Default runtimes on this machine: kill-sqlite about 23 s and kill-postgres about 35 s (both listed in `scripts/slow-tests.json`, left out of the fast tier); the others up to 22 s (connection 22 s, faults-postgres 21 s, faults-sqlite-worker 13 s, the rest shorter).

The exhaustive run and the heavy files on macOS and Windows are **not yet proven**: the `g04-exhaustive` job of `.github/workflows/qa.yml` (hand-started with input `job` = `g04` or `both`; ubuntu, macOS, Windows; sets both variables; output uploaded) has not run. Until it has, only the sampled default is expected to pass there, and even that is proven on the hosted runners only once CI has run. Platform notes: no test measures elapsed time (the only timers are 180 s watchdogs that turn a hang into a failure naming the cut); paths come from `os.tmpdir()`, `path.join` and `import.meta.url`; real kills use `process.kill(process.pid, "SIGKILL")` in the child (as the S09 slice child does on all platforms) and `ChildProcess.kill("SIGKILL")`; "killed" means the signal `SIGKILL` on POSIX and, because Windows reports a terminated process by exit code, a signal or non-zero exit code on win32. The real-kill files are not skipped on win32; if the QA job shows they cannot work there, the Chaos-crash tests (faults, waits, the controller-crash test) remain the Windows coverage and this record must say so. Temporary directories are removed on test failure and when the process ends (including a timeout).

## The path

One fixed list of commands (create project and task, assign, deliver, inbox admits the attempt, the worker starts the task, the controller's bridge submits the work to Pi once, the protected effect `git-push` is intended, claimed, applied by an idempotent target and settled, the artifact is published, the recovery point is recorded, the task is completed, the attempt finished, events delivered). Running it again after any death completes it exactly once. It has 127 numbered boundaries (before and after every storage write or claim, the bridge's three, the target's two, the blob folder's four); 41 of the boundary pairs are `applyOperation` commits. `g04-fixture.ts` records the audit type behind each commit, so every report names the operation ("84 after artifact.publish").

After every death the final state must equal the uncrashed run (`signature`: every aggregate with revision, audit counts per command type, blob files), the S09 `check` must hold (exactly one project, task, generation, attempt, recovery point; the effect `confirmed` and applied once in the outside world and reached once at the target; every message delivered once; no open blocker), Pi's transcript must hold the model's answer once and the task as one user message, and the recovery point's checkpoint must verify in the runtime.

## Acceptance sentence to proof

| Acceptance text | Test file (x3: `-sqlite`, `-sqlite-worker`, `-postgres`) | What is asserted |
|---|---|---|
| Kill worker and controller around admission and result | `g04-kill-*.test.ts` | Controller services and Pi adapter in one child process, real SIGKILL at each numbered boundary: every one of the 127 on SQLite and PostgreSQL, the key boundaries (all around task assignment, inbox receive, attempt admit, inbox admit, effect intend/claim/settle, the bridge, the target, the blob writes, artifact publish, recovery-point record, attempt finish) plus every eighth boundary on all three databases (stride 8; every boundary when exhaustive). Then the database is read with no command run, then the same path is run in a new process (new epoch, new adapter on the same JSONL), and the final state is checked. |
| Kill the worker around the model request and result | `g04-process-*.test.ts`, first two tests | The Pi adapter runs in a worker process of its own (`g04-worker.ts`, stdin/stdout JSON lines); the controller lives. The worker is SIGKILLed (a) when the scripted provider is asked for its answer (request in flight) and (b) after the adapter settled the request and before the controller heard. The acknowledged request survives (inbox message admitted, the attempt the task's active one, no effect intended, no recovery point); a new worker on the same JSONL directory finishes under the same controller epoch. (a): the new worker's adapter holds the interrupted request, the bridge takes the reviewed recovery step (`recover` exactly once) and the model is asked once in total; (b): the answer was durable, the new worker asked the model 0 times. |
| Kill the controller while the worker lives | `g04-process-*.test.ts`, third test | Controller crash at each of the 127 boundaries, in-process (`Chaos`), with the worker process alive throughout; a new controller epoch takes over. The model is asked exactly once in every run. |
| No lost acknowledged request | `acknowledgedSurvive` in all kill and crash tests | Before any command is re-run, the raw database must hold every operation whose `before` boundary passed (an operation killed at its own `after` boundary is committed but unacknowledged: present) and none that was not started. |
| No duplicate protected effect | the S09 `check` in every run | The idempotent target is reached once (raw log) and applies once; kills at "outside: before applying", "outside: after applying, before answering" and every ledger commit around them recover through `EffectService` reconciliation. |
| A wait survives service restart | `g04-wait-*.test.ts` | (1) Open an indefinite and a deadline wait, restart the service (new epoch): both open, tasks blocked, the timer pending; a service object of the older epoch is refused (`stale_epoch`); passes before the deadline change nothing; after the deadline a third instance settles the wait once (`timed_out_resumed`), repeated passes do nothing, the other wait is answered once and a second answer is refused (`wait_closed`). (2) Real SIGKILL right before, at and right after the acknowledgment of the second wait: the waits are in the database before any command runs. (3) Crash at each of the 126 boundaries of open / deadline passes / settlement / answer: the end state equals the clean run and each wait audit record exists once. |
| Exercise both real databases, connection loss, ambiguous commits | `g04-faults-*.test.ts`, `g04-connection-postgres.test.ts` | See next two sections. |
| Mechanism decisions of design proposal section 3 | this document, "Section 3 decisions" | Below. |

## Ambiguous commits and rollbacks, all three databases (`g04-faults-*`)

The production `FaultInjectingStorage` (F04c) is armed at the Nth `applyOperation` of the whole path, for each of the 41 operations: a rolled-back transaction (`retryable`), an ambiguous commit that did commit (`after` + `uncertain_commit`), an ambiguous commit that did not (`before` + `uncertain_commit`), and six rollbacks in a row (more than the budget of 5). Results on SQLite, SQLite worker and PostgreSQL alike: the single faults were absorbed 41 of 41 times each (commit protocol resolves by stable ID; the final state is byte-identical to the clean run, nothing applied twice). The six-in-a-row burst surfaced: 19 absorbed (failed scan-cursor saves and similar are retried by the next pass by design) and 22 finished by the same process's next reconciler pass after leases ended; none needed a restart. The only difference from the clean state is the `delivery-failures` counter (a delivery really failed and was retried), which is tolerated in the burst case only.

## Real connection loss on PostgreSQL (`g04-connection-postgres.test.ts`)

A relay (`FaultProxy`, F04d) between the controller and the embedded server cuts the connection immediately before or after an exact statement of the whole path (587 statements, one pooled connection). 218 cuts: before and after each of the 59 COMMITs, plus before and after every 11th other statement. A cut after COMMIT is the real ambiguous commit. All 218 end in the clean run's state: 107 COMMIT cuts absorbed by the commit protocol, 9 finished by the next pass after leases ended, and 2 restarts (the cuts at the epoch acquisition in `startProcess`, which by design needs a new start); for other statements 84 absorbed, 14 next pass, 2 restart. No run applied anything twice or lost an acknowledged operation.

## Section 3: what is validated here, row by row

Lead decision: G04 "validate section 3" is accepted as the subset covered here plus the explicit hand-offs below. Status: covered / partly / not covered (owner).

| Section 3 item | Status | Evidence or hand-off |
|---|---|---|
| D2 selection: embedded scheduler, SQLite and PostgreSQL, Pi behind the adapter | covered (for this path) | No failure argues for another engine; no failure of any kind occurred. The architecture was not reopened. |
| Storage: transactional admission, revision and epoch checks, atomic transition plus audit plus outbox | covered | All kills and cuts leave all-or-nothing state; F04 owns the adapter-level matrix. |
| Storage: uncertain commit resolved by stable ID | covered | 41 x 2 injected faults per database and 218 (or 50 sampled) PostgreSQL cuts. |
| Storage: bounded retry of a whole aborted transaction | covered | Burst of 6 beyond the budget of 5 surfaces and finishes on the next pass. |
| Storage: real deadlocks or serialization retries | partly | Only simulated by injected `retryable` faults; real lock contention is F04 (workload). |
| Storage: competing claims and per-task ordering | not covered here | F04 (claims, ordering) and H12 (dispatcher). The path has one controller. |
| Storage: 4-attempt, 32-agent workload, 100 idle hosts, latency | not covered | F04 workload qualification. |
| Storage: conversation storage a separate boundary | covered | Pi JSONL and the controller database die and recover independently; checkpoint verified after reopen. |
| Storage: backup, restore, migration between backends, promotion | not covered | F04 migration cards, D7 recovery cards. |
| Handoffs: state plus outbox, durable inbox, stable operation IDs, deduplicated admission | covered | Inbox receives the assignment twice; one attempt admitted at every boundary. |
| Handoffs: persist before acknowledging; reconcile on startup | covered | `acknowledgedSurvive` at every kill; restart needs no wake-up. |
| Scheduling and recovery: persisted due times | covered | Wait timer fires once after restarts (waits). |
| Scheduling: missed timers, duplicate wakeups | partly | Deadline passing while the service is down, repeated passes; duplicate wakeups only via repeated passes. |
| Scheduling: changed plans | not covered | Planning cards (P-series). |
| Scheduling: state migrations | not covered | F04 migration suite. |
| Conversation continuity: Pi owns transcript, checkpoint referenced | partly | Restart and checkpoint verification covered; suspend/resume and selective updates are G09/C05/C04, not repeated here. |
| Interactive control: persisted chat requests, restart after acknowledgment, saturated workers | partly | Owner wait answers survive restart; chat requests, reserved capacity and provider failure: H04, L-series. |
| Pause and loss of authority: watchdog, partial tool calls, dead supervisor | not covered | Old-epoch fencing (`stale_epoch`) only; L05/G09 for partial calls, A-series for the watchdog. |
| Retry and external effects: ambiguous outcome reconciled | covered | Kills at the target's "applied, not yet answered" point; applied once. |
| Retry: revoked grants, exhausted budgets | not covered | Security and budget cards (S-series, B-series). |
| Placement and capacity | not covered | H12, host cards. |
| Versioning and retention | not covered | F-series upgrade cards. |
| Primary recovery | not covered | D7 recovery cards. |

## A kill inside a protected tool the model calls (`g04-tool-*`, added 2026-11-19)

Before this, the protected effect always ran from the worker's own code, so a kill in the middle of a tool the Pi model calls was not proven. The `g04-tool-*` files close that gap for the generation-service route that a tool bridge write takes (card L05d).

- **The setup.** The same controller services and the same three databases as above, the real Pi adapter on durable storage, and a scripted model that calls one tool, `push`, and then gives its final answer based on what the tool returned. The tool does what the controller's bridge does for a write. It records the call in a generation and completes that generation. It admits the call as an effect, using the bridge's own command ID (`bridgeCommandId("bridge", attempt, call)`, now exported). Then it runs the effect through the ledger against the idempotent target. Like the production bridge tools, the tool does not say it is safe to replay. So after a crash, Pi does not run it again and tells the model that it was interrupted.
- **Kills.** The child process is killed with a real SIGKILL at each of the 16 boundaries of the tool's route. The route runs from the model's call through begin, record, complete, the admission, the claim, the target's two steps and the settlement, to the answer the tool gives back. As in the main path, the database is read before any command runs and a new process finishes the path. Every boundary is killed on every run, with no sampling, and each file takes about 10 to 25 s.
- **Checked every time.** No acknowledged operation is lost. The target is reached at most once and applies at most once, and the ledger holds at most one effect. The model is never told "pushed" unless the push was applied. A settled effect matches the outside world. The task finishes with one task message and one final answer, which the recovery point keeps. All of these held on SQLite, on SQLite on a worker thread and on PostgreSQL (2 tests per file, 32 kills per file; on this Linux machine with Node 22 the files took 23 s, 31 s and 27 s).
- **What actually happens (asserted per boundary, first test):**

| Kill at | Outcome after the restart |
|---|---|
| from the model's call up to just before the admission (8 boundaries) | nothing pushed, no effect, the model is told the call did not finish |
| after the admission, before the claim (2) | nothing pushed; **the admitted effect stays `intended` for good** (nothing ever starts or closes it) |
| after the claim, before the target applies (2) | nothing pushed; **the effect stays started and unsettled, with no blocker** |
| after the target applied, before settlement (2) | pushed once; **the effect stays started and unsettled, with no blocker**, and the model is told it did not finish |
| after settlement (2) | pushed once and confirmed, but **the model is told it did not finish** |

- **Second test: the same call presented again.** Here the tool is declared replay-safe, so Pi runs the interrupted call again with the same call ID. On every one of the 16 boundaries the run then ends exactly like the uncrashed run: pushed once, confirmed, and reported to the model. The admission is found again by its command ID, and the ledger reconciles a started effect with the target instead of running it again. This shows that the L05d route itself is safe to repeat.

**Classification (implementation defects, not evidence against the architecture).** Nothing is ever duplicated or lost by the controller, but three gaps in the implementation show up:
1. **An effect that was admitted but never started is never closed.** The production reconciler leaves any effect that has not started to "its owner's attempt", and the interrupted call is never presented again.
2. **A started bridge effect is never settled and no blocker is raised.** The production composition (`api/start.ts`) gives the reconciler no bridges (`bridges: {}`). An unsettled started effect is therefore only counted (`effectsUnbridged`). It is never reconciled, never marked uncertain and never shown to the owner.
3. **The model is told an applied push "did not finish".** A model that then tries again would make a new call with a new call ID, and so a second push. The scripted model here never tries again (ASSUMPTION: the model does not retry by itself, so the safety check measures the controller and not a model's choice). A real model may well retry.
The second test points to the fix: present the interrupted call again under its own call ID, either by declaring bridge write tools replay-safe while `admitCall` is on or by having the controller replay interrupted bridge calls. The bridge then answers from the ledger and nothing is run twice. Gap 2 still needs the reconciler to settle or report a started effect it has no bridge for. Neither fix is made in this slice; both are left for a follow-up card. This slice adds no new production behaviour; it only exports `bridgeCommandId`.

**Not covered by this slice.** The tool bridge service itself (`ToolExecutionService`: the credential, the binding of the call to what the model wrote, the pause gate) is not inside the killed process. Its admission behaviour is covered in-process by the L05d tests. Also not covered: the real out-of-process Pi worker (H12b), a model that retries, and macOS/Windows (Linux only).

**Mutation checks (SQLite file; each change was restored afterwards).** (a) In `effects.ts`, reconciliation was changed to ignore a target's "applied" answer and run the effect again. The replayed test then failed at boundaries 82 and 83 (the target was reached twice). (b) In `effects.ts`, the claim was changed so that it no longer marks the effect as started. Both tests then failed at 82 and 83: the target was reached twice, and the push was applied while the ledger said the effect had never started.

## Mutation checks (each made named tests fail; restored afterwards)

Five checks were run by the implementer against the exhaustive files, before the sampling was added: `commit.ts` uncertain commit rethrown (2 of 4 fault tests fail); `waits.ts` no deadline timer (3 of 3 fail); `bridge.ts` random request ID (2 of 2 worker-kill tests fail, the model is asked twice); `bridge.ts` no reviewed `recover` step (in-flight worker kill fails); `effects.ts` reconcile answer `applied` ignored (the kill test fails: the target is reached twice). The reviewer ran three further mutants against the DEFAULT sampled set and all were caught: `commit.ts` an uncertain commit with the operation absent treated as success (caught by the faults "ambiguous commit that did not commit" tests); `effects.ts` a started effect re-executed instead of reconciled; and `inbox.ts` the message's own attempt not recognised (both caught by kill-sqlite, kill-postgres and the faults burst test; the process files too when run). The five implementer checks were not repeated on the sampled set.

## Classification

No failure was found in the architecture or in the controller or adapter code. Two defects were found in the new test support while writing this and fixed: the PostgreSQL fault relay (`proxy.ts`) delayed every statement ~25 ms through Nagle's algorithm (a 587-statement path took 16 s and the first run of the cut test timed out): `setNoDelay` on both sockets, covered by the connection test; and a first driver judged "finished" by the absence of an error, whereas a reconciler pass that meets a storage error counts it and returns, so the state is now what decides. No production file changed.

## What this proof does not show

- A SIGKILL only ever lands between storage calls (at a numbered boundary), never inside a transaction or a commit, never mid-fsync. In-commit uncertainty is covered only by the injected faults and the PostgreSQL connection cuts.
- The kill that takes the controller and Pi together is a real SIGKILL; the "controller dies, worker lives" case is an in-process crash (the `Chaos` seam) with a real worker process, accepted as the evidence for that case; the controller side has no process boundary there.
- SQLite has no connection to lose; its fault coverage is the injected storage faults and the kills. Lock contention (`SQLITE_BUSY` under a second writer) is covered by F04, not here. No SIGKILL of the PostgreSQL server itself (`crashAndRestart` exists in the test server and is used by F04); here the server survives.
- Power-loss or host-crash durability (fsync behaviour, Pi's synchronous NORMAL default) is not tested: processes die, the operating system does not.
- In the main path the protected effect is run by the worker's code, not by a Pi tool. A kill during a protected tool the Pi model calls is now covered by the separate `g04-tool-*` files (next section), through the generation-service route a tool bridge write takes, not through the whole tool bridge service.
- The wait scenario uses owner commands and the reconciler; it is not coupled to a model answer, an inquiry (H04) or the scheduler's task start. The "interactive control" mechanism (chat requests with expected revisions) and the "pause and loss of authority" watchdog, placement, versioning and primary-recovery rows of section 3 are not exercised.
- The throughput targets of section 3 (4 attempts, 32 active-agent-equivalent workload, 100 idle hosts, latency and pool pressure) belong to the F04 workload qualification, not to this card.
- The model is scripted; provider failures and network faults are out of scope.
