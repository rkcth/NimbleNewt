# NimbleNewt implementation design

**Current planning baseline, October 16, 2026. Rob authorized document/task reconciliation and repository synchronization. Implementation dispatch remains separately gated by N00.**

## 1. Assessment and recommendation

The existing design has the right product direction and many of the right safety contracts. It is not yet detailed enough to ensure that independent implementers will produce a reliable orchestrator. In particular, “durable inbox,” “exclusive writer,” “checkpoint,” and “supervisor recovery” describe desired properties without fully specifying the transitions and failure recovery that make those properties hold together. The current 23 Paperclip tasks are useful workstream parents, but several contain multiple independently fallible subsystems. They should not be dispatched as single coding attempts.

I recommend retaining the accepted product, making its orchestration protocol explicit, proving a narrow vertical slice before broad feature integration, and converting the workstreams into small, evidence-producing child tasks. Pi Durable should remain behind a narrow adapter. Its internal replay is useful, but it must not become the authority for project status, approvals, assignment, external effects, or cross-worker delivery.

There is no credible way to be 100% certain before implementing and qualifying the real system. The practical substitute is a sequence of falsifiable decisions: isolated experiments now, integrated failure tests before expansion, full platform and recovery qualification before release, and explicit rejection criteria. A test that finds a limitation is useful progress; silently treating an unsupported behavior as guaranteed is not.

The first integrated runtime acceptance gate is retained task context: pause, answer from a branch of the current context, optionally inject updates, resume unchanged, or suspend and switch tasks without rebuilding the original context from summaries. Use the embedded TypeScript scheduler with SQLite and PostgreSQL adapters described below. Durable scheduling supports this execution model; tests must exercise the implemented scheduler and Pi adapter. The existing Temporal experiment proves a narrow recovery mechanism, not NimbleNewt's defining interaction. Do not build two complete scheduling backends.

### What the current design gets right

- One human owner, durable agent identities, separate task contexts and incidental conversation, and explicit ownership retention during Pause/Suspend.
- Separation of assignment from observed activity, and of submission from accepted delivery.
- Version-bound evidence, resume reconciliation against changed inputs, immutable tool/skill artifacts, and permission checks after restart.
- Tight public authorization defaults with contextual standing grants and private installation policy. Owner consent, technical review, and execution admission are already separate concepts.
- Chat as the primary interface; direct APIs and inspection views as coexisting surfaces.
- TypeScript as the primary implementation language, a portable public product, and all three desktop/server OS families as requirements.

### What must be added or made more concrete

1. Atomic task transition plus durable outbound intent; durable receipt, deduplication, retry deadlines, and startup/periodic reconciliation.
2. A complete task/attempt/delivery/effect state model, with explicit handling of ambiguous outcomes and late messages.
3. A bounded worker persistence policy covering artifacts, context, unfinished work, tool sessions, and continuation; not just model conversation checkpoints.
4. Separate health and progress supervision, deterministic detection before model-based diagnosis, and bounded recovery budgets.
5. Immutable workflow/adapter/tool versions and migration rules for long-lived paused tasks.
6. A complete chat-only control path, including deterministic recovery controls when providers or agents are unavailable.
7. Quantified, configurable operational targets and an explicit compatibility/support matrix.
8. Small task cards, continuous integration of vertical slices, and a release gate that covers the entire accepted product.

This assessment concerns the design and available probes. It does not diagnose the root cause of every current Paperclip stall; doing that would require incident-specific production traces. The proposed failure cases directly address the common classes of lost handoff, missing wakeup, ambiguous ownership, silent waiting, and unrecoverable long attempts.

## 2. Dot's suggestions: agreement, corrections, and implications

| Suggestion | Assessment | Proposed change |
| --- | --- | --- |
| Explicit observe → propose → baseline test → scoped adoption → measure → withdraw cycle | Correct and already substantially reflected in the October 15 learning contract. | Turn each transition into durable records, triggers, authority checks, and acceptance tests. Do not create a second learning scheduler. |
| Automatic learning triggers | Correct. Agents remembering to write notes is insufficient. | Generate observations from controller-visible corrections, failures, recoveries, and recurring friction. Observation is automatic; deciding a lesson is valid remains evidence-based. |
| Versioned lessons and independent evidence | Correct. | Record provenance groups, input assumptions, applicability, contradictions, and supersession. Copies and retellings remain one source observation. |
| Skill maintenance with paused tasks | Correct, with a security qualification. | Pin immutable versions and retain them while referenced. A revoked or unsafe skill cannot continue merely because a paused task uses it; migrate or block that task explicitly. |
| Improvement budget | Correct, but not a new unbounded standing obligation. | Charge reflection, evaluation, adoption, and monitoring to bounded capacity-improvement allocations. Do not accrue catch-up debt or reward proposal counts. |
| Automatic low-risk adoption within granted permissions | Correct if risk is scoped to real effects and evidence. | Separate informational lessons, executable changes, and policy changes; require the appropriate evaluation and admission path for each. |
| Success criteria and authority need a separate boundary | Essential. | Agents may propose changed evaluation or policy, but cannot approve a weaker evaluator and then count the resulting score as improvement. |
| Conservative public defaults and more autonomous private policy | Correct. | One product with conversational, revisioned policy. Rob's grants are private installation data, never public defaults or source-controlled credentials. |
| Build note: Pi Durable 1.0.1 probes, no implemented learning service | Consistent with the reviewed baseline. | Preserve this distinction. New experiments here are additional evidence, not implementation of learning or orchestration. |

The important correction is that “rollback” cannot generally undo real-world effects. Withdrawing a lesson or reverting a skill changes future behavior. A sent message, external commit, purchase, or service change requires its own reconciliation or compensating action, with authority and an audit trail.

## 3. Current architecture decisions

Questions have been sent conversationally. Rob has accepted subordinate remote workers for D1, accepted browser-based remote chat over a private network for D3, accepted D4, and offered a Windows host for D5. Rob subsequently accepted the proposed initial operating limits and controlled standby recovery, including the independently reachable recovery interface. The embedded scheduler and dual database design below are the current planning baseline; qualification is performed against their implementation. Rob accepted the measured approximately 19-second auto-login-to-lock delay for his private Windows test laptop; remaining engineering qualification is tracked separately.

| ID | Decision and paths | Recommendation and consequence |
| --- | --- | --- |
| D1 | One authoritative primary with subordinate external workers | **Accepted by Rob October 16:** remote workers are required for cross-OS release tests and distributed agent capacity. They must maintain primary communication and stop work on loss. They are not equal peers and cannot promote themselves. |
| D2 | Supporting durable scheduling implementation | **Current implementation-plan selection: embedded TypeScript scheduler with interchangeable SQLite and PostgreSQL controller stores.** Pi owns conversation execution; the controller owns tasks, policy, leases and effect admission. The reviewed mechanisms and experiments support this bounded starting design. Temporal is a reference, not a required service or second implementation. Remaining tests validate the selection and may falsify it; they do not postpone making it. |
| D3 | Browser-based remote chat over a private network | **Accepted by Rob October 16:** use the same web interface from a phone or other browser through Tailscale or an equivalent private network. No dedicated mobile app or public Internet exposure is required. |
| D4 | Strong execution isolation default, or trusted-host commands default? | **Accepted by Rob October 16:** strong isolation by default, with an explicitly authorized trusted-host mode. Choose the actual container/VM/native boundary per supported OS and publish limitations. A prompt or a tool-name allowlist is not a shell sandbox. |
| D5 | Windows qualification access now? | **Host available and research tests run October 16:** Windows 11 Pro 10.0.26200 passed native harness recovery, context-fork, stream-crash and limited migration/protocol probes. Windows Sandbox is enabled and basic isolation checks passed. No-login startup failed; Rob authorized an installation-specific auto-login plus immediate-lock fallback, which passed two real restart/locked-session/Sandbox cycles. The measured sign-in-to-lock delay was about 19 seconds in the timed run; Rob has explicitly accepted that measured delay for this private test laptop; this is not a zero-exposure or immediate-lock guarantee. See [unattended findings](windows-unattended-findings.md). Full release qualification remains required. |
| D6 | Initial operating and research limits | **Accepted October 16:** qualify exact OS versions on the three available machines; initially 4 productive attempts installation-wide, 2 per worker host, plus capacity for 2 inquiries/reviews. Test 100 simulated idle hosts and 20 concurrent synthetic tasks. Research paid-model cap is $25 total, no automatic overage; use local/scripted work first. Cache budgets follow measurement. |
| D7 | Primary recovery | **Accepted October 16:** optional replicated standby with owner-controlled promotion through a separately reachable authenticated recovery interface. Fence the old primary before promotion; keep independent versioned backups. Automatic failover is not first-release scope. |

