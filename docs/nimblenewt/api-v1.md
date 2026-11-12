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
- **Errors.** `code` is one of `invalid_command`, `command_conflict`, `stale_revision`, `not_found`, `invalid_transition`, `forbidden`, `unauthenticated`, `unavailable`, and others the operation may name. `field`, when present, points at the argument or setting at fault. Something that is not part of this contract is reported as `unavailable` with no detail.
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

#### `context.route-archive.read`

The full text of an item that was cut or left out of a task's startup context when the task moved to a route with a smaller window (the move names the item's digest). Needs the right to work on the task; anyone else gets not found.

Arguments:

- `taskId`: the task
- `digest`: the digest the cut item names

Result: `{ item: { itemId, text, digest } }`.

#### `context.note-archive.read`

The whole text of a note that was cut to fit its limit - a hand-off note, or the note telling an attempt how the calls that waited for approval were decided. The cut note names the digest of its whole text and this operation. Needs the right to work on the task the note belongs to; anyone else gets not found.

Arguments:

- `taskId`: the task the note belongs to
- `digest`: the digest the cut note names (`sha256:…`)

Result: `{ item: { taskId, attemptId?, what, digest, text } }`: `what` says which note this was, `text` is its whole text as written, credentials removed.

#### `context.handoff.read`

