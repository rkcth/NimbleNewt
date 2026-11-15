# State API: a developer's guide with worked examples

[api-v1](api-v1.md) is the reference: every operation, its arguments and its result. It is generated from the code, so it is exact but terse. This guide is the other half: how a program talks to the controller, what each kind of answer means, and what to do about it. Every request and answer shown here is run against a real controller by `packages/controller/src/api/d02-guidance.test.ts` (card D02), so an example that stops being true fails a test. A value written as `proj-...` stands for a real ID the controller made; the test fills it in from the earlier answer.

Where a thing is **not built**, this guide says so. The most important one: **the state API has no HTTP route**. It is in-process (`controller.api.handle(token, request)`); chat, the command line and the web chat are clients of it inside the controller's own process. What a separate program can reach over HTTP today is the conversation listener (threads and messages, and the MCP door), described in [conversation-and-mcp-protocol](conversation-and-mcp-protocol.md).

## Getting a credential

A credential is a token of the form `<principal id>.<secret>`. The secret is 32 random bytes, shown once, and the controller stores only a salted scrypt hash of it, so a copy of the database yields no usable credential. The owner's first credential is made by `PrincipalService.bootstrapOwner` (the launcher does it the first time you start and keeps the token in the operating system's secret store, never in a file). Everyone else is enrolled by the owner and given a credential with `issueCredential`; an agent starts with no rights and no credential. See [security-guide](security-guide.md).

## Calling the API

```js
import { startController } from "@nimblenewt/controller";

const controller = await startController({ storage: { kind: "sqlite", path: "controller.sqlite" }, argv: [], env: {}, print: console.log });
const answer = await controller.api.handle(token, { v: 1, op: "setup.readiness", args: {} });
```

`handle` never throws for a bad request: every refusal is an answer with `ok: false`. The first example is a **query** (it changes nothing, so it needs no `commandId`). On a fresh installation, the owner has an identity and nothing else, so the first thing missing is a project:

```json
{ "v": 1, "op": "setup.readiness", "args": {} }
```

```json
{ "v": 1, "op": "setup.readiness", "ok": true, "result": { "item": { "ready": false, "next": "project" } } }
```

(The real answer lists every setup item with its state and how to set it up; the example shows only the fields it is about. Examples in this guide are shown cut down in this way: every field shown is really there with that value, and fields not shown are omitted.)

## Commands: the command ID makes a retry safe

A **command** changes something and must carry a `commandId` of your choosing. The same ID with the same content is applied once:

```json
{ "v": 1, "op": "project.create", "commandId": "make-garden-1", "args": { "name": "Garden", "goal": "Keep the beds tidy" } }
```

```json
{ "v": 1, "op": "project.create", "ok": true, "result": { "id": "proj-...", "revision": 1, "replayed": false }, "accepted": true, "completed": true, "state": "completed" }
```

If the connection dropped and you do not know whether that arrived, send exactly the same request again. You get the first answer back, marked `replayed: true`, and nothing is made twice:

```json
{ "v": 1, "op": "project.create", "commandId": "make-garden-1", "args": { "name": "Garden", "goal": "Keep the beds tidy" } }
```

```json
{ "v": 1, "op": "project.create", "ok": true, "result": { "id": "proj-...", "revision": 1, "replayed": true }, "accepted": true, "completed": true, "state": "completed" }
```

Re-using an ID for a *different* command is refused, because it is almost certainly a bug in the caller:

```json
{ "v": 1, "op": "project.create", "commandId": "make-garden-1", "args": { "name": "Something else" } }
```

```json
{ "v": 1, "op": "project.create", "ok": false, "error": { "code": "command_conflict" } }
```

A command with no `commandId` is refused with `invalid_command` and `field: "commandId"`. The ID is scoped to the authenticated caller, so two callers choosing the same word never collide. Choose IDs you can reproduce after a restart (for example from the thing you are doing), not random ones, or a retry cannot find the first attempt.

## Reading, and writing against a revision

Every record has a `revision`. Read it, then name it when you change it:

```json
{ "v": 1, "op": "project.get", "args": { "projectId": "proj-..." } }
```

```json
{ "v": 1, "op": "project.get", "ok": true, "result": { "item": { "name": "Garden", "state": "active", "id": "proj-...", "revision": 1 } } }
```

```json
{ "v": 1, "op": "project.update", "commandId": "tidy-goal-1", "args": { "projectId": "proj-...", "expectedRevision": 1, "goal": "Tidy" } }
```

```json
{ "v": 1, "op": "project.update", "ok": true, "result": { "id": "proj-...", "revision": 2, "replayed": false }, "accepted": true, "completed": true, "state": "completed" }
```

If someone else changed the project in between, your write is refused and tells you where things stand. Read again and decide again; never just retry with the new number without looking at what changed:

```json
{ "v": 1, "op": "project.update", "commandId": "tidy-goal-2", "args": { "projectId": "proj-...", "expectedRevision": 1, "goal": "Again" } }
```