D2 is a choice of durable scheduling implementation, not whether NimbleNewt stores its own domain facts. In both variants NimbleNewt owns the project, policy, task, effect, and evidence model. With Temporal, workflow state owns execution sequencing and timers while domain records own business facts; commands carry stable IDs and both sides reconcile. Avoid maintaining a second independently authoritative “running task” state machine in a database. Workflow completion is not permission to mark an artifact accepted.

### Scheduler decisions for the current plan

The following decisions guide implementation. Qualification tasks test the actual components and integrated product; standalone protocol probes cannot satisfy their acceptance criteria.

**Select an embedded TypeScript controller with first-class SQLite and PostgreSQL support for v1.** One primary service owns transactional domain state, durable dispatch, timers, receipts and ownership generations. Remote workers use authenticated APIs and never open the primary database. Pi remains behind the conversation adapter. This fits the accepted single-primary topology and small initial execution envelope, and the existing controller/Pi crash probes establish a feasible integration. The cost is that NimbleNewt must implement and maintain its own recovery protocol. Do not require Temporal, reproduce its cluster topology, or build a second scheduler backend for v1.

#### Controller storage choice

Rob requested both SQLite and PostgreSQL support, with an extensible database boundary. Both are first-release controller backends. SQLite is the default for a simple local installation; PostgreSQL is the supported server deployment option. One installation uses one authoritative controller backend at a time. The scheduler remains part of NimbleNewt in both modes. PostgreSQL does not introduce peer primaries or authorize multiple active controllers.

Dozens of agents alone do not establish a SQLite limit. Short controller transactions may serve many agents; write contention, checkpoint traffic, latency and sustained workload must be measured. SQLite serializes writes, so PostgreSQL provides an appropriate alternative for higher write concurrency and remotely managed database infrastructure. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)

Use a typed domain-storage interface, not arbitrary SQL exposed throughout the application. Operations include transactional command admission, revision-checked state transition plus outbox insertion, delivery claim, receipt/effect reconciliation, due-timer selection and primary-epoch validation. Each atomic operation must stay on one connection and transaction. An ORM or query builder may assist implementation but does not establish semantic equivalence.

Both adapters must enforce unique operation IDs, reject reuse with different payloads, preserve revision/epoch checks, and atomically commit transition, audit and outbox records. Specify ordering, timestamp and integer representations, null semantics and error classifications. Transactions never include LLM calls or remote effects. Retries rerun a whole aborted database transaction within a bounded budget; an uncertain commit is resolved by stable ID rather than assumed to have failed.

SQLite uses local storage, explicit write admission, short transactions, bounded busy handling and a documented durable flush configuration. PostgreSQL uses a bounded connection pool and explicit row locking or conditional updates. Queue claiming may use SKIP LOCKED, but only for independent eligible deliveries; it must not skip required per-task ordering or bypass policy checks. PostgreSQL documents SKIP LOCKED as useful for queue consumers but unsuitable for a general consistent view. [PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html)

Support additional databases through adapters only when they meet this contract and pass its conformance suite. Do not promise compatibility with nearly any database: transactions, isolation, conditional writes, constraints and migrations differ. No alternative backend may silently weaken the guarantees to fit a generic abstraction. This is one scheduler with multiple storage implementations, not multiple scheduling engines.

**Conversation storage remains a separate boundary.** The pinned Pi Durable 1.3.0 README lists SQLite, JSONL, memory and Cloudflare SQLite backends; it does not list PostgreSQL. Selecting PostgreSQL for the controller does not migrate Pi's storage or make its checkpoints remotely durable. Keep Pi behind its existing adapter, publish verified conversation/workspace checkpoint manifests, and qualify recovery on a replacement worker for both controller modes. Do not require a custom Pi PostgreSQL backend in v1. Pi's documented SQLite default uses synchronous NORMAL; controller durability settings do not change that. Qualification must address the separate acknowledgment and host/power-loss durability contract before claiming whole-system durability.

Provide a chat-driven maintenance operation for SQLite-to-PostgreSQL migration and the reverse within the qualified capacity envelope. Drain productive work, persist paused branches, stop admissions and verify no active grants, take a consistent backup, export/import a versioned logical format, verify IDs, counts, references, checksums and checkpoint recovery, then switch authority and reconcile workers. Include settings, policy revisions, receipts, uncertain effects, timers and artifact references. No silent live dual-write or automatic switch. Preserve the source for recovery; after destination writes or external effects occur, rollback requires reconciliation rather than merely reconnecting to the old database. Schema upgrades remain separately journaled per backend.

The shared crash/concurrency/lease tests must run on real SQLite and PostgreSQL, including database disconnection, ambiguous commit acknowledgment, deadlocks or serialization retries, competing claims and per-task ordering. Test the existing four-attempt configuration and a separate 32-active-agent-equivalent synthetic storage workload plus 100 idle hosts; publish measured throughput, write/claim latency, contention, pool pressure and inquiry latency. The stress test does not change Rob's initial four-productive-attempt limit or promise 32 real LLM agents. Backup, restore and controlled-promotion qualification must cover both backends and the separately stored Pi/artifact state. PostgreSQL research remains outstanding; previous SQLite probes are not PostgreSQL evidence.

Temporal's History Service is a useful reference for jointly persisting transitions and pending dispatch, acknowledging queue progress and using generation numbers to fence obsolete owners. Apply those invariants to the simpler primary architecture. [History Service architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md)

| Concern | Choice for NimbleNewt now | Reason and qualification |
| --- | --- | --- |
| Reliable handoffs | Adopt transactional state-plus-outbox, durable inbox receipts, stable operation IDs and at-least-once delivery with deduplicated admission. Persist before acknowledging. Reconcile on startup and periodically; notifications only accelerate delivery. | Prevent a task from disappearing between stages. Kill at commit and delivery boundaries; duplicates must not create a second admitted attempt. |
| Scheduling and recovery | Persist explicit versioned state transitions and due times. Recover controller state and dispatch from those records; do not introduce a general-purpose replay engine for arbitrary workflow code. Keep an audit log in the same transition transaction. | Fits editable task plans and the existing domain model. Test missed timers, duplicate wakeups, changed plans and state migrations. Historical model answers and tool effects are not regenerated to reconstruct controller state. |
| Conversation continuity | Pi owns transcript/branch state; immutable artifact manifests own workspace checkpoints; the controller references both. Backend decoder/prefix caches are optional disposable accelerators. | A scheduler checkpoint is not a conversation or a running tool. Verify exact branch recovery, updates and suspend/resume independently of cache availability. |
| Interactive control | Persist mutating chat requests with IDs, expected revisions and accepted/applied status. Keep read-only inspection separate. Reserve inquiry/review capacity; answer contextual questions from a branch and admit selected updates through the controller. | Allows rapid control without replaying or polluting the original conversation. Test saturated workers, concurrent updates, restart after acknowledgment and provider failure. Deterministic recovery controls remain available without an LLM. |
| Pause and loss of authority | Pause cooperatively at supported boundaries; abort an unsupported mid-generation stream and retain committed context. Authority loss instead triggers an independent watchdog terminating the execution boundary. | Responsiveness and safety need different mechanisms. A server timeout alone is insufficient to stop isolated work. Test partial tool calls, lost connectivity, dead supervisor and escaped descendants. Exact decoder freeze remains an optional capability. |
| Retry and external effects | Classify operations as read-only, destination-idempotent, or non-replay-safe. Retry only within current policy and budget; ambiguous non-replay-safe outcomes enter reconciliation. | Durable dispatch cannot make an arbitrary external effect exactly once. Test success before lost acknowledgment, revoked grants and exhausted budgets. |
| Placement and capacity | Prefer the existing worker/cache when healthy and useful, but persist enough to recover elsewhere. Apply global and host limits plus reserved control capacity. Idle workers use bounded jittered polling; active workers maintain leases. | Context locality improves speed without becoming a correctness dependency. Test worker loss and inquiry latency under saturation. |
| Versioning and retention | Pin immutable adapter/tool/skill versions and checkpoint schemas; migrate copies with explicit compatibility checks. Retain artifacts referenced by paused branches; revocation can block a pinned version. | Long suspensions must survive upgrades without silently applying different executable behavior. Test incompatible migration and historical context after compaction. |
| Primary recovery | Retain the accepted controlled-promotion design, independently reachable recovery controls, old-primary fencing and independent versioned backups. No automatic promotion or peer primaries in v1. | Matches the chosen authority model. Actual old-primary-live promotion and restore drills remain mandatory. |