One hand-off note of a task: what the attempt before yours wrote when it ended, or what the controller wrote for it from the records (the first call of the attempt that follows names the note's ID, `hof-…`, and this reads it). Needs the right to work on the task; a note you may not read and one that does not exist read the same.

Arguments:

- `noteId`: the note the first call names (`hof-…`)

Result: `{ item: { id, taskId, attemptId, source, endedBecause, text } }`: `source` is `attempt` (the agent wrote it itself before ending) or `controller` (the controller wrote it when the attempt ended without one); `text` is the note as written, credentials removed.

#### `context.start-size.read`

A task's starting sizes across its hand-offs: for each attempt the size of the first call it was given, in tokens, keyed by the hand-off it started after, with its route's window, startup limit and the share of the limit used (absent, not 0, when the route's window is not known), whether the call was admitted, whether a local or a remote worker had it, what the call was made of (stored conversation, hand-off package, notes, project rules, the task's text, the rebuilt route view, system prompt and tool schemas, the rest) and the records that hold the originals. The newest 50 are kept whole and older ones rolled up (count, smallest, largest, sum). `alerts` holds the latest trend alert (the size rose over the owner's number of hand-offs in a row) and share warning (the size passed the owner's percent of the startup limit), each open or cleared; one is raised per run, not per attempt, and nothing is ever cut for it. The owner, and whoever may work on the task, may read it; anyone else gets not found.

Arguments:

- `taskId`: the task

Result: `{ item: { taskId, projectId, attempts, points, rolled?, alerts: { trend?, share? }, raised, revision, settings } }`.

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

#### `reconnect.settings.get`

Whether a worker that reconnects may take its still-owned attempt up again by itself (owner only): the owner's choice, the approval profile that gives the default (autonomous: auto; strict and derived: owner) and the one in force.

Arguments:

- none

Result: `{ item }`: `revision`, `reaccept` (auto, owner or null), `profile`, `effective`, `patienceHours` (how long an attempt waiting for you keeps its lease: a number of hours or off; 24 unless chosen) and `patienceChosen`.

Completion: finished when accepted (`completed: true`).

#### `reconnect.pending`

The attempts whose worker reconnected and waits for the owner's decision (owner only), oldest attempt ID first: attempt, placement, host, the session that asked and when it was recorded. Decide with `reconnect.reaccept`.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`: each with `attemptId`, `placement`, `hostId`, `sessionId`, `at`.

Completion: finished when accepted (`completed: true`).

#### `approval.load`

The approval load (owner only): owner decisions per day, the average wait from an ask being made to the owner's decision, how many actions ran by a rule, a standing grant, an agent review or the owner (and how many were denied), and every ask still waiting with its age. Counts come from what the dispatcher recorded; an installation whose dispatcher has recorded nothing reads as zero.

Arguments:

- `days` (optional): the window in days, 1 to 90 (default 7)

Result: `{ item }`: `days`, `perDay` (`day`, `ownerDecisions`, `agentDecisions`), `ownerDecisions`, `agentDecisions`, `averageOwnerWaitMinutes` (null when none), `decidedBy` (`rule`, `grant`, `agentReview`, `owner`, `denied`), `pending` (`reviewId`, `requester`, `tool`, `projectId`, `waitingOn`, `waitingMinutes`; longest wait first, at most 200) and `pendingCount`.

Completion: finished when accepted (`completed: true`).

#### `approval.proposals`

The standing-rule proposals (owner only): after the owner approves the same class of action for the same agent in the same project and a free environment three times, one proposal offers an expiring approval grant in their place. Each shows exactly the approvals it is drawn from, the grant accepting it would make, the lengths to choose from and the one suggested with the reason. Nothing is applied until the owner accepts.

Arguments:

- `state` (optional): open, accepted or dismissed (left out: all)

Result: `{ items }`: each with `id`, `revision` and the proposal (`requester`, `projectId`, `cls`, `environment`, `covered`, `count`, `suggestion`, `lengthOptions`, `defaultLength`, `state`, `createdAt` and, once answered, `decidedBy`, `decidedAt`, `via`, `grantId`, `reason`). At most 200.

Completion: finished when accepted (`completed: true`).

#### `approval.suggestion`

Whether the owner is due to be asked about the derived profile (owner only): a strict installation asks after every third approval the owner gives, and a seven-day trial of the derived profile asks again when it ends. Gives what may be answered (the first is the default), the approvals counted since the last answer, a plain-words preview of what would change and the revision to answer against. Never asked in the derived or autonomous profile outside a trial.

Arguments:

- none

Result: `{ item }`: `due`, `kind` (switch or trial-ended), `answers`, `approvalsSince`, `every`, `preview` and `revision`.

Completion: finished when accepted (`completed: true`).

#### `recovery.ladder.get`

Which recovery actions a stalled task's concern may take at which level of the supervisor ladder, and whether agents may take recovery steps at all (owner only).

Arguments:

- none

Result: `{ item }`: `revision`, `enabled`, `levels` (the owner's actions for level 0, 1, 2 ...; a level not listed uses the defaults), `owner` (actions at the owner's level), `minGapMinutes`, `autoStep` (whether the controller takes the next rung by itself when nobody answers), `autoStepMinutes` (the owner's time, or null), `autoStepDefaultMinutes` and `defaults`.

Completion: finished when accepted (`completed: true`).

#### `stall.concerns`

The stall concerns (a task that looks stuck) of one state the caller may read: the owner all; others those of tasks whose assignment they may read or manage, the task's own owner, its supervisor, and the supervisor a concern climbed to while it can see the task. Oldest concern ID first.

Arguments:

- `state` (optional): suspected (the default), confirmed, dismissed or cleared
- `taskId` (optional): only this task's
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`: each with `id`, `revision`, `taskId`, `projectId`, `kind`, `state`, `detail`, `route`, the holder it climbed to (`escalatedTo`, `escalationLevel`), the recovery steps taken (`recoverySteps`, `recoveryRung`, automatic ones marked `auto`) and any step in progress.

Completion: finished when accepted (`completed: true`).

#### `stall.concern.get`

One stall concern, if the caller may read it (see `stall.concerns`).

Arguments:

- `concernId`: the concern

Result: `{ item }`, as in `stall.concerns`.

Completion: finished when accepted (`completed: true`).

#### `resume.settings.get`

How many blocked rounds a stalled resume check retries before the owner is told (owner only): the owner's figure, the default and the effective one.

Arguments:

- none

Result: `{ item }`: `revision`, `maxRounds` (the owner's, or null), `default`, `effective`.

Completion: finished when accepted (`completed: true`).

#### `web.access.get`

How the web chat (the owner's chat in a phone browser) is set up and who is signed in to it (owner only): the address it listens on and the network it may be reached from, whether TLS or a TLS proxy fronts it, the host names, the trusted proxy setting (off unless the owner named a proxy), the sign-in and session limits, and the signed-in browsers (a short name such as `Safari on iPhone`, when it signed in and was last used). Nothing secret is shown: no cookie, credential, session token or pairing code. The listener's address and the trusted proxy are set when the controller starts, not here.

Arguments:

- none

Result: `{ item }`: `settings` (`url`, `host`, `port`, `network`, `tls`, `behindTlsProxy`, `publicHosts`, `trustedProxy`, `limits`, `session`) and `browsers` (each `handle`, `label`, `createdAt`, `lastSeen`). `item` is null when no web chat is running.

Completion: finished when accepted (`completed: true`).

#### `coordinator.get`

The coordinator, as the owner reads it (owner only): its principal, its model routes in the order tried (the primary first, then the fallbacks), the order the owner last gave and, when the principal is an agent record (a hosted coordinator, card U03c), the agent it runs as and where (`hosted: { agentId, host }`). For a hosted coordinator `state` is what the agent controls say now (running, paused, stopping, suspended or stopped) and `lifecycle` lists the pause gates that hold it (its own, a team's, the installation's) with what each reported (`state` is `unknown`, with no `lifecycle`, when the agent controls cannot be read: it is not claimed to be stopped; a pause made through the agent's own controls is reported reached by the coordinator when this is read); `routeSource` says where its routes come from now (`owner`, `profile`, `role` or `stored`, see `coordinator.configure`) and `profile` the agent's; pausing, stopping or resuming the agent, or a team above it, therefore changes this at once. Its grants are the agent's grants (`grant.list` with its principal) and are revoked like any agent's. `item` is null when no coordinator is set up.

Arguments:

- none

Result: `{ item }`: `id`, `revision`, `principalId`, `routes`, `explicitRoutes?`, `state` (also `unknown`), `hosted?`, `routeSource?`, `profile?`, `lifecycle?: { agent, state, profile?, heldBy: [{ scope, observed?, reason?, by? }] }`.

Completion: finished when accepted (`completed: true`).

#### `host.quiet.get`

What happens when a host stops reporting while it holds work (owner only): the owner is warned first, and the work is re-placed after a grace period unless the owner turns that off. Shows the owner's figures, the defaults and the effective ones.

Arguments:

- none

Result: `{ item }`: `revision`, `graceHours`, `autoMove`, `recoverMinutes` and `noticeHours` (the owner's, or null), `damaged` (the stored setting is damaged: automatic moves are off until `autoMove` is stated), `default` and `effective` (each `{ graceHours, autoMove, recoverMinutes, noticeHours }`).

Completion: finished when accepted (`completed: true`).

#### `workers.limits.get`

What one local agent may use (owner only): the figures the owner set, the ones from the controller's start-up configuration, and the effective limits (the owner's win per figure).

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's), `startup`, `effective`; each has any of `cpus`, `memoryMb`, `diskMb`, `processes`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.enforced`

What the launches of one local agent attempt came to (owner only): per launch (last ten) whether it started or was refused, the limits asked for, how each was enforced (full, partial or none, by what mechanism), whether best effort was allowed, the wall-clock limit, `failed` (for a refusal: the limits that could not be enforced) and `stricter` (where the host's own start-up figure was stricter than the owner's and so applied) and `environment` (the agent's environment revision the figures came from, whose each applied figure was - the agent's environment or the limits you set for all agents - and any figure the environment asked for that your limits cut: an environment can only tighten, never raise). The newest 20 attempts of each agent are kept.

Arguments:

- `attemptId`: the attempt

Result: `{ item }`: `attemptId`, `count` (all launches), `launches`.

Completion: finished when accepted (`completed: true`).

#### `cleanup.settings.get`

What happens to an attempt's scratch workspace when the attempt ends (owner only): `scratch` is the owner's entry (null when none), `default`, and the `effective` mode. `after-handoff` (the default) lets the controller order the controller-created scratch removed once the work was handed onward (submission or recorded checkpoint, settled calls, message passed on); `keep` never does. Anything an agent installed or left running is never removed: it is reported to the agent's supervisor.

Arguments:

- none

Result: `{ item: { revision, scratch, default, effective: { scratch }, damaged? } }`. A damaged record shows `damaged` and acts as `keep`.

Completion: finished when accepted (`completed: true`).

#### `dispatch.limits.get`

The dispatcher's two limits (owner only): the owner's entries (on or off, with the kept figure), the start-up options, and what applies now. Both are off (no limit) unless set.

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's entries `{ enabled, value? }` for `attemptMinutes`, `maxAttempts`), `startup`, `effective` (a figure that is absent is not limited).

Completion: finished when accepted (`completed: true`).

#### `context.route.get`

The route-change check's settings (owner only): `check` (on by default: when a task is about to run on another model route than it last ran on, the dispatcher builds its context again for that route's window, refuses to start it if what must stay whole does not fit, and otherwise puts that rebuilt context, with references to what was cut, at the end of its first prompt) and `floorChars` (the characters counted as the fixed part, system prompt and tool schemas, of a route nobody has measured yet; default 14000, 8000 for the prompt and 6000 for the tool schemas; it only sizes the cut, an unmeasured route is never refused on it: the first call on the route is checked with its real size and the owner gets a notice). Also, for the goal anchor (card W12): `anchor` (on by default: each attempt's first prompt opens with a short block the controller writes from its own records, the task's goal, acceptance criteria, what a done is checked against, the agent's own work notes, the owner's rules and the IDs of the records it was made from, and the worker puts that block again at the top of every summary that replaces a cut conversation, so an agent that has lost its place finds its goal again; that summary is a plain extract, the start and the end of what was cut, written without a model, so details from the middle may be missing; a remote machine that sets no context of its own writes it only while the anchor is on, with it off the model writes the summary again; off: no block) and `anchorChars` (the most characters the block may take, 900 to 6000, default 2400; the route's window caps it further at 4 percent of the window, always well under the reply reserve). Also, for the memory tool (card W13): `recall` (on by default: the agent may call the read-only tool task.recall to read back, from the controller's own records of its current task, its goal and plan, its own earlier notes, hand-off facts, the full text of notes that were cut, and a short digest of what was done; off: the tool answers that it is switched off) and `recallCalls` (how many calls one attempt may make, 1 to 100, default 20). Shows the entries, the defaults and what applies now.

Arguments:

- none

Result: `{ item }`: `revision`, `settings`, `defaults`, `effective` (`check`, `floorChars`; 0 is off; `anchor`, `anchorChars`, `recall`, `recallCalls`).

Completion: finished when accepted (`completed: true`).

#### `context.start-size.get`

The starting-size watch's thresholds (owner only): `risingHandoffs` (an alert when a task's starting size rises over this many hand-offs in a row; default 3, 2 to 20), `minRisePercent` (how much larger each must be to count as a rise; default 1, 0 to 100) and `warnPercent` (a warning when a first call passes this percent of its route's startup limit, before the refusal at the limit; default 80, 50 to 99). Shows the entries, the defaults, the bounds and what applies now.

Arguments:

- none

Result: `{ item }`: `revision`, `settings`, `defaults`, `bounds`, `effective`.

Completion: finished when accepted (`completed: true`).

#### `generation.stream.get`

The switches for feeding the model stream into revision-bound generation (owner only): `record` (each model call's stream is recorded against the generation it began under) and `cut` (a reply whose generation was interrupted, by a cancel, a correction or a newer generation, is held back from the worker, with the reason). Also `failClosed` (on by default; shown as `onStoreFailure` (closed or open)): when the generation store cannot answer, a call is not sent and a reply being read is cut, with the reason; off, the call and the reply go on unrecorded. Also `recordPaused` (off: a model call of a paused task is refused before it is sent; on: it is sent and recorded as a generation), `checkBridge` (on: the tool bridge refuses a call that a recorded generation shows is not a complete call of the task's current generation) and `requireRecorded` (off by default; on, the bridge also refuses a call no generation recorded). Also `bindCall` (on: a recorded call's tool name and arguments must be those of the bridge operation it is presented for), `admitCall` (on: a recorded call that writes through the bridge is admitted as an effect of its generation and settled with the operation's outcome, so a call that is not complete in a current generation can never start anything) and `requireStream` (off: a remote worker that never opened a model stream for its attempt has its bridge calls refused, on; off, the owner is only told once). And the limits `storeTimeoutMs`, `batchMs`, `batchChars` and `heldBufferBytes` (0 turns a limit off). `record`, `cut`, `failClosed` and `checkBridge` are on unless the owner turns them off; `bindCall` and `admitCall` are on unless the owner turns them off; `recordPaused`, `requireRecorded` and `requireStream` are off unless the owner turns them on.

Arguments:

- none

Result: `{ item }`: `revision`, `record`, `cut`, `failClosed`, `recordPaused`, `checkBridge`, `requireRecorded`, `bindCall`, `admitCall`, `requireStream`, `onStoreFailure`, `storeTimeoutMs`, `batchMs`, `batchChars`, `heldBufferBytes`.

Completion: finished when accepted (`completed: true`).

#### `capacity.limits.get`

The optional capacity caps (owner only): the owner's entries (on or off, with the kept figure) and what applies now. All are off (no cap) unless set.

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's entries `{ enabled, value? }` for `perProject`, `perAgent`, `fanIn`), `effective` (a figure that is absent is not capped).

Completion: finished when accepted (`completed: true`).

#### `capacity.quotas.get`

The host and global quotas (owner only): attempts that may run at once in total (`productive`) and on one host (`perHost`), the places kept for inquiries and reviews only (`control`), the most requests that may wait (`queue`), each host's declared CPUs and memory, the defaults, and what is running and waiting now.

Arguments:

- none

Result: `{ item }`: `revision`, `limits`, `defaults`, `hosts` (host ID to `{ cpus, memoryMb }`), `running` (`productive`, `control`, `perHost`), `waiting`.

Completion: finished when accepted (`completed: true`).

#### `swarm.limits.get`

The limits on spawning child tasks (owner only): `depth` (levels of children below a task that was not spawned), `liveChildren` (unfinished children of one parent at once) and `totalChildren` (the fan-in: children of one parent in all, finished ones included; absent when off), the owner's entries, the defaults and what applies now.

Arguments:

- none

Result: `{ item }`: `revision`, `limits` (the owner's entries), `defaults`, `effective` (null when the setting is damaged), `damaged`.

Completion: finished when accepted (`completed: true`).

#### `events.sources.get`

Which event sources the controller watches (owner only): every source the host configured and every source the owner defined (`events.sources.define`), with its type and whether the owner left it on, and the list of those turned off.

Arguments:

- none

Result: `{ item }`: `revision`, `disabled` (source IDs), and `sources` (`id`, `type`, `enabled`, `critical`, `defined`; a defined one also has `watches`, a short description, and `definition`).

Completion: finished when accepted (`completed: true`).

#### `catalog.running`

The owner lists the catalogue tool calls of one version that are running now (owner only), so a revocation can say what it would reach: in this controller process and in any other controller process on the same store (`elsewhere: true`). Each is named by attempt, call, task and agent, never by its input; at most 50 are listed, and `total` counts all of them. `elsewhereUnknown: true` says calls in other processes could not be checked.

Arguments:

- `name`: the canonical tool name
- `version`: major.minor.patch

Result: `{ items: [{ attemptId, callId, taskId, agentId, elsewhere? }], total, elsewhereUnknown? }`.

#### `catalog.revocations`

The owner reads the past revocations of catalogue versions (owner only), newest first: which tool and version, why, who and when. No content. `name` limits it to one tool; at most `limit` (default 50, up to 200) are listed and `total` counts all. `partial: true` says the catalogue was larger than one look through it covers, so there may be more.

Arguments:

- `name` (optional): the canonical tool name
- `limit` (optional): 1 to 200

Result: `{ items: [{ name, version, reason, revokedBy, at }], total, partial? }`.

Completion: finished when accepted (`completed: true`).

#### `catalog.policy.get`

What happens to catalogue tool calls that are running when their version is revoked and the revoke named no choice (owner only): `finish` (default), `cancel` or `pause`. Shows the owner's setting, the default and the one in force.

Arguments:

- none

Result: `{ item }`: `revision`, `runningCalls` (the owner's, or null), `damaged` (the stored setting is damaged; it reads as `cancel`), `default`, `effective`, `source` (`operator`, `setting`, `default` or `damaged`; `operator` beats the owner's setting).

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

#### `job.get`

One job (cards T07, T07b): a long-running operation tracked on its own, such as a tool an agent started through the bridge. Its state (admitted, dispatched, running, completed, failed, cancellation_requested, cancelled, outcome_unknown), kind, resumability, the end of its output (redacted), exit, orphans the stop could not end, its stop request, history and reconciliations. A task credential reads only its own task's jobs.

Arguments:

- `jobId`: the job (job-...)

Result: `{ item }` or not found.

Completion: finished when accepted (`completed: true`).

#### `job.list`

The jobs of one task, in ID order, a page at a time.

Arguments:

- `taskId`: the task
- `after` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100

Result: `{ items, next? }`.

Completion: finished when accepted (`completed: true`).

#### `job.live`

Every job that has not ended (admitted, dispatched, running, being stopped or outcome-unknown) that the caller may read, tracked exceptions left out: what a restart decides and what the owner or a supervisor may stop. Not for a task credential.

Arguments:

- `after` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100

Result: `{ items, next? }`.

Completion: finished when accepted (`completed: true`).

#### `job.unresolved`

The outcome-unknown jobs of a task: what a dependent action must wait for until each is reconciled with evidence.

Arguments:

- `taskId`: the task

Result: `{ items }`.

Completion: finished when accepted (`completed: true`).

#### `job.reconciliations`

The reconciliation records that settled an outcome-unknown job: from which state, to which, on what evidence, by whom and when.

Arguments:

- `jobId`: the job

Result: `{ items }`.

Completion: finished when accepted (`completed: true`).

#### `model-budget.get`

Owner only: a task's model limits and what it has used so far (cost, tokens, calls, failed attempts).

Arguments:

- `taskId`: the task

Result: `{ budget?, spent }`.

#### `routing.budgets`

Each model route with its context size and its length and reasoning budget (none set: the agent's runtime decides). Owner, or someone given routing.write.

Arguments:

- none

Result: `{ revision, routes: [{ route, contextTokens, maxTokens?, reasoningTokens? }] }`, by route name.

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

#### `handoff.archive.read`

The whole of a hand-off package section that was cut to fit (card C07j). A cut section begins with `[cut: N of M entries, archive <id>]` and its package lists it in `cuts`; this reads the original by that archive ID, one part at a time. Readable by the owner, whoever may control the task, and the hand-off's sender and recipient; anyone else gets not found.

Arguments:

- `archiveId`: the archive the cut marker names (`hnd-…`)
- `part` (optional): the part, from 0 (the answer says how many `parts` there are)

Result: `{ item: { archiveId, handoffId, taskId, section, entries, chars, part, parts, text, truncated? } }`: `text` is part `part`; the parts joined are the section as the source gave it (credentials removed). `truncated` is set when the section was longer than an archive keeps (1,000,000 characters) and only its start is kept.

#### `handoff.marks.get`

What the owner marked for a task's hand-offs to keep (card C07j): when a package section is cut to fit, its entries holding one of these words or IDs are kept before the newest ones. Needs the right to control the task.

Arguments:

- `taskId`: the task

Result: `{ item: { taskId, marks: [text], revision } }`.

#### `resume.get`

A resume check, with what changed, the verdicts and the history.

Arguments:

- `checkId`: the check

Result: `{ item }`.

#### `resume.for-task`

The task's current resume check (the one the dispatcher or a person started last, in any phase), or `not_found` when it has none or you may not resume the task (a host only for an attempt it runs or is pinned to).

Arguments:

- `taskId`: the task

Result: `{ item }`.

#### `continuation.latest`

The latest complete continuation of a task, for those who may work on it or read the project's histories (the owner and services too, and a host only for an attempt it runs or is pinned to), or nothing when none was captured, none was durable, or you may not read it.

Arguments:

- `taskId`: the task

Result: `{ item }` (absent when there is none).

Completion: finished when accepted (`completed: true`).

#### `resume.dependencies.get`

What a task's work recorded that it relied on, for those who may work on it or read the project's histories (and the owner and services, and a host only for an attempt it runs or is pinned to), or `not_found`.

Arguments:

- `taskId`: the task

Result: `{ item: { taskId, projectId, entries } }`.

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
- `since` (optional): only steps at or after this time (with its zone, such as 2026-11-01T08:00:00Z, or a date: midnight UTC)
- `limit` (optional): at most 100

Result: `{ steps: [{ taskId, seq, kind, summary, actor, at }], scanned, truncated }`.

#### `activity.replay.open`

Opens a task's replay: a summary first (steps by kind, outcome, branch line and actor; unavailable ranges; redacted, replaced and corrected steps), then a window of steps as they were recorded. Read only: nothing is run, sent, submitted or asked of a model.

Arguments:

- `taskId`: the task
- `from` (optional): first step number of the window (default: the newest steps the read bound allows, all of them when it is off or not reached)
- `limit` (optional): 1 to 50, default 20
- `lane` (optional): only this branch line (`main` for the main line)
- `actor` (optional): only this actor's steps
- `kind` (optional): only this kind of step
- `since` (optional): only steps at or after this time (with its zone, such as 2026-11-01T08:00:00Z, or a date: midnight UTC)
- `until` (optional): only steps at or before this time (as `since`; not before `since`)
- `withContent` (optional): true to include stored content you may read

Result: `{ taskId, projectId, summary, entries: [step | { seq, unavailable }], next?, note? }`. `summary.range` says which step numbers were read, out of how many; `next` is the NEXT step to show (pass it as `from`). A step: `{ seq, at, actor, kind, summary, lane, laneStatus (main, controller, verified or unverified; an unverified line has `laneNote`), outcome (proposed, dispatched, confirmed, uncertain or not-recorded), outcomeNote? (for example `reported by agent`: the outcome is the recorder's claim, not checked by the controller), versionsThen, authority (current or superseded), supersedes?, supersededBy?, content (size and redaction count only for a reader who may read the text), corrections, previousInLane?, nextInLane?, links }`.

#### `activity.replay.step`

One step of a replay in full: the step, the explanations written at the time and those asked for afterwards (apart, each labelled), and, for the owner, whether the model's thinking was removed by retention. Read only.

Arguments:

- `taskId`: the task
- `seq`: the step number
- `withContent` (optional): true to include stored content you may read

Result: `{ step, explanations: { contemporaneous: { label, items }, retrospective: { label, items } }, thinking? }`.

#### `activity.replay.led`

What evidence and instruction led to a step, as links: the context it was given, the evidence written at the time, the nearest earlier instructions, messages and approvals on its line, and what it replaces. Links, not reasons. Read only.

Arguments:

- `taskId`: the task
- `seq`: the step number

Result: `{ seq, links: [{ relation, kind?, id?, version?, seq?, note? }], grounded, note, scanLimited? }`; a step on a side line also links the owner's instructions on the main line.

#### `activity.replay.search`

Finds steps of a task whose summary contains some words. Stored content is not searched. Same checks as reading the steps. Read only.

Arguments:

- `taskId`: the task
- `query`: the words
- `limit` (optional): 1 to 50, default 20

Result: `{ matches: [step], scanLimited, range: { first, last, of } }`.

#### `activity.replay.export`

The whole replay of a task as data to keep: every step, gaps marked, explanations by kind. Stored content and the model's thinking are never in it. Same checks as reading the steps. Read only.

Arguments:

- `taskId`: the task

Result: `{ format, exportedAt, taskId, projectId, summary, entries, truncated: { entries, explanations }, explanations: { contemporaneous: { label, items }, retrospective: { label, items } }, content, thinking }`; `truncated` says a read bound cut it short (see `replay.limits.get`).

#### `thinking.collection.get`

Whether the model's thinking is collected from the agents' workers and kept (owner only), with the revision. On by default; what is kept is bounded, has credentials hidden, is readable only by the owner (activity.replay.thinking or the chat's thinking view) and is removed by the retention rule thinkingDays.

Arguments:

- none

Result: `{ item: { enabled, revision } }`.

#### `replay.limits.get`

How much of a task's record one replay reads (owner only): whether the bounds are on, the figures and the defaults. The bounds are generous by default and can be turned off.

Arguments:

- none

Result: `{ item }`: `revision`, `enabled`, `values` (`scan` steps, `exportPages` and `stepPages` of 100 explanations) and `defaults`.

Completion: finished when accepted (`completed: true`).

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

#### `meeting.decisions.waiting`

The adopted meeting decisions that wait for the owner's answer (agree, decline or an alternative), in ID order, with the decision's wording and topic so one can be found without its ID; owner only (not a task-scoped credential). `left` is how many changes are still to carry out (`applying` of them already started, which an answer still finishes) and `applied` how many are done. `truncated: true` means more exist than were read.

Arguments:

- `limit` (optional): 1 to 50, default 50

Result: `{ item: { items: [{ id, revision, projectId, since, left, applied, applying, text, topic? }], truncated } }`.

#### `meeting.owner-controls`

What the owner can act on in meetings (card M02h): the motions still open in meetings that are open (each with its state and version, for opening or closing a vote or tabling it), and the adopted decisions with agreed changes not yet carried out although nothing waits for the owner's answer (for carrying them out again); owner only (not a task-scoped credential). `truncated: true` means more exist than were read.

Arguments:

- `limit` (optional): 1 to 50, default 50

Result: `{ item: { meetings: [{ id, projectId, title, chair?, motions: [{ id, number, text, topic?, state, version }] }], unfinished: [{ id, projectId, text, topic?, left, applying }], truncated } }`.

#### `meeting.owner-outcomes`

The meetings whose outcomes are still to be handed back (card M05): per meeting record, the concluded motions that answer an agenda topic and are not yet returned, `deferred` on those that decided nothing (tabled, failed, no quorum, void), for returning them and asking the owner about the deferred ones; owner only (not a task-scoped credential). `truncated: true` means more exist than were read.

Arguments:

- `limit` (optional): 1 to 50, default 50

Result: `{ item: { meetings: [{ id, projectId, title, motions: [{ id, number, text, state, deferred }] }], truncated } }`.

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

#### `meeting.attend.wakes`

The owner's view of the agents woken for a meeting by the controller's own host: for each, the meeting, whether it is waiting, attending, given up on (and why) or stopped.

Arguments:

- none

Result: `{ item: [wake] }`.

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

#### `standup.owner-questions`

The questions meetings asked the owner in a project: the open ones (oldest first) and the latest answered ones, each with the topic, the words asked and, once given, the owner's answer. Needs `meeting.read`.

Arguments:

- `projectId`: the project

Result: `{ item: { open: [question], answered: [question] } }`; each question has `id`, `revision`, `topic`, `question`, `state`, `askedAt` and, when answered, `answer`.

#### `standup.agenda`

The agenda of an occurrence: conflicts, questions and decisions first.

Arguments:

- `occurrenceId`: the live meeting (occurrence) ID

Result: `{ item }`.

#### `standup.recent`

A project's stand-ups by their latest occurrence (when each ran or is planned, and that occurrence's state), most recent first. The occurrence ID is what preparing a stand-up or reading its briefs takes. Needs the right to read the project's meetings; otherwise nothing is found.

Arguments:

- `projectId`: the project
- `limit` (optional): most items, 1 to 50, default 20

Result: `{ item: { items: [{ occurrenceId, revision, title, startsAt, state, scheduleId }], more } }`.

#### `standup.list`

A project's stand-ups with their title, state (active, paused, ended), time and zone and the revision to quote when changing one. Ended ones are left out unless asked for. Needs the right to read the project's meetings; otherwise nothing is found.

Arguments:

- `projectId`: the project
- `includeEnded` (optional): also list ended stand-ups
- `endedOnly` (optional): list only the ended ones
- `limit` (optional): most items, 1 to 50, default 20

Result: `{ item: { items, more } }`.

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

#### `backup.encryption.status`

Owner only: whether backups are encrypted (off unless the host set it up), the key ID and its fingerprint (the SHA-256 of the backup public key, which the installation pins), what is pinned and what the owner approved for the next start, how many unlock methods the key has by kind, the key generation, the last proof and the last proof that worked (kept across restarts) with whether a new proof is due (every three months: `proofDue`; ask the owner to put the passcode or recovery file in place and run backup.encryption.verify), and warnings (a recovery file left on the host, a proof overdue). It never holds a passcode, a recovery key or any key material. Whether new backups are encrypted and for what (`setting`: on or off, scope `everything` or `secrets`, said in `setting.text`) is changed by the owner with backup.encryption.set. The key itself is made, an extra passcode added, and a passcode removed or replaced (which rotates to a new key, a new recovery file or printable recovery code) on the host with `backup encryption-setup`, `encryption-add-passcode` and `encryption-rotate`, because they need the passcode and recovery file, which never travel through chat; tell the owner those commands when they ask.

Arguments:

- none

Result: `{ item: { enabled, setting?: { enabled, scope, revision, changedAt?, changedBy?, text }, scope, keyId, createdAt, fingerprint, generation, proofDue, proofEveryDays, lastSuccessfulProof?, warnings, pinned?, approvedNext?, unlockMethods: { passcode, recovery }, lastProof? } }`, or `{ item: { enabled: false } }`.

#### `backup.signing.status`

Owner only: the keys that sign backups (card K01b3): each generation's key ID, public key (base64; not secret), when it was made and when it stopped signing, and when signing began. Keep a copy of the public keys OFF the server (one per line in a file) and give it to `backup verify` or `backup restore` as --trusted-signing-key-file for a check that does not depend on the running server. A valid signature shows the backup was made with the server's signing key; if the running server was compromised it could sign a forgery. The private key lives in the host's secret store and is never shown.

Arguments:

- none

Result: `{ item: { revision, since?, keys: [{ keyId, publicKey, generation, createdAt, retiredAt? }] } }`.

#### `backup.restore.preview`

Owner only: exactly what restoring a backup would do (rows, artifact files, conversation files, actions that come back uncertain, messages sent again, the steps and warnings) and the `token` that confirms it. Changes nothing and needs no secret. A restore replaces ALL current data with the backup's.

Arguments:

- `name`: the backup's name, as backup.list shows it

Result: `{ item: { token, expiresAt?, name, createdAt, kind, version, schemaVersion, encrypted, rows, artifactFiles, piStores, piFiles, piStateIncluded, piStateProblems?, changesSinceBackup?, effectsToMarkUncertain?, deliveriesToResend?, steps, warnings } }`; the token is bound to the whole backup and expires (restoreConfirmMinutes).

#### `backup.restore.status`

Owner only: whether a restore is prepared and waits for the restart, and the maintenance barrier's state.

Arguments:

- none

Result: `{ item: { pending?, barrier, markerProblem?, restart?, kept? } }`; `restart` (while a restore waits for its start) says whether the controller restarts itself and what the owner must do otherwise, with `failed` when an automatic restart failed; `pending.failed` says a start tried the swap and it was rolled back (cancel it, then prepare it again); `kept` (PostgreSQL, when any) lists the schemas earlier restores kept aside (`<schema>_br_<stamp>`, oldest first) with a note: NimbleNewt never drops them, the owner removes them by hand.

#### `database.transfer.status`

Owner only: which database the controller runs on, the databases it may be moved to (configured by the host; a PostgreSQL address holds a password and never comes from chat), the last transfer and whether it can still be rolled back.

Arguments:

- none

Result: `{ item: { source, targets: [{ name, kind, direction }], authority?, journal?, barrier } }`.

#### `database.transfer.preview`

Owner only: exactly what moving the controller database to a configured target would do: record counts per table, whether the source passes the checks (IDs, sequences, policy records, receipts, uncertain actions, timers, artifact and checkpoint references), whether the destination is empty, the right schema version and has room, and the `token` that confirms it. Changes nothing of the installation, but it OPENS the destination: a database that is new gets its empty tables created.

Arguments:

- `target`: the target's name, as database.transfer.status lists it

Result: `{ item: { token, direction, from, to, schemaVersion, rows, totalRows, bytes, bytesNeeded, freeBytes?, uncertainEffects, intendedEffects, claimsReleased, ok, findings: [{ severity, text }], steps } }`; `ok: false` means an error finding blocks the transfer.

#### `database.transfer.wipeplan`

Owner only: what removing a copy left at a transfer destination by a transfer that did not finish would do, and the `token` that confirms it. Refuses (with the reason) when the destination is empty, is the controller database, belongs to a switched transfer or cannot be emptied from here. Changes nothing.

Arguments:

- `target`: the destination's name, as database.transfer.status lists it

Result: `{ item: { token, target, leftoverOf, cleanable, findings, steps } }`.

#### `database.transfer.settings`

Owner only: whether the controller database may be moved at all (`enabled`) and whether the host restarts the controller onto the new database by itself after a move or a rollback (`restart`; `restartOffered` says whether the host can at all).

Arguments:

- none

Result: `{ item: { enabled, restart, restartOffered, revision } }`; `revision` is the one to quote in database.transfer.set.

#### `backup.list`

Owner only: the complete backups, newest first, and whether the last one failed.

Arguments:

- none

Result: `{ items: [{ name, createdAt, kind, schemaVersion, epoch, rows, piState }], status }`; `piState` says whether the agents' conversation state is in that backup ("not included" when it is not); kind `pre-restore` is the snapshot taken before a restore.

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

#### `host.local.get`

Owner only (card U14b): whether NimbleNewt starts a worker host on this computer so that agents can run here. Off until the owner turns it on. It is read when NimbleNewt starts.

Arguments:

- none

Result: `{ item: { revision, enabled, default, takesEffect } }`.

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

#### `integrator.lease.list`

The integrator leases of a project, one per branch ever leased: who holds each, its fence, when it expires and whether it is live now. Needs the right `integration.lease` on the project.

Arguments:

- `projectId`: the project
- `limit` (optional): at most this many (up to 200; default 100)

Result: `{ items: [{ leaseId, projectId, branch, holder, taskId, fence, expiresAt, state, live, ... }] }`.

#### `workspace.get`

One workspace request and what came of it.

Arguments:

- `requestId`: the request

Result: `{ item }`.

#### `status.ask`

A status view from the records, each line citing its records: `task`, `overview`, `noticeboard`, `changes`, `tools`, `delivered` (artifacts are checked against their files when the controller keeps them), `failed_events`, `failed_event`, `handoff` (the hand-off going on for a task: `{ kind: "handoff", taskId }`), `work_report` (the report an agent ended a task's attempt with, its running notes, the second agent's questions and the answers, and whether the report was found supported or not questioned, card W10: `{ kind: "work_report", taskId }`), `attempt_endings` (how each attempt of a task ended or stands, newest first, at most 6: the agent and route, when it started and ended, why its last turn stopped in plain words, the nudges to go on, the plan steps checked of how many, its stops before the work was done, the checks of its done, whether a second agent questioned its report, its waits for jobs, and the blocker it left, then the open agent_stopped_early, done_unverified and report_unsupported blockers of the task with what they say; read as the work report is, card W08: `{ kind: "attempt_endings", taskId }`; in chat the task may be named by its title), `start_size` (a task's starting sizes across its hand-offs, the alerts open on it with the trend, the largest contributors and where the originals are kept, and the watch's thresholds: `{ kind: "start_size", taskId }`; in chat the task may be named by its title), `handoff_archive` (the whole text of a hand-off package section cut to fit, a chat answer at a time: `{ kind: "handoff_archive", taskId, section?, from? }` for the task's latest hand-off, going on or finished, or `{ kind: "handoff_archive", archiveId, from? }`; without a section it lists the cuts; `from` is the line to read on from), `timeline` (a project's recent steps across its tasks: `{ kind: "timeline", projectId, agent?, since?, limit? }`), `shutdown` (whether the installation could be stopped now, owner only: `{ kind: "shutdown" }`), `setup` (owner only: the first-run walk-through, `{ kind: "setup" }`: what is set up, what is still open in the order a person sets it up, and the plain question, recommendation and meaning of declining for the next open step), `standup_questions` (what the stand-ups asked the owner: the open questions and the latest answers), `agents` (the agents with the coordinator marked and its lifecycle state, read only and under the rules of `agent.list`: `{ kind: "agents", state?, limit? }`, active agents unless state is retired, at most 50; only the owner is told which agent is the coordinator and what holds it; an agent's name is shown quoted), `database_transfer` (which database the controller runs on, where it can be moved, the last move and the restart setting, owner only: `{ kind: "database_transfer" }`), `stop_cleanup` (what the latest Suspend or Stop of a task, agent, team or the installation spent on cleanup, and how much was charged to the budgets: `{ kind: "stop_cleanup", taskId }`, or `{ kind: "stop_cleanup", scopeKind, scopeId }` (chat's flat form) or `{ kind: "stop_cleanup", scope: { kind, id } }`; in chat the task, the agent or the team may be named by its title or name, and the chat finds it; a scope with no request of its own is answered from the wider scope whose stop reaches it - its agent, a team above it, a parent task of its swarm or the installation - and the answer names that scope), `meetings` (a project's planned meetings with their rosters, and its stand-ups by their latest occurrence: `{ kind: "meetings", projectId, limit? }`), `standups` (a project's stand-ups themselves, each one two lines: the schedule as set — whether it is active, paused or ended, how often and at what time it is held, how long, how wide its window and who is on its roster — then its meetings, the one coming up and how the last one ended: `{ kind: "standups", projectId, limit? }`), `agenda` (a project's open stand-up topics in meeting order: `{ kind: "agenda", projectId, limit? }`), `decision_log` (owner only: what happened to each change a meeting decided and who allowed it: `{ kind: "decision_log", projectId?, changeKind?, outcome?, after?, limit? }`, one page of the stored log (in entry-ID order, not time order), newest first within the page, `after` continues), `explanations` (what agents wrote about their choices on a task: `{ kind: "explanations", taskId, seq?, limit? }`), `activity` (a task's recorded steps in plain lines: `{ kind: "activity", taskId, latest?, after?, limit? }`), `thinking` (owner only: what the model was thinking while it worked on a task, kept for a limited time, with `{ kind: "thinking", taskId, after?, limit? }`; shown quoted as the model's own untrusted words and each look is recorded), `replay` (step through a task's activity as it was recorded, read only: a summary with the lines of work and agents to follow and a window of steps with `{ kind: "replay", taskId, from?, limit?, lane?, agent?, stepKind?, since?, until? }` (what anyone recorded is shown quoted), or one step in full with what led to it with `{ kind: "replay", taskId, seq }`; ask for a task by its title with `taskTitle` and the chat finds the task), `owner_questions` (owner only: the questions agents have put to the owner, `{ kind: "owner_questions", limit? }`), `revocations` (owner only: the catalogue tool versions the owner revoked, newest first: which version, why, by whom and when; a closing line says when the catalogue was larger than one look covers, so there may be more: `{ kind: "revocations", name?, limit? }`), `standup_briefs` (the briefs prepared for a stand-up, or one agent's: what it did, what is unfinished, what blocks it, the advice it needs, its priorities and the notes added to it, each marked as the owner's or the agent's: `{ kind: "standup_briefs", occurrenceId, agent? }`; in chat the stand-up and the agent may be named by title and name, and the chat finds them), `retention_hold` (owner only: whether a record is kept from deletion and why, one line per reason: `{ kind: "retention_hold", recordKind, id }`; a tool version is named by its tool and version: `{ kind: "retention_hold", recordKind: "catalog-version", name, version }`), `retention` (owner only: the retention values in force and which of them the owner set, then the same state as `retention.status` as lines: the data disk's free room against the reserve, each quota class with its use and the scopes near it, the backups and the latest one, the latest deletions and retention runs, counts and record IDs only: `{ kind: "retention" }`), `web_access` (owner only: how the web chat is set up and which browsers are signed in), `event_sources` (owner only: which event sources are watched, each on or off, and what the ones the owner defined watch: `{ kind: "event_sources" }`), `capacity` (owner only: the capacity settings in force, in three groups - the optional caps (attempts at once per project, per agent and the children reporting to one supervising agent), the host and global quotas with each host's declared CPUs and memory and what runs and waits now, and the limits on spawning child tasks - each figure marked as yours or the default and an off one said to be off: `{ kind: "capacity" }`), `environment` (owner only: one agent's environment as it is now - the active revision with the shared base, the agent's own packages and their exact versions, skills and limits, a newer staged revision that waits, and why each revision was made; `{ kind: "environment", agent }` where agent is the agent principal such as agent:agt-..., or `agentName` in the owner's words), `maintenance` (owner only: the agents' requests to change their environment, what each asked for, whether it is waiting, applied, rolled back, failed or revoked and why; `maintenanceId`, `agent` or `agentName`, `status`, `limit` are optional), `release` (owner only: release testing — per candidate the gate result of each platform (pass, flaky pass, fail, interrupted, timed out, running or not run), each attempt with its state, host and time, whether the candidate is approved, and what is staged and current: `{ kind: "release", candidateId?, limit? }`), `model_routes` (owner only: the routing controls in force, how failed routes come back and which targets are down; with a target, the three facts about taking it out of service: `{ kind: "model_routes", level?, name? }`), `reconnect` (owner only: whether reconnected workers resume their attempts by themselves, where that setting comes from and how long a waiting attempt keeps its lease, and each attempt waiting for the owner's decision with its placement, host and session: `{ kind: "reconnect", limit? }`), `jobs` (owner only: the long-running jobs that have not ended, each with its state, task, kind and since when, which are outcome-unknown and wait for a reconciliation, and which a stop could not end: `{ kind: "jobs", limit? }`), `catalog_policy` (owner only: what happens to running tool calls when a version is revoked and no choice is named, where that comes from and the owner's setting: `{ kind: "catalog_policy" }`), `wakes` (owner only, card M04h: the stopped agents the controller woke for a meeting and whether each is waiting, attending, given up on or stopped by you: `{ kind: "wakes" }`), `landing` (owner only: where finished work lands, card H12s: the landing branch, whether the review gate's commit permit is required, whether the built-in protected files apply and the owner's extra protected paths, each marked as the owner's setting or the default, one policy for the whole installation: `{ kind: "landing" }`)}`), `approval_load` (owner only: the approval load - your decisions per day, how long asks waited, how many actions ran by rule, standing grant, agent review or you, every ask still waiting with its age, the standing-rule proposals waiting for your answer and whether the derived-profile question is due: `{ kind: "approval_load", days? }`, days 1 to 90, default 7) and `needs_you` (owner only: everything waiting for the owner's decision, questions, approvals, meeting decisions held for the owner and blockers, with what each holds up, ranked: what holds up the critical path the owner marked first, then what holds up the most tasks, then the oldest, then the kind, `{ kind: "needs_you", limit? }`) and `critical_path` (owner only: what the owner marked as the critical path and the decisions waiting for the owner that hold it up, `{ kind: "critical_path" }`). What the caller may not read reads as missing.

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

#### `critical.list`

Owner only: what the owner marked as the critical path (tasks, goals and projects, by ID) with the revision of the list.

Arguments:

- none

Result: `{ item: { revision, marks: [{ kind, id, markedAt }] } }`.

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

One agent record. The owner, a holder of `agent.read` or `agent.manage`, and the agent itself may ask; anyone else gets `not_found`. When the owner asks and the agent is the hosted coordinator (card U03c), the record carries a `coordinator` field (see `agent.list`).

Arguments:

- `agentId`: the agent's ID

Result: `{ item }`: the agent (friendly name, roles, team, supervisor, state, identity), with its revision, and for the hosted coordinator, to the owner only, `coordinator`.

#### `agent.list`

Agent records (needs `agent.read` or `agent.manage`). To the owner the agent that is the hosted coordinator (card U03c) is marked: its record carries `coordinator: { state, heldBy?, routeSource?, profile? }`, where `state` is what the agent controls say now (running, paused, stopping, suspended, stopped, or `unknown` when they cannot be read) and `heldBy` the pause gates holding it (scope, what was reported, reason, who). No other caller sees the field.

Arguments:

- `teamId` (optional): only this team's members
- `state` (optional): `active` or `retired`
- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

Result: `{ items, next? }`: each agent as `agent.get` shows it.

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

#### `responsibility.coverage`

The active responsibilities of a project with a coverage gap: no active holder, no recent check (none yet, or older than twice the period) or no check schedule, with how long (from when the lapse was first seen, kept: an edit of the responsibility does not move it) and whether it is beyond the alert period. A responsibility driven by event sources is not counted as having no schedule. Paged by responsibility ID; one call looks at a bounded number of records and, when it stops there, says `partial` and gives `next` to go on from. `alert.status` is `on`, `off` or `damaged` (a damaged setting is not off: set it again with coverage.settings.set). A paused or retired responsibility is not listed.

Arguments:

- `projectId`: the project
- `afterId` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100 (default 50)

Result: `{ items, next?, partial?, asOf, alert }`.

#### `coverage.settings.get`

Owner only: whether the coverage-lapse alert is on (off by default), after how many minutes of a lapse the owner is told, the default, and the revision to quote when changing it.

Arguments:

- none

Result: `{ item }`.

#### `retention.settings.get`

Owner only: the retention policy in force. Everything that deletes is off until set; every limit is optional. Gives the values you set, the installation defaults, the effective values and the revision to quote when changing them.

Arguments:

- none

Result: `{ item: { revision, settings, defaults, effective } }`.

#### `retention.status`

Owner only: the retention state: values in force, the data disk and the reserve for shutdown and recovery records, quota use with warnings, the backup counts and the latest deletions.

Arguments:

- none

Result: `{ item }`.

#### `retention.check`

Owner only: whether a record is held, and why (it then shows as retained and is never deleted). Held material is what a resumable task or a replay needs: its records, summaries, artifacts and checkpoints, its dependency records, and the tool versions it ran, pinned a call to or lists as a dependency, and the versions in the skill library of an agent's active environment or of an environment revision such a task's attempt is pinned to. The full list of holds is in `retention/references.ts` (`RetainedMaterial`).

Arguments:

- `kind`: the record kind, for example desk-record
- `id`: the record ID

Result: `{ kind, id, retained, reasons }`.

#### `retention.export`

Owner only: an export of a project's records (project, tasks, desk records, summaries, artifact metadata, archived originals, responsibility checks, stall concerns and responsibility incidents) in pages. Secrets are excluded: secret-named fields are replaced, key-shaped text is masked, and credential records are not exported.

Arguments:

- `projectId`: the project
- `after` (optional): the `next` of the previous page
- `limit` (optional): 1 to 200 (default 100)

Result: `{ projectId, items, redactions, next?, partial? }`.

#### `lease.list`

The maintenance leases of a project's managed resources: who holds each, why, until when, whether it ran out unreleased (`expired`), how many times another agent was blocked and the last few blocks (who, when, why), how a holding ended (validation result and response) and from whom a lease was taken over.

Arguments:

- `projectId`: the project
- `resourceId` (optional): only this resource

Result: `{ items }`.

#### `service.observe`

What the service reports now about one resource: its system version, its state and the time it was looked at. Needs the same right as operating on the resource.

Arguments:

- `taskId`: the task
- `service`: the service name
- `resource`: the resource name

Result: `{ systemVersion, state, observedAt }`.

#### `deliverable.record.get`

One deliverable with its newest (or the named) version: state, content, review, and the state of every version. Hidden as not found where the caller may not read it (the task's read right, narrowed or widened by the access scope).

Arguments:

- `id`: the deliverable
- `version` (optional): an older version

Result: `{ item }`.

#### `deliverable.record.list`

The deliverables of a task that the caller may read, in creation order (at most 100 per task).

Arguments:

- `taskId`: the task

Result: `{ items }`.

#### `deliverable.record.events`

The events of a deliverable in order: draft, submitted, under-review, accepted, rejected, superseded and invalidated, each with its version, who and when. History is never rewritten.

Arguments:

- `id`: the deliverable
- `after` (optional): the `next` of the previous page
- `limit` (optional): 1 to 100, default 50

Result: `{ items, next? }`.

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

#### `release.settings.get`

Owner only: who besides the owner may start and cancel release tests: agents holding the QA role, and their supervisors. What is set, what counts now (an unset field takes the installation profile's default: owner only in the strict profile, both on in the derived and autonomous ones) and the revision.

Arguments:

- none

Result: `{ item: { revision, set, effective: { qaAgents, bosses, qaRole, startsPerHour, qaAgentIds? }, profile } }`.

#### `release.gate`

Owner only: where each platform of a candidate stands (passed, failed, interrupted, timed_out, running, missing) from all of its attempts, any platform that passed only after failing (`flaky`, with the earlier failures beside the pass), and whether the release is ready and approved.

Arguments:

- `candidateId`: the candidate

Result: `{ gate }`.

#### `release.attempts`

Owner only: the attempts of a candidate with their evidence, oldest first.

Arguments:

- `candidateId`: the candidate

Result: `{ attempts }`.

#### `release.status`

Owner only: the current and previous release, the last known good and whether the current release has confirmed a healthy start, releases the launcher found failing to start, an open or interrupted switch, what the launcher's pointer says now (and `diverged` when it is not the current release), the recent history, the staged releases (up to 50) and the staging settings.

Arguments:

- none

Result: `{ item }`.

#### `release.verify`

Owner only: checks the current release's files (or a named staged release's) against the manifest digest the activation record keeps, the check the launcher makes at launch. Reports every problem found (up to 10).

Arguments:

- `releaseId` (optional): default: the current release

Result: `{ releaseId, digest, ok, problems }`.

#### `release.staging.settings.get`

Owner only: whether activation needs the candidate approved (on by default), the optional cap on all staged releases together (off by default) and the revision to quote when changing them.

Arguments:

- none

Result: `{ item: { revision, requireApproval, maxStagedBytes, keepStaged, startupWindowSeconds, startFailureLevel, set } }`.

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

#### `environment.get`

An agent's environment as it is now: the active revision (the shared base, the agent's own packages with exact versions and digests, skills, limits, protected extensions), the latest revision number, and optionally one named revision. The agent itself and the owner may read it. Use it to see what an approved maintenance request changed, or what a rolled-back one left in place.

Arguments:

- `agentId`: the agent principal, such as `agent:agt-...`
- `revision` (optional): one revision to read as well (whole number)

Result: `{ item }` (`active`, `latest`, `revision`), or `item: null` when the agent has no environment or you may not read it.

Completion: finished when accepted (`completed: true`).

#### `maintenance.get`

One maintenance request in full, as a reviewer needs it: kind, class, the exact spec (package version, source, install behaviour, mount, site), its digest, the rollback plan, the decision, the recorded effect, any pending reason, and `review`: a summary derived from the record (exact change, source, digest, access, install behaviour, rollback plan, whether it can be undone, `requesterClaims` naming what only the requester says, and a `warning` when shown text was cleaned of invisible characters or secrets; it describes the request and never judges it safe). The requester, its supervisor and the owner may read it.

Arguments:

- `maintenanceId`: the request

Result: `{ item }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.list`

Maintenance requests the caller may read (the owner all; an agent its own and its reports'), oldest first, optionally by `status` or `agentId`.

Arguments:

- `status` (optional): pending, approved, applying, applied, rejected, withdrawn, failed, revoking or revoked
- `agentId` (optional): one agent
- `after` (optional): the `next` of the last page
- `limit` (optional): 1 to 200 (default 50)

Result: `{ items, next? }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.settings.get`

Owner only: the maintenance settings: `requests` (agents may ask; default on), `bosses` (supervisors may decide what is not protected; default off in the strict profile, on otherwise), `rules` (the preapproved catalogue and allowed sites approve by themselves; default on), per-site rules and the preapproved catalogue; what counts now, the profile and the revision.

Arguments:

- none

Result: `{ item: { revision, set, effective, profile } }`.

Completion: finished when accepted (`completed: true`).

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
- `idleDays` (optional): whole days the grant may go unused before it lapses; each use renews it (card A07h)

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

The owner says which branches of a project are protected and, optionally, which branch finished work lands on (owner only). A landing of the project's work goes to that branch instead of the installation's `workspace.landing.branch`. The list replaces the earlier one; the controller, not the worker, decides from it whether a push or merge touches a protected branch.

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

#### `reconnect.settings.set`

The owner enables (`auto`) or disables (`owner`) automatic re-accept of attempts by reconnected workers (owner only), or clears the choice with null so the approval profile decides. With `owner`, a reconnected worker's attempt waits until `reconnect.reaccept` approves it. It counts from the next decision. This is the form the chat uses.

Arguments:

- `reaccept` (optional): auto, owner or null (left out: unchanged)
- `confirmWindowMinutes` (optional): how many minutes a remote worker's heartbeats are accepted before it has confirmed its dispatch contract (a slow sandbox start, or after a restart with a changed recipe): 1 to 1440, or null for the attempt lease (left out: unchanged)
- `patienceHours` (optional): how many hours an attempt that waits for your decision keeps its lease, so moving it does not race your decision: a number above 0, off, or null for the default of 24 (left out: unchanged)
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `reconnect.reaccept`

The owner decides on an attempt whose worker reconnected and waits for approval (owner only): `approve` lets that worker's next accept in its current session succeed, `stop` ends the attempt so the worker is fenced. The decision is for the named placement and for the session that asked (take both from `reconnect.pending`); if a newer session asked meanwhile it is refused (`fenced`) and nothing is approved. A repeat of the same command ID returns the recorded result.

Arguments:

- `attemptId`: the attempt
- `placement`: its current placement number
- `sessionId`: the worker session that asked, from reconnect.pending
- `waitingSince` (optional): when the waiting was recorded, from reconnect.pending (refused if it was recorded again since)
- `decision`: approve or stop

Result: `{ state }`: approved or stopped.

Completion: finished when accepted (`completed: true`).

#### `approval.proposals.check`

The owner has the controller look for repeated approvals now and open a standing-rule proposal for each class of action approved three times (owner only). Changes nothing else; a proposal already open or dismissed for a while is not opened again.

Arguments:

- none

Result: `{ opened }`: the IDs of the proposals opened.

Completion: finished when accepted (`completed: true`).

#### `approval.proposal.accept`

The owner accepts a standing-rule proposal (owner only): the suggested approval grant is made for the requester, scoped to the project and environment and lapsing after the length chosen, or, with `switchProfile`, the installation moves to the derived profile instead (permanent or a seven-day trial) and no grant is made. The length is `days` (1, 7, 30 or 90), or what the owner said in words (`statedDays`, `oneOff`), else the one the proposal showed. A repeat of the same command ID makes no second grant.

Arguments:

- `proposalId`: the proposal, from approval.proposals
- `expectedRevision`: its revision, from approval.proposals
- `days` (optional): one of the lengths the proposal offers: 1, 7, 30 or 90
- `statedDays` (optional): a length the owner stated in words, 1 to 3650 (used as stated, at most 90)
- `oneOff` (optional): true for work the owner called one-off (the shortest length)
- `switchProfile` (optional): permanent or trial: answer by switching a strict installation to the derived profile instead of making the grant

Result: `{ grantId, days, why }`, or `{ switched }` with `switchProfile`.

Completion: finished when accepted (`completed: true`).

#### `approval.proposal.dismiss`

The owner turns a standing-rule proposal down (owner only). The same one is not offered again for 30 days, and then only after a newer approval.

Arguments:

- `proposalId`: the proposal, from approval.proposals
- `expectedRevision`: its revision, from approval.proposals
- `reason`: why, in the owner's words (1 to 500 characters; never a credential)

Result: `{}`.

Completion: finished when accepted (`completed: true`).

#### `approval.suggestion.answer`

The owner answers the profile suggestion (owner only), only while it is due and at the revision `approval.suggestion` gave: `switch` (derived for good, the default), `trial` (derived for seven days), `not-now` (not asked again until three further approvals); after a trial `keep`, `extend` (seven more days) or `revert` (back to strict). Nothing is switched without this answer.

Arguments:

- `profileAnswer`: switch, trial, not-now, keep, extend or revert
- `expectedRevision`: the revision from approval.suggestion

Result: `{ switched, reverted }`.

Completion: finished when accepted (`completed: true`).

#### `recovery.ladder.set`

The owner sets which recovery actions a supervisor may take on a stalled task at each level of the supervisor ladder (owner only). The actions, lowest rung first, are `nudge`, `rebrief`, `pause`, `reassign`, `stop` and `hand-to-owner`; a concern climbs them one rung at a time. `levels` lists the allowed actions for level 0 (the first supervisor), level 1 and so on, at most 16 levels (an empty list clears them; unlisted levels use the defaults); `owner` lists the actions allowed while the owner holds the concern; `enabled` turns agents' recovery steps on or off; `autoStep` turns on or off the controller taking the next allowed rung by itself when the concern's holder has not answered for `autoStepMinutes` (off by default): one rung at a time, each recorded, in the holder's name and only with the holder's own rights and level list, never choosing a new holder (reassign is passed), never on a concern the owner holds, and stopping when the concern is decided, clears or is handed to the owner. Fields left out stay.

Arguments:

- `levels` (optional): for example `[["nudge"], ["nudge", "reassign"]]`
- `owner` (optional): for example `["stop"]`
- `enabled` (optional): true or false
- `minGapMinutes` (optional): the least minutes between two recovery steps by agents on one concern; 0 or null for none (the default)
- `autoStep` (optional): true or false: whether the controller takes the next rung by itself when nobody answers (default false)
- `autoStepMinutes` (optional): the minutes an unanswered concern waits before each automatic rung, 1 to 10080; null for the default (240)
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `recovery.ladder.enable`

The owner lets agents (supervisors and holders of `assignment.manage`) take recovery steps on stalled tasks within the ladder (owner only). This is the default.

Arguments:

- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `recovery.ladder.disable`

The owner stops agents taking recovery steps on stalled tasks (owner only); the owner can still take them.

Arguments:

- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `recovery.step`

Takes the next recovery step on a stall concern: `nudge` (a message to the agent), `rebrief` (a new brief), `pause` the task, `reassign` (to the agent in `to`, at once; a warning names rights the new holder lacks), `stop` the task, or `hand-to-owner`. Allowed for the supervisor it was routed to, its current holder and holders of `assignment.manage` (not the task's own owner nor the agent it is about). What an agent may take is the installation's list for the ACTOR's own level; the step is the lowest allowed rung above the last one, except that a rung the actor cannot take, or that is refused on a precondition, is passed and recorded as skipped with the reason. Pause and stop act on the concern's task (every agent working on it, not only the one the concern is about), which is why pause comes before reassign. A step that the actor has no right to is refused (forbidden) and the rung stays free; the owner may replace a pending step in one call. A step is recorded as pending first and finished after its effect, so a retry does it once; a repeat of a finished command is answered as recorded.

Arguments:

- `concernId`: the concern
- `expectedRevision`: the revision you read
- `action`: nudge, rebrief, pause, reassign, stop or hand-to-owner
- `text` (optional): the message, brief or reason (required except for hand-to-owner)
- `to` (optional): agent:<name>, for reassign only

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `stall.decide`

Answers a suspected stall concern: `confirm` (the task really is stuck) or `dismiss` (it is fine; the concern stays quiet for a while and reopens if the signal is still bad). Allowed for the owner, the supervisor it was routed to, its current holder and holders of `assignment.manage` (never the task's own owner). An answer stops the climb up the supervisor chain and the automatic recovery steps; it does not change the task or its assignment.

Arguments:

- `concernId`: the concern
- `expectedRevision`: the revision you read
- `decision`: confirm or dismiss
- `reason`: why, in words

Result: `{ id, revision, replayed }`.

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

#### `web.access.revoke`

The owner signs browsers out of the web chat (owner only): `all` true signs out every browser and cancels the unused pairing codes (a lost phone), or `browser` is a word from one browser's name (`iPhone`, `Firefox on Windows`) and signs out that one. No match is not_found; several matches are refused with their names so the owner says which. It takes effect on the browser's next request. This is the form the chat uses; it never signs the owner out of the terminal chat, which is a different door.

Arguments:

- `browser` (optional): words from the browser's name as the owner said them
- `all` (optional): true to sign out every browser

Result: `{ revoked, browsers, replayed? }`: how many were signed out and their names.

Completion: finished when accepted (`completed: true`).

#### `coordinator.configure`

Owner only: sets the coordinator up (without `expectedRevision`) or changes its principal and routes (with the revision `coordinator.get` showed). The chat does the same in free words. A `principalId` that is an agent record (`agent:agt-...`, an active agent) makes the coordinator a hosted agent (card U03c): it starts paused under the agent's own pause gate, which only the owner lifts (`coordinator.state` or the agent controls), and it gains no right by this. Its routes (up to four, the primary first) are optional for a hosted coordinator. The precedence for a hosted coordinator, the first that gives a route winning: the `routes` stated here (only those the routing table lets the coordinator use, in the order given: a configured route, local data, not paid, not disabled or excluded), the routing table's routes for the agent's `defaultProfile`, the routes of the coordinator role, then routes stored by an earlier set-up; `coordinator.get` says which applies (`routeSource`). Its model calls are recorded as usage of the agent (shared overhead under the rule `the coordinator's own model calls (hosted agent)`; `budget.usage` by agent), and record without ever refusing a call. To take it off its agent, set it up again with a `principalId` that is not an agent record (such as `agent:coordinator`) and `routes`: it comes back paused and held by the controller as before. A set-up refused after its pause (a concurrent change) lifts the pause it made, unless the coordinator now set up is this same agent (then the pause holds it until the owner starts it).

Arguments:

- `principalId`: the coordinator's principal: `agent:agt-...` for a hosted agent, else an agent principal such as `agent:coordinator`
- `routes` (optional): up to 4 provider route names in the order to try; needed unless the principal is an agent record
- `expectedRevision` (optional): the revision you read; leave out to set it up the first time

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `coordinator.state`

Owner only: starts (`running`), pauses (`paused`) or stops (`stopped`) the coordinator, on the revision `coordinator.get` showed. A hosted coordinator (card U03c) is started, paused and stopped through its agent's own pause gate and Stop, as for any agent; starting it lifts only its own gate, and `stillHeldBy` lists a team or the installation that still holds it. A stopped coordinator can only be started. The coordinator cannot do this for itself: it holds no right to its own agent scope.

Arguments:

- `to`: `running`, `paused` or `stopped`
- `expectedRevision`: the revision you read

Result: `{ id, revision, replayed, stillHeldBy? }`.

Completion: finished when accepted (`completed: true`).

#### `host.quiet.change`

The owner sets what happens when a host stops reporting while it holds work (owner only). `graceHours` is how long the owner has to answer the warning before the work is re-placed from its last checkpoint on another allowed host (a whole number from 1 to 720; default 12). `autoMove` false means the work is never moved by itself (the owner can still move it with host.move-work); true turns it on. `recoverMinutes` is how long a host must report without a gap before its quiet episode is over (1 to 1440; default 10), so a host that drops out and reports again is one quiet host, not many. `noticeHours` is the least time between two notices about the same host (1 to 720; default 6). `null` clears a figure to its default; a figure not named keeps its value. When the stored setting is damaged, state `autoMove` (true or false) with the change: automatic moves stay off until you do. It counts from the next pass.

Arguments:

- `graceHours` (optional): 1 to 720, or null to clear
- `autoMove` (optional): true, false, or null to clear
- `recoverMinutes` (optional): 1 to 1440, or null to clear
- `noticeHours` (optional): 1 to 720, or null to clear
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `host.move-work`

The owner moves the work off a host right away (owner only), whether or not the host is quiet and whatever the quiet-host setting says: each live attempt of the host is re-placed from its last checkpoint on another host the placement rules allow (the old host is fenced). Attempts no host can take stay where they are and are listed with the reason; at most 25 are moved per call (`more` says so). The command ID makes a repeat move nothing twice.

Arguments:

- `hostId`: the host, for example `host:build-1`

Result: `{ hostId, moved: [{ attemptId, to }], skipped: [{ attemptId, reason }], more }`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.set`

The owner sets what one local agent may use (owner only): `limits` has any of `cpus` (1 to 256), `memoryMb` (16 to 4194304), `diskMb` (1 to 16777216), `processes` (1 to 100000) and `wallTimeMs` (1000 to 604800000: how long one launch of the agent's process may run; optional, off when not set), whole numbers. The object replaces the earlier setting; an empty object clears it so the start-up figures apply. It counts from the next agent launched; agents already running keep their limits. The host enforces the limits or refuses to launch.

Arguments:

- `limits`: for example `{ "memoryMb": 4096, "processes": 256 }`
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.change`

The owner changes some of the limits for local agents, leaving the others as they are (owner only): `set` has any of `cpus`, `memoryMb`, `diskMb`, `processes`, `wallTimeMs` (same bounds as `workers.limits.set`) and `unset` lists figures to clear so the start-up figure applies. This is the form the chat uses, so a request that waits to be accepted does only what it says and keeps a figure changed meanwhile. It counts from the next agent launched.

Arguments:

- `set` (optional): for example `{ "memoryMb": 4096 }`
- `unset` (optional): figure names to clear, for example `["processes"]`
- `expectedRevision` (optional): the revision of the setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `workers.limits.besteffort`

The owner allows or forbids best effort for local agents (owner only). Off (the default): an agent whose limits (cpus, memoryMb, diskMb, processes) this operating system cannot enforce in full is not started; the refusal is recorded with the reason and names the limits that failed. Pinning to cores (taskset) counts as partial: only a cgroup scope enforces cpus in full. On: it starts anyway and the record says which limit was only partly enforced or not at all. Counts from the next agent launched. Chat: disabling applies at once (it is the safer direction); enabling is shown first.

Arguments:

- `enabled`: true to allow best effort, false to refuse
- `expectedRevision` (optional): the revision of the limits setting you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `cleanup.settings.change`

The owner changes the scratch cleanup (owner only). `set` has `scratch`: `after-handoff` or `keep`; `enable` (`["scratch"]`) is `after-handoff`; `disable` is `keep`; `unset` forgets the entry so the start-up default applies. `awaitStopHours` (1 to 8760, or null for never) is how long scratch waits for a worker to confirm it stopped before the supervisor or owner is told it is kept; `disable` is never, `enable` is 24, `unset` is the default of 24. Name each setting once. It counts from the next attempt that ends; a cleanup already decided stays as recorded. This is the form the chat uses.

Arguments:

- `set` (optional): for example `{ "scratch": "keep" }` or `{ "awaitStopHours": 48 }`
- `enable` (optional): `["scratch"]` or `["awaitStopHours"]`
- `disable` (optional): `["scratch"]` or `["awaitStopHours"]`
- `unset` (optional): `["scratch"]` or `["awaitStopHours"]`
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

#### `context.start-size.change`

The owner changes the starting-size watch's thresholds (owner only), leaving the others as they are: `set` gives figures (`risingHandoffs` 2 to 20, `minRisePercent` 0 to 100, `warnPercent` 50 to 99), `unset` returns named ones to their defaults. They count from the next first call. The watch only records and alerts; it never cuts or compacts anything.

Arguments:

- `set` (optional): for example `{ "risingHandoffs": 4, "warnPercent": 75 }`
- `unset` (optional): list of names
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `context.route.change`

The owner changes the route-change check, the goal anchor and the memory tool task.recall (owner only), leaving the others as they are: `enable` or `disable` name `check`, `floorChars` (a disabled floor counts nothing for an unmeasured route; the figure is kept) or `anchor` (the block of the task's goal, criteria and plan put at the top of each attempt's first prompt and of every summary after a cut; such a summary is a plain extract written without a model (the start and the end of what was cut), and a remote machine that sets no context of its own writes it that way only while `anchor` is on; takes effect from the next attempt's start); `recall` (whether the agent may read its own task's records back with the tool task.recall; takes effect at the agent's next call); `set` gives `floorChars` a figure (1 to 4000000), `anchorChars` one (900 to 6000) or `recallCalls` one (1 to 100, the calls an attempt may make of task.recall); `unset` returns a setting to its default. With `check` off a task that moves to another route starts as before (no rebuilt context in its first prompt), and the first call on the route is still checked by admission.

Arguments:

- `enable` (optional): list of `check`, `floorChars`, `anchor`, `recall`
- `disable` (optional): list of `check`, `floorChars`, `anchor`, `recall`
- `set` (optional): for example `{ "floorChars": 14000 }`, `{ "anchorChars": 2400 }` or `{ "recallCalls": 20 }`
- `unset` (optional): list of names
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `generation.stream.change`

The owner turns the model stream settings on or off (owner only), leaving the other as it is: `enable` and `disable` each name `record`, `cut`, `failClosed`, `recordPaused`, `checkBridge`, `requireRecorded`, `bindCall`, `admitCall` or `requireStream`; `set` gives the limits `storeTimeoutMs` (how long one store call may take, default 20000), `batchMs` (default 250), `batchChars` (default 2000) and `heldBufferBytes` (default 16 MB), each a whole number, 0 = off. With `record` off no stream is recorded and nothing is held back; with `cut` off the stream is still recorded and a late reply is shown as late, but it still reaches the worker. Applies from the next model call.

Arguments:

- `enable` (optional): settings to turn on: record, cut, failClosed, recordPaused, checkBridge, requireRecorded, bindCall, admitCall, requireStream
- `disable` (optional): settings to turn off: record, cut, failClosed, recordPaused, checkBridge, requireRecorded, bindCall, admitCall, requireStream
- `set` (optional): limits to set, as an object of whole numbers (0 turns one off): storeTimeoutMs, batchMs, batchChars, heldBufferBytes
- `expectedRevision` (optional): the revision read with generation.stream.get; a different current one refuses the change

Result: `{ revision }`.

#### `capacity.limits.change`

The owner changes the optional capacity caps (owner only), leaving the others as they are: `perProject` (attempts running at once for one project), `perAgent` (for one agent) and `fanIn` (running child attempts whose parent task is owned by one supervising agent; reviewers are not counted), each 1 to 1000. All are off by default. Work over a cap waits for capacity (it does not fail) and is served fairly; work already running is never stopped by a lower cap. `set` turns the named caps on with a figure (a null figure turns it off), `disable` turns them off keeping the figure, `enable` turns them on again with the kept figure, `unset` forgets the entry. A cap is named once. A change counts from the next admission decision and lets waiting work in at once. This is the form the chat uses.

Arguments:

- `set` (optional): for example `{ "perProject": 2, "fanIn": 3 }`
- `enable` (optional): cap names to turn on again
- `disable` (optional): cap names to turn off
- `unset` (optional): cap names to forget
- `expectedRevision` (optional): the revision you read (0 when none is set)

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `capacity.quotas.change`

The owner changes the host and global quotas (owner only), leaving the others as they are: `set` names any of `productive` (1 to 64 attempts at once in total), `perHost` (1 to 16 on one host, at most `productive`), `control` (1 to 16 places only inquiries and reviews may use, so stopping, review and questions stay possible when the work is full) and `queue` (1 to 500 waiting requests); `hosts` declares hosts' CPUs and memory (a host must have them before work is placed on it). A lower figure stops nothing that runs: nothing new starts until the work is under it, and waiting requests a host can no longer hold are withdrawn with the reason; a higher one lets waiting work in at once. This is the form the chat uses.

Arguments:

- `set` (optional): for example `{ "productive": 6, "perHost": 3 }`
- `hosts` (optional): for example `{ "host:pc": { "cpus": 8, "memoryMb": 16384 } }`

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `swarm.limits.change`

The owner changes the limits on spawning child tasks (owner only), leaving the others as they are: `depth` (0 to 8 levels; 0 allows no child task at all), `liveChildren` (0 to 64 unfinished children of one parent at once; 0 allows no new child now) and `totalChildren` (1 to 1000 children of one parent in all, the fan-in; null turns that total off). Defaults: depth 3, liveChildren 4, totalChildren 16. `unset` returns a limit to its default. A lower limit cancels nothing that exists; it only refuses new children. This is the form the chat uses.

Arguments:

- `set` (optional): for example `{ "liveChildren": 2, "totalChildren": 8 }`
- `unset` (optional): limit names to return to their defaults
- `expectedRevision` (optional): the revision you read (0 when none is set)

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

#### `events.sources.define`

The owner defines an event source in settings, or replaces one they defined under the same ID (owner only): a `timer` (every `everyMinutes`, counted from now, or once `at` a time; it fires `timer.fired`), a `file` or folder on the controller's machine (`path`; `file.changed` and `file.removed` naming the path inside it, its size and modification time, never its content; `.git` and `node_modules` are skipped, symbolic links are not followed, at most 1000 files), a git `repository` (`path` of a working copy or a bare repository; `repository.changed` when a branch or tag points at another commit, read from its files) or a `service` health address (`url`, http or https with no user name or password; asked with one GET that waits 10 seconds and follows no redirect; 2xx or 3xx is healthy; `service.failed` once per failure and `service.recovered`). It reports into the project's stream, or the task's when `taskId` is given, and is polled from the next tick, starting from what is there now; file, repository and service sources are looked at every `checkSeconds` (default 60). A watch (`watch.create`) on that stream wakes the task's owner. At most 50 are defined; the ID may not be one of the host's sources.

Arguments:

- `sourceId`: a name for it (letters, digits, `.`, `-`, `:`, `_`; at most 64)
- `type`: `timer`, `file`, `repository` or `service`
- `projectId`: the project whose stream it reports into
- `taskId` (optional): report into this task's stream instead (a task of that project)
- `everyMinutes` (optional): timer: 1 to 43200
- `at` (optional): timer: a single time, not already past
- `path` (optional): file or repository: an absolute path
- `url` (optional): service: the health address
- `checkSeconds` (optional): file, repository or service: 10 to 86400

Result: `{ revision, replaced }`.

Completion: finished when accepted (`completed: true`).

#### `events.sources.remove`

The owner removes an event source they defined (owner only). It is not polled from the next tick and leaves the list of sources turned off. A source the host configured cannot be removed; it can be turned off.

Arguments:

- `sourceId`: the defined source

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `catalog.policy.change`

The owner sets the standing answer for running calls when a version is revoked with no choice named (owner only): `finish` lets them end, `cancel` aborts them, `pause` aborts each running call and pauses its task. `null` clears to the default (`finish`). It counts from the next revocation; an explicit choice on a revoke always wins, and an operator's startup option beats this setting (`source` says which applies).

Arguments:

- `runningCalls`: `finish`, `cancel`, `pause` or null to clear
- `expectedRevision` (optional): the revision you read (0 when never set); the chat fills it in for the owner

Result: `{ revision, old, new, effective, source }` (`source` as in `catalog.policy.get`).

Completion: finished when accepted (`completed: true`).

#### `catalog.revoke`

The owner withdraws a catalogue version for good (owner only): no new run of it starts. `runningCalls` says what happens to calls of it that are running now: `finish` lets them end on the bytes they started with, `cancel` aborts them and they end as failed, `pause` aborts each running call, then pauses its task (the pause stops what the agent writes until the owner resumes the task). Chat asks the owner which, listing the calls; a caller that gives none (nobody was asked) gets the standing policy in force (`catalog.policy.get`: the operator's startup option, else the owner's setting, else `finish`). `finish` cannot be changed to `cancel` or `pause` later: a version is revoked once, and a second revoke is refused. `cancel` and `pause` reach every running call of the version at the moment it is carried out, including calls that started between the preview and the acceptance.

Arguments:

- `name`: the canonical tool name
- `version`: major.minor.patch
- `reason`: why it is withdrawn
- `runningCalls` (optional): `finish`, `cancel` or `pause`; default: the standing policy in force (`catalog.policy.get`: the operator's startup option, else the owner's setting, else `finish`)

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

The owner changes how finished work lands in a project (owner only); fields left out stay. `main-automatic` is refused while the installation forbids it. In chat this is always shown first as a proposal that says in plain words what the chosen landing does to the project's work (and what gates it, read from the project's own settings); it is applied only when the owner confirms that proposal, whatever words they used to ask.

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

The owner sets what new projects start with (existing projects keep theirs) and may forbid `main-automatic` installation-wide (owner only). In chat it is shown first as a proposal that says what the chosen landing does to every new project, and applied only on the owner's confirmation of that proposal.

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

An agent ends its own attempt: it is frozen at once, the calls in flight settle, and the controller then finishes the attempt with the result. Every ending carries a `report` (card W10): what you did, found, left and could not do, built from your running notes; an ending without one is refused with your notes, and nothing is recorded. A `done` of a task whose contract names evidence or checks is checked first (card W05): the checkout holds a change against its base, its PLAN.md not counted (the agent does not commit: on the local worker its changes are committed after review; a host where the agent commits also needs the checkout committed and clean, one commit ahead, unless `submit` carries the change), every required evidence item named with a plain, non-empty file of the checkout, and the contract's check commands passing when the host runs them in the sandbox; if any fails, the call is refused with the list and the attempt goes on (a failed done counts toward the attempt's go-ons; once they are used up the attempt ends blocked with that list). A done that passes is then questioned by a second agent (no tools, no share in your conversation; it cannot approve the work) about the report against the contract: its questions refuse the call until you answer them with `work.answer` and call again (bounded rounds, not counted); a report it finds unsupported is refused with its questions and counts toward the go-ons, and once they are used up the attempt ends blocked with a blocker for the director. Without a second agent the done is taken on the checks and the report says it was not questioned. With `submit` the attempt's changes are offered for landing (refused when the landing branch moved and changed files you changed). Only the attempt's own agent may call it (a credential scoped to another task cannot); it is unavailable while the task is paused, stopped or suspended, and an owner's stop drops it. Asking again for the same ending returns the recorded one. If your turn ends first, the ending is completed with your result.

