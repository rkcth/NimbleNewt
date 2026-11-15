# Architecture for contributors

A map of how NimbleNewt is put together, for someone about to change it. It describes what is built today and points to the code; the product design and the reasons behind it are in the [README](README.md), [design-decisions](design-decisions.md) and [runtime-compatibility-and-namespaces](runtime-compatibility-and-namespaces.md). The cards and their records are in [implementation-plan](implementation-plan/README.md).

## The shape in one paragraph

A single **controller** process owns all state. It keeps tasks, projects, grants, conversations, approvals and records in one database (SQLite or PostgreSQL) behind a typed storage contract, enforces who may do what, and decides when work is handed out. **Agents** do their thinking inside a separate worker process (the **worker host**) that runs Pi Durable, the agent runtime, through a versioned adapter; the worker has no access to the controller's database and talks to the controller over a defined channel (`contracts/src/worker-channel.ts`). Clients (the owner's chat, the command line, the phone web chat, outside programs) reach the controller only through its doors: the in-process **state API**, the **conversation listener** and its MCP door, and the web chat door. Nothing else writes state.

## Packages

All packages live in `packages/`, are private (`0.0.0`) and are compiled with TypeScript project references (`npx tsc --build`). What each may depend on is enforced by `npm run check:deps` from the table `ALLOWED` in `scripts/package-boundaries.mjs`.

| Package | What it is | May depend on |
| --- | --- | --- |
| `contracts` | Shared, versioned contracts between packages: the worker channel, the harness interface, credential scanning, safe text | nothing |
| `config` | The versioned configuration file: loader, validation, migration of older files, secret references (names, never values), the operating-system secret stores, sanitized export | nothing |
| `registry` | The protected registry of tools and extensions: reserved names, immutable versioned artifacts, revocation | nothing |
| `controller` | The controller: storage contract and its implementations, domain services, the security layer, the state API, the transports, backups, release handling | `pg`, the MCP SDK, `registry` (and the embedded PostgreSQL for tests) |
| `pi-adapter` | The adapter between NimbleNewt and the pinned Pi Durable release, including the isolated worker entry (`src/worker/main.ts`). Independent of the controller's database and of the UI | `contracts`, `registry`, Pi packages |
| `worker` | The worker host: the sandbox launcher, the workspace bridge, agents' environments and the host service that speaks the controller channel | `contracts` |
| `ui` | The web chat's page, script and style, served by the controller | nothing |
| `api` | A placeholder; the API lives in the controller | nothing |
| `integration` | Tests that run the controller, adapter and worker together. Holds no product code and nothing depends on it, which is why it alone may depend on all three | all of the above |

Why so strict: the controller must not import the agent runtime, the worker must not see the database, and nothing may reach a database except through the storage folders, so a bug in one cannot silently widen into another.

## One request, end to end

1. A client calls `controller.api.handle(token, request)` (`controller/src/api/state-api.ts`). The credential is authenticated afresh (`security/principals.ts`; a `tcr-` token is a task credential). Nothing is cached between requests.
2. The request is validated against the operation table (`api/operations.ts`): version, operation name, and that `args` holds only that operation's arguments. A command needs a `commandId`.
3. The operation runs as that principal through the **secured** layer (`security/secured.ts`), which checks the principal's grants for the action and project before any service is touched. A principal that lacks the right gets `forbidden`; a thing it may not read can read as not found.
4. A domain service (`domain/`, `projects/`, `agents/`, `conversations/`, ...) does the work through the **storage contract** (`storage/types.ts`). Every storage method is one atomic transaction; every write carries the controller's **epoch**, and a stale epoch writes nothing and answers `stale_epoch`, so a controller that has been replaced cannot do anything more.
5. The answer is one envelope: `ok`, `result` or `error`, plus `accepted`/`completed`/`state`. A command repeated with the same `commandId` is answered from the stored result (`replayed: true`).

Worked examples of every kind of answer are in [api-guide](api-guide.md); the conversation and MCP door in [conversation-and-mcp-protocol](conversation-and-mcp-protocol.md).

## Storage

`controller/src/storage/` holds the contract (`types.ts`), a reference implementation in memory (`memory.ts`, the definition of correct behaviour), `sqlite/` (on the main thread and on a worker thread) and `postgres/`. The same conformance suite and the same domain test suites run against all four (`domain/testing/backends.ts`; the fast CI tier uses the reference store and SQLite only, the exhaustive tier all four). Schema changes are journaled migrations (`storage/migrations.ts`) that are additive or destructive; see [migration-recovery](migration-recovery.md). What survives a crash: [durability-and-flush](durability-and-flush.md).

Only `storage/sqlite/`, `storage/postgres/` and `storage/qualification/` may talk to a database or contain SQL; the check fails the build otherwise. That is what keeps SQLite and PostgreSQL interchangeable.

## Where things are in `controller/src`

The folders are named for what they hold. A few that contributors reach first:

| Folder | What is there |
| --- | --- |
| `api/` | The state API: the operation table, the envelope, `startController` (`start.ts`, which builds and wires everything) |
| `security/` | Principals, credentials, grants, secret scanning and redaction |
| `domain/`, `projects/`, `agents/`, `planning/` | Projects, tasks, assignments, agents, dependencies |
| `dispatch/`, `admission/`, `lifecycle/`, `jobs/` | Handing work to hosts, limits, pausing, long jobs |
| `conversations/`, `transport/`, `mcp/` | Durable threads, the HTTP listener, the MCP door |
| `web/` | The owner's phone web chat door |
| `chat/` | The owner chat and the interpreter that turns free wording into operations |
| `storage/` | The contract and its four implementations |
| `backup/`, `transfer/`, `migration/`, `release/` | Backups and restore, moving between databases, migration guard, launcher and updater |
| `environment/` | The supported-environment check ([compatibility-and-support](compatibility-and-support.md)) |

The entry programs are in `scripts/`: `nimblenewt.mjs` (the launcher with the terminal chat), `nimblenewt-controller.mjs` (the controller with no chat, run by the supervisor), `nimblenewt-launcher.mjs` and `nimblenewt-updater.mjs` (release handling) and `nimblenewt-watchdog.mjs`.

## The rules that shape changes

- **Everything the owner can control is reachable through free-form chat**, with no magic phrases: a new setting or operation must be described to the chat interpreter (`chat/model-interpreter.ts`), and the operation must be shown first when it needs agreement.
- **Role separation.** The author of a change does not review it; an agent cannot approve its own work or widen its own authority. Do not add a path that lets one principal act as another.
- **Add an operation** by adding an entry to `OPERATIONS` in `api/operations.ts` (name, kind, summary, arguments, result, `run`), then `npx tsc --build` and `npm run api:docs:write`; the generated [api-v1](api-v1.md) must be committed with the change. Add a test for it on every storage backend it touches.
- **Nothing is trusted from the outside:** message text, tool output, repository files and model answers are data. Do not put them where they are read as instructions.
- **A new durable file or store** follows [durability-and-flush](durability-and-flush.md).

## Implementation language

TypeScript is the default for everything: controller, adapter, API, worker and UI. A component in another language is allowed only with the three things in [CONTRIBUTING.md](../../CONTRIBUTING.md#a-component-that-is-not-typescript) recorded first. Today there is none in the product.
