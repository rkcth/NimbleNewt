# Getting started: from a clean install to a first working agent

Written 2026-10-30, updated for the launcher and first-run chat (card U14) and for credentials and the local worker host (card U14b) 2026-11-11. NimbleNewt is under development: this guide uses only commands and operations that exist today, and marks every step that is **not built yet**. Read [Where things stand](#where-things-stand) first; it is honest about how far a person can get.

## Where things stand

- A **controller entry** exists for running without a terminal chat (`node scripts/nimblenewt-controller.mjs --data DIR`, the program the release launcher runs; see [maintenance-and-updates](maintenance-and-updates.md)). Agents' environment changes are off unless `--local-host-environments` (or `NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS=1`) is given to it or to `nimblenewt.mjs start`.
- A **launcher** exists (`scripts/nimblenewt.mjs`, card U14): `init` writes a configuration file that holds no secret, `start` loads it, starts the controller, makes you the owner the first time (your credential goes into the operating system's secret store, never into a file you must guard) and opens the **chat in your terminal**. `secret set NAME` puts a model key or a database address into the secret store. From there the setup is a conversation: see [Quick start](#quick-start-the-launcher-and-the-chat).
- The one door to everything is still the **state API** (`controller.api.handle(token, request)`, see [api-v1](api-v1.md)); the chat is a client of it. It is in-process: there is no HTTP route for the API. `--serve` adds the conversation listener (`conversationTransport`, card U02b), local only.
- The phone web chat (U07, first slice, see [private-web-chat](private-web-chat.md)) is built; the settings views (U08, U09) are not. The chat needs a model, so **one model server must be named before the chat can answer** (`init --model-endpoint ...`, or the configuration's `models.providers`); everything after that is done by chat, and every answer is changeable later by chat.
- The **local worker host is composed at start-up only from code** (card **H12k**): the launcher does not build one, so an agent can be created, given rights and assigned a task, but no attempt runs on this machine until a host is composed (`dispatch.local.build`, see `packages/integration/src/h12k-composed-host.test.ts`; the ready-made product composition is card H12t). `setup.readiness` shows the host as open until then.
- `setup.readiness` (owner-only, read-only) tells you at any point what is configured and what is missing, in the order a person sets things up, with the plain question, a recommended answer and what declining means for each step. The chat shows the same view as the status kind `setup`.

## Quick start: the launcher and the chat

On a clean machine with Node.js 22.19+ and git, from the repository root (`npm ci`, `npx tsc --build` first):

```
node scripts/nimblenewt.mjs init --model-endpoint http://127.0.0.1:8000/v1 --model my-local-model \
     --backup-endpoint https://free-route.example.org/v1 --backup-model free-model --backup-key-secret backup-key
node scripts/nimblenewt.mjs secret set backup-key      # the key is typed hidden, or piped in; it is never written to the configuration
node scripts/nimblenewt.mjs start
```

- `init` writes `~/.nimblenewt/nimblenewt.config.json` (or `--data DIR`, or `NIMBLENEWT_DATA`) with SQLite storage, strong isolation, the strict approval profile and no remote exposure. Use `--postgres-secret NAME` to choose PostgreSQL (its address is a secret you set the same way). `start` without a configuration writes a starter one with no model.
- `start` prints which secret store holds your credentials, makes the owner on the first start, registers the configuration's model providers (a provider needs a model server, and **at least two routes on two different servers are required** so that losing one does not stop the team; the second can be a free cloud route), and shows the setup list: `[x]` done, `[-]` a default that works, `[ ]` open.
- Then talk in your own words: "help me get started", "my project is in /home/me/shop, it lives on our own Gitea with Jenkins", "use my local model at http://127.0.0.1:8000/v1 and a free route at https://...". Each change that decides where data goes, who may do what, or what exists is **shown first and applied only when you say so**; nothing is applied unasked. A key typed into the chat is refused before any model sees it; give the provider only the **name** of the secret.
- The chat works through the list in order: approval profile (explained in plain words; it stays strict if you decline), first project and repository, per project the version control host and CI (GitHub, GitLab, a self-hosted forge, or none; nothing assumes GitHub, and a project may have no remote or no repository), model providers and routes, the host, the notification channel, the first agent and its role and rights, the first task. Budgets and time limits are offered and left off unless you set them. Declining a step leaves it unset and the system still works.
- Stop it (Ctrl-D) at any point: the next `start` reads the same owner back from the secret store and the setup list resumes at the first open step. `status` prints the list and stops.

The sections below describe each decision and the operations behind the chat, for people who want to do a step by hand or by script.

## What you must decide (checklist, with defaults)

Everything below can be changed later; the default is what you get if you decide nothing.

| # | Decision | Default | Changed later by |
| --- | --- | --- | --- |
| 1 | Where the data lives (a directory on ext4, xfs, btrfs, APFS or NTFS; not a network file system) | `~/.nimblenewt` in the script below | moving the folder and the path in the script |
| 2 | Storage: SQLite (one file, nothing to install) or PostgreSQL 17+ | SQLite | no live switch; backups and restore exist (K01) |
| 3 | Approval profile: `strict` asks at every consequential step; `derived` lets your instruction authorize what it reasonably needs; `autonomous` acts within grants | `strict`. The system offers `derived` after every third approval (A07c); you can switch any time in chat | chat (policy edit, U04) |
| 4 | Your first project: its name, its goal, where its git repository is | none | `project.update`, `resource.bind` |
| 5 | Where finished work lands: `integration-branch`, `main-automatic` or `human-promotes`, who integrates (agent or human) and which checks are required (`tests`, `review`, `qa`, `docs`, `director`) | by profile: strict gives `human-promotes`, derived and autonomous give `integration-branch` | `integration.set` (per project), `integration.default.set` |
| 6 | Version control host and CI. NimbleNewt needs a **git repository** (a local path today); it does not assume GitHub. Which forge you use (GitHub, GitLab, self-hosted, none) and which CI is yours to name per project. The chat asks it per project and records `versionControl`; the required checks you name in step 4 are what gates landing | a local git repository, no forge | `project.update`, `integration.set` |
| 7 | Model providers and routes (local or cloud) and which models serve which difficulty. At least two entries on two endpoints per role (the coordinator and the safety supervisor need a backup) | none: you must give at least one provider | routing table (owner), `difficulty.set-profiles`, `routing.*` |
| 8 | Budgets and time limits. **Optional, and none are imposed**: a task with no budget has nothing held against it | none | `model-budget.set`, budget operations (R05) |
| 9 | Hosts that run agents (this machine, others). This machine: tell the chat to run agents on this computer (`host.local.set`, off until you say so, counts from the next start; Linux with bubblewrap). Another machine: ask the chat for a credential (`credential.issue`, shown to you once) | none | enrol more any time |
| 10 | How you are notified: inbox only, or a named external channel; digest times; quiet hours | inbox only, nothing leaves the installation | `notifications.configure` |
| 11 | How you talk to the team: the owner chat in a phone browser (`webChat`: private network only, never public; [guide](private-web-chat.md)), and chat through the conversation listener (local only unless you add TLS and host names) | not started | the `webChat` and `conversationTransport` start options |
| 12 | Your first agent: name and role (`author`, `reviewer`, `integrator`, `qa`, `docs`, `director` are seeded). Its credential, if something outside NimbleNewt must act as it, is `credential.issue` (shown once; `credential.revoke` takes it back) | none | `agent.update`, `agent.retire` |

## Step by step

Run commands from the repository root. Every shell needs Node.js 22.19 or later on its path.

### Step 0. Prerequisites and build

1. Install Node.js 22.19+ and git. For PostgreSQL, a server of version 17 or later.
2. `npm ci` (or `npm install`) to fetch the dependencies, then `npx tsc --build` to compile.
3. `node scripts/check-package-boundaries.mjs` prints `package boundaries ok` when the build tree is sound.

The controller **refuses to start** on an environment it has not been tested on (an unlisted operating system, Node.js or file system, such as a data directory on tmpfs or a network share). The message says what was found, what is supported and how to test it with `node scripts/qa.mjs --runs=5`. If you have verified it and want to go on, pass `--allow-unsupported-environment` (or set `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`); the override is recorded in the audit log.
A missing hard prerequisite (git, the database library) is refused whatever the switch says.

### Step 1. Start the controller and create the owner (by hand; the launcher does this for you)

This is what the launcher does, written out. Save this as `first-run.mjs` in the repository root. It starts the controller on SQLite in your data directory, creates the one owner the first time and stores the owner's token in a file only you can read (the token is shown nowhere else), then prints the readiness view.

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

- **Owner identity.** `bootstrapOwner` works **once**; afterwards it is refused. The owner is one person per installation. Lose the token and you can issue a new credential only while you still hold a working one (`PrincipalService.issueCredential`), so back the file up. The launcher keeps the token in the operating system's secret store (card F09's backends: Keychain, DPAPI, the Linux Secret Service, or an owner-only file where none exists); this script keeps it in a file for simplicity. If the store cannot keep it, the launcher makes no owner. A crash in the instant between making the owner and storing the token loses the token (it is shown once); restore the installation from a backup or start with a fresh data directory.
- **Storage.** SQLite needs nothing else. For PostgreSQL pass the URL in the `storage` option; the server version is checked and an unsupported one refuses the start.
- Every write operation needs a unique `commandId` (repeating the same one is safe and returns the first result).
- The launcher (`scripts/nimblenewt.mjs`) replaces this script; it passes the storage choice, the transfer targets and the secrets from the configuration file.

### Step 2. Check the readiness view

`ask("setup.readiness")` on a fresh installation shows: owner done; approval profile and notifications at their defaults; project, model route, host and agent **missing**; first task optional. `ready` turns true when every required item is done, and `next` names the first required item still missing.

### Step 3. Configuration layers and the approval profile

- **Configuration document** (`packages/config`): `loadConfig` reads and validates a JSON document (`configVersion`, `profile` public or private, `installation`, `controller.storage`, `models`, `approvals.preset`, limits). Examples are in `packages/config/examples/` (`public.example.json` and `private.example.json`; the README there explains them). Secrets are never written into it: a setting holds `{ "secret": "name" }` and the value comes from the environment variable `NIMBLENEWT_SECRET_<NAME>`, a secrets directory, or the OS secret store. The launcher reads the storage choice, the database-transfer targets and the model providers (`models.providers`: address, models, the secret's name) from it. The launcher also reads `approvals.preset` once, for an installation with no approval policy yet (a profile you set by chat is never replaced by the file; `strict` needs no record). Not read from it: the grants and the limits of the document (use chat for rights and limits; see the notes for cards U14 and U14b).
- **Layers** (installation, team, agent, task) live in the controller's configuration service (`config.stage`, `config.apply`; the more specific layer overrides a default or may only narrow, and the owner alone writes the installation layer). There is no state-API operation for it; chat edits go through the policy service (U04) and the settings views are U08 (not built).
- **Approval profile.** A new installation is `strict`. Switching to `derived` or `autonomous` is a chat request ("switch to the derived profile"), previewed in plain words and applied after you confirm; the owner's own installation cannot yet start `derived` from the configuration file (the file's `approvals.preset` is not read by the launcher); ask for it in chat. Until chat works you stay on `strict`, which is safe: nothing consequential happens without you.

### Step 4. First project

```js
const p = await ask("project.create", { name: "Demo", goal: "Try NimbleNewt", versionControl: { host: "none" } }, "setup-project-1");
const projectId = p.result.id;
await ask("resource.bind", { projectId, kind: "repository", label: "main", locator: "/path/to/your/git/repository", access: "write" }, "setup-repo-1");
await ask("integration.set", { project: projectId, landing: "human-promotes", integrator: "agent", requiredChecks: ["tests", "review"] }, "setup-int-1");
```

- A repository is a **local path to a git repository** today; no forge is contacted. Binding with `access: "write"` needs `resource.scope.write`, which the owner has.
- `integration.set` is optional: without it the profile gives the defaults in the checklist (row 5). Which checks exist: `tests`, `review`, `qa`, `docs`, `director`. Gating a landing on the *exact integrated tree* passing is card **P09** (planned); until then a required check is recorded and enforced as far as P08 goes.
- **Version control host and CI** are recorded per project (`versionControl` on `project.create` and `project.update`): `{ host: "github" | "gitlab" | "self-hosted" | "none", hostName?, ci? }`. `hostName` names a self-hosted forge such as Gitea; `none` is a repository with no remote; `ci` is the label you use (`GitHub Actions`, `Jenkins`, `none`). The record changes no behaviour by itself and assumes no forge; `setup.readiness` lists the projects that have not been asked. A project may also have no repository at all.

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
- **Providers by operation or chat:** `routing.provider.add` (owner only, always shown first in chat) adds or replaces whole providers in one step: name, `local` or `cloud`, paid or not, the model server's address, its models and context window, and `credentialName`, the **name** of the secret that holds its key (a key, or an address with a password, is refused). `kind` says what the model server is (`llama-cpp`, `vllm`, `radiance`, `strata`, `openai`, `openai-compatible`, `claude` or `generic`; an unknown one is refused, and it is never guessed from a name or address): it decides in which request fields a route's reply limit and reasoning cap (`routing.budget.set`) are sent, and without it they are not sent and the task's activity says so. The configuration's `models.providers.<name>.kind` records the same, but only when the launcher registers the configuration's providers, which it does only while there is no routing table yet; after that, tell the chat the kind (a kind added to the configuration later is not read). A kind in the cache endpoint configuration (`dispatch.cache.endpoints`) comes before the provider's. It writes the routing table, the `default` profile (free and local routes first) for the coordinator, the safety supervisor and the author unless they already have another, and the address record in one step; fewer than two routes on two servers is refused in plain words. The launcher's chat reads the addresses and fetches the key from the secret store at each call. The model relay of the local worker host reads the same records at each call (card U14b), so editing a provider by chat moves the agents' model calls to the new address with the named key; only the cache endpoint configuration (`dispatch.cache.endpoints`) is still the host's.
- The model-backed chat interpreter is wired by the launcher (the `chat` start option) to the first local route, or a cloud route when no local one exists.
- **Budgets are optional and none are imposed.** A task with no budget has nothing held against it. If you want a ceiling, `model-budget.set` and the budget operations exist; you can add them later.

### Step 6. Hosts and workers

- **A second agent that questions finished work.** When an agent says its work is done, a second model call (no tools, none of the agent's conversation, it cannot approve anything) can question the agent's report first. It is **off until you name the route** (the setting `report.reviewerRoute`, a route from your routing table; say for example "let local/qwen question what the agents say they finished", shown first, applied when you agree; "stop questioning the reports" turns it off). Naming a route also lets the task's title, contract, report and notes go to that route, even a cloud or paid one, within the daily cap on the controller's own model calls. With no route set, or one the routing table cannot use, each done's report says that no second agent questioned it; that is not a pass, and the done is then taken on the controller's own checks. The launcher supplies the model client (the same one the chat uses, over your recorded provider addresses).
- **This computer.** Tell the chat you want agents to run on this computer (`host.local.set`, owner only, shown first, **off until you say so**). It counts from the next start: the launcher then builds the worker host itself (`scripts/local-host.mjs`): it enrols `host:local` and keeps its credential in memory only, announces it, declares half of this machine's CPUs and memory as its capacity (once; change it with the capacity limits) and runs each agent in a sandbox. It loads or switches no model: its routes are the providers you set up, their addresses are read from your provider records at each call (so a provider you edit by chat is used at once) and each key from the secret store by the credential's NAME at each call. If this machine cannot do it (Linux with bubblewrap and a Node.js installed in a folder of its own, not `/usr`), the start says why and tasks wait. A task needs a project whose repository is a **local git folder** (the host makes each task's checkout from it).
- **Another machine, or an agent's own credential.** Ask the chat for a credential (`credential.issue`, owner only, shown first): `kind` host with a `name` (a new host is enrolled with no rights) or `kind` agent with the agent's ID. The credential is written **once** to your terminal chat and kept nowhere: only its hash is stored, it is in no chat record, log or file, a repeated request cannot show it again, and the web page, which keeps what it receives in the browser, is refused it. Put it in the secret store of the machine or agent that uses it. Issuing again replaces the credential at once; `credential.revoke` takes one away (the agent or host stays); `grant.revoke` takes a right back. Issuing gives no rights: use `grant.create`. The worker on that machine uses the credential to **announce** its capabilities and send heartbeats (`HostService`); `setup.readiness` counts a host only once it has announced.
- Every route that work runs on needs a known context window: the host's own figure (`dispatch.local.window`, or `window` on each entry of `dispatch.remote.hosts`), else the route's `contextTokens` in the routing table (Step 5). An attempt on a route neither states is refused before its first call, on local and remote hosts alike, with a `context_overflow` blocker naming the route (cards C07n, C07o).
- Limits for local agents (`workers.limits.set`) and where local-only data may go (`placement.set`; the strict profile allows only hosts you list) are owner settings you can leave at their defaults.
- **Not built:** the product workspace composition for projects without a local git folder (H12t), the worker host on macOS and Windows (the Linux host is built; the macOS Seatbelt and Windows sandboxes exist but are not composed by the launcher yet), and the Windows sandbox (**A03b**). The sandbox for Linux (bubblewrap) and macOS (Seatbelt) exists (A03). Remote hosts are covered by H07 and the worker transport.

### Step 7. Notifications

`ask("notifications.settings")` returns the settings and their revision. The default is the inbox, and nothing leaves the installation. To change it, quote the revision:

```js
const s = (await ask("notifications.settings")).result.item;
await ask("notifications.configure", { digestTimes: ["08:00"], quietHours: { start: "22:00", end: "07:00" }, expectedRevision: s.revision }, "setup-notify-1");
```

An external channel (`channel: "external"` with `channelName`) needs a channel adapter; none ships yet, so stay on the inbox. Notification levels and the Needs you view are card **U11b** (planned).

### Step 8. Chat

The conversation listener is a start option, `conversationTransport` (local only by default; remote needs `allowRemote`, TLS and `publicHosts`). Chat itself is the `chat` option (an interpreter plus the optional coordinator model). Over HTTP the routes are `/v1/threads`, `/v1/threads/{id}/messages` and so on, authenticated with a principal's token.
The terminal chat is part of the launcher (`start`); the first-run conversation walks you through all of this using the `setup` status view. The phone web chat (U07) is a separate door: see [private-web-chat](private-web-chat.md).

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

`task.assign` is accepted at once; the work starts only when the agent's host admits an attempt (see `assignment.get` and `activity.get`). If the start script passes no `dispatch.local.build` (H12k), no local worker host runs and the task stays assigned and waiting: that is expected, not an error you made.

### Step 11. Check, and what to do when something is missing

Run `ask("setup.readiness")` again. Every required item should be `done` and `ready` true; if not, `next` names the item and `how` says which step above sets it up. The view reads records only and changes nothing, so it can be run as often as you like. To see what is waiting on you afterwards: `status.attention`, `owner.questions` and `budget.pending`.

## What is not built yet

| Gap | Card | Today's workaround |
| --- | --- | --- |
| An installer package (the launcher runs from a checkout) | U14 follow-up | `node scripts/nimblenewt.mjs` |
| The configuration's approval **grants** and **limits** are not read by the launcher (its approval **preset** is, once, for an installation with no policy yet; U14b) | U14 follow-up | ask in chat; limits by their operations |
| The worker host on macOS and Windows, and for a project with no local git folder (the Linux host and credentials by operation are built, U14b) | U14 follow-up, H12r, H12t | on Linux: tell the chat to run agents on this computer |
| Settings views | U08, U09 | HTTP conversation routes |
| Notification levels, Needs you view | U11b | the inbox |
| Landing gated on required checks for the exact tree | P09 | checks recorded only |
| Windows sandbox launcher | A03b | Linux and macOS only |
| Installing and enabling the release launcher as a service on a real macOS, Linux or Windows machine (the unit text and install steps are printed by `scripts/nimblenewt-service.mjs`, and `scripts/nimblenewt-updater.mjs` stages and announces a release; see [maintenance-and-updates](maintenance-and-updates.md)); exit-code-aware restarts on macOS and Windows; the full maintenance sequence | K02 follow-up | run the printed steps yourself | Also: the controller entry the launcher runs is `scripts/nimblenewt-controller.mjs` (run by hand: `node scripts/nimblenewt-controller.mjs --data DIR`); see maintenance-and-updates.
| Real-hardware QA of the whole path | D04 | run it yourself and report |
| Backups, signing, the model reviewer client, cache pins and other start options that only code passes (see the production wiring notes) | production wiring follow-up | not available from a configuration yet |

## How this guide is kept true

`setup.readiness` has tests (packages/controller/src/api/start-setup.test.ts and start-setup-u14.test.ts) that walk the same sequence on a fresh installation: owner, project, routing table, host (announced), agent. The launcher is tested in packages/integration/src/u14-launcher.test.ts: first start, restart, a store that cannot keep the credential, and the whole chat path from a clean data directory to a first project, agent and task with a scripted model server; and scripts/nimblenewt.test.mjs. The quick start was also run by hand against a fresh data directory twice (create, then reuse the stored credential). When a gap above is closed, remove its row and the not-built note beside the step.