Temporal's query/signal/update distinction provides a useful reference for separating inspection from durable change requests. NimbleNewt adds its own branch semantics, conversational policy and resource reservation. This is an application design choice; Temporal also supports interactive workflows. [Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)

Temporal documents that a timed-out Activity may still be running and that cancellation is cooperative. Therefore NimbleNewt's stop-on-disconnect requirement must be enforced outside agent cooperation, whichever scheduler is chosen. [Activity execution and cancellation](https://docs.temporal.io/activity-execution)

**Selection rationale:** Temporal offers mature scheduling machinery and would reduce the amount of generic recovery code we own. It would still require NimbleNewt's retained-context adapter, permission admission, sandbox watchdog and external-effect protocol, plus an additional service and integration boundary. With the accepted one-primary topology and existing probes, the embedded design is the proposed v1 choice. Retained context alone is not an argument that Temporal cannot work. No integrated comparative benchmark has established that the embedded design is faster.

**Reopen this choice only on concrete evidence:** the integrated fixture cannot preserve acknowledged commands and safe effect semantics; measured storage/scheduling limits prevent the accepted workload; or changed requirements demand multiple active control primaries. First distinguish an implementation defect from an architectural limit. A failed test does not automatically justify changing engines, and no gate may be closed by weakening its success criteria. Broader source study may improve implementation details; it is no longer a prerequisite to choosing these mechanisms.

The accepted single-owner model is retained. Corporate attribution and a required human commit review can be supported by one developer's installation and existing external review systems. Multi-human shared administration, roles, SSO, and compliance reporting would be a separate product expansion, not a hidden requirement of that example.

## 4. Durable architecture and data ownership

### Components

- **Control service:** authenticated commands, policy revisions, project/task records, admissions, effects, evidence, and audit events. It performs deterministic transitions without requiring a model.
- **Orchestrator:** executes the selected durable scheduling implementation, dependencies, timers, delivery retries, and reconciliation. It issues work only through control-service admission.
- **Worker host service:** authenticated host identity, bounded processes, workspace/artifact handling, resource accounting, and worker lifecycle. It does not grant itself work or permissions.
- **Harness adapter:** maps a durable attempt to the pinned Pi runtime, preserves contexts and command identities, and records semantic results and checkpoint references.
- **Artifact service:** immutable blobs/manifests with hashes, retention references, and permission-checked retrieval. Local files are acceptable within a local installation; remote references need explicit availability semantics.
- **Conversation service and clients:** durable messages and cursors. Chat, native API, optional MCP, and inspection views call the same protected operations.
- **Recovery/updater service:** deterministic startup, backup/restore, compatibility checks, and release activation outside model control.

No worker directly mutates the authoritative controller database. Do not share a SQLite file over a network filesystem. An embedded controller remains one writer service; remote workers call its API. The PostgreSQL backend uses its qualified database service; the SQLite backend uses local storage.

### Minimum records and identities

Each mutable domain record has an opaque stable ID, revision, creation/update time, source identity, and audit correlation. Timestamps assist diagnosis; revision/order and fencing determine correctness.

| Record | Required information beyond common fields |
| --- | --- |
| Project | Owner, outcome, scope, policy binding, repositories/resources, responsibilities, delivery criteria |
| Task | Project, outcome, dependencies, lifecycle holds, assignment, work status, budget, deliverables, current continuation |
| Assignment | Task, agent, generation, prepared handoff state, transfer reason; immutable history |
| Attempt | Task/assignment generation, host, adapter/runtime/tool versions, start/end, heartbeat, progress, checkpoint, termination reason |
| Operation | Idempotency key, request hash, actor, expected revisions, admitted policy/review versions, accepted/applied/result state |
| Effect | Operation/attempt, exact target/input digest, external idempotency/reconciliation handle, intended/confirmed/uncertain/failed status |
| Delivery/outbox | Stable message ID, aggregate revision, destination, priority, attempts, next retry/deadline, durable receipt |
| Inbox | Recipient, message ID, admitted command ID, receipt/processing/result references; dedup retained for retry horizon |
| Checkpoint | Attempt/runtime versions, conversation reference, artifact manifest, dependency versions, effect ledger position, pending work, continuation |
| Review | Requester and independent reviewer identity, exact action/artifact versions, verdict, reason, expiry, authority limits |
| Policy | Original owner wording, authenticated origin, semantic interpretation, enforceable constraints, revision, scope, applied state |
| Evidence | Exact artifact and input versions, test command/environment/result, reviewer, stale/superseded relationships |
| Learning | Observation identity/provenance group, candidate/lesson version, evaluation, scope, budget, adoption/withdrawal history |

Idempotency-key reuse with different input is an error. Duplicate identical input returns the existing operation and result. Controllers acknowledge acceptance only after the required durable write. An acknowledgment of receipt must never be rendered as execution completed.

### States and transitions

Do not compress all behavior into a single status column. Use separate dimensions:

- Work status: proposed, ready, running, waiting, submitted, accepted, cancelled.
- Lifecycle gates: pause, suspend requested, suspended, stop requested, stopped, release preparation; ancestor/project holds also apply.
- Assignment: unassigned, owned, preparing transfer; only a committed transfer changes the owner/generation.
- Attempt: admitted, starting, active, waiting, checkpointing, completed, failed, lost, fenced.
- Delivery: pending, durably received, admitted/declined, settled; delivery failures remain visible with a next action.
- Effect: intended, in flight, confirmed, uncertain, failed; reconciliation records preserve the original history.

“Waiting” always has a typed reason, dependency/correlation, responsible resolver, timeout or review deadline, and permitted next transitions. “Running” requires a current attempt with fresh observation. Loss of observation becomes unknown/stale, not fabricated progress or immediate reassignment. Accepted delivery requires current evidence and satisfied gates; a successful model turn is insufficient.

All transitions validate expected revision, assignment generation, relevant holds, authorization, and resource admission as applicable. Terminal task cancellation does not pretend that already-issued external effects were undone.

## 5. Handoffs that cannot silently disappear

### Normal flow

1. Agent A submits a versioned result or inquiry with a stable operation ID.
2. The controller commits the state change and outbound intent atomically. Use a transaction and outbox in the selected SQLite or PostgreSQL adapter; reconcile the separate Pi/effect stores with stable IDs.
3. A dispatcher delivers the intent, retrying with the same message ID.
4. The recipient durably records receipt and deduplicates. Receipt is acknowledged only after persistence.
5. Admission rechecks current assignment, policy, versions, holds, and budget. The resulting attempt/inquiry ID is committed before execution.
6. The sender can observe receipt, admission, and answer separately. The answer has a correlation ID and is itself durable.
7. Completion settles the outstanding request. Duplicate or late delivery returns its existing disposition and cannot revive a cancelled or superseded action.

A command review uses a bounded side inquiry to an eligible independent reviewer. It does not transfer the original task to a CTO and back. Review must not run inside the same resource slot that is synchronously waiting for that review. Reserve inquiry capacity and enforce a wait graph to prevent circular dependencies.

### Recovery and liveness

Run reconciliation at startup and periodically. Compare durable intent with receipt/admission/result records; retry pending delivery, recover acknowledged-but-unfinished admissions, surface expired waits, and repair derived indexes. Store reconciliation cursors and make each repair idempotent. A periodic scan must find lost wakeups even if the live event stream fails.

Classify each stuck condition:

