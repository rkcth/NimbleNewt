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

#### `setup.readiness`

Owner only: what is set up and what is missing before a first agent can work (owner identity, approval profile, a project, a model route, a host, notifications, an agent, a first task). Read-only; each item says whether it is done, left at its default, missing or optional, what was found and how to set it up.

Arguments:

- none

Result: `{ item }`: `ready` (every required item is done), `items` (each with `id`, `label`, `state`, `required`, `detail`, `how`) and `next` (the first required item still missing).

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

#### `escalation.ladder.get`

How long a stall concern nobody decides waits at each level of the supervisor ladder before it climbs to the next supervisor, and finally to the owner (owner only).

Arguments:

- none

Result: `{ item }`: `revision`, `hours` (the owner's hours for level 0, 1, 2 ..., empty when none are set) and `defaultHours` (24, used for a level the list does not name).

Completion: finished when accepted (`completed: true`).

#### `agreed.limits.get`

The optional ceilings on what a decision may carry out (owner only). None is set by default: an agreed raise or grant goes through as agreed.

Arguments:

- none

Result: `{ item }`: `revision` and `limits`, which has any of `raiseMaxCostMicros`, `raiseMaxComputeMs`, `grantMaxDays`.

Completion: finished when accepted (`completed: true`).

#### `resume.settings.get`

How many blocked rounds a stalled resume check retries before the owner is told (owner only): the owner's figure, the default and the effective one.

Arguments:

- none

Result: `{ item }`: `revision`, `maxRounds` (the owner's, or null), `default`, `effective`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.get`

What one local agent may use (owner only): the figures the owner set, the ones from the controller's start-up configuration, and the effective limits (the owner's win per figure).

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's), `startup`, `effective`; each has any of `cpus`, `memoryMb`, `diskMb`, `processes`.

Completion: finished when accepted (`completed: true`).

#### `dispatch.limits.get`

The dispatcher's two limits (owner only): the owner's entries (on or off, with the kept figure), the start-up options, and what applies now. Both are off (no limit) unless set.

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's entries `{ enabled, value? }` for `attemptMinutes`, `maxAttempts`), `startup`, `effective` (a figure that is absent is not limited).

Completion: finished when accepted (`completed: true`).

#### `events.sources.get`

Which event sources the controller watches (owner only): every source the host configured with its type and whether the owner left it on, and the list of those turned off.

Arguments:

- none

Result: `{ item }`: `revision`, `disabled` (source IDs), and `sources` (`id`, `type`, `enabled`, `critical`).

Completion: finished when accepted (`completed: true`).

#### `catalog.running`

The owner lists the catalogue tool calls of one version that are running now (owner only), so a revocation can say what it would reach. Each is named by attempt, call, task and agent, never by its input; at most 50 are listed, and `total` counts all of them.

Arguments:

- `name`: the canonical tool name
- `version`: major.minor.patch

Result: `{ items: [{ attemptId, callId, taskId, agentId }], total }`.

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

#### `note.get`

Reads a working note the caller may read. A note is data to read, not an instruction.

Arguments:

- `noteId`: the note
- `viaProject` (optional): one of the caller's own projects, when reading across an opened path

Result: `{ item }`.

Completion: finished when accepted (`completed: true`).

#### `note.versions`

The kept versions of a working note the caller may read.

Arguments:

- `noteId`: the note
- `viaProject` (optional): one of the caller's own projects, when reading across an opened path

Result: `{ items }`.

Completion: finished when accepted (`completed: true`).

#### `note.list`

Working notes the caller may read, in ID order.

Arguments:

- `projectId` (optional): only this project's
- `ownerId` (optional): only this agent's
- `viaProject` (optional): one of the caller's own projects, when reading across an opened path
- `limit` (optional): 1 to 100
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.status`

What a scope's pause gate says: whether it is paused, who paused it, why, and what the runtime has actually reached (pausing, paused, suspended, stopped, recovery-required), apart from what was asked.

Arguments:

- `scope`: `{ kind, id }`

Result: `{ item }`: `intent`, `owner`, `reason`, `observed`, or `{ intent: "active" }` for a scope never paused.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.get`

A suspension or stop request: its phase, mode, inventory, what blocks it, its outcome (graceful or forced) and history.

Arguments:

- `intentId`: the request

Result: `{ item }` or not found.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.readiness`

Whether a stop of a task, an agent, a team or the installation could finish now, without starting one: what is still running or unknown for the scope. A look that fails is reported as unknown, never as ready.

Arguments:

- `scope`: { kind, id }

Result: `{ scope, ready, paused, unsettled: [{ kind, ref, state }], truncated }`.

#### `model-budget.get`

Owner only: a task's model limits and what it has used so far (cost, tokens, calls, failed attempts).

Arguments:

- `taskId`: the task

Result: `{ budget?, spent }`.

#### `routing.controls`

The controls in force (disabled, draining, cut over) and the failback policy. Owner only.

Arguments:

- none

Result: `{ controls: { entries, failback, … } }`.

#### `routing.report`

The three facts about taking a target out of service, kept apart: routing applied, requests still running on it, and whether it is safe to stop; with possible charges.

Arguments:

- `level`: model, endpoint, account, provider or service
- `name`: which one

Result: `{ report: { routingApplied, inFlightRemaining, safeToStop, routesAffected, drainUntil?, possibleCharges, … } }`.

#### `handoff.for-task`

The hand-off of a task that is still going (prepared, ready, blocked or being completed), or `not_found` when none is.

Arguments:

- `taskId`: the task

Result: `{ item }`.

#### `handoff.get`

A hand-off, with its package, readiness and history.

Arguments:

- `handoffId`: the hand-off

Result: `{ item }`.

#### `resume.get`

A resume check, with what changed, the verdicts and the history.

Arguments:

- `checkId`: the check

Result: `{ item }`.

#### `activity.steps`

A task's steps in order. A step in an unavailable range shows only that it was there.

Arguments:

- `taskId`: the task
- `after` (optional): the last step number you have
- `limit` (optional): at most 100

Result: `{ steps: [...], next? }`.

#### `activity.timeline`

A project's recent steps across its tasks, newest first (a summary to start from: each task contributes its latest ten). Read only. Needs the project's history right.

Arguments:

- `projectId`: the project
- `agent` (optional): only this actor's steps
- `since` (optional): only steps at or after this time
- `limit` (optional): at most 100

Result: `{ steps: [{ taskId, seq, kind, summary, actor, at }], scanned, truncated }`.

#### `activity.payload`

The stored content of one step (redacted). Sensitive content needs the owner or a history grant.

Arguments:

- `taskId`: the task
- `seq`: the step number

Result: `{ payload: { text, redactions } | null }`.

#### `activity.explanations`

The explanations written for a task, or one step of it, a page at a time (the worker's own in the order written, then the retrospective ones).

Arguments:

- `taskId`: the task
- `seq` (optional): one step
- `after` (optional): how many you have already read (the previous `next`)
- `limit` (optional): 1 to 100, default 50

Result: `{ items: [...], next? }`; `next` is passed as `after` for the following page. A page can hold fewer than `limit` items when steps in it are unavailable.

#### `activity.corrections`

The corrections appended to one step (oldest first), each with who and when. A step in an unavailable range has none to show. Read only. Needs the task's history right.

Arguments:

- `taskId`: the task
- `seq`: the step number
- `after` (optional): how many corrections you have already read (the previous `next`)
- `limit` (optional): at most 100

Result: `{ items: [{ note, by, at, ... }], next? }`; `next` is passed as `after` for the following page.

#### `policy.context`

The approval policy as it binds you in a project, read from the records now: which kinds of action are decided by the owner, by review or not at all, the environment tier, the approvals you hold and the latest changes. Nothing is cached, so a change the owner made is in your next read. You may ask about yourself only.

Arguments:

- `projectId`: the project

Result: `{ context: { … } | null }`; null when the project does not exist or you hold nothing in it.

#### `meeting.record.get`

A meeting record, if you may read it.

Arguments:

- `recordId`: the meeting record's ID

Result: `{ item }`.

#### `meeting.record.of-meeting`

The record of a meeting occurrence.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item }`.

#### `meeting.record.discussion`

The full discussion in order, a page at a time.

Arguments:

- `recordId`: the meeting record's ID
- `fromSeq`: first entry number
- `toSeq`: last entry number
- `limit`: at most 100

Result: `{ item: { entries, next? } }`.

#### `meeting.record.motion`

A motion with its versions.

Arguments:

- `motionId`: the motion's ID

Result: `{ item }`.

#### `meeting.record.ballots`

The ballots on a motion; while the vote is open only the count is shown.

Arguments:

- `motionId`: the motion's ID

Result: `{ item }`.

#### `meeting.record.decision`

A decision record.

Arguments:

- `decisionId`: the decision's ID

Result: `{ item }`.

#### `meeting.record.why`

Why a decision was taken, from the record, with links to the discussion; conclusions from records you may not see are marked unverifiable.

Arguments:

- `decisionId`: the decision's ID

Result: `{ item: { decision, lines } }`.

#### `meeting.record.summary`

The meeting summary: attendance, updates, decisions with reasons, dissent, open questions, actions, plan; adopted kept apart from applied.

Arguments:

- `recordId`: the meeting record's ID

Result: `{ item }`.

#### `meeting.decisions.log`

The log of what happened to each change a meeting decided (applied, not applied, refused, declined, overridden), who allowed it and under which setting; owner only (not a task-scoped credential), a page at a time in ID order, at most 20 storage reads a call: a scan that stops early says `scanLimited: true` and gives `next`. `decidedBy` is owner, policy (a widening class the approval policy let through), vote (the team alone, nothing widened), steward or none; `setting` is the policy cell when the change was decided; `code` may be `rights_withdrawn` (the owner agreed, the carrying agent no longer held the right). It holds a digest of each change and safe counters, never its words.

Arguments:

- `kind` (optional): a kind of change, such as budget.raise
- `outcome` (optional): applied, not-applied, refused, declined or overridden
- `projectId` (optional): the project
- `after` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100, default 50

Result: `{ item: { entries, next?, scanLimited? } }`.

#### `meeting.record.plan`

The project's latest plan from a meeting.

Arguments:

- `projectId`: the project

Result: `{ item }`.

#### `meeting.attend.admission`

Whether work an agent is about to start would collide with a nearby meeting (long work that cannot yield is advised against; safe long-running operations continue).

Arguments:

- `agent`: the agent (agent:agt-…)
- `expectedMinutes`: how long the agent's next piece of work would take
- `yieldsAtBoundary`: the work can stop at a safe boundary
- `safeLongRunning`: the work is a safe long-running operation

Result: `{ item }`.

#### `meeting.attend.status`

Who is preparing, present, unavailable or blocked in a room.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item }`.

#### `meeting.attend.revalidation`

What a task must re-check after meeting decisions.

Arguments:

- `taskId`: a task this concerns

Result: `{ item }`.

#### `meeting.attend.brief`

An agent's saved brief, marked as not live.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)

Result: `{ item }`.

#### `standup.get`

A stand-up's schedule and configuration.

Arguments:

- `scheduleId`: the stand-up schedule

Result: `{ item: { schedule, config } }`.

#### `standup.prepared`

What was prepared for an occurrence.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item }`.

