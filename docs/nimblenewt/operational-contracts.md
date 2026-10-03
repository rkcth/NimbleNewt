# Operational contracts

This document makes the product's existing requirements explicit at component boundaries. It defines behavior, not final database schemas or implemented APIs. Mechanisms and policy defaults that need selection are tracked in the [decision register](design-decisions.md).

## Terms and responsibilities

| Term | Meaning |
| --- | --- |
| Installation | One configured NimbleNewt administrative domain with its own identities, policy, and durable records. |
| Controller | Deterministic services that authorize, schedule, journal, and coordinate work. It is not an LLM agent. |
| Coordinator | An agent that converses with people and helps plan; it calls controller services under scoped authority. |
| Agent | Durable identity with a desk, role, permissions, and assignments. Neither a model name nor a process ID. |
| Worker | An execution process/environment hosting a harness for an agent's authorized attempt. Restarting a worker does not replace the agent. |
| Harness | The model/tool execution runtime. Pi Durable is selected; its internal tasks are not automatically NimbleNewt tasks. |
| Model route | A provider/account/endpoint/model combination with capability, privacy, availability, and budget constraints. A remote model endpoint is not a remote worker. |
| Task | An authorized outcome and acceptance criteria, with scope, dependencies, priority, difficulty, budget, and P/PC classification. |
| Context | A persistent task, discussion, or meeting history and its current model-facing view. Context switching is not assignment transfer. |
| Attempt | One authorized execution instance, with a worker/environment version, routing/decision revisions, and expiry or cancellation state. |
| Job | An independently tracked long-running local/remote operation. A durable job record does not imply the underlying process is resumable. |
| Checkpoint | A committed recovery record referring to exact context, task, job, environment, and artifact versions. |
| Capability | A scoped permission enforced by trusted services. A role supplies capabilities; a friendly role name grants none by itself. |

Controller services own assignments, decisions, policy, routing exclusions, inboxes, budgets, and operation outcomes. A worker owns execution progress only within its current authority. Harness history can remain in native storage, but NimbleNewt must retain stable references and export/recovery metadata. Shared artifact storage and agent desks are distinct from editable repository files. Final storage engines and deployment topology remain separate implementation choices.

## State and ownership

Do not encode all state into one status field:

| Dimension | Example values and meaning |
| --- | --- |
| Task outcome/readiness | Proposed, ready, waiting, blocked, completed, failed, cancelled. Waiting has a known wake condition; blocked has a recorded missing requirement or unresolved outcome. Completion requires the task's acceptance evidence. |
| Assignment | Unassigned, or a durable agent ID plus assignment generation. Worker expiry never changes this implicitly. |
| Lifecycle intent | Active, Pause, Suspend, Suspend and Release, Stop, or Force Stop requested at explicit scope. |
| Observed execution | Idle, running, pausing, paused, preparing-to-suspend, suspended, stopping, stopped, recovery-required, or unreachable/unknown. A requested mode is not an observed guarantee. |
| Attempt/job state | Admitted, dispatched, running, completed, failed, cancellation-requested, cancelled, or outcome-unknown, with separate reconciliation records. |

A task can be waiting, assigned to agent A, and subject to A's Pause simultaneously. A finished background job may resolve the dependency without lifting Pause. A stopped agent may still own unfinished tasks. A failed attempt does not necessarily fail its task. Cancel a task only under explicit task authority; Stop controls execution and is not cancellation of its goal. Cancellation must still settle or report effects and preserve history.

Every lifecycle request records actor, target scope, requested mode, operation ID, and policy revision. Scopes are task, agent, team, or installation; organizational descendants and included jobs must be explicit. Enforce all applicable gates. Resuming one task cannot lift a parent/team/system gate. Resume changes only the authorized gate and rechecks the remaining restrictions. No mode implies permission to transfer assignments except a completed explicit release or authorized emergency recovery.

Pause closes ordinary foreground ingress immediately, then reaches a safe boundary; report pausing until actual readiness. Existing permitted background work may continue and record results. An agent-level pause applies across its ordinary task contexts. A task-level pause allows a separately authorized response/meeting task, but does not restart the paused task. A temporary meeting interruption records its return condition; a manual Pause does not acquire an automatic return condition just because a meeting ended.

A safe boundary means the current foreground step has finished with its result recorded, or has been cancelled with its effect status explicitly recorded for recovery, and no further ordinary step may dispatch. For an uncooperative foreground tool, report pausing/blocked rather than paused; an elapsed deadline alone does not establish safety. Cancelling a model request, stopping a tool, and stopping a remote job are distinct operations. An outcome-unknown effect can be preserved while execution is idle, but must be resolved before a dependent action or readiness claim that requires it.

Suspend allows bounded cleanup, durably saves recoverable state, and releases execution resources while preserving ownership. Suspend and Release adds the handoff-ready record and assignment release. Stop uses graceful suspension when possible, then terminates. Force Stop revokes dispatch and attempts external termination without claiming cleanup succeeded. None can promise to undo effects already accepted by another system.