Arguments:

- `attemptId`: your attempt
- `submit` (optional): true to offer your changes for landing
- `result` (optional): `done` (default), `blocked`, `partial` or `abandoned`
- `note` (optional): up to 1,000 characters
- `message` (optional): up to 2,000 characters for your supervisor
- `evidence` (optional): list of `{ item, path }`: for each evidence item the task contract requires, the file of your checkout that holds it
- `report`: up to 4,000 characters: what you did, found, left and could not do
- `commandId`: required

Result: `{ item }`: the ending (state, result, replayed).

Completion: finished when accepted (`completed: true`).

#### `work.note`

An agent writes a running note to its own attempt as it works (card W10): `kind` did, found, left or could-not, and the text. The notes are kept with the attempt (at most 30, 600 characters each, 12,000 in all; past that a note is refused), survive a restart and a readmit, are shown back when an ending lacks a report, are part of the attempt's report and are told to the next attempt of the task. Only the attempt's own agent, while it runs; the same command again writes nothing.

Arguments:

- `attemptId`: your attempt
- `kind`: `did`, `found`, `left` or `could-not`
- `text`: up to 600 characters
- `commandId`: required

Result: `{ notes, replayed }`: how many notes the attempt holds.

Completion: finished when accepted (`completed: true`).

#### `work.answer`