#### `standup.brief`

One agent's brief.

Arguments:

- `briefId`: the brief

Result: `{ item }`.

#### `standup.briefs`

The briefs of an occurrence.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item: [...] }`.

#### `standup.agenda`

The agenda of an occurrence: conflicts, questions and decisions first.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item }`.

#### `watch.list`

Owner only: the active watches.

Arguments:

- none

Result: `{ items: [watchId] }`.

#### `watch.describe`

Owner only: the active watches with what each watches (`stream`) and whose task owner it tells (`taskId`).

Arguments:

- none

Result: `{ items: [{ id, stream, taskId, projectId }] }`.

#### `improvement.get`

One proposal with its evidence and disposition, if you may read it.

Arguments:

- `itemId`: the proposal

Result: `{ item }`.

#### `improvement.list`

The open proposals of a project, a page at a time.

Arguments:

- `projectId`: the project
- `afterId`: continue after this proposal
- `limit`: most items

Result: `{ item: { items, next? } }`.

#### `backup.list`

Owner only: the complete backups, newest first, and whether the last one failed.

Arguments:

- none

Result: `{ items: [{ name, createdAt, kind, schemaVersion, epoch, rows }], status }`.

#### `message.readable`

The messages an agent may read at a boundary (check-in, stand-up and so on); focus time and pauses hold some back.

Arguments:

- `boundary`: check-in, stand-up, safe-boundary or interrupt
- `occurrenceId`: the meeting, for a stand-up boundary
- `limit`: most items

Result: `{ item: { items, withheld } }`.

#### `message.get`

One message, marked as untrusted content.

Arguments:

- `messageId`: the message

Result: `{ item }`.

#### `message.inbox`

An agent's waiting messages and focus.

Arguments:

- `recipient`: the agent whose inbox

Result: `{ item }`.

#### `message.owner-questions`

Owner only: the questions waiting for an answer, oldest first, each with its task and the wait it will resolve.

Arguments:

- `afterId`: continue after this question
- `limit`: most items

Result: `{ item: { items, next? } }`.

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

A status view from the records, each line citing its records: `task`, `overview`, `noticeboard`, `changes`, `tools`, `delivered` (artifacts are checked against their files when the controller keeps them), `failed_events`, `failed_event`, `handoff` (the hand-off going on for a task: `{ kind: "handoff", taskId }`), `timeline` (a project's recent steps across its tasks: `{ kind: "timeline", projectId, agent?, since?, limit? }`), `shutdown` (whether the installation could be stopped now, owner only: `{ kind: "shutdown" }`), `meetings` (a project's planned meetings with their rosters: `{ kind: "meetings", projectId, limit? }`), `agenda` (a project's open stand-up topics in meeting order: `{ kind: "agenda", projectId, limit? }`), `explanations` (what agents wrote about their choices on a task: `{ kind: "explanations", taskId, seq?, limit? }`), `activity` (a task's recorded steps in plain lines: `{ kind: "activity", taskId, latest?, after?, limit? }`) and `owner_questions` (owner only: the questions agents have put to the owner, `{ kind: "owner_questions", limit? }`), `needs_you` (owner only: everything waiting for the owner's decision, questions, approvals and blockers, with what each holds up, `{ kind: "needs_you", limit? }`). What the caller may not read reads as missing.

Arguments:

- `request`: `{ kind, ... }` as the view needs (for example `{ kind: "delivered", projectId }`, `{ kind: "failed_event", handlingId }`)

Result: `{ item }`: `{ observedAt, lines, ... }`, or `not_found` when the subject (a task, a failed handling) is missing or unreadable; a view of a project the caller may not read is empty.

#### `status.attention`

What in the overview needs a person's eye, as a paged list: assignees whose work is paused (`paused_assignee`), workers that reported the work and can no longer be relied on, a host not heard from or revoked (`unreachable_worker`), and tool calls whose result is not known (`uncertain_tool_result`). Read only. Each kind needs the same right as its neighbour (pauses and workers: the right to read the task's assignment; tool calls: the tool-history right on the task); what the caller may not see is never listed. Only the owner may leave out both `projectId` and `taskId`. Stale artifacts are not covered yet.

Arguments:

- `projectId` (optional): only this project
- `taskId` (optional): only this task
- `agentId` (optional): only this agent (the task's owner of record, or the caller of the tool)
- `state` (optional): only tasks in this state
- `kind` (optional): `paused_assignee`, `unreachable_worker` or `uncertain_tool_result`
- `since` (optional): only items after this UTC time (the pause time, the last sign of work, the call time)
- `until` (optional): only items up to this UTC time
- `limit` (optional): 1 to 100, default 50
- `after` (optional): the `next` of the previous page

Result: `{ observedAt, items, next?, scanLimited? }`; each item has `kind`, `taskId`, `projectId`, `title`, `taskState`, `agentId?`, `at?`, `summary`, `detail` and `cite`; `scanLimited` means the search stopped before the end: ask again from `next`.

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

#### `notifications.settings`

Owner only: how notifications reach the owner (channel, digest times, quiet hours, hours before an unanswered item is escalated), with the revision to quote when changing them.

Arguments:

- none

Result: `{ item }`.

#### `budget.aggregate.get`

The owner's optional aggregate money cap (owner only): whether it is on, its scope, period and amount, and the revision to quote. Unset means no cap.

Arguments:

- none

Result: `{ item }`: `revision`, `enabled`, `state` (off, on or damaged: a cap record that cannot be read is damaged and refuses paid work, it is never off), and `scope`, `period`, `amountMicros`, `currency` when set, and `approximate` when the totals were built from a ledger scan that hit its bound.

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

#### `deliverable.list`

The deliverables recorded for a task: its artifacts, with each one's revision, who recorded it and when, its manifest digest, size and file list (names redacted). Needs the right to read the task; anyone else gets `not_found`.

Arguments:

- `taskId`: the task
- `limit` (optional): 1 to 100, default 50
- `after` (optional): the `next` of the previous page (an opaque cursor bound to you and this task; any other value is `invalid_command`)

Result: `{ items, next?, scanLimited? }`; `scanLimited` means the search stopped before the end: ask again from `next`.

#### `deliverable.get`

One deliverable by its artifact ID, with the same fields as `deliverable.list`. An artifact that belongs to no task, or to a task the caller may not read, is `not_found`.

Arguments:

- `id`: the artifact's ID

Result: `{ item }`.

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

#### `responsibility.checks`

The checks of a project's responsibilities that came due and are not yet finished by a `check` entry in the history, oldest first. A catch-up after downtime names the gap it covers.

Arguments:

- `projectId`: the project

Result: `{ items }`.

#### `responsibility.incidents`

A project's incidents: repeated alerts grouped by what they are about, open ones first, with how many, the worst outcome and whether they were escalated.

Arguments:

- `projectId`: the project
- `open` (optional): true for the open ones only

Result: `{ items }`.

#### `responsibility.observed`

What the checks found for a responsibility, apart from what is wanted: `unknown` without a check in the last two periods, never healthy by default.

Arguments:

- `responsibilityId`: the responsibility

Result: `{ item }`.

#### `submission.list`

The submissions recorded for a task, in ID order, visible exactly as `submission.get`: the owner sees all; an agent that may read the task sees the ones it made and the ones it was asked to review (a reviewer sees only the submission its review request names). A task the caller may not read is `not_found`. A listing is not a feed: IDs are hash-ordered, so new records can land before a cursor you hold and pages are not a stable snapshot; page through to collect, do not poll for news.

Arguments:

- `taskId`: the task
- `kind` (optional): `code`, `review`, `qa`, `document` or `signoff`
- `limit` (optional): 1 to 100, default 50
- `after` (optional): the `next` of the previous page (an opaque cursor bound to you and this task; any other value is `invalid_command`)

Result: `{ items, next?, scanLimited? }`; `scanLimited` means the search stopped before the end: ask again with `next`.

#### `submission.get`

One submission record. The owner reads any; an agent needs to read the submission's task (task read, and with a task credential only that task) and to have made the submission or been asked to review it; anyone else gets not found.

Arguments:

- `submissionId`: the submission's ID (`id` of `submission.record`)

Result: `{ item }`: the submission with its revision.

#### `release.gate`

Owner only: where each platform of a candidate stands (passed, failed, interrupted, running, missing) and whether the release is ready and approved.

Arguments:

- `candidateId`: the candidate

Result: `{ gate }`.

#### `release.attempts`

Owner only: the attempts of a candidate with their evidence, oldest first.

Arguments:

- `candidateId`: the candidate

Result: `{ attempts }`.

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

#### `escalation.ladder.set`

The owner sets how long a stall concern waits undecided at each level of the supervisor ladder (owner only): a stuck agent's concern goes to its supervisor first and, undecided after the level's time, to that supervisor's supervisor, and so on up to the owner. `hours` lists whole hours from 1 to 720 (30 days) for level 0 (the first supervisor), level 1 and so on, at most 16 levels; a level the list does not name waits 24 hours. The list replaces the earlier one; an empty list clears it. It counts from the next pass; a wait already running uses the new figure for its level.

Arguments:

- `hours`: for example `[24, 48]`
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `agreed.limits.change`

The owner sets or clears ceilings on agreed raises and grants (owner only; none by default). `set` has any of `raiseMaxCostMicros` (most money one raise carried out by the approval policy may add, in millionths, 1 to 1e15), `raiseMaxComputeMs` (most compute time one such raise may add, 1 to 1e12 ms) and `grantMaxDays` (longest a right granted by a decision may last, 1 to 3650); `unset` lists ceilings to remove. A ceiling counts from the next carry-out; the rights re-check at carry-out and every other check stay.

Arguments:

- `set` (optional): for example `{ "grantMaxDays": 90 }`
- `unset` (optional): ceiling names to remove
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `resume.settings.set`

The owner sets how many blocked rounds a stalled resume check retries before the owner is told (owner only): `maxRounds` is a whole number from 1 to 10, or null to clear it so the default (3) applies. It counts for checks started afterwards; a check already running keeps the figure it started with. This is the form the chat uses.

Arguments:

- `maxRounds`: 1 to 10, or null to clear
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `project.branches.change`

The owner protects more branches of a project or takes named ones off the list, leaving the others as they are (owner only). This is the form the chat uses, so a request that waits to be accepted does only what it says. Taking off a branch from a project still on the default list writes the default out first, so the other default stays protected.

Arguments:

- `project`: the project ID
- `add` (optional): branch names or prefixes such as `release/*` to protect
- `remove` (optional): branch names or prefixes to stop protecting
- `landing` (optional): the landing branch, or null to clear it
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.set`

The owner sets what one local agent may use (owner only): `limits` has any of `cpus` (1 to 256), `memoryMb` (16 to 4194304), `diskMb` (1 to 16777216) and `processes` (1 to 100000), whole numbers. The object replaces the earlier setting; an empty object clears it so the start-up figures apply. It counts from the next agent launched; agents already running keep their limits. The host enforces the limits or refuses to launch.

Arguments:

- `limits`: for example `{ "memoryMb": 4096, "processes": 256 }`
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.change`

The owner changes some of the limits for local agents, leaving the others as they are (owner only): `set` has any of `cpus`, `memoryMb`, `diskMb`, `processes` (same bounds as `workers.limits.set`) and `unset` lists figures to clear so the start-up figure applies. This is the form the chat uses, so a request that waits to be accepted does only what it says and keeps a figure changed meanwhile. It counts from the next agent launched.

Arguments:

- `set` (optional): for example `{ "memoryMb": 4096 }`
- `unset` (optional): figure names to clear, for example `["processes"]`
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `dispatch.limits.change`

The owner changes the dispatcher's limits (owner only), leaving the others as they are: `attemptMinutes` (1 to 525600: how long an attempt may run) and `maxAttempts` (1 to 1000: attempts admitted after a lost one). Both are off by default. `set` turns the named limits on with a figure (a null figure turns the limit off), `disable` turns them off keeping the figure, `enable` turns them on again with the kept figure, `unset` forgets the entry so the start-up option or no limit applies. A task's contract `maxMinutes`/`maxAttempts` still applies. It counts from the next attempt claimed or re-admitted; an attempt already running keeps the expiry it was given. This is the form the chat uses.

Arguments:

- `set` (optional): for example `{ "attemptMinutes": 240, "maxAttempts": 3 }`
- `enable` (optional): limit names to turn on again
- `disable` (optional): limit names to turn off
- `unset` (optional): limit names to forget
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `events.sources.set`

The owner names the event sources to leave off (owner only); the list replaces the earlier one and an empty list turns all on. Each must be a source this controller has. A source not listed, including one added later, is watched. A turned-off source is not polled from the next tick and keeps its saved position, so what happened meanwhile is reported when it is turned on again.

Arguments:

- `disabled`: source IDs to leave off, for example `["service-health"]`
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision, warning? }`: `warning` says when a source turned off will lose events older than its window. A source the controller relies on (critical) cannot be turned off.

Completion: finished when accepted (`completed: true`).

#### `events.sources.change`

The owner turns event sources off or on, leaving the others as they are (owner only). `disable` must name sources this controller has; `enable` may also clear an old entry. This is the form the chat uses, so a request that waits to be accepted does only what it says.

Arguments:

- `disable` (optional): source IDs to turn off
- `enable` (optional): source IDs to turn on

Result: `{ revision, warning? }`: `warning` says when a source turned off will lose events older than its window. A critical source cannot be turned off.

Completion: finished when accepted (`completed: true`).

#### `catalog.revoke`

The owner withdraws a catalogue version for good (owner only): no new run of it starts. `runningCalls` says what happens to calls of it that are running now: `finish` lets them end on the bytes they started with, `cancel` aborts them and they end as failed. Chat asks the owner which, listing the calls; a caller that gives none (nobody was asked) gets `finish`. `finish` cannot be changed to `cancel` later: a version is revoked once, and a second revoke is refused. `cancel` reaches every running call of the version at the moment it is carried out, including calls that started between the preview and the acceptance.

Arguments:

- `name`: the canonical tool name
- `version`: major.minor.patch
- `reason`: why it is withdrawn
- `runningCalls` (optional): `finish` or `cancel`; default `finish`

Result: `{}`; a repeat with the same commandId and the same arguments answers again, with a different `runningCalls` it is a conflict.

Completion: finished when accepted (`completed: true`).

#### `command.run`

Runs a typed command as the caller (card T09b). `/nimblenewt.<operation>` names a state-API operation with its dots written as hyphens, for example `/nimblenewt.grant-list {"grantee": "service:dispatcher"}`: the arguments are a JSON object after the name, and the operation runs under the caller's own rights, so it refuses what the caller may not do. The command is queued with what it resolved to and runs once; sending the same command ID again answers from the record. A name that is unknown, ambiguous or needs a context is answered in words and nothing runs. Toolbox and agent commands are queued and answered as not runnable yet.

Arguments:

- `typed`: the command text, starting with `/`
- `context` (optional): `{ agent?, scope?, version? }` for `/agent.` and `/custom.` shortcuts

Result: `{ status }`: `done` (with `answer`), `failed` (with `error`), `unsupported`, or, when nothing was queued, `ambiguous`, `needs_context`, `unknown` or `refused` with the reason. `command` names the operation and `queued` the record.

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

#### `work.end`

An agent ends its own attempt: it is frozen at once, the calls in flight settle, and the controller then finishes the attempt with the result. With `submit` the attempt's changes are offered for landing (refused when the landing branch moved and changed files you changed). Only the attempt's own agent may call it (a credential scoped to another task cannot); it is unavailable while the task is paused, stopped or suspended, and an owner's stop drops it. Asking again for the same ending returns the recorded one. If your turn ends first, the ending is completed with your result.

Arguments:

- `attemptId`: your attempt
- `submit` (optional): true to offer your changes for landing
- `result` (optional): `done` (default), `blocked`, `partial` or `abandoned`
- `note` (optional): up to 1,000 characters
- `message` (optional): up to 2,000 characters for your supervisor
- `commandId`: required

Result: `{ item }`: the ending (state, result, replayed).

Completion: finished when accepted (`completed: true`).

#### `note.write`

Writes a shared working note on the caller's own desk: what the agent is doing, a decision with its reason, a measurement or hand-off state, for its project to read while the work is not yet in the codebase. A text that looks like a credential is refused.

Arguments:

- `projectId`: the project
- `taskId` (optional): the task it concerns
- `category`: `status`, `decision`, `measurement` or `handoff`
- `title`: up to 200 characters
- `body`: up to 8,000 characters
- `reason` (optional): required for a decision

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `note.revise`

Revises one of the caller's own notes (the revision you read must still be current). Every revision is kept.

Arguments:

- `noteId`: the note
- `expectedRevision`: the revision you read
- `title` (optional): new title
- `body` (optional): new body
- `reason` (optional): why

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `note.visibility`

Marks one of the caller's own notes private again, or shared.

Arguments:

- `noteId`: the note
- `expectedRevision`: the revision you read
- `visibility`: `shared` or `private`

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.pause`