Only one current authorized execution writer may advance a task. A retry/restart gets a new attempt identity; stale attempts cannot write merely because the agent ID is unchanged. Assignment generation and execution fencing must cover trusted services and every direct write path. If a disconnected worker retains uncontrolled filesystem or service access, safe takeover is not established. Preserve ownership and report uncertainty instead of dispatching a duplicate writer.

## Admission, execution, and recovery

1. Authenticate the actor and resolve project, task, agent, command, and version. Resolve shortcuts before queueing. Save durable intent before acknowledging acceptance.
2. Validate lifecycle gates, current decisions, capabilities, dependencies, provider eligibility, tool version, and budget. Reserve shared resources atomically where necessary.
3. Persist an operation identity and intended effect before dispatch. Bind the attempt to the current authorization/ownership generation. A model turn or tool-call ID is not sufficient identity for an external business action.
4. Capture confirmed results and artifact versions durably before declaring completion. If the result is lost or ambiguous, preserve an outcome-unknown record and reconcile rather than invent success or blindly repeat the effect.
5. On restart, inspect journaled intent, results, native harness state, artifacts, and external job status. Recheck current policy and exclusive execution authority before any continuation. Preserve prior lifecycle gates.

Assume messages may be redelivered. Deduplicate by stable input identity, retain acknowledgment/handled/answered separately, and bound retries with a visible failed-input queue. Logical ordering is per task/context where required; timestamps do not establish a total causal order across concurrent workers. Record causation links and authoritative revisions.

A checkpoint becomes ready only when its referenced data and artifacts are durable and readable. Cross-store writes require a recoverable commit protocol: incomplete snapshots are not published as ready, and orphaned artifacts are distinguishable from committed ones. Pin required references during retention. Actual transaction and artifact-store implementation is still to be selected.

Restore native conversation/history when supported; reconstruct from portable records only with visible fidelity limits. Recovery does not freeze and restore arbitrary process memory or hidden model computation. Completed effects remain recorded; uncertain effects require investigation. A live job may need completion, cancellation, restart from a tool checkpoint, or an explicitly tracked remote-job exception.

## Authority and visibility

Each installation has one authenticated human owner, distinct from agent and service identities. Agent consensus cannot override the owner's decision, but text in a repository, tool output, or agent paraphrase cannot impersonate the owner. Multiple owner sessions must preserve decision revisions and surface ambiguous conflicting instructions before acting. Publication, merging, installation, deployment, external messages, and capability changes are distinct authorizations; an accepted proposal is not permission for every downstream action.

Permissions can be delegated only within a grantor's ceiling and explicit scope. Parentage does not grant private-desk access, toolbox maintenance, or release authority. A supervisor can review within delegated policy, while deterministic services enforce it. Independent review cannot be satisfied by the author approving itself under another friendly name. Role combinations and conflict rules must be explicit.

Published work records are readable by authorized peers in their project/team scope. Private scratch is inaccessible to peer agents, including supervisors unless explicitly granted. Trusted recovery services may access required state for their job; that does not make it conversationally available to other agents. Human inspection of private agent records follows the installation access policy and must be defined before release. Secrets remain separately protected and are not exposed in replay or export.

An agent serving multiple projects must use task-scoped retrieval and credentials. Access to a source does not authorize sending it to another project or a cloud provider. Summaries, tool outputs, embeddings/indexes, and copied artifacts inherit relevant restrictions; shared conclusions require an authorized publication path. Failed or revoked tools do not regain authority through a personal fork.

Tool revocation blocks future catalog dispatch for the affected identity/version and applies the configured policy to active operations. It cannot erase source already read or copied. Track known fork lineage for vulnerability notices and review/revocation where warranted; keep permission enforcement independent of code names. Do not claim that renaming or copying code makes it trustworthy, or that revoking a catalog entry makes unrestricted shell execution safe.

## Meeting decisions and work resumption

Represent a motion, ballot result, human decision, authorized action, and applied result separately. Record exact motion versions, stable voter IDs, short reasons, and outstanding applications. A summary may report an adopted plan while saying task updates are still pending; it must not claim successful application prematurely.

Presence must be explicit in the meeting interface, with durable join/leave events, not inferred from reading a transcript or a stale browser connection. Before acting, ask the present owner whether they agree with the agents' decision or want another direction. Pending human agreement remains pending through disconnect or departure unless explicitly delegated. Meeting quorum and human decision authority are separate checks.

Task return revalidates decisions and ownership. A bounded side discussion can have an authorized automatic return condition, but manually paused, suspended, or stopped work stays gated. New priorities can defer the return without transferring the original assignment.

## Failure visibility and administration

Provide model-independent status, Stop/Force Stop, routing exclusions, and recovery controls. Separate receipt, durable acceptance, activation, and successful effect in replies. Report exact blockers and last observed state, including freshness. Controller outage cannot be treated as renewed permission for worker effects; already-running remote operations remain observable uncertainties until reconciled.

Backups include reference-consistent records and artifacts plus a separate secure credential-restoration plan; secret references alone cannot recover a deleted secret store. Restoring a backup must not replay already-performed effects. Retention/export/deletion rules must specify treatment of derived data and backups, and cannot quietly remove material required by resumable tasks. Capacity limits reserve room for shutdown and recovery records.