| Condition | Required response |
| --- | --- |
| Intent committed; no receipt | Retry same ID with backoff; report age and delivery error. |
| Receipt exists; no admission | Re-run admission against current state; explain a hold or rejection. |
| Attempt admitted; host never starts | Expire start deadline; verify/fence ownership before replacement. |
| Host heartbeat missing | Mark observation stale, investigate; never infer that an external action did not happen. |
| Heartbeat fresh; no useful progress | Inspect bounded evidence and known long-running operations, then use a scoped recovery action. |
| Review queue unavailable | Use authorized fallback or visible wait; never implicitly approve. |
| Circular inquiry waits | Break via allowed alternate reviewer/continuation or escalate with the cycle recorded. |
| Unknown external effect | Reconcile using target-side evidence before retry or transfer. |
| Manual hold present | Preserve hold during every repair. |

Retries have total attempt, time, and cost limits with jitter. Exhaustion produces a durable actionable blocker, not a quiet queue or infinite loop. The owner can ask “why is this waiting?” and receive the exact dependency, last attempt, next retry, and available authorized remedy.

### Leases and fencing

A lease helps detect liveness; it is not sufficient to prevent stale work. Every protected mutation carries a monotonically increasing assignment/attempt generation and is conditionally admitted. Where an external target supports fencing or expected versions, propagate them. Where it does not, a disconnected worker may still have an already-issued operation in progress: block conflicting replacement actions until reconciliation or an explicitly authorized resolution.

Prepared reassignment preserves checkpoints and unfinished artifacts before committing transfer. Pause/Suspend retain ownership. Suspend-and-Release or an authorized prepared takeover changes ownership atomically. Returning old workers cannot reclaim the task.


## 5A. Subordinate remote workers, release testing, and primary recovery

**Owner direction recorded October 16:** remote execution is part of the first-release architecture. There is one authoritative primary control host and subordinate worker hosts. Workers must maintain communication with the primary and stop when communication is lost. They cannot continue independently, elect themselves primary, accept new local user work as authoritative, or delegate execution outside primary admission. Multiple agents may run on each host within centrally assigned and locally enforced capacity limits.

### Communication and disconnected-worker behavior

Use outbound authenticated connections from worker hosts; inbound access to every test machine is unnecessary. Enrollment pins installation/primary identity and host credentials. Every assignment carries primary epoch, assignment generation, attempt ID, permitted resources, resource budget, and an expiring execution lease. A standby is a distinct controller role, never an ordinary worker's self-selected promotion.

Idle discovery and active safety are different loops. An idle host can maintain one long-poll request or poll at a configurable jittered interval, advertising available slots and capabilities. A proposed starting point is a 30–60-second long poll, with backoff during outages and randomized reconnects. The primary responds only with admitted work compatible with the host. Avoid a request per idle agent. For 100 hosts polling every 60 seconds, the average request rate is about 1.7 requests/second, but simultaneous reconnects and open-connection memory still need measurement. This arithmetic is not a load qualification result.

Active hosts renew a short execution lease through an independent control heartbeat, provisionally every 5 seconds with a 15-second maximum lease lifetime. These are proposed tunable values, replacing the earlier generic 10/30-second defaults for active remote execution. Lease deadlines must use monotonic elapsed time conservatively, count request transit time, reject delayed renewals, and prevent a long model/tool call from starving the watchdog. Sleep/resume invalidates execution until renewed communication; platform suspend-clock behavior must be tested.

On a detected connection failure or missed health deadline, the local supervisor closes admission immediately, cancels model requests where supported, and starts bounded checkpoint-and-stop. No new productive tool calls, subprocesses, retries, or external actions are allowed during this cleanup. Only local persistence and previously authorized termination/cleanup may proceed. The lease deadline is a hard backstop enforced outside the agent: kill the managed process/container tree if graceful stopping has not finished. A worker supervisor failure must also expire execution through an independent containment/watchdog mechanism; an in-process JavaScript timer alone is insufficient.

An idle host with no live lease cannot start cached work. Reconnection does not resume a process automatically: authenticate the current primary epoch, report actual checkpoint/process/effect status, reconcile permissions and dependencies, and obtain fresh admission. A late response from an old primary or old attempt cannot renew execution.

No networked system can detect a silent partition at the exact instant it starts. The enforceable contract is immediate stop on detected loss and a tested upper bound for undetected loss. Nor can killing a local process undo a request already accepted by a remote service. Such effects remain uncertain until reconciled; detached jobs must have controllable handles or be explicitly unsupported for automatic safe stop. Do not claim that a disconnected worker's earlier cloud job or server-side write has ceased merely because its process is gone. The primary must not start conflicting replacement work until fencing/reconciliation makes that safe.

### Capacity and agent swarms

Track hosts separately from logical agents and attempts. Hosts advertise OS/build, CPU architecture, isolation backend, runtime/tool versions, memory/disk availability, execution slots, and special resources. The primary chooses placement and reserves capacity atomically; the local host can reject an unsafe reservation. Cloud LLMs reduce local inference demand but do not remove browser, build, sandbox, context, log, network, or subprocess costs.

Use bounded per-host and installation-wide concurrency, resource quotas, provider/cost/rate budgets, queue fairness, and reserved control/review slots. Spawned agents consume the same budgets and require primary admission. Swarm communication is correlated and deduplicated, with fan-out/fan-in limits and cancellation propagation. Avoid all-to-all broadcasts and recursive spawning without a ceiling. Scale scheduling through indexed eligible queues and host capability groups, not repeated full scans of every task for every idle poll.

### External release-test workers

The same worker transport can run deterministic test jobs without starting an LLM agent. A release coordinator submits an immutable candidate manifest containing source commit, built artifact hashes, dependency locks, test-suite revision and required OS/architecture matrix. Each run gets a clean isolated workspace or disposable VM, explicit timeout/resource limits, and a restricted test capability. A machine available for production work is not automatically authorized for destructive release tests.

Workers return structured results, logs, environment facts and artifact hashes linked to the exact candidate/run/attempt. Lost workers produce interrupted/unknown results, never a pass. Retries use new attempt IDs and retain previous failure evidence. The primary verifies receipt/integrity and aggregates results; a worker cannot approve a release. Missing platforms block the release gate. A representative machine per OS is useful, but supported version/architecture claims require the corresponding matrix coverage.

Reboot and partition tests need an outer test supervisor or host-management path that survives the guest/worker failure. Stop-on-disconnect tests must not depend on asking the disconnected worker whether it stopped. Observe externally, including a synthetic external-effect sink. Use disposable systems and fake credentials, not the live primary or unrelated production services.

### Replication and backups