Pauses a task, an agent, a team or the installation: ordinary foreground work stops from now on; background work may go on unless `background` is `deny`. Nothing is resumed by time, a message or a meeting; only `lifecycle.resume` lifts it.

Arguments:

- `scope`: `{ kind: task|agent|team|installation, id }`
- `reason`: why, in words
- `background` (optional): `permit` (default) or `deny`

Result: `{ gateId, requestId, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.resume`

Lifts the pause on this scope only; the answer lists the gates that still hold it.

Arguments:

- `scope`: `{ kind, id }`
- `reason`: why, in words

Result: `{ gateId, requestId, stillPausedBy, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.resume-condition`

Records, ahead of time, the UTC time after which the controller lifts this scope's pause without asking again. Only the owner; the scope must be paused now; a resume or a new pause drops it.

Arguments:

- `scope`: `{ kind, id }`
- `at`: UTC time, such as `2026-11-01T08:00:00Z`

Result: `{ gateId, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.stop`

Suspends or stops a task, an agent, a team or the installation: it is paused at once, prepared inside a deadline (scoped cleanup only), and called suspended only after a durable checkpoint; a stop then ends execution. Assignments and the task goal are untouched and nothing is resumed. The first steps run now; the answer says where it stands, and `blocked` lists the choices when work will not settle.

Arguments:

- `scope`: `{ kind: task|agent|team|installation, id }`
- `mode`: `suspend` or `stop`
- `reason`: why, in words
- `deadlineMs` (optional): preparation deadline in milliseconds (default 60,000; at most one hour)
- `spendBudget` (optional): most the cleanup may spend

Result: `{ intentId, replayed, phase, outcome?, blocked? }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.force`

Force Stop: ends execution without waiting for cleanup. Explicit and recorded as forced; unresolved work is reported and the result is `recovery-required`, never a graceful stop.

Arguments:

- `scope`: `{ kind, id }`
- `reason`: why, in words

Result: `{ intentId, outcome }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.choose`

Answers a blocked suspension or stop: `wait` (more time), `restart-earlier-boundary` (the scope is never called suspended) or `force-stop`.

Arguments:

- `intentId`: the request
- `choice`: `wait`, `restart-earlier-boundary` or `force-stop`
- `extendMs` (optional): for wait, how much longer
- `reason` (optional): for force-stop, why

Result: `{ phase }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.advance`

Takes a suspension or stop as far as it can go now (call it again to go on; nothing calls it by itself after a restart yet).

Arguments:

- `intentId`: the request

Result: `{ item }`.

Completion: finished when accepted (`completed: true`).

#### `lifecycle.sweep`

Carries every unfinished suspension or stop on (owner only; nothing runs it by itself after a restart yet).

Arguments:

- none

Result: `{ advanced, failed }`.

Completion: finished when accepted (`completed: true`).

#### `routing.disable`

The owner stops new work from reaching a model, endpoint, account, provider or local service. Running work is left alone; only the owner lifts it (routing.reenable).

Arguments:

- `level`: model, endpoint, account, provider or service
- `name`: which one
- `reason`: why
- `commandId`: required

Result: `{ revision, replayed }`.

#### `routing.drain`

Planned maintenance: new work stops reaching the target now, running work may finish until `drainSeconds` from now. There is no default; you choose it.

Arguments:

- `level`: model, endpoint, account, provider or service
- `name`: which one
- `reason`: why
- `drainSeconds`: how long running work may take, in seconds
- `commandId`: required

Result: `{ revision, replayed }`.

#### `routing.cutover`

Immediate cutover: new work stops reaching the target and the running attempts on it are cancelled so their calls move to the next route. Repeat the same command to carry out what a crash left.

Arguments:

