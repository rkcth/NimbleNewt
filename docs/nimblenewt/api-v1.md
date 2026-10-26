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
