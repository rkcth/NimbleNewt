# Security guide for developers and operators

This is the security model as it is **built today**, in the order a reader needs it. It is the companion of [SECURITY.md](../../SECURITY.md), which says how to report a problem. Where something is planned and not built, it says so. The older design text in [authorization-and-delegation](authorization-and-delegation.md) and [pitfalls-and-safeguards](pitfalls-and-safeguards.md) is the source of the intent; the section "Known limits" below is the honest list of what is not yet true.

## Who can do what: principals, credentials and grants

- **Principals.** Everything that acts is a principal: the owner (`owner:<name>`), agents (`agent:<id>`), hosts that run agents, services and outside clients. The owner is made once, by `PrincipalService.bootstrapOwner`; the launcher does it for you on first start. Everyone else is enrolled by the owner, with only the grants the owner gives (none unless named) and **no credential** until one is issued; the controller's own dispatcher service is the one principal it provisions itself.
- **Credentials.** A credential is a token `<principal id>.<secret>`. The secret is 32 random bytes, shown once. The database keeps only a salted scrypt hash, compared in constant time, and a wrong, unknown or disabled credential, or a token the service cannot parse, takes about as long as a right one to refuse (at the listener a request with no well-formed `Bearer` header is refused at once, which says nothing about any credential), so a copy of the database yields no usable credential and timing says nothing. Principal IDs never contain a dot. Task credentials (prefix `tcr-`) are narrower still: they belong to one task. Source: `packages/controller/src/security/credentials.ts`.
- **Grants.** A right is a grant of an action in a project (for example `conversation.send` in one project). Every call is checked against the caller's grants on every request; nothing is cached across requests. A principal sees and changes only what its grants allow. In the state API a caller other than the owner cannot tell a record it may not read from one that does not exist: for projects and tasks both answer `forbidden` (for a project the message names the missing right), and some operations answer `not_found` for both, as their text in [api-v1](api-v1.md) says ([api-guide](api-guide.md) shows a `forbidden`).
- **The owner's gates.** A new installation starts in the **strict** approval profile: consequential changes, external effects, executable installation and access changes ask the owner. The profile and each grant are changed by chat or the API, shown first and applied only when the owner agrees. An agent cannot approve its own work, widen its own grants or edit the gates; role separation is enforced in the controller, not by agent good behaviour.
- **Protected branches.** Pushes and merges that change a protected branch (by default `main` and `master`) stay a decision for the owner whatever a worker says (`project.branches.get`).

## Secrets

- Provider keys and database addresses are kept in the **operating system's secret store** (the macOS Keychain, the Linux Secret Service, Windows DPAPI, or a protected file where none exists), looked up by a configured name. A service manager may supply a secret in the environment as `NIMBLENEWT_SECRET_<NAME>` instead. The configuration file holds only the name. Nothing secret is printed or passed in a command-line argument. `node scripts/nimblenewt.mjs secret set NAME` reads a value from the terminal without echo, or from standard input.
- A model server address with a user name, password, query or fragment is refused when NimbleNewt writes it to the configuration (setup or the command line); a hand-edited file is refused only for an embedded user name or password. The reason: a key there would be stored in the clear.
- Text that passes through the controller (tool results, notes, logs) is scanned and credentials are removed before it is stored or shown (`security/redact.ts`, `security/secret-scan.ts`). That is a safety net, not permission to put secrets in arguments.
- Backups can be encrypted and are signed; an encrypted backup's unlock material is not in the backup. See [maintenance-and-updates](maintenance-and-updates.md) and [migration-recovery](migration-recovery.md).

## What is exposed on the network

- **Nothing by default.** The state API is in-process: there is no HTTP route for it. The conversation listener (threads, messages, the MCP door) exists only when it is switched on, binds to loopback, and refuses any other address unless remote exposure is asked for with TLS and public host names. The phone web chat is off unless configured; it listens on loopback behind a TLS proxy you set up, or on a private-network address with TLS ([private-web-chat](private-web-chat.md)): public addresses and `0.0.0.0` are refused. The listener for remote worker hosts exists only when remote hosts are configured, with the same loopback and TLS rules.
- **Checks on every request** (conversation listener): the host name must be one of the listener's own, an `Origin` that is not its own is refused on the MCP door, failed sign-ins are counted per address and refused with 429 over the allowance, authenticated traffic is limited per principal, bodies are limited to 64 KiB, and host and service credentials are refused. Details and examples: [conversation-and-mcp-protocol](conversation-and-mcp-protocol.md).
- **Message text is untrusted.** Every conversation message is marked `trust: untrusted-content`, and the MCP answers say so: an agent must treat what another party wrote as data, not as instructions.
- **No telemetry.** NimbleNewt contains no telemetry, crash reporting or update beacon. (Pi's model library `pi-ai`, used by Pi Durable and the adapter, depends on a package named `pi-telemetry`; it holds only the contracts and an in-memory reference, with no exporter, so nothing leaves the machine through it.) The only outbound requests are to the model servers and other services you configure, and to the release source if you switch updates on. Reading the documentation, finding a bug or voting for an improvement sends nothing anywhere; opening an issue or a pull request about NimbleNewt is a deliberate act of a person.

## The supply chain

- Install scripts are disabled for the whole repository (`.npmrc`: `ignore-scripts=true`). A package that declares one is marked in the [license inventory](implementation-plan/license-inventory.md); enabling any is a deliberate, reviewed change.
- Dependencies are pinned exactly in `package-lock.json`; `npm ci` is the install. The package boundary rules (`npm run check:deps`) say which package may depend on what; for example the controller may use only `pg`, the MCP SDK, the registry package and the embedded PostgreSQL used by tests.
- Every license is checked against an allow-list on every full test run (`npm test`, and the exhaustive CI run) with `npm run licenses:check`. See [notices](notices.md).
- The tests run under an offline guard (`scripts/offline-guard.mjs`) that fails any network call beyond the loopback address made from Node.js (on Linux CI the suite also runs with no network at all), so a test cannot quietly depend on, or leak to, the internet.

## Running agents safely

- An agent's tools run in a sandbox. Today that is **Linux with bubblewrap only**; on macOS and Windows the launcher says so and tasks wait for a host that can confine them. Isolation is a setting, strong by default.
- Agent environment changes (installing packages) are off unless you pass `--local-host-environments`, and each package needs approval (the owner, or a decider the owner permitted), the owner's standing permission for packages without install scripts, or a preapproved catalogue entry (exact name, version, digest and source).
- Network access for agents is decided per site by the owner (`allow`, `deny`, or `clear` back to the installation profile).

## Known limits (read these before trusting a claim)

- No tagged release, and no third-party security audit. The security audit is a launch item still to be done.
- Sandbox: Linux only; the sandbox's effectiveness has been tested on the project's own CI and development server, not on hardware you have not tested.
- Pi Durable, the agent runtime, is pinned to one release and stores its conversation history in JSONL files that are not flushed to disk (Pi Durable's default), unlike NimbleNewt's own database ([durability-and-flush](durability-and-flush.md)).
- The conversation listener counts failed sign-ins per connecting address; behind a shared proxy every client looks like one address. The web chat can read the real address from a proxy header only when the connection comes from a configured proxy address ([private-web-chat](private-web-chat.md)).
- Windows and macOS are qualified on CI runners only, not on installed machines.