- `level`: model, endpoint, account, provider or service
- `name`: which one
- `reason`: why
- `commandId`: required

Result: `{ revision, replayed, cancelled: [{ callId, taskId, route, attempt, since }] }`.

#### `routing.reenable`

The owner lets a disabled, draining or cut-over target be used again. Probes and recoveries never do this.

Arguments:

- `level`: model, endpoint, account, provider or service
- `name`: which one
- `reason`: why
- `commandId`: required

Result: `{ revision, replayed }`.

#### `model-budget.set`

Owner only: limits what a task may use of model calls in all: money (`maxCostMicros`), tokens (`maxTokens`) and failed attempts (`maxFailedAttempts`, counted across calls, routes and rebuilt contexts). A limit left out keeps its earlier value; a limit given as null is removed (no limit; 'remove the limit' in chat). When one is reached the next call waits visibly until the owner raises it.

Arguments:

- `taskId`: the task
- `maxCostMicros` (optional): whole number, or null to remove the limit
- `maxTokens` (optional): whole number, or null to remove the limit
- `maxFailedAttempts` (optional): whole number, or null to remove the limit
- `commandId`: required

Result: `{ ok }`.

#### `routing.failback.set`

Sets how a target that failed comes back: manual, or automatic after enough good probes over enough time (and never automatically if it failed soon after its last restore).

Arguments:

- `policy`: { mode: manual|automatic, minProbes, stableSeconds, holdDownSeconds }
- `commandId`: required

Result: `{ revision, replayed }`.

#### `handoff.prepare`

Starts a prepared hand-off of a task to another agent: the task is suspended at a checkpoint, a package is collected (brief, acceptance criteria, versions, questions, work done and unfinished, next action, …), and it is ready to be completed. Nothing moves until you complete it. One at a time per task.

Arguments:

- `taskId`: the task
- `to`: { kind: "agent", id }
- `reason`: why
- `deadlineMs`: optional deadline for the suspension
- `returnAt` (optional): a temporary reassignment: when the task goes back to its current owner (a time ahead, within 30 days); the return is made if you still hold the right to control the task then
- `commandId`: required

Result: `{ id, phase, package: { sections, missing, ready }, blocked? }`.

#### `handoff.complete`

Moves the task to the recipient in one fenced step. A package with required sections missing is refused unless `acceptGaps` is true, which is recorded.

Arguments:

- `handoffId`: the hand-off
- `acceptGaps`: true to hand over an incomplete package
- `commandId`: required

Result: `{ item: { id, phase, … } }`.

#### `handoff.takeover`

Forced takeover for a task whose owner cannot prepare: Force Stop, the package as it can be collected, the move, and a recorded exception listing missing cleanup and uncertain effects.

Arguments:

- `taskId`: the task
- `to`: { kind: "agent", id }
- `reason`: why
- `commandId`: required

Result: `{ item: { id, phase, exception } }`.

#### `handoff.choose`

Answers a blocked hand-off: wait, force-takeover or cancel (the old owner keeps the task).

Arguments:

- `handoffId`: the hand-off
- `choice`: wait, force-takeover or cancel
- `reason`: why (for a takeover)
- `commandId`: required

Result: `{ item }`.

#### `handoff.cancel`

Ends a hand-off that has not moved the task; the old owner keeps it and a hold the hand-off added is lifted.

Arguments:

- `handoffId`: the hand-off
- `commandId`: required

Result: `{ item }`.

#### `handoff.advance`

Takes a hand-off as far as it can go now (safe to repeat).

Arguments:

- `handoffId`: the hand-off
- `commandId`: required

Result: `{ item }`.

#### `handoff.sweep`

Owner only: carries unfinished hand-offs on after a restart.

Arguments:

- `commandId`: required

Result: `{ advanced: [id], failed: [id] }`.

#### `resume.start`

Begins a checked resume of a task from its latest complete continuation: the recorded dependencies are verified against what is true now, each change is reviewed, and the resume waits for `resume.commit`. Missing critical context, earlier effects of unknown outcome and a failed review stop it with a reason.

Arguments:

- `taskId`: the task
- `model`: { provider, id } the resume will run on
- `previousModel` (optional): { provider, id } it ran on before
- `after`: restart, model-change or continue
- `commandId`: required

Result: `{ item: { id, phase, delta, verdicts, blocked? } }`.

#### `resume.commit`

Commits a ready resume: the inputs are checked once more, and if anything changed since the review the check starts over (and stops as a blocker after three rounds). Otherwise the resume is recorded with how the context came back and what that cannot promise.

Arguments:

- `checkId`: the check
- `restoredBy` (optional): native-restore, reconstruction or restart
- `limits` (optional): what the restoration cannot promise, as short statements
- `commandId`: required

Result: `{ item }`.

#### `resume.retry`

Starts a blocked resume check over once the reason has been dealt with.

Arguments:

- `checkId`: the check
- `commandId`: required

Result: `{ item }`.

#### `resume.cancel`

Cancels a resume check that has not been committed.

Arguments:

- `checkId`: the check
- `commandId`: required

Result: `{ item }`.

#### `resume.advance`

Takes a resume check as far as it can go now (safe to repeat).

Arguments:

- `checkId`: the check
- `commandId`: required

Result: `{ item }`.

#### `resume.sweep`

Owner only: carries unfinished resume checks on after a restart.

Arguments:

- `commandId`: required

Result: `{ advanced: [id], failed: [id] }`.

#### `activity.record`

Appends a step to a task's activity record with the exact context it used. Sensitive content goes in `payload` (stored apart, redacted, readable only with history rights); a missing manifest or payload is marked missing, never left silent.

Arguments:

- `taskId`: the task
- `kind`: owner-message, agent-message, instruction, source-retrieved, model-selected, harness-selected, tool-call, approval, artifact-version, compression, branch, meeting-decision, lifecycle or ownership
- `summary`: one line
- `manifest` (optional): { refs: [{ kind, id, version? }], summaryId? } or { missing: true, reason }
- `payload` (optional): { text, sensitive? } or { missing: true, reason }
- `commandId`: required

Result: `{ id, seq, replayed }`.

#### `activity.explain`

Explains a choice as it is made: the choice, the alternatives considered and why not, the key evidence, and what is uncertain. Statements to a person; provider thinking is refused.

Arguments:

- `taskId`: the task
- `seq` (optional): the step it explains
- `choice`: what was chosen
- `alternatives`: [{ option, whyNot }]
- `evidence`: [{ statement, ref? }]
- `uncertainty`: what is uncertain
- `commandId`: required

Result: `{ id, replayed }`.

#### `activity.explain-later`

Asks for an explanation of a step after the fact. It is labelled retrospective, built only from the records, and says so when they cannot explain.

Arguments:

- `taskId`: the task
- `seq`: the step
- `commandId`: required

Result: `{ id, replayed, explanation }`.

#### `activity.correct`

Appends a correction to a step. The step is never changed; the correction keeps who and when.

Arguments:

- `taskId`: the task
- `seq`: the step
- `note`: the correction
- `commandId`: required

Result: `{ id, replayed }`.

#### `activity.unavailable`

Owner only: marks a range of steps as no longer available (archived, deleted, lost). They stay listed; their content is withheld.

Arguments:

- `taskId`: the task
- `first`: first step
- `last`: last step
- `reason`: why
- `commandId`: required

Result: `{ replayed }`.

#### `meeting.record.open`

Opens the record of a live meeting that is still planned (owner, host, service or meeting.manage in the project). The roster is the occurrence's; those it could not reach are absent. Without a chair a tie fails.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `chair`: an agent (agent:name) who chairs; none means a tie fails
- `commandId`: required

Result: `{ id, replayed }`.

#### `meeting.record.set-chair`

Changes the chair (or clears it with null).

Arguments:

- `recordId`: the meeting record's ID
- `chair`: an agent (agent:name) who chairs; none means a tie fails
- `commandId`: required

Result: `{ ok }`.

#### `meeting.record.join`

The caller joins the meeting.

Arguments:

- `recordId`: the meeting record's ID
- `commandId`: required

