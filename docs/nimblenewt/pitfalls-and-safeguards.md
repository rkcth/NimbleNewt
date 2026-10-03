# NimbleNewt pitfalls and safeguards

NimbleNewt's goal is durable, coordinated agent work. This document records failure scenarios and the safeguards incorporated into the [design plan](README.md#safeguards-in-the-design-plan), before selecting phases or an MVP. Safeguard outcomes are design requirements; the mechanisms described below and remaining policy choices need implementation validation. The [isolated harness experiments](harness-test-results.md) demonstrate selected behaviors and hazards, not implemented NimbleNewt safeguards.

## Hazards confirmed in initial experiments

Both tested frameworks repeated an unprotected action after a crash when recovery permitted retry. Stable operation IDs protected the fake service in the corresponding tests; deduplicating a conversation submission alone did not protect tool effects. Pi Durable's default unsafe-tool handling reported an interruption without rerunning it, but declaring that tool replay-safe enabled duplication. Keep that declaration host-controlled and reconcile uncertain results before a model can issue a replacement action.

Pi Durable's abort withdrew queued inputs but a new submission restarted work; preserve NimbleNewt's inbox separately and enforce a durable Pause gate. Its registry also allowed another extension to override a tool name; protect registration and enforce service authority outside extension code. The default SQLite synchronous mode was NORMAL, so specify stronger flush behavior where required rather than inferring host-failure durability from process recovery. Enforce single ownership and stale-owner rejection independently of the storage engine. Full results and test limitations are in the experiment report.

## Production and improvement can starve one another

An unlimited production backlog can consume every improvement opportunity; an unconstrained improvement loop can also produce tools and experiments without delivering user outcomes. Misclassification, unbounded catch-up debt, and token-count targets can make accounting look healthy while either goal is neglected.

Use the [P/PC planning contract](production-and-capacity.md): protected improvement capacity, a delivery floor, separate spending limits, bounded experiments, and expiring exceptions. Evaluate accepted production results and actual improvement evidence rather than activity alone. Missing eligible PC work should be visible, not filled with busywork. No allocation overrides Pause, ownership, permissions, or the user's direction.

## Shared tools can spread defects or unintended authority

A personal utility may depend on private files, assume one host, contain credentials, or need permissions its future users lack. Publishing a mutable path can also let its author change everyone's tool without review. A meeting vote can be mistaken for publication authority.

Provide audience-scoped read-only source access and independent writable personal forks with base-version provenance. Enforce shared immutability through file and service access, not just UI controls. Personal forks cannot shadow shared names or inherit execution privileges. Improvement proposals contain explicit patches and evidence, not entire private desks; stale proposals require conflict resolution and validation before a maintainer publishes a new version.

