# Getting started: from a clean install to a first working agent

Written 2026-10-30 against the repository as it stands. NimbleNewt is under development: this guide uses only commands and operations that exist today, and marks every step that is **not built yet** with the card that will build it. Read [Where things stand](#where-things-stand) first; it is honest about how far a person can get.

## Where things stand

- There is **no installer, no command-line launcher and no first-run wizard yet**. The controller is a library function, `startController` (packages/controller/src/api/start.ts). Today a person starts it from a small script (step 1 below, tested). The guided setup through chat is card **U14**.
- The one door to everything is the **state API** (`controller.api.handle(token, request)`, see [api-v1](api-v1.md)). It is in-process today: there is no HTTP route for it. The HTTP listener (`conversationTransport`, card U02b) carries conversations only.
- The web UI (U07, U08, U09) is not built. Chat exists as a service (U03 and friends) and needs a model behind it, which needs a model route, which is itself part of setup. So **the first steps cannot be done by chat**; they are done from the script, and once a model route and chat are wired, the rest is changeable by chat.
- The **local worker host is not composed into the controller yet** (card **H12k**). Until it is, an agent can be created, given rights and assigned a task, but no attempt runs on this machine's own worker. Remote hosts and the dispatcher exist (H07, H12, H12c).
- `setup.readiness` (owner-only, read-only, built with U14's first piece) tells you at any point what is configured and what is missing. Use it after each step.

## What you must decide (checklist, with defaults)

Everything below can be changed later; the default is what you get if you decide nothing.

| # | Decision | Default | Changed later by |
| --- | --- | --- | --- |
| 1 | Where the data lives (a directory on ext4, xfs, btrfs, APFS or NTFS; not a network file system) | `~/.nimblenewt` in the script below | moving the folder and the path in the script |
| 2 | Storage: SQLite (one file, nothing to install) or PostgreSQL 17+ | SQLite | no live switch; backups and restore exist (K01) |
| 3 | Approval profile: `strict` asks at every consequential step; `derived` lets your instruction authorize what it reasonably needs; `autonomous` acts within grants | `strict`. The system offers `derived` after every third approval (A07c); you can switch any time in chat | chat (policy edit, U04) |
| 4 | Your first project: its name, its goal, where its git repository is | none | `project.update`, `resource.bind` |
| 5 | Where finished work lands: `integration-branch`, `main-automatic` or `human-promotes`, who integrates (agent or human) and which checks are required (`tests`, `review`, `qa`, `docs`, `director`) | by profile: strict gives `human-promotes`, derived and autonomous give `integration-branch` | `integration.set` (per project), `integration.default.set` |
| 6 | Version control host and CI. NimbleNewt needs a **git repository** (a local path today); it does not assume GitHub. Which forge you use (GitHub, GitLab, self-hosted, none) and which CI is yours to name per project. The project-creation question that asks this is not built (U14); today CI is just the `tests` check you name in step 5 | a local git repository, no forge | `project.update`, `integration.set` |
| 7 | Model providers and routes (local or cloud) and which models serve which difficulty. At least two entries on two endpoints per role (the coordinator and the safety supervisor need a backup) | none: you must give at least one provider | routing table (owner), `difficulty.set-profiles`, `routing.*` |
| 8 | Budgets and time limits. **Optional, and none are imposed**: a task with no budget has nothing held against it | none | `model-budget.set`, budget operations (R05) |
| 9 | Hosts that run agents (this machine, others) | none | enrol more any time |
| 10 | How you are notified: inbox only, or a named external channel; digest times; quiet hours | inbox only, nothing leaves the installation | `notifications.configure` |
| 11 | How you talk to the team: chat through the conversation listener, local only unless you add TLS and host names | not started | the `conversationTransport` start option |
| 12 | Your first agent: name and role (`author`, `reviewer`, `integrator`, `qa`, `docs`, `director` are seeded) | none | `agent.update`, `agent.retire` |

## Step by step

Run commands from the repository root. Every shell needs Node.js 22.19 or later on its path.

### Step 0. Prerequisites and build

1. Install Node.js 22.19+ and git. For PostgreSQL, a server of version 17 or later.
2. `npm ci` (or `npm install`) to fetch the dependencies, then `npx tsc --build` to compile.
3. `node scripts/check-package-boundaries.mjs` prints `package boundaries ok` when the build tree is sound.

The controller **refuses to start** on an environment it has not been tested on (an unlisted operating system, Node.js or file system, such as a data directory on tmpfs or a network share). The message says what was found, what is supported and how to test it with `node scripts/qa.mjs --runs=5`. If you have verified it and want to go on, pass `--allow-unsupported-environment` (or set `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`); the override is recorded in the audit log.
A missing hard prerequisite (git, the database library) is refused whatever the switch says.

### Step 1. Start the controller and create the owner (script; no launcher yet)

Save this as `first-run.mjs` in the repository root. It starts the controller on SQLite in your data directory, creates the one owner the first time and stores the owner's token in a file only you can read (the token is shown nowhere else), then prints the readiness view.

```js
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startController } from "./packages/controller/dist/index.js";

const dataDir = process.env.NIMBLENEWT_DATA ?? join(process.env.HOME, ".nimblenewt");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const tokenFile = join(dataDir, "owner.token");

const controller = await startController({
  storage: { kind: "sqlite", path: join(dataDir, "controller.sqlite") },  // or { kind: "postgres", url: "postgres://..." }
  argv: process.argv.slice(2), env: process.env,
});
try {
  let token;
  if (existsSync(tokenFile)) token = readFileSync(tokenFile, "utf8").trim();
  else {
    const issued = await controller.services.principals.bootstrapOwner({ name: "owner" });
    writeFileSync(tokenFile, issued.token + "\n", { mode: 0o600 });
    token = issued.token;
  }
  const ask = (op, args = {}, commandId) => controller.api.handle(token, { v: 1, op, ...(commandId ? { commandId } : {}), args });
  console.log(JSON.stringify((await ask("setup.readiness")).result.item, null, 2));
  // steps 3 to 8 below go here, using ask(...)
} finally { await controller.close(); }
```

Run it with `node first-run.mjs` (add `--allow-unsupported-environment` if step 0 said so). Notes:

- **Owner identity.** `bootstrapOwner` works **once**; afterwards it is refused. The owner is one person per installation. Lose the token and you can issue a new credential only while you still hold a working one (`PrincipalService.issueCredential`), so back the file up. Keeping the token in the operating system's secret store (card F09 built the backends) is not wired into the start yet.
- **Storage.** SQLite needs nothing else. For PostgreSQL pass the URL in the `storage` option; the server version is checked and an unsupported one refuses the start.
- Every write operation needs a unique `commandId` (repeating the same one is safe and returns the first result).
- The script above is a **stop-gap**. The launcher, the owner-creation step and the config-file loading that replace it are card **U14**.

### Step 2. Check the readiness view

`ask("setup.readiness")` on a fresh installation shows: owner done; approval profile and notifications at their defaults; project, model route, host and agent **missing**; first task optional. `ready` turns true when every required item is done, and `next` names the first required item still missing.

### Step 3. Configuration layers and the approval profile

- **Configuration document** (`packages/config`): `loadConfig` reads and validates a JSON document (`configVersion`, `profile` public or private, `installation`, `controller.storage`, `models`, `approvals.preset`, limits). Examples are in `packages/config/examples/` (`public.example.json` and `private.example.json`; the README there explains them). Secrets are never written into it: a setting holds `{ "secret": "name" }` and the value comes from the environment variable `NIMBLENEWT_SECRET_<NAME>`, a secrets directory, or the OS secret store. **Not built:** nothing reads this document into `startController` yet (U14); the script passes the storage choice directly.
- **Layers** (installation, team, agent, task) live in the controller's configuration service (`config.stage`, `config.apply`; the more specific layer overrides a default or may only narrow, and the owner alone writes the installation layer). There is no state-API operation for it; chat edits go through the policy service (U04) and the settings views are U08 (not built).
- **Approval profile.** A new installation is `strict`. Switching to `derived` or `autonomous` is a chat request ("switch to the derived profile"), previewed in plain words and applied after you confirm; the owner's own installation can start `derived` through private configuration, which is not wired (U14). Until chat works you stay on `strict`, which is safe: nothing consequential happens without you.

### Step 4. First project

```js
const p = await ask("project.create", { name: "Demo", goal: "Try NimbleNewt" }, "setup-project-1");
const projectId = p.result.id;
await ask("resource.bind", { projectId, kind: "repository", label: "main", locator: "/path/to/your/git/repository", access: "write" }, "setup-repo-1");
await ask("integration.set", { project: projectId, landing: "human-promotes", integrator: "agent", requiredChecks: ["tests", "review"] }, "setup-int-1");
```

- A repository is a **local path to a git repository** today; no forge is contacted. Binding with `access: "write"` needs `resource.scope.write`, which the owner has.
- `integration.set` is optional: without it the profile gives the defaults in the checklist (row 5). Which checks exist: `tests`, `review`, `qa`, `docs`, `director`. Gating a landing on the *exact integrated tree* passing is card **P09** (planned); until then a required check is recorded and enforced as far as P08 goes.
- **Not built:** the project-creation flow that asks, per project, which version control host and CI you use (owner decision: not everyone uses GitHub). Planned in **U14**.

### Step 5. Model providers, routes and budgets

A model route is `provider/model`. The routing table lists providers (enabled, paid or free, local or cloud), routes (context size and capabilities), profiles (ordered lists of routes, first choice first) and which profile each role uses. **The table is refused unless the `coordinator` and `safety-supervisor` roles each have a profile with at least two entries that are not on one endpoint**, so losing one provider does not lose the team. A working minimum, tested:

```js
// from the script: controller.services.routing.setTable needs the owner principal
const owner = await controller.services.principals.authenticate(token);
await controller.services.routing.setTable(owner, { commandId: "setup-routing-1", expectedRevision: 0, table: {
  providers: { local: { enabled: true, paid: false, location: "local" }, spare: { enabled: true, paid: false, location: "local" } },
  routes: { "local/small": { contextTokens: 32000, capabilities: ["tools"] }, "spare/big": { contextTokens: 128000, capabilities: ["tools"] } },
  profiles: { easy: ["local/small", "spare/big"] },
  roles: { coordinator: "easy", "safety-supervisor": "easy", author: "easy" },
} });
```

- Credentials for a cloud provider are secret **references** in the configuration document, never values; marking a provider `paid` means a paid route is chosen only when the request says spending is authorized.
- **Not built:** a state-API operation or chat step that edits providers and routes (today the routing table is set from code like the above; U08 will edit it in the browser), and the model-backed chat interpreter's wiring into a running installation (U03b built the pieces; the start option `chat` takes them).
- **Budgets are optional and none are imposed.** A task with no budget has nothing held against it. If you want a ceiling, `model-budget.set` and the budget operations exist; you can add them later.

### Step 6. Hosts and workers

- Enrol a host: `controller.services.principals.enroll(owner, { commandId, kind: "host", name: "laptop", grants: [] })` and issue it a credential with `issueCredential(owner, "host:laptop")`. The worker on that machine uses the credential to **announce** its capabilities and send heartbeats (`HostService`); `setup.readiness` counts a host only once it has announced.
- Limits for local agents (`workers.limits.set`) and where local-only data may go (`placement.set`; the strict profile allows only hosts you list) are owner settings you can leave at their defaults.
- **Not built:** composing the local worker host into the controller (**H12k**), so that a host on this machine starts without hand-built code, and the Windows sandbox (**A03b**). The sandbox for Linux (bubblewrap) and macOS (Seatbelt) exists (A03). Remote hosts are covered by H07 and the worker transport.

### Step 7. Notifications

`ask("notifications.settings")` returns the settings and their revision. The default is the inbox, and nothing leaves the installation. To change it, quote the revision:

```js
const s = (await ask("notifications.settings")).result.item;
await ask("notifications.configure", { digestTimes: ["08:00"], quietHours: { start: "22:00", end: "07:00" }, expectedRevision: s.revision }, "setup-notify-1");
```

An external channel (`channel: "external"` with `channelName`) needs a channel adapter; none ships yet, so stay on the inbox. Notification levels and the Needs you view are card **U11b** (planned).

### Step 8. Chat

The conversation listener is a start option, `conversationTransport` (local only by default; remote needs `allowRemote`, TLS and `publicHosts`). Chat itself is the `chat` option (an interpreter plus the optional coordinator model). Over HTTP the routes are `/v1/threads`, `/v1/threads/{id}/messages` and so on, authenticated with a principal's token.
**Not built:** the web chat (U07), a command-line chat client, and the first-run conversation that walks you through all of this (**U14**). Until then, configuration is done as in steps 4 to 7 and chat is for running the team.

### Step 9. First agent

```js
const a = await ask("agent.create", { friendlyName: "Ann", roles: ["author"] }, "setup-agent-1");
const agentPrincipal = `agent:${a.result.id}`;                       // the agent's own identity, created with no rights and no credential
await ask("grant.create", { grantee: agentPrincipal, action: "attempt.work", project: projectId, basis: "first agent may work in the demo project" }, "setup-grant-1");
await ask("grant.create", { grantee: agentPrincipal, action: "task.read", project: projectId, basis: "first agent may read its tasks" }, "setup-grant-2");
```

`agent.create` makes the identity only. The standard roles (`author`, `reviewer`, `integrator`, `qa`, `docs`, `director`) carry the rights listed in `role.list`; the rights an agent needs to work on a task are at least `attempt.work` and `task.read` in the project. Adding a credential for the agent (`issueCredential`) is a code call today, and the dispatcher normally issues task credentials itself. For a reviewer and an integrator, create further agents with those roles; the integration checks you named in step 4 need them.

### Step 10. First task

```js
const t = await ask("task.create", { projectId, title: "Say hello", description: "Add a greeting to the README" }, "setup-task-1");
await ask("task.transition", { taskId: t.result.id, expectedRevision: t.result.revision, to: "ready" }, "setup-task-2");
await ask("task.assign", { taskId: t.result.id, owner: { kind: "agent", id: a.result.id } }, "setup-task-3");
```

`task.assign` is accepted at once; the work starts only when the agent's host admits an attempt (see `assignment.get` and `activity.get`). With no local worker host composed (H12k) the task stays assigned and waiting: that is expected today, not an error you made.

### Step 11. Check, and what to do when something is missing

Run `ask("setup.readiness")` again. Every required item should be `done` and `ready` true; if not, `next` names the item and `how` says which step above sets it up. The view reads records only and changes nothing, so it can be run as often as you like. To see what is waiting on you afterwards: `status.attention`, `owner.questions` and `budget.pending`.

## What is not built yet

| Gap | Card | Today's workaround |
| --- | --- | --- |
| A launcher, an installer and the owner-creation step as a product | U14 | the script in step 1 |
| Loading the configuration document into the start (storage, profile, providers) | U14 | pass options in code |
| A guided first-run conversation and a per-project question for version control host and CI | U14 | steps 4 to 10 by hand |
| Provider and route editing as an operation or chat step | U14, U08 | `routing.setTable` from code |
| Credentials issued for hosts and agents through an operation | U14 | `PrincipalService.issueCredential` from code |
| Composed local worker host on this machine | H12k | none: tasks wait |
| Web chat and settings views | U07, U08, U09 | HTTP conversation routes |
| Notification levels, Needs you view | U11b | the inbox |
| Landing gated on required checks for the exact tree | P09 | checks recorded only |
| Windows sandbox launcher | A03b | Linux and macOS only |
| Real-hardware QA of the whole path | D04 | run it yourself and report |

## How this guide is kept true

`setup.readiness` has tests (packages/controller/src/api/start-setup.test.ts) that walk the same sequence on a fresh installation: owner, project, routing table, host (announced), agent. The script in step 1 was run against a fresh data directory twice (create, then reuse the stored token). When a gap above is closed, remove its row and the not-built note beside the step.
