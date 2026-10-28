# NimbleNewt state API, version 1

<!-- Generated from packages/controller/src/api/operations.ts by renderApiDocs(); do not edit by hand. Regenerate with `npm run api:docs:write`. -->

One door to the controller's state for chat, command-line and HTTP clients. A client presents a credential and a request; the API authenticates, scopes every fact to what that principal may see, checks every write, and answers in one envelope. A chat client and an API client holding the same credential see the same facts, because there is no other path.

## Request

```json
{ "v": 1, "op": "task.transition", "commandId": "move-7f3a", "args": { "taskId": "task-...", "expectedRevision": 3, "to": "ready" } }
```

- `v` must be 1. Any other value is refused with `invalid_command`.
- `op` is one of the operations below. `args` holds only that operation's arguments; an unknown one is refused, never ignored. `commandId` and `actor` do not go inside `args`: the caller is the authenticated principal.
- A **query** takes no `commandId`. A **command** requires one.

## Response

```json
{ "v": 1, "op": "task.transition", "ok": true, "result": { "id": "task-...", "revision": 4, "replayed": false }, "accepted": true, "completed": true }
{ "v": 1, "op": "task.transition", "ok": false, "error": { "code": "stale_revision", "message": "...", "currentRevision": 5 } }
```

- **Idempotent writes.** Send the same command again (same `commandId`, same content) and you get the first result with `replayed: true`. Reuse a `commandId` for a different command and you get `command_conflict`.
- **Revisions.** A write names the revision it read. A stale one is `stale_revision` with `currentRevision`: read again and decide again.
- **Accepted is not completed.** `accepted: true` means the command is durably recorded. `completed: true` means its effect is finished (the recorded change is the effect). `completed: false` means someone else must act first; `awaits` says what, and the queries named there show when it has happened. A client must not tell a user that work is done because a command was accepted.
- **Pagination.** A list takes `limit` (1 to 100, default 20) and `after`, and returns `items` and, when more may follow, `next`: pass it as `after` for the next page. A page can hold fewer than `limit` items while `next` is present.
- **Errors.** `code` is one of `invalid_command`, `command_conflict`, `stale_revision`, `not_found`, `invalid_transition`, `forbidden`, `unauthenticated`, `unavailable`, and others the operation may name. `field` points at the argument at fault. Something that is not part of this contract is reported as `unavailable` with no detail.
- **Scope.** A principal sees and changes only what its grants allow. A thing it may not read reads exactly like a thing that does not exist.

## Operations

### Queries

#### `context.spill.read`

One page of the rest of a tool result that was cut to the model's window (the cut result names its spill ID). Needs the right to work on the task the result belongs to; anyone else gets not found.

Arguments:

- `spillId`: the spill ID named in the cut result (`spl-…`)
- `index` (optional): the page, from 0
- `size` (optional): page size in characters (at most 50,000)

Result: `{ item: { text, next? } }`; `next` is the index of the following page when there is one.

#### `grant.list`

The rights the owner has granted, with their IDs and revisions (owner only).

Arguments:

- `grantee` (optional): only this principal's grants
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`: each grant with its grantee, action, project, state (`active` or `revoked`), basis and revision.

#### `grant.get`

One grant record (owner only).

Arguments:

- `grantId`: the grant's ID

Result: `{ item }`: the grant, with its revision.

#### `placement.get`

Where local-only data may go (owner only): the hosts the owner allowed and excluded, the approval profile that gives the default, and the hosts that may hold local-only data now. The strict profile allows only listed hosts; the derived and autonomous profiles allow every enrolled host of the owner that is not excluded.

Arguments:

- none

Result: `{ item }`: `allow`, `exclude`, `profile`, `dataHosts` and the revision.

#### `project.branches.get`

Which branches of a project are protected (owner only). A push or merge that changes one stays a decision for the owner whatever the worker says; a project the owner has not set protects `main` and `master`.

Arguments:

- `project`: the project ID

Result: `{ item }`: `revision`, `protected` (branch names, or prefixes such as `release/*`), `landing` when set, and `isDefault`.

Completion: finished when accepted (`completed: true`).

#### `integration.get`

How finished work lands in a project (owner only): `landing` (`integration-branch`, `main-automatic` or `human-promotes`), who integrates, the checks required, and how many times an author refreshes before the integrator takes over. A project made without a setting gets the installation default, else the approval profile's.

Arguments:

- `project`: the project ID

Result: `{ item }`: the settings, `revision`, `source` (`owner`, `installation-default` or `profile`) and `lockedMainAutomatic`.

Completion: finished when accepted (`completed: true`).

#### `integration.default.get`

What new projects start with, and the installation lock on `main-automatic` (owner only).

Arguments:

- none

Result: `{ item }`: the default settings that are set, `revision` (0 when never set) and `forbidMainAutomatic`.

Completion: finished when accepted (`completed: true`).

#### `budget.report`

A task's budget: limit, delegated to children, in flight, uncertain, spent, overrun and available, for money and for compute, with the reservations and open requests behind them. A task you may not read reads like a missing one.

Arguments:

- `taskId`: the task

Result: `{ item }`: the report.

#### `budget.usage`

What has been spent, by project, task or agent, with work and shared overhead apart and the cache figures.

Arguments:

- `projectId` (optional): only this project
- `taskId` (optional): only this task
- `agentId` (optional): only this agent
- `category` (optional): `work` or `shared-overhead`

Result: `{ item }`: the summary.

#### `workspace.get`

One workspace request and what came of it.

Arguments:

- `requestId`: the request

Result: `{ item }`.

#### `status.ask`

A status view from the records, each line citing its records: `task`, `overview`, `noticeboard`, `changes`, `tools`, `delivered` (artifacts are checked against their files when the controller keeps them), `failed_events` and `failed_event`. What the caller may not read reads as missing.

Arguments:

- `request`: `{ kind, ... }` as the view needs (for example `{ kind: "delivered", projectId }`, `{ kind: "failed_event", handlingId }`)

Result: `{ item }`: `{ observedAt, lines, ... }`, or `not_found` when the subject (a task, a failed handling) is missing or unreadable; a view of a project the caller may not read is empty.

#### `budget.pending`

The open requests for more budget addressed to you (the owner: those that went to the owner), with whether the list may be partial.

Arguments:

- none

Result: `{ requests, truncated }`; when `truncated` is true some older open requests may be missing (read each task's `budget.report`).

#### `budget.get-request`

One request for more budget (its requester, its addressee and the owner may read it).

Arguments:

- `requestId`: the request's ID

Result: `{ item }`: the request.

#### `difficulty.profiles`

The difficulty profiles and the mapping from difficulty to profile (owner, or someone with `routing.write`).

Arguments:

- none

Result: `{ item }`: the profiles, with the revision to quote when replacing them.

#### `difficulty.delegation`

A task's delegation: parent, ceiling and the budgets left.

Arguments:

- `taskId`: the task

Result: `{ item }`.

#### `escalation.list`

A task's escalations.

Arguments:

- `taskId`: the task

Result: `{ items }`.

#### `routing.decisions`

The persisted routing decisions of a task: which profile and route were chosen and why.

Arguments:

- `taskId`: the task
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `routing.decision`

One routing decision of a task.

Arguments:

- `taskId`: the task
- `decisionId`: the decision

Result: `{ item }`.

#### `decision.get`

One decision (superseded ones stay visible, marked non-authoritative).

Arguments:

- `decisionId`: the decision

Result: `{ item }`.

#### `decision.history`

Every version of a topic, oldest first, superseded ones marked.

Arguments:

- `projectId`: the project
- `topic`: the topic
- `taskId` (optional): narrow to a task

Result: `{ item }`.

#### `decision.authoritative`

What is decided on a topic now, or that it is open or disputed.

Arguments:

- `projectId`: the project
- `topic`: the topic
- `taskId` (optional): narrow to a task

Result: `{ item }`.

#### `decision.context`

The versioned record of current decisions, permissions, pending questions and goals.

Arguments:

- `projectId`: the project
- `taskId` (optional): narrow to a task

Result: `{ item }`.

#### `decision.reliance`

The decisions a task relies on, which are stale, its follow-ups and revalidations.

Arguments:

- `taskId`: the task

Result: `{ item }`.

#### `decision.propagation`

The progress of a correction reaching the affected tasks.

Arguments:

- `propagationId`: the propagation

Result: `{ item }`.

#### `meeting.schedule-get`

One schedule.

Arguments:

- `scheduleId`: the schedule

Result: `{ item }`.

#### `meeting.invitations`

The meeting invitations addressed to an agent (it reads its own, with a task credential only those of its task's project; the owner reads anyone's; anyone else sees none). Nothing wakes the agent: it reads them when it next looks. They go to the controller's own inbox; a host that supplies its own sink delivers them itself and this list stays empty.

Arguments:

- `agent`: the agent principal ID, e.g. agent:abc

Result: `{ items }`, most recently sent first, at most 50 (older ones drop off; meetings already held stay until pushed out).

#### `meeting.occurrence`

One occurrence with its agenda.

Arguments:

- `occurrenceId`: the occurrence

Result: `{ item }`.

#### `meeting.planned`

A project's planned meetings.

Arguments:

- `projectId`: the project
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `project.get`

One project.

Arguments:

- `projectId`: the project's ID

Result: `{ item }`: the project, with its ID, revision and timestamps.

#### `project.list`

The projects the caller may read.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `task.get`

One task.

Arguments:

- `taskId`: the task's ID

Result: `{ item }`: the task, with its state, revision and timestamps.

#### `task.list`

Tasks the caller may read. Only the installation owner may list across projects; anyone else names the project.

Arguments:

- `projectId` (optional): the project (required unless the caller is the owner)
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `agent.get`

One agent record. The owner, a holder of `agent.read` or `agent.manage`, and the agent itself may ask; anyone else gets `not_found`.

Arguments:

- `agentId`: the agent's ID

Result: `{ item }`: the agent (friendly name, roles, team, supervisor, state, identity), with its revision.

#### `agent.list`

Agent records (needs `agent.read` or `agent.manage`).

Arguments:

- `teamId` (optional): only this team's members
- `state` (optional): `active` or `retired`
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `team.list`

Teams (needs `agent.read` or `agent.manage`).

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `role.list`

Role templates: each name, the capability bundle it stands for and the roles it excludes (needs `agent.read` or `agent.manage`). A role grants nothing by itself.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `contract.get`

A task's contract as it stands (expected result, acceptance criteria, priority, difficulty, budget, P or PC class, required evidence, permissions). A task with none reads as the defaults at version 0.

Arguments:

- `taskId`: the task

Result: `{ item }`: the contract with its `version`.

#### `contract.history`

Every stored version of a task's contract, oldest first.

Arguments:

- `taskId`: the task

Result: `{ items }`.

#### `dependency.list`

What a task depends on, and which tasks depend on it.

Arguments:

- `taskId`: the task

Result: `{ item: { dependsOn, dependents } }`.

#### `assignment.get`

Who owns a task, at which generation, and its state. This is where a deferred command (`task.assign`) is seen to complete.

Arguments:

- `taskId`: the task's ID

Result: `{ item }`: the assignment (owner, generation, state, revision).

#### `assignment.history`

Every generation of a task's assignment, oldest first.

Arguments:

- `taskId`: the task's ID

Result: `{ items }`.

#### `activity.get`

The latest observed activity on a task (what was last seen, by whom, and whether it was the current generation).

Arguments:

- `taskId`: the task's ID

Result: `{ item }`.

#### `search`

Word search over the desk records and histories the caller may read.

Arguments:

- `projectId`: the project to search
- `query`: words to look for
- `limit` (optional): 1 to 50, default 20
- `cursor` (optional): the `next` of the previous page

Result: `{ hits, next?, scanLimited }`: each hit links to its original.

#### `events.failures`

Event handling attempts that failed (a delivery that could not be made, one the agent reported failed, one whose lease ended without a report, or one given up on), in record ID order (IDs are derived, so this is not chronological; sort by `createdAt`). The owner sees all; anyone else sees only the handlings of projects whose histories they may read (`projectId` narrows the list and grants nothing).

Arguments:

- `projectId` (optional): narrow to this project (what the caller may read is filtered either way)
- `taskId` (optional): only this task
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next?, scanLimited? }`: each handling with its state, attempts, failure, owner and the events it carried. `scanLimited: true` means the scan stopped before the end of the records: continue with `after` (as `next`).

#### `events.handling`

One event handling attempt: its events, why it was made, what became of it, the inbox item, and the text that came with the events (untrusted data).

Arguments:

- `handlingId`: the handling's ID

Result: `{ item: { handling, data, inbox? } }`.

#### `events.loops`

Self-triggering event loops that are held (their events are not scheduled until the owner releases them).

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next?, scanLimited? }` (see `events.failures` for `scanLimited`).

#### `branch.get`

A branch, the updates applied to it (resolved for the caller only) and the lengths of the frozen parent and the branch.

Arguments:

- `branchId`: the branch

Result: `{ item: { branch, updates, counts } }`.

#### `branch.history`

The frozen parent's history up to where the branch began, or the branch's own, in order.

Arguments:

- `branchId`: the branch
- `part`: `parent` or `branch`
- `afterSeq` (optional): return entries after this number
- `limit` (optional): how many, default 50

Result: `{ item }`.

#### `branch.pending`

Branches that are waiting to be returned from.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `owner.questions`

The questions agents have put to the owner (each page in the order asked), each with the task it is about (title, state, project) and the wait its answer will resolve. Owner only.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `inquiry.pending`

Open inquiries waiting for the caller to answer.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

#### `resource.list`

The resources bound to a project (repositories, output folders, documents, services), each with its access scope.

Arguments:

- `projectId`: the project
- `state` (optional): `bound` or `unbound`

Result: `{ items }`.

#### `resource.get`

One bound resource.

Arguments:

- `resourceId`: the resource's ID

Result: `{ item }`.

#### `checkout.get`

The checkout a task works in, from records: the bound repository it names, with its location and scope. Refused with `checkout_changed` when a dispatched task's checkout has moved or been unbound.

Arguments:

- `taskId`: the task

Result: `{ item }`.

#### `project.schedule`

A project's due date and milestones against the clock now (`overdue` is computed, never stored; passing a date changes nothing).

Arguments:

- `projectId`: the project

Result: `{ item }`.

#### `responsibility.get`

One ongoing responsibility.

Arguments:

- `responsibilityId`: the responsibility's ID

Result: `{ item }`.

#### `responsibility.list`

A project's ongoing responsibilities.

Arguments:

- `projectId`: the project
- `state` (optional): `active`, `paused` or `retired`

Result: `{ items }`.

#### `responsibility.status`

Where a responsibility stands against its schedule now: last check, next check due, whether it is overdue, whether now is inside a maintenance window. Starts nothing.

Arguments:

- `responsibilityId`: the responsibility

Result: `{ item }`.

#### `responsibility.history`

A responsibility's operational history (checks, interventions, incidents, notes), oldest first.

Arguments:

- `responsibilityId`: the responsibility
- `afterSeq` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100, default 20

Result: `{ items, next? }`.

#### `agenda.get`

One agenda item with its state, owner, deferral and outcome link.

Arguments:

- `itemId`: the agenda item

Result: `{ item }`; the same answer for a missing item and one you may not see.

#### `agenda.list`

A project's open agenda items (queued or deferred) in the order a meeting takes them: urgent first, then conflicts, questions, decisions, other topics and improvement proposals. Needs `meeting.read`.

Arguments:

- `projectId`: the project
- `after` (optional): the `next` of the previous page
- `limit` (optional): page size, at most 100

Result: `{ items, next? }`.

### Commands

#### `grant.create`

The owner gives a principal a right (owner only). A service may hold only recovery actions and a client only conversation actions. Repeating the same command ID gives the same grant.

Arguments:

- `grantee`: the principal, for example `service:dispatcher`
- `action`: the action, for example `recovery.stall-scan`
- `project`: a project ID, or `*` for every project
- `basis`: the reason, in the owner's words
- `notBefore` (optional): ISO time the grant starts
- `expiresAt` (optional): ISO time the grant ends

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `placement.set`

The owner says which hosts may hold local-only data (owner only). `allow` and `exclude` are lists of host IDs (`host:name`); each replaces the earlier list, and one left out stays as it was. A task whose data is local-only is placed only on a host this allows; the change counts from the next placement.

Arguments:

- `allow` (optional): hosts that may hold local-only data, for example `["host:laptop"]`
- `exclude` (optional): hosts that may not, even when the profile would allow them
- `expectedRevision` (optional): the revision you read (0 when none is set)

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `placement.change`

The owner adds hosts to or takes them off the lists of where local-only data may go (owner only), leaving the rest of the lists as they are. Allowing a host takes it off the excluded list and excluding it takes it off the allowed list. This is the form the chat uses, so a request that waits to be accepted does only what it says.

Arguments:

- `allowAdd` (optional): hosts (`host:name`) to allow
- `allowRemove` (optional): hosts to take off the allowed list
- `excludeAdd` (optional): hosts to exclude
- `excludeRemove` (optional): hosts to take off the excluded list

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `project.branches.set`

The owner says which branches of a project are protected and, optionally, which branch finished work lands on (owner only). The list replaces the earlier one; the controller, not the worker, decides from it whether a push or merge touches a protected branch.

Arguments:

- `project`: the project ID
- `protected` (optional): branch names or prefixes such as `release/*`
- `landing` (optional): the landing branch, or null to clear it
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `integration.set`

The owner changes how finished work lands in a project (owner only); fields left out stay. `main-automatic` is refused while the installation forbids it.

Arguments:

- `project`: the project ID
- `landing` (optional): `integration-branch`, `main-automatic` or `human-promotes`
- `integrator` (optional): `agent` or `human`
- `requiredChecks` (optional): list of `tests`, `review`, `qa`, `docs`, `director`
- `refreshRounds` (optional): 0 to 10
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `integration.default.set`

The owner sets what new projects start with (existing projects keep theirs) and may forbid `main-automatic` installation-wide (owner only).

Arguments:

- `landing` (optional): `integration-branch`, `main-automatic` or `human-promotes`
- `integrator` (optional): `agent` or `human`
- `requiredChecks` (optional): list of checks
- `refreshRounds` (optional): 0 to 10
- `forbidMainAutomatic` (optional): true to forbid landing on main automatically everywhere
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `grant.revoke`

The owner takes a grant back (owner only; the revision you read must still be current). It stops counting at the next check.

Arguments:

- `grantId`: the grant's ID
- `expectedRevision`: the revision you read
- `reason`: why, in the owner's words

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `events.configure-idle`

Sets how long an event subscription may sit without acknowledging before it expires (owner only). A subscription that was made before this existed, or without its own time, uses this one.

Arguments:

- `idleSeconds`: whole seconds, 10 to 604800

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `events.cancel`

Cancels an event subscription (its subscriber or the owner). Its events stay in the stream.

Arguments:

- `subscriptionId`: the subscription's ID

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `workspace.request`

Integrates, refreshes or quarantines a task's checkout on the host that holds it. The task's running attempts are made quiet first (new calls refused, calls in flight settled, a checkpoint taken) and go on afterwards; if one cannot be made quiet nothing runs and a blocker says why.

Arguments:

- `operation`: `integration`, `refresh` or `quarantine`
- `taskId`: the task
- `reason`: why

Result: `{ id, state, operation, taskId, summary?, blocker?, quietAttempts?, replayed }`; `state` is `done`, `refused`, `failed` or `uncertain` (a repeat while the host was still working: check the checkout before asking again).

Completion: finished when accepted (`completed: true`).

#### `budget.request-more`

A task asks for more budget. It goes to the holder of the parent node, or to the owner, who is told.

Arguments:

- `taskId`: the task
- `costMicros` (optional): money wanted, in millionths
- `computeMs` (optional): compute wanted, in milliseconds
- `reason`: why

Result: `{ id, to, replayed }`: the request and who it was addressed to.

Completion: finished when accepted (`completed: true`).

#### `budget.decide`

Approves (possibly less than asked) or denies a request. The owner may add new money; the holder it was addressed to may only move allowance from its own node.

Arguments:

- `requestId`: the request
- `approve`: true or false
- `costMicros` (optional): money to grant, at most what was asked
- `computeMs` (optional): compute to grant, at most what was asked
- `note` (optional): a note

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `difficulty.set-profiles`

Replaces the profiles and the mapping in one validated step (owner, or someone with `routing.write`). It applies to the next dispatch only.

Arguments:

- `expectedRevision`: the revision you read (0 for the first)
- `profiles`: the profiles and mapping

Result: `{ revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `difficulty.set`

Sets (or with `null` clears) a task's difficulty. The task's parent may; anyone else needs the ordinary right to change its contract.

Arguments:

- `taskId`: the task
- `expectedVersion`: the contract version you read
- `difficulty`: a difficulty name, or null

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `difficulty.delegate`

The caller (the parent) delegates a task to a child agent with a difficulty ceiling and retry and total budgets for escalation.

Arguments:

- `taskId`: the task delegated
- `child`: the child agent principal (agent:<name>)
- `ceiling`: the highest difficulty the child may escalate to on its own
- `retryBudget` (optional): failures before it must escalate
- `totalBudget` (optional): escalations in all

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `difficulty.reassign-parent`

Moves a delegated task to another parent (the owner only).

Arguments:

- `taskId`: the delegated task
- `parent`: the new parent's principal ID

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `escalation.request`

A blocked or repeatedly failing child asks for a harder profile, within its ceiling or by asking its parent.

Arguments:

- `taskId`: the task
- `kind`: `blocked` or `failing`
- `reason`: why
- `blockerId` (optional): the blocker, for `blocked`
- `to` (optional): the difficulty asked for

Result: `{ item }`: the escalation and how it was decided or who decides.

Completion: finished when accepted (`completed: true`).

#### `escalation.decide`

The parent approves or denies a child's escalation.

Arguments:

- `taskId`: the child task
- `escalationId`: the escalation
- `approve`: true or false
- `reason`: why

Result: `{ item }`.

Completion: finished when accepted (`completed: true`).

#### `decision.record`

The owner records a decision, correction or gate in their own words (direct channel; a chat decision is recorded from the chat turn). A correction supersedes only the conflicting decisions in its scope and takes effect at once; dependent work is marked and blocked until revalidated. Anything but `stance: decided` records nothing.

Arguments:

- `projectId`: the project
- `taskId` (optional): narrow to one task
- `category`: the kind of decision
- `topic`: what it is about
- `statement`: the decided choice
- `wording`: the owner's own words
- `gate` (optional): for a gate, which
- `basedOn`: the version of this topic you saw (0 for none)
- `session` (optional): a label for the session or device
- `stance` (optional): how the words were read
- `sourceTurnId` (optional): set by the owner's chat to the turn the words came from; the words must be in that turn, and a direct caller leaves it out

Result: `{ recorded, ... }`: the decision, or why none was made.

Completion: finished when accepted (`completed: true`).

#### `decision.resolve-dispute`

The owner settles a dispute between conflicting instructions on one decision; arrival order and agents never do.

Arguments:

- `disputeId`: the dispute
- `chosen`: the decision chosen

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `decision.ask`

A task asks the owner a question on a topic; a decided topic answers itself and a disputed one is surfaced instead.

Arguments:

- `taskId`: the task
- `topic`: the topic
- `question`: the question

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `decision.dismiss-question`

Drops a pending question.

Arguments:

- `questionId`: the question
- `reason`: why

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `decision.link`

Records that a plan, contract, review or pending action relies on decisions.

Arguments:

- `taskId`: the task
- `subject`: `{ kind, id }` of what relies on them
- `decisions`: the decision IDs

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `decision.revalidate`

Confirms that work still stands after decisions changed, which unblocks its next action.

Arguments:

- `taskId`: the task
- `decisions`: the decision IDs now current
- `note`: what was checked
- `subjects` (optional): which linked things

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `decision.close-follow-up`

Closes a corrective follow-up recorded for an effect that already happened (it is never claimed undone).

Arguments:

- `followUpId`: the follow-up
- `state`: `addressed` or `accepted`
- `note`: what was done
- `correctiveEffectId` (optional): the effect that corrected it

Result: `{ ... }`: what was done.

Completion: finished when accepted (`completed: true`).

#### `meeting.schedule`

Creates a recurring or one-off meeting schedule for a project. Meetings are held for the roster; a restart or a catch-up creates one occurrence per slot. Needs `meeting.manage`.

Arguments:

- `projectId`: the project
- `title`: the meeting's title
- `roster`: participant principal IDs
- `time`: wall-clock time such as 09:30
- `recurrence` (optional): how often (default daily)
- `timeZone`: an IANA zone such as Europe/Berlin
- `startDate` (optional): YYYY-MM-DD
- `endDate` (optional): YYYY-MM-DD
- `durationMinutes` (optional): length
- `prepareMinutes` (optional): preparation time
- `budgetTokens` (optional): token budget
- `window` (optional): `{ from, to }` times of day

Result: `{ id, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `meeting.update-schedule`

Changes, pauses or ends a schedule. Quote the revision you read.

Arguments:

- `scheduleId`: the schedule
- `expectedRevision`: the revision you read
- `state` (optional): the new state
- `title` (optional): title
- `roster` (optional): participants
- `time` (optional): time
- `recurrence` (optional): recurrence
- `timeZone` (optional): zone
- `startDate` (optional): date or null
- `endDate` (optional): date or null
- `durationMinutes` (optional): length
- `prepareMinutes` (optional): preparation
- `window` (optional): times of day

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `meeting.call-urgent`

Calls an urgent meeting for a roster. Needs `meeting.manage`. Invitations are decided by the dispatcher's own instance; absent or paused participants are withheld there (not composed in the API instance).

Arguments:

- `projectId`: the project
- `title`: title
- `reason`: why it cannot wait
- `roster`: participants
- `durationMinutes` (optional): length

Result: `{ id, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `meeting.settle`

Marks an occurrence held or cancelled.

Arguments:

- `occurrenceId`: the occurrence
- `outcome`: `held` or `cancelled`
- `reason` (optional): why

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `agent.create`

Creates an agent with a new durable ID and its own identity (no grants, no credential). Needs `agent.manage`.

Arguments:

- `friendlyName`: a label for people (it may change and repeat)
- `roles` (optional): role names
- `teamId` (optional): a team
- `supervisorId` (optional): the agent it reports to
- `defaultProfile` (optional): a routing profile name
- `permittedOverrides` (optional): what its profile may be overridden for
- `environment` (optional): an environment name
- `persona` (optional): style text (no effect on permissions)

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `agent.update`

Changes fields of an agent (the revision you read must still be current; `null` clears teamId, supervisorId, defaultProfile, environment or persona). Needs `agent.manage`.

Arguments:

- `agentId`: the agent
- `expectedRevision`: the revision you read
- `friendlyName` (optional): new label
- `roles` (optional): the full list of role names
- `teamId` (optional): team or null
- `supervisorId` (optional): agent or null
- `defaultProfile` (optional): profile name or null
- `permittedOverrides` (optional): list
- `environment` (optional): name or null
- `persona` (optional): text or null

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `agent.retire`

Retires an agent and disables its identity. Refused while active agents report to it. Its ID is never reused; tasks it owns stay assigned to it until explicitly transferred. Any holder of `agent.manage` may retire any agent.

Arguments:

- `agentId`: the agent
- `expectedRevision`: the revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `team.create`

Creates a team, optionally under another team. Needs `agent.manage`.

Arguments:

- `name`: the team's name
- `parentTeamId` (optional): the team it sits under

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `role.define`

Defines a role template, or replaces one when `expectedRevision` is given. Needs `agent.manage`.

Arguments:

- `name`: the role's name
- `capabilities`: action names the role stands for (granting is separate)
- `excludes` (optional): roles that may not be combined with it
- `description` (optional): what it is for
- `expectedRevision` (optional): the revision you read, to replace an existing role

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `role.label`

Sets or clears the owner's display label for a role, for example "CTO" for `director`. Owner only. The label is shown in screens and chat and changes no grant, check or history.

Arguments:

- `name`: the role's name
- `label`: the label, or null to clear it
- `expectedRevision` (optional): the revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `contract.set`

Changes fields of a task's contract; each change stores a new version. Priority, difficulty and the P or PC class each need their own authority.

Arguments:

- `taskId`: the task
- `expectedVersion`: the version you read (0 if none)
- `expectedResult` (optional): text or null
- `acceptanceCriteria` (optional): list of text
- `priority` (optional): 0 to 9, higher first
- `difficulty` (optional): `trivial`, `easy`, `medium`, `hard`, `expert` or null
- `budget` (optional): `{ maxAttempts?, maxMinutes?, maxCost? }`
- `workClass` (optional): `P` or `PC`
- `requiredEvidence` (optional): list of text
- `permissions` (optional): action names the work may use, at most
- `recovery` (optional): `none`, `native-continuation` (default) or `portable-reconstruction`: what the task needs from its harness to be recovered

Result: `{ id, revision (the new version), replayed }`.

Completion: finished when accepted (`completed: true`).

#### `dependency.add`

Makes a task depend on another task of the same project. Refused if it would make a cycle. Needs `task.dependency.write` for the dependent task.

Arguments:

- `taskId`: the dependent task
- `prerequisiteId`: the task it depends on
- `responsible` (optional): the agent answerable for the prerequisite

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `dependency.remove`

Removes a dependency. Needs `task.dependency.write` for the dependent task.

Arguments:

- `taskId`: the dependent task
- `prerequisiteId`: the task it depended on

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `waits.detect`

Looks for tasks waiting for each other in a ring (through task dependencies and open inquiries) and opens a blocker for each ring. Needs `blocker.manage`.

Arguments:

- `projectId`: the project

Result: `{ cycles }`: each ring's tasks and agents, the waits that form it and its blocker.

Completion: finished when accepted (`completed: true`).

#### `branch.open`

Opens a retained context branch of a task (an inquiry's, or a side question's): the parent's history is frozen at this point and the branch has its own. `returnTo` is where the work goes back to (default: the task it began from).

Arguments:

- `taskId`: the task
- `purpose`: what the branch is for
- `returnTo` (optional): the return destination
- `continuationId` (optional): a complete continuation capture the branch inherits
- `inquiryId` (optional): the inquiry it answers

Result: `{ id, scopeId, throughSeq, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `branch.apply`

Applies selected updates (references to records) to a branch, once; the revision you read must still be current.

Arguments:

- `branchId`: the branch
- `expectedRevision`: the revision you read
- `updates`: a list of references

Result: `{ revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `branch.suspend`

Suspends an active branch (a newer task arrived): it keeps exactly the history it had and its return destination.

Arguments:

- `branchId`: the branch
- `expectedRevision`: the revision you read
- `reason`: why

Result: `{}`.

Completion: finished when accepted (`completed: true`).

#### `branch.restore`

Brings a suspended branch back with exactly the history it had; anything others wrote to it meanwhile is reported, not hidden.

Arguments:

- `branchId`: the branch
- `expectedRevision`: the revision you read

Result: `{}`.

Completion: finished when accepted (`completed: true`).

#### `branch.redirect`

Changes where a branch returns to; the destination otherwise stays until the branch is resumed.

Arguments:

- `branchId`: the branch
- `expectedRevision`: the revision you read
- `returnTo`: the new return destination

Result: `{}`.

Completion: finished when accepted (`completed: true`).

#### `branch.append`

Adds a line to the branch's own history (never to the frozen parent's).

Arguments:

- `branchId`: the branch
- `text`: the text

Result: `{ seq, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `branch.switch`

Suspends one branch and restores another in one step; each keeps exactly the history available to it.

Arguments:

- `suspend`: `{ branchId, expectedRevision, reason }`
- `restore`: `{ branchId, expectedRevision }`

Result: `{}`.

Completion: finished when accepted (`completed: true`).

#### `branch.resume`

Finishes a branch and returns to its destination, which stays until resumed or explicitly changed.

Arguments:

- `branchId`: the branch
- `expectedRevision`: the revision you read

Result: `{ returnedTo }`.

Completion: finished when accepted (`completed: true`).

#### `branch.delegate`

Gives a child task only the selected references of a branch (never a fork of the parent context).

Arguments:

- `branchId`: the branch
- `childTaskId`: the child task
- `refs`: a list of references

Result: `{ id, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `owner.ask`

An agent asks the owner a question about a task it works on. The question appears in `owner.questions` with the task's context; if `waitId` names the typed wait the task is blocked in for the owner, the owner's answer resolves it. Asking never wakes or resumes anything.

Arguments:

- `taskId`: the task the question is about
- `question`: the question
- `waitId` (optional): the wait the answer resolves

Result: `{ id, replayed }` (`id` is the inquiry).

Completion: finished when accepted (`completed: true`).

#### `owner.answer`

The owner answers a question; if the task waits on it, the wait is resolved and the task is ready again. Owner only.

Arguments:

- `inquiryId`: the question's ID (`id` of `owner.ask`)
- `answer`: the answer

Result: `{ id, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `project.create`

Creates a project.

Arguments:

- `name`: the name
- `goal` (optional): what it is for
- `repositories` (optional): list of `{ id, location, label? }`

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `project.update`

Changes a project (the revision you read must still be current).

Arguments:

- `projectId`: the project's ID
- `expectedRevision`: the revision you read
- `name` (optional): new name
- `goal` (optional): new goal
- `state` (optional): `active` or `archived`
- `addRepositories` (optional): repositories to add

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `task.create`

Creates a task in a project (it starts `proposed`).

Arguments:

- `projectId`: the project
- `title`: the title
- `description` (optional): details
- `repositoryId` (optional): one of the project's repositories

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `task.update`

Changes a task's title, description or repository (the revision you read must still be current).

Arguments:

- `taskId`: the task
- `expectedRevision`: the revision you read
- `title` (optional): new title
- `description` (optional): new description
- `repositoryId` (optional): a repository of the project, or null to detach

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `task.transition`

Moves a task to another state (only the lifecycle's allowed moves).

Arguments:

- `taskId`: the task
- `expectedRevision`: the revision you read
- `to`: `ready`, `in_progress`, `blocked`, `done` or `cancelled`

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `task.assign`

Gives a task an owner. Accepted and recorded at once; the work is not under way until the owner's worker admits an attempt.

Arguments:

- `taskId`: the task
- `expectedRevision` (optional): the assignment's revision, when it was released before
- `owner`: `{ kind, id }` of the owner
- `reason` (optional): why

Result: `{ id, revision, replayed }`.

Completion: **deferred** (`completed: false`); awaits the owner's worker admitting an attempt (see assignment.get and activity.get).

#### `task.transfer`

Moves a task's ownership to another owner, fencing the old owner. Accepted and recorded at once; the new owner's worker must admit an attempt.

Arguments:

- `taskId`: the task
- `expectedRevision`: the assignment's revision
- `to`: `{ kind, id }` of the new owner
- `reason` (optional): why

Result: `{ id, revision, replayed }`.

Completion: **deferred** (`completed: false`); awaits the new owner's worker admitting an attempt (see assignment.get).

#### `task.release`

Gives up a task's ownership. The record is changed at once; the previous owner's worker may keep running until its next fenced write is refused.

Arguments:

- `taskId`: the task
- `expectedRevision`: the assignment's revision
- `reason` (optional): why

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `resource.bind`

Binds a resource to a project with an access scope (read by default). A repository bind also lists the repository for the project's tasks. Needs `resource.write` (and `resource.scope.write` for write access).

Arguments:

- `projectId`: the project
- `kind`: `repository`, `output`, `document`, `service` or `other`
- `label`: a name, unique among the project's bound resources
- `locator`: where it is (a path, URL or name; never a credential)
- `repositoryId` (optional): the project's handle for a repository (default: made from the label)
- `access` (optional): `read` (default) or `write`
- `paths` (optional): limit the scope to these paths below the resource
- `acknowledgeOverlap` (optional): true to bind a location that contains or lies inside another project's binding (needs `resource.scope.write`)

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `resource.move`

Points a bound resource at another location (needs `resource.scope.write` too when its access is write or unlimited). Tasks already dispatched to it are not redirected: they refuse with `checkout_changed` until their checkout is confirmed.

Arguments:

- `resourceId`: the resource
- `expectedRevision`: the revision you read
- `locator`: the new location
- `acknowledgeOverlap` (optional): true to accept an overlap with another project's binding

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `resource.scope`

Replaces a resource's access scope for its project. Widening it needs `resource.scope.write`.

Arguments:

- `resourceId`: the resource
- `expectedRevision`: the revision you read
- `access`: `read` or `write`
- `paths` (optional): limit the scope to these paths

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `resource.unbind`

Ends a binding (refused while a responsibility manages the resource or an unfinished task is dispatched against it).

Arguments:

- `resourceId`: the resource
- `expectedRevision`: the revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `checkout.pin`

Pins the checkout a task is dispatched against: the bound repository it names, at its current location. Needs `assignment.manage` for the task.

Arguments:

- `taskId`: the task

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `checkout.repin`

Confirms the checkout a task now resolves to after a move or a change of its repository.

Arguments:

- `taskId`: the task
- `expectedRevision`: the pin's revision

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `checkout.release`

Gives up the pin of a task whose repository was cleared after it was dispatched, so it holds no checkout (it is pinned afresh if it names a repository again). Refused while the task still names a repository.

Arguments:

- `taskId`: the task
- `expectedRevision`: the pin's revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `project.plan`

Sets a project's optional due date, workstreams, milestones and authorized participants (each given field replaces that field; `dueDate: null` clears it). A due date is information: passing it changes no state.

Arguments:

- `projectId`: the project
- `expectedRevision`: the revision you read
- `dueDate` (optional): `YYYY-MM-DD` or a UTC timestamp, or null
- `workstreams` (optional): list of `{ id, name, description? }`
- `milestones` (optional): list of `{ id, name, state?, dueDate?, workstreamId? }`
- `participants` (optional): list of `{ principalId, role? }` (active agents; needs `project.participants.write`)

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `responsibility.create`

Creates an ongoing responsibility in a project. Naming the answerable agent or managed resources also needs `responsibility.assign`.

Arguments:

- `projectId`: the project
- `title`: the title
- `objective`: what must continually be true or done
- `desiredCondition` (optional): the condition to keep
- `ownerId` (optional): the answerable agent (principal ID)
- `managed` (optional): IDs of project resources it manages
- `everyMinutes` (optional): how often to check
- `eventSources` (optional): names of event sources
- `permittedActions` (optional): action names its work may use at most
- `maintenanceWindows` (optional): list of `{ days, start, end }` (UTC)
- `escalation` (optional): `{ to, afterMinutes?, note? }`

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `responsibility.update`

Changes a responsibility (the revision you read must still be current); `state` is active, paused or retired (final).

Arguments:

- `responsibilityId`: the responsibility
- `expectedRevision`: the revision you read
- `state` (optional): `active`, `paused` or `retired`
- `title` (optional): new title
- `objective` (optional): new objective
- `desiredCondition` (optional): new condition
- `ownerId` (optional): agent or null
- `managed` (optional): resource IDs
- `everyMinutes` (optional): minutes or null
- `eventSources` (optional): names
- `permittedActions` (optional): action names
- `maintenanceWindows` (optional): windows
- `escalation` (optional): escalation or null

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `responsibility.record`

Adds a check, intervention, incident or note to a responsibility's history, optionally linked to the bounded task it produced.

Arguments:

- `responsibilityId`: the responsibility
- `kind`: `check`, `intervention`, `incident` or `note`
- `summary`: what was found or done
- `outcome` (optional): `ok`, `attention` or `failed`
- `taskId` (optional): the task it produced

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `agenda.capture`

Saves a topic for a later stand-up or meeting, linked to the conversation it came from, and returns it as it will appear so it can be checked and corrected. The request type sets its authority: `discussion` and `recommendation` never execute anything; `delegated-decision` and `owner-instruction` can be recorded by the owner only. Needs `meeting.agenda` in the project (or the owner).

Arguments:

- `projectId`: the project
- `topic`: the topic, in the requester's words
- `question` (optional): the requester's actual question
- `context` (optional): relevant context and constraints
- `requestedOutcome` (optional): what the requester wants out of it
- `urgency` (optional): `normal` (default) or `urgent`
- `intent` (optional): `discussion` (default), `recommendation`, `delegated-decision` or `owner-instruction`
- `participants` (optional): agent principal IDs it is for (empty: whoever attends)
- `category` (optional): `conflict` (managers and the owner), `question`, `decision`, `topic` or `improvement`; default derived from the request type
- `sourceTurnId` (optional): the owner's chat turn it came from (the chat sets this)

Result: `{ id, revision, replayed, shown }`: `shown` is the plain lines to show the requester.

Completion: finished when accepted (`completed: true`).

#### `agenda.correct`

Corrects an open agenda item (the revision you read must still be current); a field given as null is cleared. Only the owner can set or change an instruction or a decision delegated to the team. Returns the item as it now reads.

Arguments:

- `itemId`: the agenda item
- `expectedRevision`: the revision you read
- `topic` (optional): new topic
- `question` (optional): new question, or null
- `context` (optional): new context, or null
- `requestedOutcome` (optional): new outcome, or null
- `urgency` (optional): `normal` or `urgent`
- `intent` (optional): the request type
- `participants` (optional): agent principal IDs
- `category` (optional): the kind of point, or null
- `timeboxMinutes` (optional): minutes to spend on it, or null

Result: `{ id, revision, replayed, shown }`.

Completion: finished when accepted (`completed: true`).