An agent answers the second agent's questions about the report of its done (card W10): one answer per question of the open round, in order (at most 3, 800 characters each). Then it calls work.end done again, and the second agent reads the answers. Only the attempt's own agent, while it runs; refused when no question is open or the round is answered already; the same command again answers as before.

Arguments:

- `attemptId`: your attempt
- `answers`: list of text, one per question
- `commandId`: required

Result: `{ round, replayed }`.

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

Suspends or stops a task, an agent, a team or the installation: it is paused at once, prepared inside a deadline (scoped cleanup only), and called suspended only after a durable checkpoint; a stop then ends execution, including local processes, the work of swarm children and background jobs (a Pause leaves those running; a permitted remote job the controller tracks is named as an exception and keeps running). A process or job that will not end is listed and Force Stop is offered. Assignments and the task goal are untouched and nothing is resumed. The first steps run now; the answer says where it stands, and `blocked` lists the choices when work will not settle.

Arguments:

- `scope`: `{ kind: task|agent|team|installation, id }`
- `mode`: `suspend` or `stop`
- `reason`: why, in words
- `deadlineMs` (optional): preparation deadline in milliseconds (default 60,000; at most one hour)
- `spendBudget` (optional): most the cleanup may spend, in millionths of the budget currency (cost only; optional, no limit when left out). Whatever the cleanup and the ending cost is charged to the budgets of the tasks it served, with or without this limit

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

