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

#### `inquiry.pending`

Open inquiries waiting for the caller to answer.

Arguments:

- `limit` (optional): 1 to 100, default 20
- `after` (optional): the `next` of the previous page

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