Use a scoped toolbox-management permission, immutable reviewed promotion artifacts, explicit audiences, versioned updates, and independent invocation authorization. Keep proposals and shared entries separate; record author provenance without copying private context. Validate platform/backend requirements, replay behavior, and dependencies. Test unauthorized edits, personal-file changes, audience changes, revocation of queued work, and rollback. Toolbox permission never grants control over protected NimbleNewt commands. See the [shared toolbox design](README.md#shared-toolbox-and-promotion).

## Runtime upgrades can change the meaning of saved commands

An API rename may also change arguments, return values, cancellation behavior, or persisted state. Prefixes reduce accidental naming conflicts but do not prevent an extension from attempting to shadow a protected operation. Editable agent names and context-sensitive shortcuts can also retarget queued work if stored as routing identities.

Pi Durable is selected with this risk accepted. Use a pinned, versioned adapter; reserve NimbleNewt namespaces; bind agent-owned commands to immutable computer-assigned IDs; and persist resolved operation identities and schema versions. Qualify explicit mappings, migration of suspended checkpoints, collision rejection, and rollback on all required platforms before activation. Keep final authorization outside worker extension code. Follow the [runtime compatibility and namespace plan](runtime-compatibility-and-namespaces.md), including reconciliation of external effects when rollback would otherwise rewind state.

## A reusable project can accidentally depend on its first installation

Hardcoded model choices, private endpoints, host paths, parent-project imports, or setup instructions that rely on existing services could make a separate open-source repository unusable elsewhere. UI settings can also become misleading if workers use a different configuration source or overrides bypass global exclusions.

Require an independent core, optional adapters, and versioned deployment configuration managed through the same service by the UI and conversational controls. Keep credentials and private installation profiles out of public examples. Show effective values and apply changes atomically with explicit restart semantics. Validate extraction in a clean workspace and multiple routing configurations without source edits. See [Standalone distribution and configuration](portability-and-configuration.md) for required UI settings, repository boundaries, and acceptance evidence.

macOS, Linux, and Windows are all required targets. Unix signals, shell commands, permissions, path handling, file replacement, and background services cannot be assumed portable. Implement platform adapters and test equivalent lifecycle and isolation outcomes on all three; do not silently weaken containment or skip mandatory recovery assertions. The initial macOS crash probes are limited evidence, not proof of Linux or Windows support.

## Durable history can still produce an incorrect continuation

Saving a transcript does not establish that the next model will retrieve or understand the relevant constraint. Summaries may omit important details, and a long-dormant task may have an obsolete plan.

Propose retaining original evidence alongside structured goals, decisions, constraints, and next actions. Resume should validate the current task contract and external state, then assemble relevant context with source references. If critical context cannot be recovered, mark the task blocked rather than invent continuity. Validate recovery by checking resulting behavior and artifacts, including when the needed fact is buried deep in history.

Native harness restoration, reconstruction from records, and restarting an interrupted computation need distinct capability labels. An adapter must not report exact restoration when it only reconstructed a prompt. Changing a model or harness should trigger compatibility checks for tools, context capacity, and environment requirements.

The requested billion-context-style conversation layer introduces additional risks: summaries of summaries can drift, source references can break across branches, and two compression mechanisms can discard context independently. Preserve original events, stable source references, summary lineage, and an explicit current user-decision record. Use one coordinated compression owner per context, persist its state, and verify retrieval after restart and model fallback. Expansion requires available originals; a summary alone is not losslessly reversible. Check access boundaries for both retrieval and derived summaries, and test repeated compression against actual earlier decisions rather than assuming a large archive guarantees recall.

## Crashes can duplicate external actions

An agent could submit a job, lose its connection before recording success, and submit it again after restart. Rewinding local files would not undo the first submission.

Propose durable operation identities and intent records, idempotency keys when supported, and reconciliation of uncertain outcomes before retries. Expose an unknown-outcome state when a service cannot confirm what happened. Retry reads and reversible local work according to policy; require a deliberate resolution for uncertain consequential effects. Test crashes before dispatch, after dispatch, and before result persistence. Simulation replay must use recorded results or fake tools rather than repeat live effects.

## Two workers can believe they own the same task

A disconnected worker may keep running while NimbleNewt assigns its task to a replacement. Two agents can also produce individually valid edits that conflict semantically when combined.

Propose a single durable owner and increasing ownership generation for each task. Trusted write services reject requests from an obsolete generation. Expiring a lease alone is insufficient if an old worker retains direct write credentials. Transfers must revoke or fence the old worker before the new owner can change shared state. Use isolated task workspaces, version checks, controlled integration, and checks against the combined result. Direct write paths must provide equivalent enforcement or remain unavailable during uncertain ownership.

## Messages and delegation can consume all useful work

An agent can spawn subtasks faster than they finish, repeatedly interrupt peers, or trigger new events in response to its own updates. Constant urgent arrivals can starve older work. Agents may also wait on one another in a cycle.

Propose limits on delegation depth, active children, queued work, meeting rounds, and interruption frequency. Track event causation to suppress loops, deduplicate delivery, batch informational updates, and slow producers when queues are full. Record dependencies, detect circular waits, and escalate to a named resolver after a deadline. Increase scheduling attention to older eligible tasks without overriding explicit pauses. Track accepted outcomes and time blocked alongside activity counts.

## Approval and review can become either a bottleneck or a rubber stamp

A supervisor may be unavailable, overloaded, or persuaded by an agent's confident report. A reviewer may repeat the author's assumptions and approve work that does not meet the actual request.

Propose preapproved bounded actions and review queues with deadlines. An unavailable reviewer leaves the restricted change pending while unrelated permitted work continues. Reviewers receive the task contract and inspect the actual artifacts and evidence. Important checks should run independently; another model's agreement alone is not sufficient. Bind approval to an artifact version, capabilities, and scope so changing the proposal invalidates old approval. Neither author nor supervisor can raise its own permission ceiling.

## Readable records can spread mistakes or hostile instructions

B might copy A's guess, C might cite B, and the team could treat repetition as independent evidence. Instructions embedded in a repository, tool result, or shared skill could also be mistaken for authorized commands.

Propose explicit provenance, draft and accepted states, supersession links, and a distinction between source evidence and agent interpretation. Repeated copies of one claim retain the original source identity. Reading content never grants it authority or activates a skill. Policy checks live outside model prompts. Shared reading applies within an authorized project or team; confidential material must not spread across unrelated projects, search indexes, logs, or model-provider boundaries.

The user's explicit decisions take precedence over team consensus. Track those decisions separately from agent conclusions, and require planning and review to use the current applicable user decision. A user correction supersedes conflicting team guidance and triggers revalidation of dependent work; repeated agent agreement cannot restore the superseded guidance. Agents may explain factual concerns, but cannot quietly substitute their preferred choice. Surface genuine technical or permission blockers explicitly. Test propagation to busy and suspended agents, including stale reviews and queued actions.

## Environment freedom can undermine isolation

An extension can run installation code, exhaust disk space, alter a shared dependency, or seek broader credentials. A restored environment may depend on packages that no longer exist.

Propose per-agent homes and dependency stores, versioned environment artifacts, scoped secrets and network access, and resource limits that leave capacity for the controller and recovery. Review applies before installation scripts execute. Protect host administration interfaces and actual backing repository metadata, including access through links or renamed ancestors. Test isolation through every exposed tool and shell route. Trial changes in disposable environments and maintain a usable rollback revision. A reviewed package remains subject to containment.

## Agent tools can change after review or bypass the controller

A reviewed script may be edited before it runs, a newly registered tool may shadow a trusted name, or an in-process extension may reach controller credentials. A stale prompt can also attempt a tool after its permission has been revoked.

Protected Pi Durable extensions should be loaded from controller-owned read-only artifacts, with reserved names and protected loader configuration. However, another extension in the same process can still interfere with runtime behavior. Treat the worker as untrusted and keep final authorization in external NimbleNewt services. Test attempts to disable or shadow the bridge as well as direct service calls from personal extensions; immutable source files alone are not sufficient enforcement.

Propose isolated harness workers and a stable tool bridge with versioned manifests and immutable executable artifacts. Approvals bind to the exact code, dependencies, and capabilities. Enforce access again at invocation, reserve controller tool names, and keep in-flight calls bound to their selected version. Treat shell access as an equivalent execution path subject to the same containment. Test live registration, unauthorized activation, changed code, revocation, and checkpointed background jobs. These safeguards are part of evaluating the proposed runtime and tool architecture.

## Budgets can be exceeded by parallel work

Several children might each observe the same available budget and spend it. Retries, meetings, failed attempts, and abandoned remote jobs can accumulate charges without producing useful work.

Propose atomic budget reservations across the task hierarchy before dispatch, followed by reconciliation to actual usage. Account for in-flight uncertainty and distinguish currency spending from local compute and resource measurements. Stop new dispatch at limits and surface already-running charges. Provider-side limits and cancellation support determine how tightly an external spending ceiling can be enforced; report that limit honestly. Escalation should reflect measured task suitability and outcomes, not price alone.

## Pause Suspend and forced stop have different guarantees

Pausing an agent may leave a subprocess or remote job active. An urgent cancellation may arrive while an action is already irreversible. A queued event may otherwise restart intentionally paused work after reboot.

Pause and Suspend must preserve the agent's task assignments, including across server reboots. An idle replacement, approaching deadline, or expired worker lease must not trigger reassignment of paused work. Distinguish a stopped execution lease from durable task ownership. Only explicit Suspend and Release permits ordinary release of paused or suspended work, after preparation is safe. Releasing execution resources must not release assignments. A returning agent must check which tasks it still owns before resuming.

A reassignment request for paused work first requests Suspend and Release and gives the current owner a bounded cleanup opportunity. The recipient must wait for readiness and recorded release or ownership transfer. Released work can remain unassigned with its handoff package intact; a returning owner cannot silently reclaim it. Persist preparation progress across restarts; cleanup failure or an unavailable owner requires an explicit recovery decision rather than silently treating the task as ready for takeover.

Pause permits existing background jobs to continue; Suspend performs bounded preparation before becoming shutdown-ready. Persist pause intent before acknowledging it. Expose preparation progress, unsettled jobs, and time or cost limits. Allow narrowly scoped preparation work during suspension, then stop execution once its checkpoint is durable. Forced termination is separate. A background job finishing must not resume paused foreground work. A system shutdown report must aggregate actual readiness, including any explicitly permitted remote jobs. Completed external effects still require reconciliation or compensation.

Stop prefers a graceful progression through Pause and suspension preparation before termination when the agent and model are responsive. Block ordinary work immediately while permitting bounded cleanup. A reachable model can still stall or lose access to a tool, so persist the Stop request, show preparation progress, and enforce a deadline and resource budget. Use Force Stop to bypass or interrupt preparation only on explicit request or under a previously authorized escalation policy; do not silently label failed cleanup successful. Independent administrative controls must work without any model. Preserve durable records, report unresolved remote work, and reconcile effects before recovery or takeover. Test successful graceful Stop, failure mid-preparation, restart with pending Stop intent, and Force Stop with no available model.

## An instant provider switch can hide unfinished work

Changing a model setting may leave queued requests using old configuration or allow a late primary response to compete with the backup. A replacement model may lack required tools or context capacity, and the coordinator may depend on the very service being shut down.

Propose central durable routing exclusions enforced on every dispatch, including retries, with preconfigured backups for all model-using roles. Acknowledge immediate routing changes separately from the time needed to drain or abandon in-flight work and receive a backup response. Planned maintenance can drain; immediate cutover invalidates old attempts and resumes from committed task state. Preserve and reconcile tool effects rather than replaying them. Check backup permissions, capabilities, and budgets, limit failover loops, and keep explicit user exclusions in force across restarts. If no eligible route exists, preserve progress and report a blocker rather than silently weakening requirements.

## Durable storage can fail or grow without bound

Desk histories, snapshots, environments, and logs could fill the disk needed to save the next checkpoint. A checkpoint can also point to a missing artifact or become unreadable after a schema change.

Propose consistent checkpoint and artifact commits, integrity verification, storage quotas, reserved recovery capacity, tested backups, and explicit version migrations. Retention must keep artifacts referenced by active or resumable tasks. Archive inactive work, retain provenance, and test restoration from backup on a clean runtime. Replication and snapshots should not be treated as a substitute for a tested recovery procedure. User-requested deletion needs a policy for derived indexes, cached replies, and backups as well as primary records.

## Team learning can optimize the wrong outcome

Agents might learn to produce more messages, close easy tasks, or satisfy familiar tests instead of solving the user's problem. A locally successful skill change could degrade other tasks.

Propose evaluating accepted outcomes, regressions, cost, and recovery reliability against versioned task criteria. Keep evaluation examples separate from the cases used to develop an improvement, and include representative failure scenarios. Preserve the previous skill or routing version, trial changes within bounded scope, and roll back regressions. Agents cannot silently redefine acceptance criteria to make their own work pass. Simulation provides useful failure coverage but must be supplemented with controlled tests of real adapters and permissions.

## Complexity can obscure responsibility

If every subsystem becomes another autonomous agent, it may become unclear which component owns a decision or why the system is idle. A dashboard based only on agent narratives can hide stalled processes and failed operations.

Propose a small deterministic core for ownership, scheduling, persistence, permissions, and accounting. Agents handle judgment within that core's rules. The console should distinguish observed process and tool status from agent-reported progress, connect actions to their initiating request, and expose the current blocker and responsible owner. Outages of the controller should prevent new unapproved effects while preserving records for recovery. The controller itself needs restricted access, backup, and failure testing.

## Conversation can target the wrong project or overstate progress

A user may switch projects mid-conversation or brainstorm an idea without requesting implementation. A coordinator could apply the next instruction to the wrong checkout, start work prematurely, or answer a status question from an outdated agent report.

Propose explicit project and repository scope on every dispatched task, independent of the chat's current focus. Resolve references from context and ask only when a consequential target remains ambiguous. Keep proposed work distinct from authorized work. Status replies should cite current internal records, state their freshness, and distinguish observed effects from plans. The conversational interface and visual console should use the same underlying task state and permission checks.

## Repository independence can fail through accidental contamination

An agent might write its plans into an upstream repository, add ignore rules for internal files, or include existing user changes in a PR. A cross-repository task could also complete only half of a coordinated update.

Propose storing all NimbleNewt operational records externally, binding tasks to explicit checkout identities and revisions, recording initial working state, and inspecting actual contribution diffs before publication. Existing repository conventions still apply, but NimbleNewt-specific documents must never be required. Test an ordinary checkout with no NimbleNewt files present. Model related PRs and integration order as separate durable operations, with visible partial completion and a recovery plan.

## Meetings can interrupt work or imply consent

A scheduled meeting could wake deliberately suspended agents, an urgent invitation could abandon an unsafe operation, or simultaneous replies could drown out the user. A recap could claim a decision was applied when tasks still hold the previous plan. An absent user or agent must not be treated as agreeing by silence.

Propose advance preparation, durable briefs, facilitated turns, bounded attendance tasks, and visible participant readiness. Urgent meetings start immediately with available participants while others reach safe boundaries. Preserve task ownership and preexisting lifecycle controls; explicit authorization is needed to wake suspended or stopped participants. Give user questions priority, apply decisions as versioned task changes, and notify absent agents. Keep unanswered questions and failed state updates visible. Time and cost limits prevent endless discussion; meeting records distinguish actual participation from retrieved reports. Meetings proceed without the user and retain both a default summary and the full communicated discussion. Parliamentary mechanics remain proposals to refine. Prevent duplicate votes and roster manipulation, defer binding votes without quorum, and ensure no procedural ruling or team vote overrides user authority. Summaries must preserve significant dissent and link decisions to the full discussion; a summarizer failure must leave the transcript accessible.

## Replay can misrepresent the past or repeat actions

A replay could display current files instead of the versions used at the time, mistake a later explanation for a recorded reason, or rerun a consequential tool while stepping through history. Compressed or missing records can also make an incomplete history appear authoritative.

Preserve versioned evidence and context references, causal links between operations, and original message records. Playback is read-only and never dispatches tools or models automatically. Separate simulation and retrospective analysis from playback, label generated explanations, and show gaps and redactions explicitly. The record describes observed behavior and stated reasons, not hidden model reasoning. Validate no repeated effects, accurate historical versions, and access controls across private and shared histories.

## Meeting policy decisions

Different personalities and models can still repeat a common mistake. Require a brief rationale with each vote, preserve provenance and significant dissent, and distinguish shareable conclusions from inaccessible private evidence. Independent initial positions are a proposed way to reduce early convergence, not proof that ballots are independent. Supervisor-submitted agenda items must preserve the user's question and authority accurately, remain tracked when deferred, and link back to their outcomes. Validate that summaries show individual reasons, private records remain protected, and a discussion request is not converted into authorization to execute.

Voting in the user's absence is accepted behavior. Adopted motions within delegated authority can proceed without later ratification; votes outside that authority remain recommendations. Record outcomes in the summary and full discussion, and apply subsequent user corrections to dependent work. The user's absence is not itself a grant of additional authority.

When the user is present, the chair must ask whether they agree with the vote or want another direction before implementing it. Silence leaves the result pending, and departure does not silently authorize a previously pending decision. Check attendance before dispatching an absent-user outcome, preserve vote and user decision as separate records, and test joins and departures around that boundary to prevent bypassing the user's choice.

- What time, duration, and participant group should scheduled stand-ups use?
- What agent quorum, voting thresholds, and requirements for seconding motions should the lightweight parliamentary procedure use? Meetings already proceed without the user, with a summary as the default view and full discussion available.
- When should an urgent meeting wait for all requested participants rather than begin with the available group?

## Release and deployment boundaries

Ordinary users improve their own projects and tooling. Our optional NimbleNewt development deployment must not become an enabled-by-default self-modification loop or gain access to the live installation through its project name. An authorized official-release updater can be public functionality without granting agents permission to produce or deploy NimbleNewt builds. Keep development artifacts, release authority, updater code, and live state separate. Test startup-failure rollback and prohibit blind state rewind after production effects. See [development scope](development-workflow.md) and [maintenance](maintenance-and-updates.md).

## Remaining operational tradeoffs

- What preparation deadlines and remote-job exceptions should apply to suspension?
- What deadline and preauthorized escalation policy should apply when graceful Stop cannot finish?
- Should a provider-switch request default to immediate cutover or a bounded drain, and when may automatic failback occur?
- Which operations may be retried automatically when their outcome is uncertain?
- Where is shared live editing necessary, and where are isolated workspaces sufficient?
- Which actions require independent review, and who resolves review deadlocks?
- What is the scope of shared reading across teams and projects?
- How much history and environment state must remain recoverable, and for how long?
- Which decisions can a supervisor make autonomously, and which remain with the human?

The [decision register](design-decisions.md) is authoritative for which policy questions remain open; questions above describe the failure cases to consider, not independent decisions. The guiding rule is to make uncertain state visible and preserve a bounded path to recovery. A task should not appear complete, paused, suspended, restored, or approved merely because an agent says it is. The design plan pairs each failure category with its required response and validation evidence.