#### `job.cancel`

Stops a job (Stop), or with `force` asks at once or escalates a stop that was not obeyed (Force Stop, a separate recorded step). The kind decides the operation (a model request is cancelled, a tool is stopped, a remote job or MCP operation is stopped remotely); a job the controller runs ends with its whole process tree, and what could not be ended is recorded on the job as orphans. Needs job.control; a task credential stops only its own task's jobs, with job.write there.

Arguments:

- `jobId`: the job
- `reason`: why, in words
- `force` (optional): true for Force Stop

Result: `{ id, operation, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `job.decide`

The decision on a live job after a restart (card T07): `complete` it from evidence (needs `exit`), `cancel` it (the stop is then confirmed by its host), `restart` it from its tool checkpoint (only a tool that left one), or keep it as a tracked `exception` under a named `tracker`. An outcome-unknown job is settled by job.reconcile instead. The owner or a supervisor with job.control.

Arguments:

- `jobId`: the job
- `decision`: `complete`, `cancel`, `restart` or `exception`
- `reason`: why, in words
- `exit` (optional): `{ code?, signal?, reason? }` for complete
- `tracker` (optional): who tracks an exception

Result: `{ id, state, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `job.reconcile`

Settles an outcome-unknown job with the evidence found, in a record of its own: it becomes completed, failed or cancelled. Nothing is invented; the evidence is required. The owner or a supervisor with job.control.

Arguments:

- `jobId`: the job
- `to`: `completed`, `failed` or `cancelled`
- `evidence`: what shows how it ended
- `exit` (optional): `{ code?, signal?, reason? }`

Result: `{ id, reconciliationId, replayed }`.

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

#### `routing.provider.add`

Owner only (guided setup): adds or replaces model providers in one step: each with its name, where it runs (`local` or `cloud`), whether it costs money, its model server's address, the NAME of the secret that holds its key (never the key itself; the owner puts the key in the secret store on the machine), what kind of server it is (`kind`: llama-cpp, vllm, radiance, strata, openai, openai-compatible, claude or generic; an unknown kind is refused; left out, the routes' reply limit and reasoning cap are not sent on `chat/completions` and the task's activity says so), its model names and their context window. The routes `provider/model` are added to the routing table, and the `default` profile (free and local routes first) is rebuilt and given to the coordinator, the safety supervisor and the author unless the table already gives them something else. The team needs at least two routes on two different servers so that losing one does not stop it; fewer is refused in plain words and nothing is changed. Providers and routes not named stay as they are.

Arguments:

- `providers`: list of `{ name, location, endpoint, models, contextTokens, paid?, enabled?, credentialName?, kind? }`
- `expectedRevision` (optional): the routing revision you read, when the table already exists
- `commandId`: required

Result: `{ revision, replayed, providers, routes }`.

Completion: finished when accepted (`completed: true`).

#### `routing.budget.set`

The owner (or someone given routing.write) sets how long one reply of a model route may be (`maxTokens`) and how many of those tokens it may spend reasoning (`reasoningTokens`, less than maxTokens). Both go into every model call of the route from the next call on, in the field names of the route's endpoint; a reply cut off at the limit is continued in the same turn with a nudge to stop deliberating and act. A value left out keeps its earlier value; null removes it (the call then keeps what the agent's runtime asks for).

Arguments:

- `route`: the route, provider/model
- `maxTokens` (optional): whole number of tokens from 1 to 1000000 (and at most the route's context), or null to remove the limit
- `reasoningTokens` (optional): whole number of tokens from 1 to 1000000, or null to remove the cap
- `commandId`: required

Result: `{ revision, replayed, budget: { maxTokens?, reasoningTokens? } }`.

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
- `acceptGaps` (optional): true to hand over an incomplete package
- `reassignResponsibilities` (optional): IDs of the sender's responsibilities (listed in the package) to move to the recipient with the task; needs the rights to assign and write responsibilities in the project, and the recipient must be an active agent (all checked before anything moves); not with a temporary reassignment; a repeat must name the same list. Moved at once; a recipient lacking rights for a duty is warned about to the owner, naming them. A failure for one leaves it with the sender and is reported in `reassigned`
- `moveIntegratorLease` (optional): owner only: true moves the sender's integrator leases for the task (listed in the package's locks) to the recipient with a new fence; otherwise they are released when the task moves. Not with a temporary reassignment; a repeat must make the same choice. A lease that expired or changed hands meanwhile is left as it is and reported in `leasesSettled`
- `commandId`: required

Result: `{ item: { id, phase, reassign?: { ids, by, at }, reassigned?: { at, moved: [id], failed: [{ id, reason }] }, leaseMove?: { by, at }, leasePlan?: { at, entries: [{ leaseId, branch, fence, action }] }, leasesSettled?: { at, entries: [{ leaseId, branch, outcome, fence?, reason? }] }, … } }`: `reassign` is what was asked, `reassigned` what came of it (present once the task has moved); `leasePlan` the sender's lease holds read just before the move, `leasesSettled` what came of each (released, moved, or skipped when no longer the sender's).

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

#### `handoff.marks.change`

The owner marks what a task's hand-offs must keep when a package section is cut to fit (owner only, card C07j): an entry holding one of the marks (any case) is kept before the newest ones; the rest of the section stays readable through `handoff.archive.read`. `add` and `remove` take words or record IDs (3 to 200 characters, one line each, at most 20 marks per task); `remove` names marks there are. It applies from the next package collected. This is the form the chat uses.

Arguments:

- `taskId`: the task
- `add` (optional): marks to add, for example `["dsk-…", "UTF-8 decision"]`
- `remove` (optional): marks to take off, by their words
- `commandId`: required

Result: `{ item: { taskId, marks, revision, replayed } }`.

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

#### `resume.approve`

The owner lets a task go on after a resume check that holds changes judged to matter to its work (owner only): the task's current check, when it is ready, is committed. A check already done answers as it is (one left half-recorded by a crash is finished); one that is not ready is refused with where it stands, and an approval during which the task's inputs changed again is refused (`invalid_transition`) and the check stays held for a new look.

Arguments:

- `taskId`: the task
- `commandId`: required

Result: `{ item }`: the check, `phase` done when it was approved.

Completion: finished when accepted (`completed: true`).

#### `resume.decline`

The owner does not let a task go on after a resume check that holds changes judged to matter (owner only): the task is released (its waiting attempt ends; nothing works on it until it is assigned again), then its check is cancelled and the notice that it is held is closed. A decline interrupted after the release is finished by declining again, and the same command ID answers as it did the first time. Refused with where it stands: a check that is not held (`invalid_command`, also one already approved), a check whose attempt was transferred or given another attempt (`invalid_transition`; nothing is released), and a check not tied to an attempt (`invalid_command`; cancel it with `resume.cancel` or release the task).

Arguments:

- `taskId`: the task
- `commandId`: required

Result: `{ item }`: the check, `phase` cancelled (or, when an approval committed it just before the release, as it stands; the task is released either way).

Completion: finished when accepted (`completed: true`).

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

#### `continuation.capture`