Result: `{ ok }`.

#### `meeting.record.leave`

The caller leaves the meeting.

Arguments:

- `recordId`: the meeting record's ID
- `commandId`: required

Result: `{ ok }`.

#### `meeting.record.append`

Adds a statement, an owner message, a ruling or a correction to the discussion. Corrections are linked updates; nothing is rewritten.

Arguments:

- `recordId`: the meeting record's ID
- `kind`: statement, owner-message, ruling or correction
- `text`: the words
- `speaker`: an agent speaking (agent:name)
- `tag`: decision, action, plan, question or similar tag
- `assignee`: an agent an action or plan item is for
- `taskId`: a task this concerns
- `motionId`: the motion's ID
- `corrects`: an entry this corrects
- `overrules`: a ruling this overrules
- `answers`: a question this answers
- `sources`: records the words rest on
- `commandId`: required

Result: `{ id, seq, replayed }`.

#### `meeting.record.move`

Makes a motion, optionally with proposed task changes.

Arguments:

- `recordId`: the meeting record's ID
- `text`: the words
- `topic`: the topic
- `agendaItemId`: the agenda item discussed
- `changes`: proposed changes to tasks (applied only if adopted and allowed)
- `sources`: records the words rest on
- `commandId`: required

Result: `{ id, replayed }`.

#### `meeting.record.amend`

Amends a motion; a material amendment restarts any vote.

Arguments:

- `motionId`: the motion's ID
- `expectedVersion`: the motion version you read
- `text`: the words
- `material`: true if the change alters what is voted on
- `changes`: proposed changes to tasks (applied only if adopted and allowed)
- `commandId`: required

Result: `{ version }`.

#### `meeting.record.table`

Tables a motion.

Arguments:

- `motionId`: the motion's ID
- `reason`: why
- `commandId`: required

Result: `{ ok }`.

#### `meeting.record.open-vote`

Opens the vote on a motion version.

Arguments:

- `motionId`: the motion's ID
- `expectedVersion`: the motion version you read
- `limitMinutes`: how long the vote stays open
- `commandId`: required

Result: `{ closesAt }`.

#### `meeting.record.cast-ballot`

Casts or revises a ballot, with a reason.

Arguments:

- `motionId`: the motion's ID
- `version`: the motion version voted on
- `value`: yes, no or abstain (casting vote: yes or no)
- `reason`: why
- `sources`: records the words rest on
- `ownerMessageEntryId`: the owner's message this vote follows
- `commandId`: required

Result: `{ revised }`.

#### `meeting.record.close-vote`

Counts the vote and closes it.

Arguments:

- `motionId`: the motion's ID
- `commandId`: required

Result: `{ state, decisionId? }`.

#### `meeting.record.casting-vote`

The chair breaks a tie.

Arguments:

- `motionId`: the motion's ID
- `value`: yes, no or abstain (casting vote: yes or no)
- `reason`: why
- `commandId`: required

Result: `{ state, decisionId? }`.

#### `meeting.record.apply`

Applies an adopted decision's changes with expected revisions; a target that moved is reported as not applied.

Arguments:

- `decisionId`: the decision's ID
- `commandId`: required

Result: `{ applied, notApplied, pending }`.

#### `meeting.record.owner-respond`

The owner agrees, declines or answers with an alternative to a decision that needs them.

Arguments:

- `decisionId`: the decision's ID
- `response`: agree, decline or alternative
- `alternative`: the owner's own decision instead
- `commandId`: required

Result: `{ ownerDecisionId?, applied? }`.

#### `meeting.record.finish`

Ends the meeting; an interrupted meeting voids open votes and keeps the record.

Arguments:

- `recordId`: the meeting record's ID
- `interrupted`: true if the meeting was cut short
- `reason`: why
- `commandId`: required

Result: `{ voided }`.

#### `meeting.record.summarize`

Builds the summary from the record alone.

Arguments:

- `recordId`: the meeting record's ID
- `commandId`: required

Result: `{ builds, overviewFailed? }`.

#### `meeting.record.outcomes`

Returns the outcomes to the conversations they came from.

Arguments:

- `recordId`: the meeting record's ID
- `commandId`: required

Result: `{ returned, pending }`.

#### `meeting.record.sweep`

Closes votes past their time, breaks or fails ties and finishes abandoned meetings in a project.

Arguments:

- `projectId`: the project
- `commandId`: required

Result: `{ closed, tied, failedTies, interrupted }`.

#### `meeting.attend.open-room`

Opens the room for a planned meeting: a bounded meeting task under a task-scoped pause for each attendee.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `requireAll`: { timeoutMinutes } to wait for everyone
- `commandId`: required

Result: `{ roomId, replayed }`.

#### `meeting.attend.call-now`

Starts an immediate meeting with the available participants of the project or a named team.

Arguments:

- `projectId`: the project
- `title`: the meeting's title
- `reason`: why
- `scope`: { kind: project } or { kind: team, teamId }
- `requireAll`: { timeoutMinutes } to wait for everyone
- `durationMinutes`: planned length
- `commandId`: required

Result: the room.

#### `meeting.attend.begin`

Starts the discussion with whoever is present; with 'everyone required' waits for the rest until the timeout.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `commandId`: required

Result: `{ startedWith, missing, fullAttendance }`.

#### `meeting.attend.prepare`

Asks an agent to reach a safe boundary before the meeting.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `interrupted`: tasks the agent interrupted
- `commandId`: required

Result: `{ state, waitingOn }`.

#### `meeting.attend.blocked`

Says an agent cannot attend, or can again.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `blocked`: true if the agent cannot come
- `reason`: why
- `commandId`: required

Result: `{ ok }`.

#### `meeting.attend.join`

An agent joins the room; its ownership and background work stay as they are.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `commandId`: required

Result: `{ joined, state, meetingTaskId?, waitingOn }`.

#### `meeting.attend.join-owner`

The owner joins the room.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `commandId`: required

Result: `{ replayed }`.

#### `meeting.attend.wake`

The owner authorizes waking a suspended or stopped agent for this meeting.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `commandId`: required

Result: `{ ok }`.

#### `meeting.attend.leave`

An agent leaves the room.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `commandId`: required

Result: `{ ok }`.

#### `meeting.attend.keep-paused`

Keeps a task paused after the meeting.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `taskId`: a task this concerns
- `commandId`: required

Result: `{ ok }`.

#### `meeting.attend.defer-return`

Delays the return to a task.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `taskId`: a task this concerns
- `minutes`: how long to defer the return
- `reason`: why
- `commandId`: required

Result: `{ until }`.

#### `meeting.attend.end`

Ends the meeting; attendance-only pauses are lifted and decisions that affect tasks are queued for re-checking.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `decisions`: decisions the meeting made about tasks
- `revalidateWithinMinutes`: how soon affected tasks are re-checked
- `commandId`: required

Result: the outcome.

#### `meeting.attend.return`

Returns an agent to its tasks after the meeting.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `agent`: the agent (agent:agt-…)
- `commandId`: required

Result: `{ ok }`.

#### `meeting.attend.acknowledge`

An agent says what it will do about the decisions that touch its tasks.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `all`: true to clear every pending return
- `outcome`: continue, replanned or stopping
- `note`: a short note
- `commandId`: required

Result: `{ cleared }`.

#### `meeting.attend.save-brief`

Saves an agent's brief for a meeting. A saved brief is never shown as a live answer.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID
- `text`: the words
- `commandId`: required

Result: `{ ok }`.

#### `standup.configure`

Sets up a stand-up: time, time zone, participants, duration, advance notice and the daily window it may be held in. Agents are told to reach a safe boundary before it.

Arguments:

- `projectId`: the project
- `title`: the stand-up's name
- `roster`: the agents (agent:agt-…) who take part
- `time`: the local time, HH:MM
- `windowFrom`: earliest local time it may be held
- `windowTo`: latest local time it may be held
- `timeZone`: an IANA zone such as Europe/London
- `recurrence`: how often
- `startDate`: first date
- `endDate`: last date
- `durationMinutes`: planned length
- `prepareMinutes`: how long before it agents are asked to reach a safe boundary
- `coverageHours`: how far back briefs look (about 24)
- `budgetTokens`: token allowance for the meeting
- `commandId`: required