```json
{ "v": 1, "op": "project.update", "ok": false, "error": { "code": "stale_revision", "currentRevision": 2 } }
```

## Pages

First a second project, so that there is something to page through:

```json
{ "v": 1, "op": "project.create", "commandId": "make-orchard-1", "args": { "name": "Orchard" } }
```

```json
{ "v": 1, "op": "project.create", "ok": true, "result": { "id": "proj-...", "revision": 1, "replayed": false }, "accepted": true, "completed": true, "state": "completed" }
```

A list takes `limit` (1 to 100, default 20) and `after`. When the answer carries `next`, pass it as `after` to get the following page. **`next` is present whenever a page came back full, including the last full page**: the end is an empty `items`, not a missing `next`.

```json
{ "v": 1, "op": "project.list", "args": { "limit": 1 } }
```

```json
{ "v": 1, "op": "project.list", "ok": true, "result": { "items": [{ "state": "active", "id": "proj-..." }], "next": "proj-..." } }
```

```json
{ "v": 1, "op": "project.list", "args": { "limit": 1, "after": "proj-..." } }
```

```json
{ "v": 1, "op": "project.list", "ok": true, "result": { "items": [{ "state": "active", "id": "proj-..." }], "next": "proj-..." } }
```

```json
{ "v": 1, "op": "project.list", "args": { "limit": 1, "after": "proj-..." } }
```

```json
{ "v": 1, "op": "project.list", "ok": true, "result": { "items": [] } }
```

(Projects are listed in the order of their IDs, which are random, so the page that holds Garden is not always the first. The three list requests above are shown in order; the `after` of the second is the first answer's `next`, and of the third the second's. The test follows them that way.)

## Refusals you should expect

Each of these is a normal answer, not a crash, and the `field` (when present) says where to look.

An unsupported version:

```json
{ "v": 2, "op": "setup.readiness", "args": {} }
```

```json
{ "v": 1, "op": "setup.readiness", "ok": false, "error": { "code": "invalid_command", "field": "v" } }
```

An argument the operation does not have is refused, never ignored (a misspelt option would otherwise do nothing and look as if it had worked):

```json
{ "v": 1, "op": "setup.readiness", "args": { "verbose": true } }
```

```json
{ "v": 1, "op": "setup.readiness", "ok": false, "error": { "code": "invalid_command", "field": "args.verbose" } }
```

An operation that does not exist:

```json
{ "v": 1, "op": "setup.nothing", "args": {} }
```

```json
{ "v": 1, "op": "setup.nothing", "ok": false, "error": { "code": "invalid_command", "field": "op" } }
```

A credential that is not accepted (a wrong or malformed one reads the same, and the answer does not say which):

<!-- as: nobody -->
```json
{ "v": 1, "op": "setup.readiness", "args": {} }
```

```json
{ "v": 1, "op": "setup.readiness", "ok": false, "error": { "code": "unauthenticated" } }
```

A caller who is known but lacks the right. A new agent has no grants, so it may not even read a project (the message names the missing right):

<!-- as: agent -->
```json
{ "v": 1, "op": "project.get", "args": { "projectId": "proj-..." } }
```

```json
{ "v": 1, "op": "project.get", "ok": false, "error": { "code": "forbidden" } }
```

The `forbidden` examples run with an agent's credential; the `unauthenticated` one with a token that was never issued.

## Accepted is not completed

`accepted: true` says the controller has durably recorded your command. `completed: true` says its effect is finished. Every example above is `completed: true` because the recorded change is the whole effect. Some commands (for example `task.assign`) are `completed: false` because another party must act, and then `awaits` says who or what; follow it with `command.state` and the command ID you sent. A client must never tell a person that work is done because a command was accepted.

## Building a client: a checklist

1. Send `v: 1`; treat any other `v` in an answer as a client too old or too new.
2. Give every command a reproducible `commandId`; on a timeout, a dropped connection or `unavailable`, resend the identical request.
3. Name the revision you read; on `stale_revision`, read again.
4. Treat unknown fields in answers as additions (the contract only grows), and unknown `code`s as failures to show, not to retry blindly.
5. Never put a secret (a provider key, a database address) in an argument: store it in the secret store and refer to it by name, as the launcher's `secret set` does.
6. Follow `next` until `items` is empty.
7. Regenerate nothing by hand: [api-v1](api-v1.md) is written by `npm run api:docs:write` from `packages/controller/src/api/operations.ts`.

## Where the pieces are

| What | Where |
| --- | --- |
| The operation table (names, kinds, argument summaries) | `packages/controller/src/api/operations.ts` |
| The entry point `handle` and the envelope | `packages/controller/src/api/state-api.ts` |
| Rights, grants and who may call what | `packages/controller/src/security/` |
| The generated reference | `docs/nimblenewt/api-v1.md` (do not edit by hand) |