A primary/standby arrangement improves recovery availability, but replication and backup solve different failures. A replica can quickly copy accidental deletion or corruption. Retain independent versioned backups, point-in-time recovery where supported, retention protection, integrity checks and restoration drills. PostgreSQL documents the different data-loss properties of asynchronous and synchronous replication and the need to retain backup recovery material separately. [Replication](https://www.postgresql.org/docs/17/high-availability.html), [standby and archive operation](https://www.postgresql.org/docs/current/warm-standby.html).

Replicate the actual authoritative state: domain data and event positions, workflow-service persistence if selected, policy/identity metadata, checkpoint/artifact manifests and required blobs. Securely provision needed encryption keys/credential references without casually copying all worker secrets. Database replication alone does not make missing artifacts or a separate workflow service recoverable. Record replication lag and a consistent recovery watermark across stores; the recoverable point is constrained by the least-recovered required component.

Asynchronous replication permits a gap after primary loss. Report that gap and reconcile possible external effects before reissuing work whose admission/result may be absent from the standby. Synchronous replication can reduce acknowledged-write loss but adds latency and can stop writes when the required standby is unavailable. Choose recovery-point and recovery-time objectives explicitly; do not silently weaken durability to maintain availability.

Accepted first-release recovery is controlled promotion: verify recovery completeness and lag, fence the old primary from control/storage access, advance authoritative primary epoch, activate the standby, and require workers to re-enroll/reconcile under the new epoch. The recovered old primary remains fenced until explicitly rebuilt/rejoined. Two machines missing each other cannot safely decide independently that each is primary. Automatic failover needs a separately qualified witness/quorum and fencing mechanism; adopting a quorum service is a design option, not an assumption that every worker is a voting peer. [etcd failure behavior](https://etcd.io/docs/v3.7/op-guide/failures/).

The standby hosts a separately reachable, narrowly authenticated web recovery interface accessible over the private network, independent of the failed primary and of any LLM. It reports last replicated state, recovery gaps and fencing status; accepts an authenticated owner command to promote; and durably records authorization and outcome. A deterministic command such as “promote this standby” is sufficient, with an optional equivalent button. Normal chat becomes available after promotion. The endpoint cannot depend on the failed primary for login validation or recovery authorization; provision and test its recovery credentials in advance. If neither controller nor recovery endpoint is reachable, another management path or physical access is required. Workers remain stopped until the new primary explicitly reconciles and admits their work. Owner consent never substitutes for successful fencing; unsafe promotion remains blocked.

For PostgreSQL deployments, use PostgreSQL native replication and standby promotion for the controller database; do not implement a second database replication protocol in NimbleNewt. Distinguish database failover from controller promotion: a database endpoint may recover while the same controller remains authoritative, or a controller may fail while the database stays healthy. Neither event alone authorizes a second controller. PostgreSQL supplies standby promotion, while automated failure detection and safe promotion coordination require an external operational mechanism. [PostgreSQL failover](https://www.postgresql.org/docs/current/warm-standby-failover.html)

NimbleNewt should tolerate a qualified PostgreSQL HA endpoint, including externally managed automatic database failover; NimbleNewt-managed automatic controller promotion remains outside v1. On lost database connectivity, stop new admission and lease renewal, discard failed connections and reconnect with bounded backoff. Before continuing, verify writable-primary identity, schema, current controller authority and recovery consistency. Reconcile uncertain commits by stable operation IDs. Never treat successful reconnection as proof that the recovered database contains every acknowledged command or effect receipt.

Replication mode is explicit installation policy. Asynchronous replication can lose recently acknowledged controller records during failover; synchronous replication can protect commits on an eligible synchronized standby, at the cost of latency and possible blocked writes when required standbys are unavailable. Do not silently weaken synchronous durability to restore availability. Test the actual configured promotion policy and loss window; database protection does not include Pi checkpoints or artifacts outside PostgreSQL. Independent versioned backups remain necessary. [PostgreSQL standby replication](https://www.postgresql.org/docs/current/warm-standby.html)

#### Portable backups and recovery correctness

SQLite is a first-class portable deployment, not merely a development substitute. Provide a chat command to create a versioned recovery folder containing consistent controller and Pi snapshots, required immutable artifacts, configuration and policy revisions, runtime/schema versions, and a checksum manifest. Export explicit secret references and a documented recovery-key procedure; do not silently include machine credentials in an ordinary shareable bundle. Publish the complete marker only after every required item is captured and verified. An interrupted or partial bundle cannot be selected for unattended restore.

Use SQLite's online backup API or another qualified snapshot mechanism for live databases. Do not implement backup by independently copying the changing database/WAL files. A finished immutable bundle can be copied to external storage or a file-sharing destination. Running the live SQLite database from a network/synchronization folder is a different operation and is unsupported. PostgreSQL mode should offer the same portable recovery-folder interface, using an appropriate consistent database export plus the same checkpoint/artifact manifest. [SQLite backup API](https://www.sqlite.org/backup.html), [SQLite WAL](https://www.sqlite.org/wal.html)

**Accepted by Rob October 16:** coordinated backup pauses state-changing work only while establishing a consistent recovery point. Stop new admissions, ask workers to reach safe pause points and checkpoint, capture matching database snapshots and immutable artifact references, then resume before copying or uploading the secured snapshot. Keep read-only status available. An in-flight tool may delay a safe pause; an unavailable worker requires an explicit incomplete/older-checkpoint report. Snapshot data must remain retained and immutable during transfer. This accepts the backup behavior, not overall implementation activation.

Individual database snapshots are not automatically a consistent snapshot of the whole system. For v1 full portable exports, enter a bounded maintenance barrier: stop admissions and mutation, settle or record uncertain in-flight effects, obtain worker checkpoint acknowledgments, capture the controller and referenced snapshots/artifacts, verify them, and release the barrier. Unreachable workers or unavailable referenced data must be reported; do not claim their newest work was captured. Incremental background backups may use an older verified recovery point and must display its age and missing-progress bound. Restoring a bundle never automatically resumes external effects or clones controller authority; it enters recovery reconciliation with old grants invalidated.

The PostgreSQL failover review exposes a critical invariant: database availability does not imply authority continuity. A lagging standby or historical backup may omit acknowledged admissions, receipts or permission revocations. A generation counter stored only in rolled-back data can also be reused. Therefore absence of a record after lossy recovery is not proof an operation never happened, and incrementing the restored counter alone is not sufficient fencing.

For the proposed protected PostgreSQL HA profile, acknowledge authority-changing records only under the configured synchronous durability contract and promote only an eligible replica that preserves it. If continuity cannot be established, enter recovery quarantine: stop new admission, invalidate old grants through a fresh recovery incarnation, fence the former controller/database paths, and reconcile worker and external-system receipts before any uncertain work is reissued. A fresh identifier prevents accidental token reuse but is not physical fencing. Old authority must actually be unable to admit accepted work, and previously issued remote effects remain potentially in flight. In asynchronous or backup-restore recovery, report the possible loss window and require this reconciliation path. Do not claim a global zero-loss guarantee for separately stored conversations and artifacts.

Retain bounded stop-on-disconnect: a worker may continue only within its last valid lease and then must stop the execution boundary. An already accepted external request cannot necessarily be recalled; its outcome remains uncertain until resolved. During a database outage the controller cannot renew execution authority from cached policy. Status may remain readable with a clearly marked last-known timestamp; mutation is not acknowledged as durable while persistence is unavailable.

Required coupled tests are: controller-only crash with healthy database; database-only failover with the controller alive; partition leaving old controller and old database reachable to some workers; standby missing a revocation or effect receipt; missing Pi/artifact checkpoint despite intact database; historical folder restore while the original installation still exists; and interrupted export/restore. Each must show one valid authority, no blind replay of uncertain effects, and an honest recoverable-state report. The protected HA profile is the specified safety-first configuration; PostgreSQL failover and complete portable-bundle qualification run against the implemented product before release.

Accepted initial backup policy: nightly versioned backups retaining 7 daily and 4 weekly copies, plus a pre-upgrade backup. Verify restoration before release. Keep backup history independent from replicated live state, and validate retention/storage requirements during implementation. This policy does not imply zero data loss or a fixed recovery time; those depend on replication mode, lag, complete artifacts and measured recovery procedures.

### Added qualification cases

- Silent and explicit connection loss during idle, model streaming, local tool execution, and an in-flight external effect; measure detection, graceful-stop and hard-stop bounds externally.
- Worker supervisor death, host sleep/wake, delayed renewals, primary epoch changes, duplicate assignment and stale reconnect.
- 100 simulated idle host identities, jitter/backoff and mass reconnect; separately measure realistic active resource demand. This is a stress fixture, not a promise to operate 100 physical hosts.
- Swarm fan-out/cancellation and capacity exhaustion without starving stop/revoke/review traffic.
- Cross-OS candidate test delivery, worker loss, retry, tampered/mismatched artifact, and missing matrix member.
- Primary loss with replica lag, missing blobs, expired credentials, old-primary return, and partition during promotion. Assert no simultaneous authority and no blind replay of uncertain effects.
- Restore a historical backup after replicating a deliberately bad change, proving that replication has not replaced recovery history.

These are new proposed qualifications and tasks, not tests already executed by the earlier local crash probes.

## 6. Checkpoints, failure, and bounded lost work

Pi's persisted execution is one layer. NimbleNewt also needs workspace and continuation persistence. Neither can serialize hidden model reasoning, arbitrary process memory, or every external tool session.

### Proposed policy

Checkpoint after each durable model/tool boundary, before a lifecycle transition, before handoff, at a safe interval during extended work, and before consuming the final continuation reserve. A provisional maximum interval is 60 seconds of active work when a safe boundary is available. If a tool cannot checkpoint, label it non-checkpointable, capture its external handle if available, and set an explicit maximum exposure and recovery rule. Never claim the 60-second target applies to an uncheckpointable 30-minute tool call.

A checkpoint contains:

- Durable conversation/request identity and exact runtime/adapter/tool/skill versions.
- Immutable artifact manifest, including uncommitted source changes and relevant untracked outputs.
- Completed acceptance steps, outstanding work, decisions and assumptions, current blockers, and a specific next action.
- Input/read/search dependencies and revisions, source event cursors, freshness limitations.
- Current effect ledger and external job handles; confirmed versus uncertain outcomes.
- Task budgets used/reserved, assignment generation, policy revision, pending messages and reviews.

Write artifact data first, flush it as required, atomically publish the immutable manifest, then commit the checkpoint reference. Crashing before the reference may leave a reclaimable orphan; it must not leave a checkpoint that points to incomplete content. Garbage collection respects live and paused-task references and backup retention.

Normal turn/time budget exhaustion checkpoints and ends the attempt with a resumable disposition. It does not mark the task failed or discard artifacts. Reserve a provisional final 10% of an attempt budget, with a minimum continuation window chosen for the harness, for persistence; if a hard platform timeout prevents cleanup, recover from the last committed checkpoint and actual workspace state.

### Resume procedure

Load compatible runtime and checkpoint; verify artifact integrity; reacquire or confirm assignment; recheck permissions and holds; reconcile uncertain effects; replay relevant change streams and verify current resource versions; present bounded changes to retained task context; invalidate affected evidence; commit resume against the versions reviewed. A race after review forces another reconciliation or rejects the write.

Full process-image snapshots are not the default. They are OS-specific, often unsafe across versions, and still do not reconcile external actions. Prefer structured durable state plus immutable workspace artifacts. A future specialized checkpointable process adapter must demonstrate its own compatibility and side-effect contract.

## 6A. Retained contexts, mid-generation interruption, and optional inference-cache acceleration

### Core behavior comes first

The application retains each task's exact available message/tool history, execution state and relevant artifacts. Answering an inquiry uses a branch derived from the task's current context and permitted history, not an unrelated empty conversation or reconstructed summary. Returning to the task preserves the original context unchanged unless a relevant update is deliberately committed. Switching tasks preserves each context separately. Context-window limits still apply; any required compaction is explicit and versioned, never an incidental consequence of asking a question.

The prior side-conversation probe did not establish this contract: it demonstrated separation, not access to the original task's current context. Add a test that proves both access and separation, then verifies unchanged and updated resumes, suspension and restart. Application context preservation is required on every supported backend, regardless of cache support.

Mid-generation interruption is separate from a completed-turn branch. Persist streamed partial output separately; never execute an incomplete tool call. For ordinary inquiries the proposed behavior is finish-and-hold or parallel inquiry when resources permit. For Pause or correction, gate subsequent actions immediately and either hold or cancel the outstanding generation. Late responses carry attempt/context revisions and cannot execute stale actions. This default remains a proposal subject to latency/cost measurements. An API connection cancellation is not proof that remote inference stopped.

### Optional backend branch markers

Rob proposed retaining inference state at a branch point so repeated inquiries need not prefill the whole task context again. This is a sound optimization to investigate. Represent the marker as an opaque out-of-band handle bound to an exact context/token boundary, not a literal marker token inserted into the model prompt. Inserting or changing earlier tokens invalidates cache from that point onward.

Example: retain task prefix P; branch to P + inquiry + answer; discard or retain that side conversation separately; resume P + task continuation, or P + selected update + continuation. The common prefix can reuse compatible inference state; only new suffix tokens require processing. If the branch happens inside an unfinished assistant response, use a backend-supported continuation/branch serialization rather than pretending it is a completed chat message. A chat-template role delimiter or assistant terminator can change the actual shared token boundary.

Proposed adapter capabilities, negotiated independently: prefix reuse; inspect cache hit/miss; checkpoint at a supported boundary; retain with quota/expiry; fork; resume; release; export/import compatible state; and mid-generation decoder pause/resume. Advertising one does not imply the others. A handle includes task/context revision, model/weights/adapter identity, tokenizer/template and backend version, exact token/image prefix digest and length, tenant scope, placement, lifetime and state-format compatibility. Backend restart, eviction, incompatible routing or a changed model returns an explicit miss; fall back to retained application context and ordinary prefill without information loss.

An exact frozen decoder continuation may need more than KV tensors: recurrent/hybrid state, positions, sampler/RNG state, grammar/parser state, speculative-decoding state and accepted-versus-proposed tokens. A prefix checkpoint supports efficient new inference but does not by itself prove byte-identical resumption of an interrupted sampling trajectory. Qualify those as distinct capabilities.

Use immutable shared prefix state or verified copy-on-write where supported. Never let inquiry generation overwrite the parent's checkpoint. Bound per-task/host/tenant retention, prioritize active interruption points, and allow explicit eviction. GPU-resident state is fastest but competes with active work; RAM or disk parking incurs copy/restore cost. Pinned contexts must not exhaust memory or starve other tasks. Check cache privacy and scope; cache handles cannot confer access to another agent's context.

### Evidence available today

- **vLLM:** automatic prefix caching already reuses KV blocks for matching prefixes. This is a useful baseline, but opportunistic reuse is not proof of arbitrary named checkpoint pinning or exact mid-generation resume. Measure the deployed version's capabilities, block boundaries and eviction behavior. [Automatic prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching/).
- **llama.cpp:** the server documents prompt-cache reuse and slot save/restore. Inspect and test the selected model/backend combination before treating those operations as complete resumable decoder state. [Server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
- **Strata:** read-only inspection of `the inspected Strata source checkout` at HEAD `d4949d0fc0659e6cb1ad67d3c2eb6ff0c3fcb95c` found `docs/DETAILS.md` conversation-cache documentation, `include/strata/core/conversation_cache.hpp`, engine integration in `src/program/generate.cpp`, and `tools/conversation_cache_parity.py`. The checkout describes exact token/image-prefix matching, bounded opt-in RAM parking, checkpoints and fallback under memory pressure. Source contains corresponding cache structures and restore tests. This is not confirmation of the running server's version or a new performance result. Documentation and code comments need reconciliation where platform/split coverage differs.

No engine fork is justified merely because a marker API would be convenient. First measure native caching, then add a thin adapter, and only patch missing behavior demonstrated by the experiment. Prefer upstreamable changes with pinned compatibility and regression tests. Backends lacking this optimization remain supported. TypeScript/Node owns the adapter and task contexts; engine-level optimization can use each backend's existing implementation language without changing NimbleNewt's primary language.

### Server source audit

The [backend protocol audit](backend-protocol-audit.md) inspected server-vendored llama.cpp and packaged vLLM 0.28.0 source. Their chat envelopes are compatible, but cache controls differ. llama.cpp defers slot save/restore during active generation; vLLM keep/resume pauses the entire engine and is exposed through development routes. Neither establishes a common per-request branch-marker protocol. No model service was started or changed.

### Experiment and acceptance plan

1. Freeze exact backend commits, model/quantization, template, hardware, request settings and baseline. Inspect the deployed Strata separately from candidate source. Use isolated instances; do not restart a serving production model for this probe.
2. Compare cold full prefill, native automatic reuse, and explicit retained-marker reuse where supported. Use long task prefixes with short repeated questions, A/B/A task switching, and update injection. Test both same-worker affinity and deliberate rerouting/cache misses.
3. Assert exact serialized context/prefix identity, correct side-branch knowledge, no contamination of the parent, and correct tool boundaries. Compare logits/tokens against a fresh baseline under controlled deterministic conditions where feasible; specify tolerances for backend numerical variation instead of assuming universal bitwise reproducibility.
4. Measure time to first token, interruption-to-answer latency, return-to-task latency, prompt tokens actually evaluated/reused, restore/copy time, memory retained, throughput impact and cost. Request latency alone cannot prove skipped prefill. Report distributions over repeats and short-prefix cases where caching overhead may dominate.
5. Exercise generation at different token positions, partial tool calls, cancellation, speculative decoding if enabled, memory pressure/eviction, model/template changes, restart and invalid handles. Preserve application context through every cache miss. A full-context cold fallback is acceptable; silently changing context is not.
6. Decide which capabilities merit first-release adapters and whether any engine patch is justified. Backend-specific acceleration is optional; core context continuity and interruption correctness are mandatory gates. Establish performance targets from this baseline before promising an improvement factor or zero prefill.

The first new experiments are now complete: retained-context fork and interrupted-stream recovery passed on Mac/Linux/Windows; actual llama.cpp CPU prefix reuse and idle-slot restore substantially reduced evaluated tokens. Exact decoder freeze, large-model Strata/vLLM optimization and full isolation remain unqualified. See [Windows and context experiment results](context-and-windows-results.md). The earlier Pi/Temporal probes alone did not establish these properties.

## 7. Flexible control through conversation

The owner should be able to create projects, express outcomes, set priorities, change policies, add resources, inspect progress, pause/resume/reassign, approve, diagnose a blocker, request backups, and manage supported updates through chat. They should not need to edit task rows, JSON, or a dashboard. Agents decompose and maintain tasks under authorization. Direct UI/API operations remain supported and must be visible to the same conversation state.

Configuration remains freeform at the interaction layer. Persist the owner's actual wording and a revisioned operational interpretation. Distinguish statements of preference, proposals, and authorized commands. If the system cannot enforce part of a request, say exactly which part remains unapplied. A preset can seed policy but must not restrict its expressiveness.

Examples:

- “You can fix and test this project; ask before touching the customer site.” Interpret necessary development work within scope, keep live deployment gated, and do not ask again for each already-covered build command.
- “For this repository, I want to review the code before every commit.” Bind that gate to the staged tree/diff and base. A change after review invalidates admission for that commit.
- “For tonight's maintenance window, restore this service automatically within this budget.” Store resource, time, action, and spending scope. Do not extend it to collateral services.
- “Relax approvals for read-only diagnosis on my server, but keep independent review for writes.” Preserve both clauses and explain the effective policy.

Use structured controller commands generated from conversation, with actor identity, expected revision, idempotency key, and an auditable result. Harmless clear authorized edits apply directly. Ask only for ambiguity that would materially change access, effect, cost, or user intent. Never reinterpret a quoted document, external agent message, or repository instruction as the owner's authenticated grant.

### Web interface and private remote access

The first release provides a responsive browser interface usable locally and from a phone over Tailscale or an equivalent private network. This resolves D3. Use the same chat, durable history and controller operations on both devices; a separate mobile app, public hosting service, or mandatory Tailscale dependency is not required.

Private networking supplies reachability; NimbleNewt still authenticates the owner, protects browser sessions and state-changing requests, and enforces grants. Default to local binding, with an explicitly configured private listener or authenticated HTTPS proxy path. Document secure private access without enabling public exposure or requiring router port forwarding. Deployment-specific Tailscale configuration stays outside the portable core.

Qualify small-screen chat, approvals, status and deterministic recovery controls. Mobile disconnection or browser suspension must preserve conversation cursors and command IDs, reconnect without duplicate actions, and show authoritative status after recovery. Private network access does not keep a failed primary alive; the separately reachable recovery endpoint remains relevant to standby promotion. Background mobile notifications are not implied by browser access and remain outside this decision.

### When the agent or model is unavailable

Chat must include a deterministic command path for status, pause, stop, revoke, diagnostics, and recovery using documented phrases or discoverable chat actions. It can report durable state without an LLM. If the entire control host is down, its local chat service cannot respond; an independently reachable recovery endpoint or another enrolled host is needed for remote recovery. Make that availability boundary explicit, especially under D1/D3. Do not promise that any single offline machine can be controlled through its own unavailable chat endpoint.

## 8. Approval and command review

Authorization answers “is this action within the owner's granted scope?” Technical review answers “is this concrete operation appropriate and safe?” Admission answers “are those decisions still valid for this exact operation now?” These are different records.

Public defaults are tight. Rob's installation may start with pregranted scopes after their exact terms are recorded. A user may loosen only a project, resource, action class, time window, environment, or cost range. Restrictions and human-review requirements retain their precedence. Existing grants survive ordinary task switches and restarts; revocation takes effect at admission and cancels or bounds pending work according to the operation contract.

For command review, bind the verdict to executable, arguments, working directory, relevant environment/credential references, script content hashes, target identity, expected resource version, and policy revision. A reviewed shell string is insufficient if the script it invokes changes. Recheck before execution and prevent unchecked substitution. Reviewers use limited context, cannot approve their own request where independence is required, and cannot grant access the owner has not granted.

The fast path is an immediate durable side inquiry. A busy worker can answer through a separate conversation when policy/resources allow, retaining its main task. An explicitly paused agent remains paused unless the relevant policy permits that inquiry. An available model and reviewer slot are prerequisites; “much faster than Paperclip” is a hypothesis to measure using equivalent review cases and real model latency, not a guarantee from an offline test.

An agent reviewer reduces some risks but is not a security boundary. Enforce sandbox/resource constraints and capabilities outside the model. Preserve developer, requesting agent, executing identity, reviewer, and owner-consent provenance. Do not claim multi-user corporate accountability beyond identities actually authenticated by the installation and connected source-control systems.

## 9. Learning and improvement

Emit durable observations for explicit corrections, repeated tool failures, recovered failures, approval friction, and measurable regressions. Group repeats by incident/source to prevent evidence inflation. Rate-limit candidate generation and retain source links instead of copying private transcripts into shared lessons.

Lifecycle: observed → candidate → triaged → experiment proposed → authorized experiment → evaluated → adopted in scope → monitored → retained, superseded, or withdrawn. Rejected and inconclusive experiments are legitimate completed work. Reopening needs new evidence or a changed premise.

A lesson version records claim, evidence groups, applicability, dependencies, uncertainty, contradictions, expiry/review trigger, evaluator version, and adoption history. A skill additionally pins exact instructional/executable content and the versions used by each attempt. Record exposure and outcome without pretending correlation alone proves benefit.

Experiments compare against a pinned baseline and separate evaluation cases. Preserve negative results. Do not let a candidate change its own success metric, review rules, authority, or benchmark inputs and then call the new score an improvement. Any requested change to those constraints follows a separate owner/delegated policy decision.

Adoption consumes the appropriate grant and review. Withdrawal stops new use, retains history, locates affected paused/running tasks, and reconciles their dependencies. It does not rewind external effects. Storage retention cannot preserve permission to execute a revoked artifact.

Budget reflection, experiments, and monitoring explicitly within P/PC allocations; normal production command review remains a production cost. Use cost/time ceilings, low-priority admission and interruptibility, and no quota-driven make-work. Exhausted improvement budget produces a deferred candidate, not hidden production spending.

## 10. What to borrow from other systems

The following are selected design lessons, not proposals to combine several full agent frameworks.

- **Hermes:** adopt the usability of skills as maintained reusable knowledge, searchable prior sessions, and conversational automation. Keep lessons permission-aware and evaluated; importing a skill should not import authority. [Official repository](https://github.com/NousResearch/hermes-agent).
- **Pi/Pi Durable:** retain the narrow extensible harness and checkpointed conversation execution. Pin runtime and extensions; layer product authorization and controller durability outside it. The upstream durability description explicitly discusses interrupted tools and request identity. [Pi Durable introduction](https://earendil.com/posts/pi-durable/), [Pi repository](https://github.com/earendil-works/pi).
- **DeepSeek Harness (`dsh`):** consider explicit plugin boundaries and composable services. Avoid making a changing preview framework a second core runtime without a demonstrated need. [Official repository](https://github.com/deepseek-ai/deepseek-harness), [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).
- **Temporal:** durable timers, signals, retried activities with heartbeat details, bounded histories, and worker compatibility are directly relevant to orchestration. Activity retries still require idempotent effects. Production operation is substantially more than the local dev server used here. [Tasks](https://docs.temporal.io/tasks), [worker practices](https://docs.temporal.io/best-practices/worker), [production deployment](https://docs.temporal.io/production-deployment), [Continue-As-New](https://docs.temporal.io/workflow-execution/continue-as-new).
- **Dapr:** the transactional outbox pattern illustrates why a business update and outbound event intent must not be separate best-effort writes. Its workflow sidecar is another operational dependency; do not add it alongside Temporal without a separate need. [Outbox](https://docs.dapr.io/developing-applications/building-blocks/state-management/howto-outbox/), [workflow overview](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/).
- **LangGraph:** persisted checkpoints and pending writes illustrate preserving completed parallel work when another branch fails. Treat graph persistence as a layer, not proof of shell isolation or external effect safety. Existing historical comparisons are not newly executed qualification. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

Upstream behavior can change. Record exact package/source versions and the review date; verify capabilities against installed code and conformance tests before adoption.

## 11. Evidence from experiments performed now

See [experiment-results.md](experiment-results.md) for exact reports and limitations.

The strongest new finding is a real compatibility trap: Pi Durable 1.3.0 could pass the old crash-count probes while the legacy `content` tool result was not visible to the next model step. Using its current `output` contract restored the sentinel result. Upstream 1.2.0 documents the breaking change. This is why package pinning, TypeScript compilation, and semantic assertions belong in the adapter gate. “The process exited successfully” is insufficient. [Upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md).

Mac and Linux process-kill experiments verified the expected contrast between interrupted non-replay-safe calls, deliberately misclassified safe calls that duplicate effects, and idempotent calls that retry without duplicating the synthetic effect. Neither Pi nor Temporal makes arbitrary external effects exactly-once.

A local Temporal experiment recovered from a killed worker, carried heartbeat progress to a retry, preserved a completed prerequisite, and delivered a signal after a persisted development-server restart. A SQLite protocol spike exercised crash windows, duplicate delivery, concurrent admission, fencing and checkpoint publication. These establish feasibility of mechanisms, not a completed controller or production reliability proof.

A live Pi side conversation answered while the main conversation was blocked in a tool, with separate contexts. This supports the proposed inquiry structure. It does not prove reviewer independence, admission security, fairness, or real model response speed.

The historical probe remains pinned to 1.0.1. Implement the new adapter against candidate 1.3.0 with its corrected output contract, exact dependency lock and migration tests; release qualification selects the shipped version without silently rewriting historical evidence. Three synthetic forward-migration cases passed; simple Windows forward-migration fixtures also passed; compaction, all extension types and downgrade remain unqualified.

## 12. Operational targets and release qualification

The initial operating limits and backup policy below were accepted October 16; remaining timing and soak values are proposed qualification targets. All remain subject to evidence-based revision, and none is a performance claim.

| Property | Proposed criterion |
| --- | --- |
| Acknowledged commands | No loss in tested crash windows; acceptance only after durable commit. |
| Side effects | No unintended duplicate in supported idempotent paths; uncertain unprotected effects block conflicting retry. |
| Handoffs | Every pending handoff has observable state, retry/deadline, and deterministic reconciliation. |
| Health | Active remote control heartbeat provisionally every 5 seconds, execution lease at most 15 seconds; stop on detected loss, hard stop by lease expiry. Idle work polling is separate. Expiration never authorizes unsafe duplicate work. |
| Recovery | Known dead-worker recovery within 60 seconds when storage, targets, permissions and replacement capacity are available. |
| Delivery overhead | Provisional p95 admission/delivery under 2 seconds local, 5 seconds remote, excluding model/tool execution and deliberate holds. |
| Saved work | Safe-boundary checkpoints within a provisional 60 seconds active work; explicitly measured exceptions. |
| Operating limits | Initially 4 productive attempts total, 2 per host, and capacity for 2 inquiries/reviews. Deterministic stop/revoke remains independent of model slots. Logical idle/suspended agents do not each reserve an execution slot. |
| Load qualification | 100 simulated idle hosts and 20 concurrent synthetic tasks; separate these fixtures from paid-model production concurrency. |
| Research budget | $25 total paid-model spending accepted for this research, local/scripted tests first, no automatic overage. Track cumulative spend and reserve for in-flight requests. No recurring monthly grant or model-service disruption is implied. |
| Cache budgets | Measure representative context state before setting per-backend memory limits; start context tests with one task and one inquiry. |
| Backups | Nightly; retain 7 daily and 4 weekly copies, plus pre-upgrade backup; restore drill before release. |
| Soak | At least 72 hours of representative mixed work and repeated injected failures before release signoff. |
| Platforms | Fresh installation, chat workflow, restart, effects, isolation, updates and restore on each approved macOS/Linux/Windows version. |
| Completion | Every accepted requirement mapped to implemented behavior, reproducible evidence and current review; no silent scope deletion. |

Test failures must distinguish implementation defects, test defects, and unsupported contracts. Fix or explicitly revise the design before expanding dependent work. Never accept a changed test threshold solely to make a failing implementation pass.

Qualification includes process death at each persistence boundary; controller/service restart; host reboot on disposable hosts; disk-full and I/O failures; network loss and delayed messages; duplicate/out-of-order delivery; queue starvation; reviewer cycles; revoked permissions; stale scripts/diffs; compaction and runtime upgrades; lost external responses; checkpoint corruption; and restore after later external effects. Avoid rebooting or power-failing the active production server for this research.

The release demonstration starts with a project created in chat, performs multi-step work and review, answers an interruption without losing context, survives worker/controller restart, resumes changed inputs correctly, recovers a blocked handoff, delivers a verified artifact, evaluates and withdraws a learning candidate, and performs supported backup/update recovery. Include non-code work, meetings, MCP, routing fallback, and operations responsibilities as required by the existing design.

## 13. Publication and execution boundary

Rob authorized publication of this reconciled planning baseline and task definitions to the Mac, server, GitHub and Paperclip. Preserve existing parent IDs, import children idempotently and verify native blockers. The current task graph is the execution specification; implementation/platform qualification occurs against the code at the appropriate stage. N00 still requires explicit implementation scope and budget before assignment or dispatch. Planning publication does not claim that features or tests are complete. See paperclip-sync-status.md for verified tracker results.

## 14. Test actual implementation and staged acceptance

Rob directed that durability, recovery, isolation and failover tests exercise NimbleNewt's actual code. Standalone SQLite/Pi/Temporal probes are historical feasibility evidence only. They do not count as product qualification or block starting the code needed for those tests. Unit tests may isolate a component; integration and fault tests import or launch the production controller, storage adapter, worker, launcher and recovery code. Scripted model providers and synthetic effect destinations remain useful fixtures around those components. A fixture must not reimplement the controller logic it claims to verify.

G01/G07 capture the design and executable DAG. After separate N00 execution authorization, F tasks build the foundation and adapters; G02/G03 test those actual adapters; S09 validates the durable vertical slice before broad feature integration. G04/G05/G06/G08/G09/G10 then qualify their implemented components at the dependency points recorded in task-plan.json. X tasks run full-product fault, platform and release campaigns. A failed test preserves artifacts and blocks dependent acceptance; it does not erase completed work or automatically reopen settled architecture.

Every test result records the implementation commit, build/lock hashes, backend and OS, exact command, injected failure and observed outcome. No production-readiness claim may rely solely on the archived probes. Cache optimization remains optional; a supported no-cache path must pass context tests even if an engine optimization is unavailable.

Initial configurable implementation defaults: active-worker heartbeat every 5 seconds, lease no longer than 15 seconds, safe-boundary checkpoint target 60 seconds, backup capture wait limit 120 seconds before reporting incomplete/older-state recovery, and no automatic force-kill merely to finish a backup. Protected PostgreSQL HA stops authority-changing writes when its synchronous durability requirement cannot be met. The first release supports Windows isolation in a verified signed-in session; unattended startup requires an explicitly qualified deployment mode and must never be silently inferred from feature installation. Auto-login is installation-specific opt-in, never enabled by public defaults.

Use authenticated HTTPS commands with stable IDs and cursor-based server-sent event updates; reconnect retrieves missed durable records. Worker control uses outbound authenticated requests, active lease renewal and bounded jittered idle polling. WebSockets are not required for correctness. Persisted operations and threads remain independent of transports. Version and pin protocols in the implementing cards.

## 15. Pi adapter as the first implementation milestone

Rob selected the Pi integration as the first piece to build and test, then build the surrounding system around its verified contract. Begin with the minimal TypeScript package and portable test runner (F01/F03), implement the actual Pi adapter (F05/F06), and accept its behavior and checkpoint compatibility through G02/G03 before broader configuration, controller storage and orchestration work. The adapter must run independently of the controller database and UI.

Test actual NimbleNewt adapter APIs for semantic tool results, inquiry branches with unchanged parent context, selective updates, task switching, mid-generation abort, incomplete tool-call rejection, queued input retention, duplicate submission IDs, process death/fresh-process restoration, compaction/history recovery and incompatible checkpoint rejection. Use deterministic providers to make assertions reproducible; substitute only external dependencies, never the adapter under test. Test supported Mac/Linux/Windows runtimes and attach exact source/lock versions.

The deliverable is reusable product code plus its tests and explicit limitations. It is not another stand-alone Pi experiment or an entire agent-management application. Controller authorization/inbox integration, external-effect recovery, OS containment and remote-worker guarantees remain subsequent actual-code integration gates. Optional inference-cache optimization does not block this first milestone. Initial qualification may reveal a necessary adapter change; resolve that before building dependent contracts around it.

This records implementation order. It does not by itself dispatch agents or clear the separately retained N00 execution gate.