Result: `{ scheduleId, replayed }`.

#### `standup.update`

Changes, pauses or ends a stand-up. Quote the revision you read.

Arguments:

- `scheduleId`: the stand-up schedule
- `expectedRevision`: the revision you read
- `state`: active, paused or ended
- `title`: the stand-up's name
- `roster`: the agents (agent:agt-…) who take part
- `time`: the local time, HH:MM
- `timeZone`: an IANA zone such as Europe/London
- `recurrence`: how often
- `durationMinutes`: planned length
- `prepareMinutes`: how long before it agents are asked to reach a safe boundary
- `windowFrom`: earliest local time it may be held
- `windowTo`: latest local time it may be held
- `coverageHours`: how far back briefs look (about 24)
- `commandId`: required

Result: `{ ok }`.

#### `standup.prepare`

Prepares one occurrence: notifies the agents and builds each brief from records (accomplishments over about 24 hours, unfinished work, blockers, advice needed, next priorities) without waking a paused agent.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ notified, withheld, briefs, review }`.

#### `standup.add-statement`

An agent adds advice, priorities or a note to its brief.

Arguments:

- `briefId`: the brief
- `expectedRevision`: the revision you read
- `section`: advice, priorities or note
- `text`: the statement
- `commandId`: required

Result: `{ ok }`.

#### `standup.deliver`

Delivers a project's stand-up outcomes to the conversations they came from.

Arguments:

- `projectId`: the project

Result: `{ delivered, waiting }`.

#### `watch.create`

Owner only: watches a task's stream (or its project's) so that matching events become an inbox item for the task's owner and schedule it. The controller's dispatcher keeps the watch and hands over the waiting events each tick.

Arguments:

- `stream`: `task:<id>` or `project:<id>`
- `taskId`: the task whose owner is told
- `kinds` (optional): only these event kinds
- `cooldownSeconds` (optional): least seconds between hand-overs
- `batch` (optional): most events per hand-over
- `commandId`: required

Result: `{ id, replayed }`.

#### `watch.cancel`

Owner only: ends a watch and its subscription.

Arguments:

- `watchId`: the watch
- `commandId`: required

Result: `{ ok }`.

#### `improvement.propose`

Reports friction in a tool, skill, communication or workflow, with the evidence you may share and the work it affected. Anyone with meeting.agenda may; a similar proposal is grouped, never merged.

Arguments:

- `projectId`: the project
- `title`: a short name for the friction
- `observation`: what keeps going wrong
- `possibleImprovement`: what might fix it
- `evidence`: records that show it (task, artifact or desk record of this project)
- `affectedTasks`: tasks it slowed
- `timeboxMinutes`: how long the stand-up may spend on it
- `commandId`: required

Result: `{ id, replayed }`.

#### `improvement.group`

Manager or owner: records that a proposal is another report of the same friction as an earlier one. Each proposer's evidence stays on its own record.

Arguments:

- `itemId`: the proposal
- `expectedRevision`: the revision you read
- `under`: the earlier proposal it repeats
- `underRevision`: that proposal's revision
- `commandId`: required

Result: `{ ok }`.

#### `improvement.decide`

Manager or owner: accepts, rejects or defers a proposal (accepting grants nothing; planning and authority come from the usual process). Recorded on the proposal; returning it to the proposers is not connected yet.

Arguments:

- `itemId`: the proposal
- `expectedRevision`: the revision you read
- `to`: accepted, rejected or deferred
- `reason`: why
- `nextStep`: what happens next
- `evaluation`: how the change will be judged
- `taskId`: the task made for it
- `owner`: who will do it
- `commandId`: required

Result: `{ ok }`.

#### `improvement.bring`

Manager or owner: puts a proposal on the next stand-up's agenda, timeboxed.

Arguments:

- `itemId`: the proposal
- `expectedRevision`: the revision you read
- `commandId`: required

Result: `{ agendaItemId }`.

#### `backup.now`

Owner only: takes a consistent backup of the controller database now (a backup already running is the answer).

Arguments:

- `commandId`: required

Result: `{ item: { name, createdAt, kind, schemaVersion, epoch, rows } }`.

#### `message.send`

Sends a message (or a reply) about a task. Information and advice wait for the agent's next check-in; a request or blocking message is kept for it; only an urgent one with the right can interrupt.

Arguments:

- `taskId`: the task the message is about
- `to`: the recipient (agent:agt-…)
- `class`: informational, advice, request, blocking or urgent
- `purpose`: a short reason
- `text`: the message
- `expectsReply`: an answer is expected
- `deadline`: when a reply is due
- `escalateTo`: who is told if there is no reply
- `replyTo`: the message being answered
- `correlationId`: groups related messages
- `coalesceKey`: repeated updates replace the one waiting message
- `commandId`: required

Result: `{ id, replayed, coalesced, effectiveClass, reach, woke }`.

#### `message.receive`

Marks messages as received at a boundary.

Arguments:

- `boundary`: check-in, stand-up, safe-boundary or interrupt
- `messageIds`: the messages being received
- `occurrenceId`: the meeting, for a stand-up boundary
- `commandId`: required

Result: `{ delivered, refused }`.

#### `message.handled`

Says a message has been dealt with.

Arguments:

- `messageId`: the message
- `commandId`: required

Result: `{ ok }`.

#### `message.focus`

Sets or ends an agent's focus time, when only urgent messages break in.

Arguments:

- `agent`: the agent
- `until`: when the focus ends (ISO time) or null to end it
- `reason`: why
- `commandId`: required

Result: `{ ok }`.

#### `message.ask-owner`

An agent asks the owner a question about a task it works on; the task's wait (if named) ends when the owner answers. The question is shown to the owner as untrusted content.

Arguments:

- `taskId`: the task the message is about
- `question`: what you need to know
- `waitId`: the wait that ends with the answer
- `commandId`: required

Result: `{ inquiryId, replayed }`.

#### `message.answer-owner`

Owner only: answers a question; the task's wait is resolved and the task is ready again.

Arguments:

- `inquiryId`: the question
- `answer`: the answer
- `commandId`: required

Result: `{ id, replayed }`.

#### `message.release`

Releases what is queued for an agent whose focus ended.

Arguments:

- `recipient`: the agent whose inbox

Result: `{ woken, stillQueued, downgraded }`.

#### `policy.forward`

An agent passes on a message the owner wrote in a conversation it can read, so a policy edit in it can be prepared for the owner. The edit records who wrote it and who passed it on; it is never applied on the forwarder's say-so, only the owner applies it.

Arguments:

- `threadId`: the conversation
- `seq`: the message's number in it
- `commandId`: required

Result: `{ edits: [{ editId, status }] }`.

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

#### `notifications.configure`

Owner only: sets how notifications reach the owner; only the fields given change, and they count from the next notification.

Arguments:

- `channel` (optional): inbox or external
- `channelName` (optional): the name of the external channel (needed for external)
- `digestTimes` (optional): 1 to 8 UTC times such as 09:00
- `quietHours` (optional): { start, end } UTC times, or null to remove them
- `levelByKind` (optional): { kind: notice | needs-you | urgent } for blocker, review-request, owner-question, maintenance, presence, safety-stop; null puts a kind back to its default (a safety stop stays urgent)
- `noticeRetentionDays` (optional): whole days (1 to 365) a Notice stays in the inbox before it is closed (default 7)
- `escalateAfterHours` (optional): whole hours (1 to 720) before an unanswered item is escalated; null turns escalation off (set a number again to turn it on)
- `expectedRevision` (optional): the settings revision you read (0 or absent when none were set yet)

Result: `{ revision }`.

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

#### `budget.open`

The owner gives a task a root allowance of its own: new money, in one currency, and/or compute time (owner only). The task must exist and not already be in a budget. No limit is imposed on the amount; a budget is optional and a task without one is not held back by it.

Arguments:

- `taskId`: the task
- `currency`: a currency code such as USD
- `costMicros` (optional): money, in millionths of the currency
- `computeMs` (optional): compute time in milliseconds
- `holder` (optional): the principal (owner:<name>, agent:<name>) who answers for it and may delegate from it

Result: `{ id, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `budget.raise`

The owner adds new money or compute to a task's budget and, so that nobody's available figure falls, to each budget above it (owner only). A raise the owner states here counts as agreed by the owner; no size limit applies to it.

Arguments:

- `taskId`: the task
- `costMicros` (optional): money to add, in millionths
- `computeMs` (optional): compute to add, in milliseconds

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `budget.close`

The owner closes a budget (the task it was opened on; owner only): nothing more can be reserved, delegated, requested or added, and it stops counting as open. Refused while calls still hold allowance or requests are open. It cannot be undone; closing again changes nothing.

Arguments:

- `taskId`: the task the budget was opened on

Result: `{ ok: true }`.

Completion: finished when accepted (`completed: true`).

#### `budget.aggregate.set`

The owner sets, changes, turns on or turns off an aggregate money cap (owner only; only the fields named change). It is off until set. When on, a reservation that would take the money used in the scope and period above the amount is refused, no further paid model call of a local agent is made once the money SPENT (settled and charged, not holds) has reached the amount (calls made by remote workers and by the chat and coordinator models are not gated by it; they are still bounded by their reservations), and the owner is told once per window; with it off, or never set, nothing is refused. Spending already recorded stays recorded. Only money in the cap's currency counts (default USD). Turning it on needs scope, period and amount (now or from before). Running totals are kept only once a cap has been configured; they start from a bounded scan of the ledger (marked approximate in the result when the scan was cut short) and are rebuilt whenever the cap is turned on. Money only; compute is not capped.

Arguments:

- `enabled` (optional): true to turn on, false to turn off (the figures are kept)
- `scope` (optional): installation, project (the amount applies to each project) or agent (to each agent)
- `period` (optional): day or month (UTC; the count restarts) or none (everything ever recorded)
- `amountMicros` (optional): the cap in millionths of one currency, a whole number from 0
- `currency` (optional): the currency the cap counts, such as USD (default USD)
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

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

#### `meeting.invite-direct`

The owner asks, ahead of the meeting, for a paused, suspended or stopped agent to attend it: the exception lets it in for this meeting only, with its other work staying as it was. Owner only; the agent must be on the roster.

Arguments:

- `occurrenceId`: the occurrence
- `agent`: the agent principal

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
- `integration` (optional): how finished work lands, `{ landing?, integrator?, requiredChecks?, refreshRounds? }` (owner only; otherwise the installation default or the profile's)

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
- `escalation` (optional): `{ to, afterMinutes?, afterAlerts?, note? }`

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

#### `incident.report`

Reports an alert on a responsibility: the first of a signature opens an incident, later ones add to it.

Arguments:

- `responsibilityId`: the responsibility
- `signature`: what the alert is about, for example `disk-full:web-1`
- `summary`: what was found
- `outcome`: `attention` or `failed`
- `commandId`: required

Result: `{ id, replayed }`.

#### `incident.resolve`

Resolves an open incident with the evidence that it is over.

Arguments:

- `incidentId`: the incident
- `evidence`: what shows it is resolved
- `commandId`: required

Result: `{ id, replayed }`.

#### `submission.record`

An agent records one submission in the role it holds: a code submission (author) names the base, tree and patch ID of its work, a review (reviewer), qa report (qa), document (docs) or sign-off (director) names the submission it is about. Evidence must be bound to the submitted tree or artifact. A code submission must come from the owner of the task's current attempt; a review or qa report on one's own submission is always refused; a code submission records whether review is required, and `review_disabled_single_agent` when no other agent of the project could review. Agents only. Repeating the same command ID records once.

Arguments:

- `taskId`: the task
- `kind`: `code`, `review`, `qa`, `document` or `signoff`
- `role`: the role you submit in: `author`, `reviewer`, `qa`, `docs` or `director`
- `base` (optional): code: the base commit (git object ID)
- `tree` (optional): code: the tree (git object ID)
- `patchId` (optional): code: the patch ID
- `refreshRound` (optional): code: the refresh round, default 0
- `subject` (optional): review, qa, signoff: the submission it is about
- `verdict` (optional): review: `approve`, `changes` or `reject`
- `decision` (optional): signoff: `approve` or `decline`
- `report` (optional): qa or document: the report
- `artifactDigest` (optional): document: `sha256:` and the digest
- `artifactId` (optional): document: the artifact
- `evidence` (optional): [{ check, result: `pass`, `fail` or `not_run`, boundTo }]
- `commandId`: required

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `release.submit`

Owner only: submits an immutable release candidate: source commit, built artifact hashes, dependency lock hashes, test-suite revision and the platforms (os, arch) it must pass on. The same manifest is the same candidate.

Arguments:

- `manifest`: { sourceCommit, suiteRevision, artifacts: {name: sha256}, dependencyLocks: {name: sha256}, matrix: [{os, arch, osVersion?}] }
- `commandId`: required

Result: `{ candidateId, replayed }`.

#### `release.host`

Owner only: allows (or with active=false stops allowing) a host to run destructive release tests for one platform. A machine used for production work is not authorized by that.

Arguments:

- `hostId`: the host
- `os`: linux, darwin or win32
- `arch`: x64 or arm64
- `active` (optional): false to withdraw
- `commandId`: required

Result: `{ ok }`.

#### `release.issue`

Owner only: issues the next test attempt for one platform of a candidate to an authorized host and the worker that will report. Returns the job payload. Refused while an attempt is open or after the platform passed.

Arguments:

- `candidateId`: the candidate
- `cell`: { os, arch, osVersion? }
- `hostId`: the authorized host
- `workerId`: the worker principal that will report
- `timeoutSeconds`: whole seconds
- `memoryMb`: whole megabytes
- `commandId`: required

Result: `{ attemptId, payload }`.

#### `release.report`

A release-test worker (holding `release.report`) returns the result of its attempt: what it ran against must equal the candidate exactly, or it is refused and counts for nothing. A worker cannot approve a release.

Arguments:

- `attemptId`: the attempt
- `sourceCommit`: commit tested
- `suiteRevision`: suite revision run
- `artifactHashes`: {name: sha256} of what was tested
- `dependencyLockHashes`: {name: sha256} of the locks used
- `environment`: { os, arch, osVersion? }
- `outcome`: pass or fail
- `counts`: { passed, failed, skipped }
- `logDigest`: sha256 of the log
- `summary`: short text
- `commandId`: required

Result: `{ ok }`.

#### `release.interrupt`

Owner only: ends an open attempt without a result (a worker was lost). It is never a pass; a retry is a new attempt.

Arguments:

- `attemptId`: the attempt
- `reason`: why
- `commandId`: required

Result: `{ ok }`.

#### `release.approve`

Owner only: approves a candidate for release; refused unless every platform's latest attempt passed. A worker cannot.

Arguments:

- `candidateId`: the candidate
- `commandId`: required

Result: `{ ok }`.

#### `swarm.spawn`

Makes a child task of a task you hold the budget of: it gets the outcome and acceptance criteria you give and part of the parent's allowance (it can spend only that). Refused when the parent has nothing to give, is three levels deep, or already has four live children.

Arguments:

- `parentTaskId`: the parent task
- `title`: the child's title
- `expectedResult` (optional): what the child must deliver
- `acceptanceCriteria` (optional): list of checks
- `costMicros` (optional): allowance to hand over
- `computeMs` (optional): compute allowance to hand over
- `commandId`: required

Result: `{ taskId, replayed }`.

#### `swarm.cancel`

Cancels a task's whole swarm: every child and grandchild is stopped (deepest first), what each did not use goes back to its parent, and the tasks are cancelled. Repeat it to carry on if some are still being stopped.

Arguments:

- `parentTaskId`: the parent task
- `reason`: why
- `commandId`: required

Result: `{ settled, pending }`.

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