A host (or the agent, for its own run) records what is needed to continue a task at a safe boundary: the adapter's checkpoint reference, the artifacts and decisions made, pending effects, budget, the next step, a manifest, tools a checkpoint cannot reproduce, and credentials by name only. Complete only when the host's durability check passed (an agent's word is not durability); an incomplete capture is kept, never resumed from. A host captures only for an attempt it runs or is pinned to. A resumed attempt is checked against the latest complete one.

Arguments:

- `taskId`: the task
- `identity`: the conversation identity (the same for every capture of the task)
- `agent`: the run's agent, like agent:ann
- `boundary`: { kind: turn-complete, timeout, manual or shutdown }
- `checkpoint`: { conversationId, at, digest, runtime: { name, version }, format }
- `durable`: { verified, error? }: the host's durability check
- `continuation`: { artifacts, decisions, pendingEffects: [{ effectId, state }], budget: { spent, remaining, unit }, nextStep }
- `manifest`: { summaryLineage, summaryLineageEarlier?, sourceRanges, compression, branches, messageCursor, routingRevision, environmentRevision, adapter }: summaryLineage (oldest first, up to 10,000 record IDs) keeps its newest 200; the older ones are folded into summaryLineageEarlier { count, digest, through }, which a host may also pass as the controller's compaction records give it
- `nonCheckpointableTools`: [{ name, reason }]
- `scratchRecords`: desk record IDs of the run's agent in the task's project
- `credentialRefs`: names of secrets, never values
- `commandId`: required

Result: `{ id, seq, status, replayed }`: `status` is complete or incomplete.

#### `resume.dependencies.record`

The agent working a task (or the owner) records what the work relied on: files, directories, searches, records, decisions, tool versions, environments, external and MCP resources, and negative lookups, each with what was seen (a hash, an ETag, the members). The same dependency again replaces it. A resumed attempt is checked against them, and each change is reviewed. What the controller can judge itself is recorded only as it really is.

Arguments:

- `taskId`: the task
- `dependencies`: [{ kind, key, hash?, etag?, scope?, cursor?, members?, freshness?, server?, protocol? }], 1 to 500
- `commandId`: required

Result: `{ recorded }`.

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
- `outcome` (optional): proposed, dispatched, confirmed or uncertain; leave out when not known
- `branch` (optional): the branch line the step belongs to (leave out for the main line)
- `supersedes` (optional): the number of an earlier step this one replaces
- `commandId`: required

Result: `{ id, seq, replayed }`.

#### `activity.replay.thinking`

Owner only: expands the model's thinking for a task. It is a recorded look with a reason, shown labelled as model output (not an explanation of any decision). After retention removed it, the answer says so.

Arguments:

- `taskId`: the task
- `reason`: why you are looking
- `after` (optional): { entryId, block } from the previous page
- `limit` (optional): blocks per page
- `commandId`: required

Result: `{ collapsed, state: stored | removed-by-retention | unavailable, label, blocks?, next?, lookId? }`; `unavailable` means this controller runs without the thinking store or the retention marker (not wired), which is not the same as there being none.

#### `thinking.collection.set`

The owner turns collecting the model's thinking off or on (owner only). Off: nothing more is kept from agents that work after this; what was kept stays until retention removes it. The agents' work is not changed.

Arguments:

- `enabled`: true or false
- `expectedRevision` (optional): the revision you read

Result: `{ revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `replay.limits.set`

The owner sets how much of a task's record one replay reads (owner only): `scan` (steps in one view), `exportPages` and `stepPages` (pages of 100 explanations); a figure of null goes back to the default; `enabled` turns every bound on or off. Fields left out stay. A replay that stopped at a bound says so.

Arguments:

- `enabled` (optional): true or false
- `scan` (optional): whole number or null
- `exportPages` (optional): whole number or null
- `stepPages` (optional): whole number or null
- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `replay.limits.enable`

The owner turns the replay read bounds on (owner only). This is the default.

Arguments:

- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `replay.limits.disable`

The owner turns every replay read bound off (owner only): a replay then reads the whole record of a task.

Arguments:

- `expectedRevision` (optional): the revision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

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

Applies an adopted decision's changes with expected revisions; a target that moved is reported as not applied. A change that was already started when the owner declined is finished by this call too (the owner's answer reports `stillApplying: true` when that could not be done just then).

Arguments:

- `decisionId`: the decision's ID
- `commandId`: required

Result: `{ applied, notApplied, pending }`.

#### `meeting.record.owner-respond`

The owner agrees, declines or answers with an alternative to a decision that needs them. After an agreement the agreed changes are carried out, and after a decline or an alternative a change that had already started is finished, at once; if that could not be done just now the answer says `stillApplying: true` (the answer itself is saved, the change stays applying, and nothing applies it again by itself: it is finished when the decision is applied again with `meeting.record.apply`).

Arguments:

- `decisionId`: the decision's ID
- `response`: agree, decline or alternative
- `alternative`: the owner's own decision instead
- `commandId`: required

Result: `{ ownerDecisionId?, orphanedDecisions?, ownerDecisionDisputed?, applied?, stillApplying?, passFailed?, replayed?, carriedOut, refused, alreadyDone, refusedBefore, stillOpen, applying, shown }`: `applied` (changes of the decision carried out, in all) after an agreement; `stillApplying` when a change that was started could not be carried out or finished just now and stays applying; `passFailed` when carrying out stopped with changes still adopted (before any started, or after some were carried out; `carriedOut` tells which); `replayed` for the same command sent again (an alternative's own command ID stands for one owner decision and must differ from the answer's own command ID: sent again with the same content it resolves to that decision and is not recorded twice, with other content (the `basedOn` version aside) it is refused with `command_conflict`, and when the owner decision was recorded for another meeting decision (or, recorded before that was kept, for none that can be shown) it is refused with `invalid_command`; so is an ID whose decision is recorded but whose meeting decision no longer waits for an answer. Such a refusal gives the owner decision's id, topic and state (in force, conflicting or replaced) and says it is not linked to it. An alternative the decision service would refuse is refused before anything is written, and at most 8 attempts that were recorded or begun for one meeting decision and never saved as its answer are kept: a ninth is refused until the decision is answered): the answer is not given twice (an alternative is not recorded twice), the pass runs again and the counts are what this call itself did (a repeat can finish a change an earlier call left applying); `orphanedDecisions [{ id, topic, state }]` listing every owner decision that was recorded for this meeting decision (its own origin names it) by an alternative whose answer was never saved, and is not linked to this answer: each stands, and the owner is told how to replace it (one recorded for another meeting decision, or before that was kept, is never listed); `ownerDecisionDisputed` when the alternative was recorded but conflicts with another instruction on its topic (nothing on the topic is in force until the owner chooses); `carriedOut` the changes this answer carried out, `refused` the codes of those it refused, `alreadyDone` those done before, `refusedBefore` those refused before (each change is in exactly one of these counts), `stillOpen` those still adopted or applying; `shown` plain lines saying what happened (for the chat).

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

Returns the outcomes to the conversations they came from. With `askOwner` (owner, host or service holding meeting.manage; never an agent, an outside app or a task credential) a decision the meeting deferred also puts a question to the owner (at most 10 open per project; past that the outcome is returned without the question and listed in `notAsked`). The owner's answer is written back onto this meeting record and shown on the next stand-up agenda.

Arguments:

- `recordId`: the meeting record's ID
- `askOwner`: true to put a question to the owner for every decision the meeting deferred, or a list of { motionId, question? } (words made from the motion when left out); owner, host or service only, never an agent or a task credential
- `commandId`: required

Result: `{ returned, pending, asked, notAsked }`.

#### `meeting.record.sweep`

Closes votes past their time, breaks or fails ties, finishes abandoned meetings in a project and hands back, without a question to the owner, the outcomes of meetings that ended more than an hour ago (at most 5 meetings a call).

Arguments:

- `projectId`: the project
- `commandId`: required

Result: `{ closed, tied, failedTies, interrupted, logChecked, returned, returnFailed }`.

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

#### `meeting.attend.wake-stop`

The owner ends the wake of a stopped agent for a meeting: the agent is at rest again at once, and if it had joined the room it leaves it.

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

#### `standup.answer-question`

Owner only: answers a question a meeting asked. Quote the revision you read. The answer is shown on the next agenda; the topic is not reopened by it.

Arguments:

- `questionId`: the question a meeting asked the owner
- `expectedRevision`: the revision you read
- `answer`: the owner's answer, in their own words
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

#### `backup.encryption.rekey`

Owner only: approves a new backup key by its fingerprint (as `backup encryption-setup` printed it, 64 hexadecimal characters), or withdraws the approval with null. The installation pins the backup key it first used and refuses to start with a different one; this is the owner's word that the change is meant. Do it while the controller runs with the old keyring, then replace the keyring file and restart. It never changes the pin itself, and old backups stay readable only with the old key's passcode or recovery file.

Arguments:

- `fingerprint`: the new key's fingerprint, or null
- `expectedRevision` (optional): the pinRevision you read

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `backup.encryption.set`

Owner only, recorded and announced to the owner's inbox: switches backup encryption on or off, or chooses its scope, without touching the key or any old backup (they stay readable with the passcode or recovery file). `enabled: false` means new backups are written in PLAIN, so say that to the owner and have them agree first. Scope `everything` seals every file of a backup; `secrets` seals only secret values, and since no secret values are in a backup today (they stay in the secret store) that writes plain backups too. The installation refuses to start with its backup keyring removed from the configuration unless this setting says off, so taking the option away is no way around it. The same call turns encryption back on. It applies from the next backup. Give `expectedRevision` from backup.encryption.status `setting.revision`.

Arguments:

- `enabled` (optional): true or false
- `scope` (optional): `everything` or `secrets`
- `expectedRevision` (optional): the setting.revision you read

Result: `{ revision, enabled, scope, weaker, changed, text }`; `weaker` is true when later backups are less protected; `text` says in plain words how new backups are written.

Completion: finished when accepted (`completed: true`).

#### `backup.signing.rotate`

Owner only, recorded and announced to the owner's inbox: makes a new backup signing key (after the old key may have been exposed, say). The old key stops signing; its public key stays trusted so backups it signed still verify, unless `revokePrevious: true` (the owner says the key was exposed or stolen): then every earlier key is trusted for no backup at all, since whoever holds it could sign a forgery with any date, and backups those keys signed can only be restored with the host command without a trusted key. The owner should then save the new public key (backup.signing.status) off the server.

Arguments:

- `expectedRevision` (optional): the revision you read from backup.signing.status
- `revokePrevious` (optional): true when the old key may be in someone else's hands

Result: `{ revision, keyId, generation, revoked }`; `revoked` is how many earlier keys are no longer trusted.

Completion: finished when accepted (`completed: true`).

#### `backup.encryption.verify`

Owner only: proves that a passcode or the recovery file still opens the backup key. The secret is NOT an argument: the owner puts it in the file the host was told about (mode 600), and this reads it for the moment of the proof; it says only ok or that it failed. One proof at a time, at most one every 10 seconds. The server sees the passcode at that moment and drops the unwrapped key at once.

Arguments:

- `method`: `passcode` or `recovery`

Result: `{ ok, method, at }`.

Completion: finished when accepted (`completed: true`).

#### `backup.restore.apply`

Owner only, a dangerous action: restores a backup. `confirm` must be the token of the preview the owner approved; the call prepares the restore beside the live data, takes a snapshot of the current state, raises the maintenance barrier (every other command is refused) and waits for the controller to be restarted, which swaps the data in (the old data is kept beside). Refused while agent work is running. For an encrypted backup the passcode or recovery file is read from the host file (never an argument); `method` says which. The chat only proposes this; it is never applied from an interpreter's words.

Arguments:

- `name`: the backup's name
- `confirm`: the token from backup.restore.preview
- `method` (optional): passcode or recovery, for an encrypted backup (default passcode)

Result: `{ item: { name, restartRequired: true, restart: { automatic, instruction }, safetyCopy, rows, blobsRestored, piStoresRestored, piFilesRestored, effectsMarkedUncertain, deliveriesToResend, blobsSkippedDeleted, changesDiscarded? } }`; `restart` says whether this host restarts the controller itself or what the owner must do to restart it; `blobsSkippedDeleted` counts artifact files not put back because the artifact was deleted on the retention ledger; `changesDiscarded` is the exact number of recorded changes the restore will discard.

#### `backup.restore.cancel`

Owner only: withdraws a prepared restore that the restart has not applied yet. The staged copy is removed, the maintenance barrier comes down and the live data is exactly as it was.

Arguments:

- none

Result: `{ cancelled, leftovers? }`; also clears a restore that a start tried and rolled back, and puts back what a half-done swap had moved.

#### `database.transfer.apply`

Owner only, a dangerous action: moves the controller database to the target. `confirm` must be the token of the preview the owner approved. The maintenance barrier is raised (agent attempts must have ended), every record is copied and read back, the current database is fenced, and the target becomes the only database a controller will start on; the controller then waits to be restarted on it. A failure before the fence leaves the current database exactly as it was. The chat only proposes this; it is never applied from an interpreter's words.

Arguments:

- `target`: the target's name
- `confirm`: the token from database.transfer.preview

Result: `{ item: { id, direction, to, rows, claimsReleased, uncertainEffects, restartRequired: true, restart, findings } }`; `restart` is `scheduled` (the host restarts the controller onto the new database by itself in a moment), `off` (the host offers it and the owner turned it off with database.transfer.set) or `not-offered` (the host restarts it when it chooses). The same command sent again, also to the controller restarted on the new database, is answered with the recorded result and `replayed: true`. A copy left by an earlier transfer that did not finish is emptied first (the preview says so).

#### `database.transfer.rollback`

Owner only, run on the controller that runs on the NEW database: fences it and puts the previous database back as the only one a controller will start on (then restart). Allowed only while the new database has recorded no work since its first start (its own start-up records do not count); otherwise records exist only there and the way back is a transfer in the other direction.

Arguments:

- none

Result: `{ item: { id, to, restartRequired: true, restart } }`; `restart` as for database.transfer.apply. The same command sent again is answered with the recorded result.

#### `database.transfer.wipe`

Owner only, a destructive action: removes the copy a transfer that did not finish left at a destination (its controller tables and, for PostgreSQL, the schema made for it), so the owner does not have to empty it by hand. Never touches the controller database in use or a database any controller has owned. `confirm` must be the token of database.transfer.wipeplan. The chat only proposes this.

Arguments:

- `target`: the destination's name
- `confirm`: the token from database.transfer.wipeplan

Result: `{ item: { target, removed } }`.

#### `database.transfer.set`

Owner only: turns database transfers on or off (`enabled`) and/or the host's automatic restart after a move or rollback on or off (`restart`). Only the fields given change. Turning transfers off refuses new ones; it does not undo one. With `expectedRevision` (from database.transfer.settings) the change is made only if nothing changed the installation settings since (else `stale_revision`); the chat always quotes the revision it planned at. One write: nothing staged in the installation settings goes into force with it, and a resend of the same command is answered from its record.

Arguments:

- `enabled` (optional): true or false
- `restart` (optional): true or false
- `expectedRevision` (optional): the revision you read (0 when nothing is set)

Result: `{ item: { enabled, restart, restartOffered, revision } }`.

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

#### `credential.issue`

Owner only (card U14b): issues a credential to an agent or a host and shows it ONCE, in `secret.value`. Only its hash is stored; it is never logged, kept in a chat record or repeated, so a lost one is replaced by issuing again (the earlier credential stops working at once). `kind` is `agent` (`agentId`: an agent made with `agent.create`) or `host` (`name`: the host's name, enrolled with no rights if it is new). Repeating the same `commandId` is refused: it cannot show the credential again. The credential carries only the rights the owner gave that principal (`grant.create`); issuing one gives none. Put it where the agent or host reads it (its secret store), not in a chat or a file others can read.

Arguments:

- `kind`: `agent` or `host`
- `agentId` (optional): for an agent: the agent's ID (`agent.list`)
- `name` (optional): for a host: its name, 1 to 40 lower-case letters, digits or hyphens
- `commandId`: required

Result: `{ id, kind, credentialId, enrolled, secret: { label, value } }`: `id` is the principal (`agent:<id>` or `host:<name>`), `credentialId` the public identifier of this credential, `secret.value` the credential, shown once.

Completion: finished when accepted (`completed: true`).

#### `credential.revoke`

Owner only (card U14b): takes an agent's or a host's credential away. The agent or host stays, keeps its rights and its history, and nothing can authenticate as it until `credential.issue` gives it a new credential. It stops counting at the next request. To take back a right, use `grant.revoke`.

Arguments:

- `kind`: `agent` or `host`
- `agentId` (optional): for an agent: the agent's ID
- `name` (optional): for a host: its name
- `reason` (optional): why, in the owner's words
- `commandId`: required

Result: `{ id, revoked }`: `revoked` is false when it had no credential.

Completion: finished when accepted (`completed: true`).

#### `host.local.set`

Owner only (card U14b): turns on or off the worker host that NimbleNewt starts on this computer (`enabled`). On: the next start of NimbleNewt enrolls the host, announces it and lets agents run on it in a sandbox, using only the model providers already set up (it loads or switches no model). Off (the default): tasks stay assigned and wait for a host. It counts from the next start.

Arguments:

- `enabled`: true or false
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision, enabled, takesEffect }`.

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

Integrates, lands, refreshes or quarantines a task's checkout on the host that holds it (the local worker or a remote one, which answer the same typed outcomes). The task's running attempts are made quiet first (new calls refused, calls in flight settled, a checkpoint taken) and go on afterwards; if one cannot be made quiet nothing runs and a blocker says why. A refresh is refused for a checkout that holds changes; an integration carries the changes into the shared workspace through the expected-version bridge (a file that moved is kept for review) and makes no commit; a landing is an integration of committed work that is made only while the checkout's base is the landing branch's current head (otherwise it is refused and nothing is written; the author refreshes first) and reports `detail.landed` (all or nothing: it is planned from the checkout's committed objects, needs a clean shared tree on the named landing branch and, unless the project says otherwise, the review gate's commit permit on the checkout's commits; protected paths such as CI configuration, hooks and Git attributes are kept for review; the landed files stay uncommitted in the shared tree until the integrator or owner commits them, and no further landing is made before); a quarantine moves the checkout to the owner-only quarantine and stops the task's running attempts. A running agent is told when its checkout was refreshed or its changes integrated or landed. An attempt of the task does not start while a request is running. `release` is run behind the same quiet and commits what the checkout holds in the task's own checkout as the platform's commit (fixed author, task, request and attempt trailers; `detail.committed`, `commit`, `files`, `protectedHeld`, `permitRequiredToLand`); it is not a review-gate permit commit, so a landing that requires the permit still refuses it, and an unreadable landing policy refuses the release. A host that does not carry it answers with a refusal.

Arguments:

- `operation`: `integration`, `landing`, `refresh`, `release` or `quarantine`
- `taskId`: the task
- `reason`: why
- `leaseId` (optional): a landing only, when the installation gates landings by lease (it does): the integrator lease of the task's project on the landing branch (`integrator.lease.acquire`); the caller must be its holder and still have the right `integration.lease`. The owner may leave it and `fence` out: the live lease of the landing branch is then used (refused when no integrator holds it)
- `fence` (optional): a landing only: the fence of that lease, as the acquire or renew answered it

Result: `{ id, state, lease?, operation, taskId, requestedBy, assignee?, summary?, detail?, blocker?, quietAttempts?, told?, stopped?, held?, replayed }`; `assignee` is the agent the task was assigned to (the request is recorded against it); `detail` is the host's bounded figures (files written or kept for review, the new base, the quarantine ID; for a landing `landed` is true only when every file was written and the checkout marked, so `state` `done` can mean not landed: look at `detail.landed`, `kept` and `partial`, and `waitingToCommit` says the landed files wait to be committed); `told` and `stopped` name the attempts told their checkout changed or stopped by a quarantine; `held` names attempts whose freeze could not be lifted (a blocker says so; the recovery lifts it); `state` is `done`, `refused`, `failed` or `uncertain` (a repeat while the host was still working: check the checkout before asking again).

Completion: finished when accepted (`completed: true`).

#### `integrator.lease.acquire`

Takes the integrator lease of a project's landing branch for an agent: the one right to land finished work on that branch. One holder per branch at a time; whoever asks while another holds a live lease is refused `unavailable`. A hold has a fence number that grows each time the lease changes hands and expires unless the holder renews it (the controller's clock); a lost integrator frees the branch at expiry. Needs the right `integration.lease` on the task's project (the owner always has it); an agent holds the lease as itself, only the owner may name another agent as `holder`. The task must belong to the project.

Arguments:

- `taskId`: the task the integrator works the landing under (its project is the lease's project)
- `branch`: the landing branch, such as `main`
- `ttlMs`: how long the hold lasts without a renewal, 60000 to 86400000 milliseconds
- `holder` (optional): owner only: the ID of the active agent that will hold it
- `commandId`: required

Result: `{ item: { leaseId, projectId, branch, holder, taskId, fence, ttlMs, acquiredAt, expiresAt, state, live, revision } }`; keep `leaseId` and `fence`: a landing (`workspace.request` with `operation: landing`) must show both.

Completion: finished when accepted (`completed: true`).

#### `integrator.lease.renew`

Extends the integrator lease the caller holds. Only the holder, with the fence it was given; `fenced` when the lease expired, was released or changed hands.

Arguments:

- `leaseId`: the lease
- `fence`: the fence you hold
- `commandId`: required

Result: `{ item }` as `integrator.lease.acquire`.

Completion: finished when accepted (`completed: true`).

#### `integrator.lease.release`

Lets an integrator lease go. The holder gives its fence; the owner may name the lease by `projectId` and `branch` and omit the fence, which ends the hold whoever has it. A release for an old fence is refused `fenced` and never touches the current hold.

Arguments:

- `leaseId` (optional): the lease (or give projectId and branch)
- `projectId` (optional): the project, with branch
- `branch` (optional): the landing branch, with projectId
- `fence` (optional): the fence you hold (required unless you are the owner)
- `note` (optional): why
- `commandId`: required

Result: `{ item }` as `integrator.lease.acquire`, with `state` `released`.

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

#### `security.report`

A host or a service tells the controller of a security event it detected (a sandbox escape attempt, a credential used from the wrong task or host, a protected path touched, a failed integrity check). The controller tells the owner at once as an Urgent item; the same event (same kind, key and project) is told once, also after the owner closed it. Agents and tasks cannot report.

Arguments:

- `kind`: sandbox-escape-attempt, credential-misused, protected-path-touched or integrity-check-failed
- `key`: your own identifier of the event (up to 200 characters, never a secret, never sent outside); the same key is the same event
- `projectId` (optional): the project concerned (a project ID)

Result: `{ itemId, held }`: the owner's item; `held` is true when your hourly allowance of separate reports was used and the report went into the collected item.

Completion: finished when accepted (`completed: true`).

#### `critical.mark`

Owner only: marks a task, a goal or a project as on the critical path, or takes the mark off (`marked` false). A task is on the path itself; a goal is a task you want delivered, and it and every task it waits for are on the path; a project puts all its tasks on the path. A decision waiting for you that holds up the path is listed first in the Needs-you view and the digest, and is raised to Urgent after a few minutes (criticalBlockedAfterMinutes). Only the owner can mark: nothing an agent writes sets or changes it. At most 100 marks.

Arguments:

- `kind`: task, goal or project
- `taskId` (optional): the task or goal (for kind task or goal)
- `projectId` (optional): the project (for kind project; beside a task it must be the task's own project)
- `marked` (optional): true (the default) marks, false takes the mark off

Result: `{ revision, changed, marks }`: the list's revision, whether the marks changed, and how many there are.

Completion: finished when accepted (`completed: true`).

#### `notifications.configure`

Owner only: sets how notifications reach the owner; only the fields given change, and they count from the next notification.

Arguments:

- `channel` (optional): inbox or external
- `channelName` (optional): the name of the external channel (needed for external; it must be a channel adapter registered in this installation, otherwise the change is refused)
- `digestTimes` (optional): 1 to 8 UTC times such as 09:00; until you name times yourself the plain 09:00 digest gives way to scheduled stand-ups only when every decision it would list belongs to a project whose stand-up carries it, naming them (even 09:00) always sends the digest
- `quietHours` (optional): { start, end } times in your time zone setting (UTC when none is set), or null to remove them
- `levelByKind` (optional): { kind: notice | needs-you | urgent } for blocker, review-request, owner-question, maintenance, presence, safety-stop; null puts a kind back to its default (a safety stop stays urgent)
- `noticeRetentionDays` (optional): whole days (1 to 365) a Notice stays in the inbox before it is closed (default 7)
- `escalateAfterHours` (optional): whole hours (1 to 720) before an unanswered item is escalated; null turns escalation off (set a number again to turn it on)
- `escalationsPerHour` (optional): whole number (1 to 1000) of Urgent messages sent outside per hour, escalations and the controller's own Urgent triggers together (default 10; decisions waiting for you, raised because work stopped or the critical path is blocked, use at most half of it, so a missing backup, a silent host or a security alarm always has room); more in a burst are held in the inbox and told in ONE "N more" message; null turns the limit off
- `sweepEverySeconds` (optional): seconds (5 to 3600) between two full sweeps by the dispatcher, also of the Urgent watch (default 60)
- `urgentMinGapMinutes` (optional): whole minutes (1 to 1440) before the same record (a host that keeps going down and up) is sent again as Urgent (default 30; the item is still raised in the inbox); null turns it off
- `securityReportsPerHour` (optional): whole number (1 to 1000) of security reports one host or service may raise as separate Urgent items per hour (default 20); the rest of that reporter's burst is collected in ONE item; null turns the limit off
- `securityDetectors` (optional): true (default) or false: whether the controller's own security detectors report (a task credential used on another task, a host naming an attempt it never held, the signs its local worker sees such as a Git folder planted in a checkout); false stops the reports, not the refusals; the same hourly allowance (securityReportsPerHour) bounds them
- `deniedAlertsPerHour` (optional): how many agents' repeated refusals (1 to 1000) may send an Urgent message per hour (default 5; the rest are raised in the inbox only); null turns it off
- `sendTimeoutSeconds` (optional): seconds (1 to 120) one channel send may take before it is retried later (default 10)
- `urgentInterruptsQuietHours` (optional): true (default): an escalated Urgent item and its retries are also sent in quiet hours; false: they wait for the end of quiet hours
- `backupMaxAgeHours` (optional): whole hours (1 to 8760) without a good backup before the controller raises an Urgent item (default 48); null turns it off and closes its open item
- `hostDownAfterMinutes` (optional): whole minutes (1 to 1440) a host may stay silent before the controller raises an Urgent item (default 10); null turns it off
- `deniedThreshold` (optional): refusals of one agent (2 to 10000) within deniedWindowMinutes that raise an Urgent item; not set or null: off
- `deniedWindowMinutes` (optional): whole minutes (1 to 1440) the refusals are counted in (default 60)
- `stoppedWorkAfterMinutes` (optional): whole minutes (1 to 10080) a decision waiting for you may hold up a project that has nothing else to do before the controller raises it to Urgent (default 30); null turns it off and puts what it raised back to Needs you
- `criticalBlockedAfterMinutes` (optional): whole minutes (1 to 10080) a decision waiting for you may hold up a task on the critical path you marked before the controller raises it to Urgent, and the minutes it must have stopped doing so before it is put back to Needs you without a message (default 5); null turns it off and puts what it raised back to Needs you
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
- `requiredEvidence` (optional): list of text: what the agent must name in work.end `evidence` (a file of its checkout each) before its done is accepted
- `checks` (optional): list of `{ name, run, timeoutSeconds? }`: commands the host runs in the attempt's sandbox (the checkout as working directory) when the agent says done; each must exit 0 (at most 10; `run` is the program and its arguments; default 600 seconds, at most 3,600)
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
- `versionControl` (optional): where the repository is hosted and which CI checks it, `{ host, hostName?, ci? }`: host is `github`, `gitlab`, `self-hosted` (hostName: the forge's name, such as Gitea) or `none` (no remote); ci is a short label such as `GitHub Actions`, `GitLab CI`, `Jenkins` or `none`. NimbleNewt needs only a git repository and assumes no forge; this records the owner's answer.
- `integration` (optional): how finished work lands, `{ landing?, integrator?, requiredChecks?, refreshRounds? }` (owner only; otherwise the installation default or the profile's). Drafted in chat the section is shown as settings with what the chosen landing does to the new project's work; it is created only when the owner confirms the draft.

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
- `versionControl` (optional): where the repository is hosted and which CI checks it, `{ host, hostName?, ci? }`: host is `github`, `gitlab`, `self-hosted` (hostName: the forge's name, such as Gitea) or `none` (no remote); ci is a short label such as `GitHub Actions`, `GitLab CI`, `Jenkins` or `none`. NimbleNewt needs only a git repository and assumes no forge; this records the owner's answer.

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

#### `coverage.settings.set`

Owner only: turns the coverage-lapse alert on or off (`enabled`) and/or sets after how many minutes a responsibility without coverage is told to the owner (`afterMinutes`, 1 to 525600; null for the default of 1440). Only the fields given change. Off by default. This is the form the chat uses.

Arguments:

- `enabled` (optional): true or false
- `afterMinutes` (optional): whole minutes, or null for the default
- `expectedRevision` (optional): the revision you read (0 when none was set yet)

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `retention.settings.set`

Owner only: changes retention values; only the fields given change, `null` clears an optional one and "default" returns a field to the installation default. `derivedDays` (7 to 3650) expires derived summaries (off unless set); `contextRouteDays` (1 to 3650) removes the records of a task's move to another model route (the text cut from its context, and the decisions) that many days after their last change (off unless set: they are kept); `generationRunDays` (1 to 3650) removes recorded model replies (generation runs, which may hold personal data) that are over, that many days after their last change (off unless set: they are kept); `checkRecordDays` (7 to 3650) removes finished responsibility checks (never one still owed) that many days after their slot (off unless set: they are kept); `concernDays` (7 to 3650) removes stall concerns that are over that many days after their last change: cleared, confirmed, or dismissed with the dismissal run out, and only once their task is done or cancelled or has been assigned again since (never a suspected one, a dismissal still in force or a concern with a recovery step half made; off unless set: they are kept); `stallEvidenceDays` (7 to 3650) removes the progress evidence of a task that is done, cancelled or gone that many days after its last report or last change (never one with a suspected concern or a recovery step half made; off unless set); `stallSpeedDays` (7 to 3650) removes a route's measured speed not updated for that many days (it is measured again; one a request in flight names is kept; off unless set); `responsibilityHistoryDays` (7 to 3650) removes the history entries and incident counters of a responsibility that was retired that many days ago (the responsibility, its log, incidents and check records stay; a counter whose incident is still open stays; off unless set); `noteArchiveDays` (7 to 3650) removes the whole text of a cut note (the archive its marker names) that many days after it was written, only once its task is done, cancelled or gone (a task that can still run keeps its archives; the note's marker stays and then reads as no longer kept; off unless set); `autoRun` lets the dispatcher run it by itself; `thinkingDays` (default 14) is how long stored model thinking is kept after a task is done (recorded; deleting it needs card K06c); `backupDaily` and `backupWeekly` are the backup counts kept (7 and 4); `preRestoreKept` (1 to 1000, null keeps all, the default) keeps only that many of the newest snapshots taken before a restore; `preRestoreMaxAgeDays` (1 to 3650, null for no limit, the default) removes those snapshots when older than that (they never take a scheduled daily or weekly slot); `dataLockStaleMinutes` (1 to 10080, default 10, null for never) is how long a start waits for the data directory lock's refresh before taking it over when the holder's process cannot be looked for (another host name, a container; never sooner than twice the refresh period plus 30 seconds, and hosts whose clocks differ by more need a larger value); `restoreChangeMargin` (0 to 1000000, default 200, null for no check; counted in audit rows, which are several per operation) refuses a restore, asking for a new preview, when more than that many recorded changes were made between the preview and the apply; `restoreConfirmMinutes` (1 to 10080, default 30, null for no expiry) is how long the owner's approval of a restore stays good; `incidentArchiveDays` and `incidentPurgeDays` archive and then remove old resolved incidents (off); `catalogVersionsKept` (1 to 500, off) keeps only that many of the newest versions of each catalogue tool: the latest, the one a tool resolves to now, the newest unrevoked one, revoked ones and any a resumable task ran, has a call pinned to (in any state: parked, approved, running or ended) or lists as a dependency, or that is in the skill library of an agent's active environment or of an environment revision a resumable task's attempt is pinned to, stay, older ones are dropped by the runner (by hand always; by the automatic pass only when `catalogAutoDrop` is true, default false); `revokedBytesBlank` (true or false, default false) is the switch for blanking the executable text of revoked versions, and `revokedBytesDays` (7 to 3650, default 90, null keeps them) is how long after the revocation, applied only while the switch is on; only a record whose text is still exactly what was registered and that no resumable task, dependency or checkpoint cites and that no unrevoked version also uses is blanked (the record, digest and revocation stay); `quotaProjectBytes` and `quotaAgentBytes` are optional storage quotas (off), warned at `quotaWarnPercent` (80); `reserveBytes` is the room kept for shutdown and recovery records (16 MiB; 0 for none). The answer names each old and new value. This is the form the chat uses.

Arguments:

- `derivedDays` (optional): 7 to 3650, or null
- `generationRunDays` (optional): 1 to 3650, or null
- `contextRouteDays` (optional): 1 to 3650, or null
- `checkRecordDays` (optional): 7 to 3650, or null
- `concernDays` (optional): 7 to 3650, or null
- `stallEvidenceDays` (optional): 7 to 3650, or null
- `stallSpeedDays` (optional): 7 to 3650, or null
- `responsibilityHistoryDays` (optional): 7 to 3650, or null
- `noteArchiveDays` (optional): 7 to 3650, or null
- `autoRun` (optional): true or false
- `thinkingDays` (optional): 1 to 365
- `backupDaily` (optional): 1 to 365
- `backupWeekly` (optional): 0 to 520
- `incidentArchiveDays` (optional): 7 to 3650, or null
- `incidentPurgeDays` (optional): 30 to 3650, or null
- `catalogVersionsKept` (optional): 1 to 500, or null
- `catalogAutoDrop` (optional): true or false (default false)
- `revokedBytesBlank` (optional): true or false (default false): switch for blanking revoked executable text
- `revokedBytesDays` (optional): 7 to 3650, or null (default 90)
- `preRestoreKept` (optional): 1 to 1000, or null
- `preRestoreMaxAgeDays` (optional): 1 to 3650, or null (default)
- `dataLockStaleMinutes` (optional): 1 to 10080, or null (default 10)
- `restoreChangeMargin` (optional): 0 to 1000000, or null (default 200)
- `restoreConfirmMinutes` (optional): 1 to 10080, or null (default 30)
- `quotaProjectBytes` (optional): bytes, or null
- `quotaAgentBytes` (optional): bytes, or null
- `quotaWarnPercent` (optional): 50 to 99
- `reserveBytes` (optional): 0 to 1073741824
- `expectedRevision` (optional): the revision you read (0 when none was set yet)

Result: `{ id, revision, changed: [{ field, old, new }], summary, shown }`.

Completion: finished when accepted (`completed: true`).

#### `retention.run`

Owner only: the retention runner. Without `dryRun: false` it only shows what the rule would remove (derived summaries older than `derivedDays`, backups outside the counts, and, when `catalogVersionsKept` is set (by hand; the automatic pass only when `catalogAutoDrop` is on), old versions of catalogue tools: `catalogVersions` lists them and the ones kept because something still needs them: a resumable task ran or pinned them, an environment or dependency record lists them) and gives a `digest`; run it for real by passing that digest as `confirm`. Material a resumable task or replay needs is skipped and shown as retained (a revoked executable text that something cites when the run reads it is left out of `revokedBytes`; one that becomes cited during the run stays listed there but is not blanked, so `blanked` is lower; neither is listed as retained). Each rule acts only when its own value is set (`derivedDays`, `generationRunDays`, `contextRouteDays`, `catalogVersionsKept`, and `revokedBytesBlank` with `revokedBytesDays`); backups follow their counts. `revokedBytes` lists the revoked executable texts that would be blanked, and a real run reports `blanked`. When the incident windows are set the preview also counts the resolved incidents to archive and the archived ones to remove (`incidents.wouldArchive` and `wouldPurge`, `incidents.more` when more are due than one run takes: at most 200 of each kind per project); the digest covers their IDs and a confirmed run acts on those (each is checked again when handled; one that no longer qualifies is skipped, so `incidents.archived` or `purged` can be lower than the preview's counts), and reports `incidents.archived` and `purged`.

Arguments:

- `dryRun` (optional): default true
- `confirm` (optional): the digest of the preview; a real run also needs dryRun false (the chat sets both for the owner, from a preview it makes just now)
- `limit` (optional): 1 to 1000 (default 200)

Result: The report: candidates, retained, removed, partial, backups, incidents, catalogVersions, revokedBytes, and digest (a preview) or runId (a real run).

Completion: finished when accepted (`completed: true`).

#### `retention.delete`

Owner only: deletes a desk record at the owner's request, with what was made from it: copies, summaries that cite it (removed), compactions (text blanked and marked) and its archive. A digest, who, why and when stay. A record a resumable task or a replay needs is not deleted: the request is recorded as retained with the reasons. The answer and the record say how backups are handled (left to expire, and for how long); no search index or reply cache exists. `dryRun: true` shows the effect only.

Arguments:

- `recordId`: the desk record
- `reason`: why (recorded)
- `dryRun` (optional): true to preview

Result: `{ status: deleted | partial | retained | preview, derived, backups, retained?, deletionId?, remaining? }`. `partial` (more than one request handles): ask again with the same commandId to continue. Backups made before the deletion hold the text until they expire; a restore re-applies the deletion ledger.

Completion: finished when accepted (`completed: true`).

#### `retention.archive`

Owner only: archives a done or cancelled task's desk records: their text moves into archive records and the desk record keeps a stub. A record a resumable task or replay needs is left and shown as retained.

Arguments:

- `taskId`: the finished task
- `reason` (optional): why

Result: `{ taskId, archived, retained, skipped }`.

Completion: finished when accepted (`completed: true`).

#### `retention.restore`

Owner only: puts a task's archived desk records back exactly as they were. A record changed since is left and listed as a conflict.

Arguments:

- `taskId`: the task

Result: `{ taskId, restored, conflicts, conflictDetails }` (a reason for each conflict).

Completion: finished when accepted (`completed: true`).

#### `lease.acquire`

Takes (or, for the holder, renews) the maintenance lease on a resource a responsibility manages, before changing it. Only one agent holds it at a time: if another agent holds it the answer is `status: blocked` with the holder and the time, and the attempt is recorded visibly on the lease. A lease that ran out unreleased is taken over and the previous holder recorded. For the answerable agent, the owner or a holder of `responsibility.write`; a paused responsibility starts no new maintenance.

Arguments:

- `resourceId`: the managed resource's ID
- `purpose`: what the maintenance is for
- `minutes` (optional): how long, 1 to 1440 (default 60)
- `commandId`: required

Result: `{ status: granted | blocked, lease }`.

Completion: finished when accepted (`completed: true`).

#### `lease.release`

Gives back a maintenance lease with the result of validating the change: `validation` passed or failed. A failed validation needs `onFailure`: `rollback` (only when the responsibility permits the action `rollback`) or `escalate` (opens an incident and escalates it at once to the responsibility's escalation target or the owner). Both are recorded in the responsibility's history. The owner may instead release another agent's lease by force: give only `evidence` (the reason), no `validation`.

Arguments:

- `resourceId`: the resource
- `validation` (optional): `passed` or `failed` (leave out only for the owner's forced release)
- `evidence`: what shows the result, or the reason for a forced release
- `onFailure` (optional): `rollback` or `escalate`, with a failed validation
- `commandId`: required

Result: `{ lease, response?, incidentId? }`.

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

#### `artifact.publish`

Publishes the output of a task that is not code (a research note, a document, a design description) as an artifact of that task: text files with a name. The agent holding `artifact.publish` for the task (roles author, docs and qa) or the owner; a task credential reaches its own task only. The artifact records the task, the project and the digest of every file; a deliverable (`deliverable.draft`) then names it, and a later change of the files is found when the deliverable is submitted or accepted. Publishing is not submitting and not acceptance. Each publication is an `artifact-version` step of the task's activity, naming who published it; a local worker publishes through its tool bridge (`nimblenewt__artifact-publish`, its own task only). Repeating the same command ID publishes once.

Arguments:

- `commandId`: required
- `taskId`: the task
- `name`: a label (1 to 120 characters)
- `files`: [{ path, text }] (portable relative paths, UTF-8 text)

Result: `{ id, revision, replayed }`: `id` is the artifact ID.

Completion: finished when accepted (`completed: true`).

#### `service.operate`

Does ONE action on ONE resource of a service for a task and records what the service itself reports afterwards. The scope is judged first: the right `effect.perform` (granted per resource: kind `service`, id `<service>/<resource>`, or project-wide) is needed on the named resource and on every other resource the action would change, otherwise it is refused as `forbidden` and nothing is done. An agent must own the task's current attempt. The intent is written to the effect ledger first; the service applies it once (a repeat with the same command ID applies nothing again); the resource is read back and judged, and the resources next to it are checked to be unchanged. `confirmed` means applied and verified; the result then carries `outcome { reference, systemVersion, observedAt }`, the only thing a deliverable of type `operational-outcome` may name. A change that cannot be verified, or that moved something outside the scope, is `uncertain`: it is never retried blindly and a person decides. No service connected: `unavailable`.

Arguments:

- `commandId`: required
- `taskId`: the task
- `service`: the service name
- `resource`: the resource name
- `action`: { type, params? }, for example { type: "restart" } or { type: "set", params: { fields: { ... } } }

Result: `{ effectId, status, outcome?, evidence?, note? }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.draft`

Starts a deliverable of a task in `draft` (version 1): its type, title, responsible agent, audience and access scope, and optionally its content (artifacts of the task, grouped as `source` or `exported`; the code or document submissions it is; for an operational outcome the verified reference, system version and observation time). An agent holding the author, docs or qa role creates its own; the owner may name the responsible agent. Access scope `owner`: the owner and the responsible agent read it; `task` (default): also agents that may read the task; `project`: also any agent holding a role in the project. Audience `external`: only the owner can accept it. Repeating the same command ID records once.

Arguments:

- `commandId`: required
- `taskId`: the task
- `type`: `code`, `document`, `report`, `design` or `operational-outcome`
- `title`: a short title
- `audience` (optional): list of `owner`, `director`, `reviewers`, `project`, `external`; default `project`
- `accessScope` (optional): `owner`, `task` or `project`; default `task`
- `responsibleAgent` (optional): owner only: the agent (agent:name) answerable for it
- `artifacts` (optional): [{ artifactId, role?: `source` or `exported`, exportedFrom? }]
- `submissionIds` (optional): code or document submissions of the task
- `outcome` (optional): { reference, systemVersion, observedAt } (UTC time)
- `note` (optional): free text

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.revise`

Replaces the content of the version still in `draft` (the responsible agent or the owner). A version that was submitted is changed only by starting a new version.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `expectedRevision`: the revision you read
- `artifacts` (optional): see `deliverable.draft`
- `submissionIds` (optional): see `deliverable.draft`
- `outcome` (optional): see `deliverable.draft`
- `note` (optional): free text

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.version.new`

Starts the next version (in `draft`) with new content. The earlier version becomes `superseded`, except a rejected one, which stays rejected: its history is kept. Responsible agent or owner.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `expectedRevision`: the revision you read
- `artifacts` (optional): see `deliverable.draft`
- `submissionIds` (optional): see `deliverable.draft`
- `outcome` (optional): see `deliverable.draft`
- `note` (optional): free text

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.submit`

Submits the draft version for review (draft to submitted). The artifacts are checked against their bytes, the version must be complete for its type, and `contractVersion` must be the task contract version now in force (a stale one is `stale_revision` with the current version). Responsible agent or owner. Submitting is not acceptance.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `expectedRevision`: the revision you read
- `contractVersion`: the task contract version you worked against (0 when it has none)

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.review.start`

Starts the review of the submitted version (submitted to under-review). The owner, or a director or reviewer that did none of the work behind it (no self-review; where the project has one agent only the owner can). The artifacts are checked first.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `version`: the version to review (the newest)
- `expectedRevision` (optional): the revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.accept`

Accepts the version under review (under-review to accepted). Only the owner, a director, or the reviewer that started the review, and never an agent that did the work; a deliverable for an external audience is accepted by the owner only. The artifacts are checked again: a missing or changed one voids the review (event `invalidated`, version back to `submitted`) and the call fails with `integrity`. Finishing a task by a tool never accepts it.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `version`: the version to accept (the newest)
- `expectedRevision` (optional): the revision you read
- `reason` (optional): why

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.reject`

Rejects the version under review (under-review to rejected) with a reason; same authority as `deliverable.accept`. The rejected version and its reason stay on the record; the work continues in a new version.

Arguments:

- `commandId`: required
- `id`: the deliverable
- `version`: the version to reject (the newest)
- `reason`: why
- `expectedRevision` (optional): the revision you read

Result: `{ id, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `deliverable.check`

Checks the newest version's artifacts against their bytes. If something is missing or changed while the version is under review or accepted, the review (or acceptance) is voided with an `invalidated` event and the version returns to `submitted`. The owner, the responsible agent, a director or a reviewer.

Arguments:

- `commandId`: required
- `id`: the deliverable

Result: `{ id, ok, problems, invalidated }`.

Completion: finished when accepted (`completed: true`).

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

Owner only: allows (or with active=false stops allowing) a host to run destructive release tests for one platform. A machine used for production work is not authorized by that. Authorizing names the platform; withdrawing may leave `os` and `arch` out and takes the machine off the release machines whatever platform it stood for.

Arguments:

- `hostId`: the host
- `os` (optional): linux, darwin or win32 — with `arch`, the platform the host is authorized for; both may be left out only with `active: false`
- `arch` (optional): x64 or arm64, with `os`
- `active` (optional): false to withdraw (then `os` and `arch` may be left out)
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

#### `release.start`

Starts the release test of one platform of a candidate on a host the owner authorized for it. Who may: the owner always; an agent holding the QA role and the QA agent's supervisor only as the owner's setting allows (`release.settings.get`). The host picks the job up over the worker protocol and reports its own result; an agent cannot name another worker. Refused while an attempt is open or after the platform passed.

Arguments:

- `candidateId`: the candidate
- `cell`: { os, arch, osVersion? }
- `hostId`: the authorized host
- `workerId` (optional): owner only: a worker other than the host
- `timeoutSeconds` (optional): whole seconds (default 3600)
- `memoryMb` (optional): whole megabytes (default 4096)
- `commandId`: required

Result: `{ attemptId, payload }`.

#### `release.cancel`

Ends an open release-test attempt without a result, for whoever may start one (see `release.start`); an agent cancels only an attempt it or an agent reporting directly to it started, the owner any. It is never a pass; a retry is a new attempt.

Arguments:

- `attemptId`: the attempt
- `reason`: why
- `commandId`: required

Result: `{ ok }`.

#### `release.settings.set`

Owner only: sets who besides the owner may start and cancel release tests: `qaAgents` (agents holding the QA role), `bosses` (their supervisors), `qaRole` (the role's name, default `qa`; the role is editable by every holder of `agent.manage`, so the switches reach every agent that holds it), `qaAgentIds` (the QA agents you name: when set, the role is ignored) and `startsPerHour` (starts plus cancels one agent may make per hour, default 12, 0 is no limit; you are never limited). `null` returns a field to the profile's default. Optional `expectedRevision`.

Arguments:

- `qaAgents` (optional): true, false or null
- `bosses` (optional): true, false or null
- `qaRole` (optional): role name or null
- `qaAgentIds` (optional): list of agent IDs, or null
- `startsPerHour` (optional): whole number, 0 for no limit, or null
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

#### `release.issuers.enable`

Owner only: lets QA agents, their supervisors, or both start and cancel release tests.

Arguments:

- `who`: qa-agents, bosses or all
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

#### `release.issuers.disable`

Owner only: stops QA agents, their supervisors, or both from starting and cancelling release tests (the owner still can). Attempts already started stay as they are.

Arguments:

- `who`: qa-agents, bosses or all
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

#### `release.approve`

Owner only: approves a candidate for release; refused unless every platform's latest attempt passed. A platform that passed only after a failed attempt is shown as flaky in `release.gate`. Such a release is approved only by an approval that carries the earlier failures the gate lists (`acknowledgeFlaky` true with `expectedFailures` set to those attempt IDs); the chat draws that approval up from the gate and shows it first, so what the owner confirms is the list of failures itself, and no wording of theirs is scanned for a particular phrase. A worker cannot.

Arguments:

- `candidateId`: the candidate
- `acknowledgeFlaky` (optional): true to approve a release in which a platform passed only after earlier failures
- `expectedFailures` (optional): the attempt IDs `release.gate` listed as earlier failures when this approval was drawn up (the chat fills them from its own reading of the gate); refused if the gate's earlier failures are not exactly these, so a gate that changed while the owner was asked is never approved behind their back
- `commandId`: required

Result: `{ ok }`.

#### `release.stage`

Owner only: copies the artifacts of a candidate from its incoming folder under the release root into a new read-only versioned directory, refusing any file whose digest is not the one the candidate's manifest names. The owner names no path. Staging changes nothing that is running. The same candidate again is the same release.

Arguments:

- `candidateId`: the candidate
- `commandId`: required

Result: `{ candidateId, digest, bytes, files, replayed }`: quote `digest` to activate.

Completion: finished when accepted (`completed: true`).

#### `release.activate`

Owner only: makes a staged release the current one. The word is bound to the candidate, to the digest of what was staged (so a changed directory is refused) and to this installation's platform (the candidate must have been tested for it); the candidate must be approved unless the owner switched that requirement off. The files are verified again, then the switch is one atomic step recorded in a journal, so an interruption ends at the old release or the new, never between. A candidate built by an agent cannot stage or activate itself: only the owner can.

Arguments:

- `candidateId`: the staged candidate
- `digest`: the digest `release.stage` returned
- `expectedRevision` (optional): the `revision` of release.status
- `commandId`: required

Result: `{ revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `release.rollback`

Owner only: goes back to the release that was current before the last activation, named by its ID (so a record that moved cannot send it elsewhere). Its files are verified first; the switch is journalled like an activation.

Arguments:

- `releaseId`: the previous release's ID, as release.status shows it
- `expectedRevision` (optional): the `revision` of release.status
- `commandId`: required

Result: `{ revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `release.confirm`

Owner only: marks the current release as the last known good (the one a failed start of a later release falls back to) when it did not confirm itself, for example because it was not started by the launcher. Its files are verified first. A release that started under the launcher and reported itself healthy is confirmed without this.

Arguments:

- `releaseId`: the current release's ID, as release.status shows it
- `expectedRevision` (optional): the `revision` of release.status
- `commandId`: required

Result: `{ revision, releaseId }`.

Completion: finished when accepted (`completed: true`).

#### `release.stage.remove`

Owner only: removes a staged release (its record and files) so the staging cap does not fill for good. Refused for the current release, the previous one (the rollback target), either end of an open switch and whatever the launcher's pointer names.

Arguments:

- `candidateId`: the staged candidate
- `commandId`: required

Result: `{ candidateId, removed }`.

Completion: finished when accepted (`completed: true`).

#### `release.activation.resolve`

Owner only: closes an open or interrupted switch that restart recovery could not (the launcher's pointer names neither release, so release.status shows a journal that never closes and every activation and rollback is refused). `commit` makes the new release current (verified first, pointer set to it); `abort` keeps the old one (pointer set back to it, or removed when there was none); `set-pointer` sets the pointer to `releaseId` (one end of the switch) and closes the switch the way that pointer says. Leaves a history entry and an audit record.

Arguments:

- `action`: commit, abort or set-pointer
- `releaseId` (optional): for set-pointer: the release the pointer should name (the new or the old end of the switch)
- `expectedRevision`: the `revision` of release.status (required)
- `commandId`: required

Result: `{ revision, action }`.

Completion: finished when accepted (`completed: true`).

#### `release.staging.settings.set`

Owner only: sets whether activation needs an approved candidate (`requireApproval`) and/or the cap on staged releases in bytes (`maxStagedBytes`, null for no cap). Only the fields given change. Turning the approval requirement off widens what can be activated.

Arguments:

- `requireApproval` (optional): true or false
- `maxStagedBytes` (optional): whole bytes, or null for no cap
- `keepStaged` (optional): keep only the newest N staged releases (1-200; never the current, the previous or one being switched to), or null to keep all (the default)
- `maxStaged` (optional): the most releases staged at once (default 200), or null
- `maxFiles` (optional): the most artifacts of one release (default 100), or null
- `maxFileBytes` (optional): the largest artifact in bytes (default 4 GiB), or null
- `startupWindowSeconds` (optional): seconds (10 to 86400) a started release may stay unconfirmed before the launcher's watchdog counts the start as failed and falls back (default 300); null for the default
- `startFailureLevel` (optional): needs-you (default) or urgent: how loudly the owner is told when the launcher fell back to the last known good (a failed start with nothing to fall back to is always urgent); null for the default
- `expectedRevision` (optional): the revision you read (0 when none was set yet)
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `release.start.acknowledge`

Owner only: the owner has seen that a release failed to start or that the launcher fell back to the last known good. Closes the notice (all open ones, or those of one release) and takes it out of the inbox; it changes no release and no setting. A later release that starts and confirms closes them too.

Arguments:

- `releaseId` (optional): only the notices about this release (default: all open ones)
- `commandId`: required

Result: `{ acknowledged }`: how many notices were closed.

Completion: finished when accepted (`completed: true`).

#### `release.approval.enable`

Owner only: activation needs the candidate approved through release.approve (the default). This narrows.

Arguments:

- `expectedRevision` (optional): the revision of the staging settings
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `release.approval.disable`

Owner only: activation no longer needs the candidate approved (its staged digest still must match). This widens.

Arguments:

- `expectedRevision` (optional): the revision of the staging settings
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `swarm.spawn`

Makes a child task of a task you hold the budget of: it gets the outcome and acceptance criteria you give and part of the parent's allowance (it can spend only that). Both are required: the parent assigns the outcome and how it is accepted. A parent limited in money or compute time must give some of each it is limited in. Refused when the parent has nothing to give, is finished, is at the owner's depth limit, already has its live children or its fan-in total of children (swarm.limits), or its swarm is being cancelled; nothing is left live after a refusal.

Arguments:

- `parentTaskId`: the parent task
- `title`: the child's title
- `expectedResult`: what the child must deliver
- `acceptanceCriteria`: list of checks (at least one)
- `costMicros` (optional): allowance to hand over
- `computeMs` (optional): compute allowance to hand over
- `commandId`: required

Result: `{ taskId, replayed }`.

#### `swarm.cancel`

Cancels a task's whole swarm: no new child is made under it meanwhile, every child and grandchild is stopped (deepest first) and cancelled, and what each did not use goes back to its parent (also from children that had already finished or been cancelled). Repeat it to carry on if some are still being stopped; the parent may spawn again once nothing is pending.

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

#### `agenda.settle`

Moves an agenda item along after the meeting: `discussed`, `resolved` (with the meeting's words as `outcomeNote`), `deferred` (with a `reason` and a `nextStep`) or `queued` again. A meeting that needs something from the owner sets `ownerQuestion`: it becomes a question of its own that the owner is told about and answers in chat, and the answer is shown on the next agenda. The item's owner or someone with `meeting.manage` does it (a task credential only for the topics its own agent owns, whatever grant it carries); only the owner, or a host or service with `meeting.manage`, may set `ownerQuestion` (never an agent or a task credential: an agent asks the owner through an inquiry).

Arguments:

- `itemId`: the agenda item
- `expectedRevision`: the revision you read
- `to`: `discussed`, `resolved`, `deferred` or `queued`
- `reason` (optional): why it was deferred
- `nextStep` (optional): what happens next, for a deferral
- `outcomeRef` (optional): a link to the decision, for a discussed or resolved item
- `outcomeNote` (optional): what the meeting made of it, in words
- `ownerQuestion` (optional): a new question for the owner (not for a queued item; not from an agent)

Result: `{ ok }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.request`

Asks for a change to an agent's environment as a maintenance request (card A09). An agent asks for its own; the owner for any agent. `kind`: `skill` (a skill draft: allowed and recorded), `package` or `extension` (an executable dependency: a preapproved catalogue entry approves it, and so does the owner's standing permission for that kind, a grant of exactly `approve.maintenance.package` or `approve.maintenance.extension` for project `*`, when the package runs no install scripts; else a decider), `mount` or `network` (broader access: a decider; an allowed site is approved by the owner's rule, a denied site is rejected), `host-policy` or `base` (protected: the owner only). The answer is the maintenance ID at once, before anything is decided or applied. A decided-yes request is applied by the controller and the effect is recorded. Install scripts never run before the approval of this exact request. At most 20 requests of one agent wait at once (settable); the owner may also cap how many requests of one agent are accepted per day, however they are decided (`requestsPerDay`, no cap by default). A name has no `/`, `..`, leading `.` or `@` (a package may be `@scope/name`); the version is exact (no tag or range); the source is an https URL without credentials, and the applier must verify the fetched artifact against `digest`. A mount `resource` is `<your agent key>.name` (yours) or `shared.name`; only the owner decides another's resource or write access to a shared one. A supervisor never decides for an agent it created or whose supervisor it set.

Arguments:

- `agentId` (optional): the agent (an agent's own by default)
- `kind`: skill, package, extension, mount, network, host-policy or base
- `spec`: skill `{ name, digest }`; package or extension `{ name, version, digest, source, installScripts }`; mount `{ mountPath, resource, mode: read|write }`; network `{ site, port? }`; host-policy `{ setting, change }`; base `{ change, digest? }`
- `reason`: why (1 to 500 characters)
- `rollbackPlan` (optional): how the change is undone (required except for skill drafts)
- `commandId`: required

Result: `{ maintenanceId, status, revision, replayed }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.decide`

A decider approves or rejects a waiting request. `specDigest` must be the digest of the request as you read it (the verdict is for that exact package version, source, access, install behaviour and rollback plan). Who decides: the owner always; in a profile other than strict also the requester's supervisor when the owner's `bosses` setting is on, except for host policy and the shared base, which are the owner's alone. Nobody decides their own request. Approval starts the application.

Arguments:

- `maintenanceId`: the request
- `verdict`: approve or reject
- `specDigest`: the request's `specDigest`
- `note` (optional): a short reason
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision, status }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.revoke`

Takes a maintenance change back: a waiting or approved request is ended (the requester may withdraw its own); an applied one is reverted by the controller and the revert is recorded. The owner may revoke any; the requester's supervisor what a supervisor may decide.

Arguments:

- `maintenanceId`: the request
- `reason`: why
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision, status }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.apply`

Owner only: tries again to apply an approved request that is waiting (the applier could not take it, or safe restoration was not possible). It does nothing for a request that is not approved.

Arguments:

- `maintenanceId`: the request
- `commandId`: required

Result: `{ status }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.settings.set`

Owner only: sets any of `requests`, `bosses`, `rules` (true, false, or null for the profile's default), `bossKinds` (the kinds supervisors may decide: package, extension, mount, network; none by default, and a supervisor never decides for an agent it created or whose supervisor it set), `leaseMinutes` (how long an application claim lasts without a heartbeat; default 30), `requestsPerDay` (requests per agent per day; no cap by default, 0 or null for none; the owner is exempt), `pendingPerAgent` (requests of one agent waiting at once, default 20, 0 = no cap), `attempts` (application tries before a request fails, default 5), `applyTimeoutMinutes` (how long an application may run before it is marked uncertain and verified or reverted, default 60, 0 = no timeout), `closeWaitSeconds` (how long a shutdown waits for running applications, default 30, 0 = until they end), `maxApplies` (applications at once, default 4), `tickSeconds` (how often maintenance work is looked at, default 30); null returns any of them to its default, `sites` (`{ "pypi.org": "allow" | "deny" | null }`; a key may be `host:port` or, for an allow, `*.host`; a deny on a host also covers its subdomains and every port unless a port is named), `catalogueAdd` and `catalogueRemove` (lists of `{ name, version, digest, source, installScripts? }`). A narrowing counts for requests already made, judged by the next maintenance tick (not inside this call): a request approved for a site now denied is rejected and an applied one is reverted. Removing a catalogue entry or switching `rules` off only stops future automatic approvals: packages already applied stay until revoked. Optional `expectedRevision`.

Arguments:

- `requests` (optional): true, false or null
- `bosses` (optional): true, false or null
- `rules` (optional): true, false or null
- `bossKinds` (optional): list of kinds supervisors may decide, or null
- `leaseMinutes` (optional): 1 to 1440 or null
- `requestsPerDay` (optional): 0 to 100000 or null (no cap)
- `pendingPerAgent` (optional): 1 to 1000, 0 for no cap, or null
- `attempts` (optional): 1 to 20 or null
- `applyTimeoutMinutes` (optional): 1 to 1440, 0 for none, or null
- `closeWaitSeconds` (optional): 1 to 3600, 0 for until they end, or null
- `maxApplies` (optional): 1 to 32 or null
- `tickSeconds` (optional): 5 to 3600 or null
- `sites` (optional): map of site to allow, deny or null
- `catalogueAdd` (optional): entries to preapprove
- `catalogueRemove` (optional): entries to remove
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.settings.enable`

Owner only: turns on `requests`, `bosses`, `rules` or `all` of them.

Arguments:

- `what`: requests, bosses, rules or all
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.settings.disable`

Owner only: turns off `requests`, `bosses`, `rules` or `all` of them (the owner still decides). Requests already made are judged again under the new setting.

Arguments:

- `what`: requests, bosses, rules or all
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.site.set`

Owner only: one network site's rule: `allow` (requests for it are approved by themselves), `deny` (rejected; an applied one is reverted) or `clear` (back to the installation profile).

Arguments:

- `site`: a host name such as pypi.org
- `rule`: allow, deny or clear
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.catalogue.add`

Owner only: preapproves one exact package (name, version, digest and https source); a request for exactly that (same source too) is approved by itself. `installScripts` true also preapproves its install scripts.

Arguments:

- `name`: package name
- `version`: exact version
- `digest`: sha256:...
- `source`: the https URL it is fetched from
- `installScripts` (optional): true to preapprove install scripts
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).

#### `maintenance.catalogue.remove`

Owner only: removes one package from the preapproved catalogue. Requests for it are decided by a person again; a package already applied is not reverted by this (revoke its request).

Arguments:

- `name`: package name
- `version`: exact version
- `digest`: sha256:...
- `source`: the https URL it is fetched from
- `expectedRevision` (optional): the revision you read
- `commandId`: required

Result: `{ revision }`.

Completion: finished when accepted (`completed: true`).
