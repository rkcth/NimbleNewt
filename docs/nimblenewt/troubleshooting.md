# Troubleshooting

Start here when something does not work. Each entry says what you see, what it means and what to do. Messages are quoted in part so you can search for them; the code is the authority for the full text. Anything that needs an operation name is reachable by asking the chat in your own words; the names are for the API ([api-guide](api-guide.md)) and the interpreter.

## First, look around

1. `node scripts/nimblenewt.mjs status` starts the controller, prints what is set up and what is missing, and stops. It changes nothing but the start itself.
2. In the chat, or `setup.readiness` in the API (owner only): what is configured, what is missing, in the order a person sets things up, with a recommended answer for each.
3. `migration.status` says what database migrations ran or are deferred; `release.status` says what the launcher did with the last start.
4. The controller prints why a start was refused. Read the first problem, not the last.
5. The data directory is `~/.nimblenewt` unless `--data DIR` or `NIMBLENEWT_DATA` says otherwise; the configuration is `nimblenewt.config.json` in it, and backups are in its `backups` folder.

## The controller will not start

| What you see | What it means | What to do |
| --- | --- | --- |
| A list of problems about the operating system, Node.js, a file system or a missing program, ending with how to fix each | The start-up check found something outside what is supported ([compatibility-and-support](compatibility-and-support.md)) | Fix the first item. If you have verified your setup and still want to start, pass `--allow-unsupported-environment` (or set `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`). Items marked as not overridable cannot be skipped. |
| `the database could not enter WAL mode` | The data directory is on a file system that cannot do SQLite's log, usually a network share | Move the data directory to a local disk (see [durability-and-flush](durability-and-flush.md)). |
| `the durability settings did not take effect` | SQLite did not accept the flush setting NimbleNewt requires | Same cause as above; do not work around it, the setting is what makes a crash safe. |
| `the PostgreSQL server is configured without durable writes` or `synchronous_commit is ... not "on"` | The server's `fsync`, `full_page_writes` or `synchronous_commit` is off | Turn them on at the server. NimbleNewt will not keep controller state on a server that can lose it. |
| A PostgreSQL version message naming the minimum | The server is older than 17 | Use PostgreSQL 17 or 18, or pass the override at your own risk. |
| `the file has tables but no schema journal` | The database file was not made by NimbleNewt (or by an old development build) | It is left untouched. Point NimbleNewt at a new file, or restore a backup. |
| `... newer than the latest this version of NimbleNewt knows` | The data was written by a newer release | Run a release that understands it, or restore the snapshot taken before that upgrade. Nothing was changed. See [migration-recovery](migration-recovery.md). |
| `... was changed after it was applied` | An applied migration differs from what this build ships | You are running a modified build. Use the release the data was made by. |
| A refusal that names where the data is now | You moved the database with a transfer and started the old configuration, or restored an old copy over the old path | Start with the configuration for the new place. Only one place is the real database. |
| A refusal naming the holder of the data directory | Another controller is running on it (or died and left a lock) | Stop the other one. A lock whose holder is gone is taken over after its stale period; do not delete lock files by hand. |
| The same start fails over and over and the launcher backs off | A crash loop. Exit **76** means the machine is at fault (disk full, no write permission, a port or file taken, out of memory, database server down); **77** means a provider is down. Neither sets the release aside. | Fix the disk, permissions, port, server or provider. |
| Exit code **75** | Not a failure: the controller asked the launcher to start it again (after an activation or a database move) | Nothing. |

## It runs but nothing happens

- **The chat does not answer.** The chat needs a model: one model server must be named first (`init --model-endpoint URL --model NAME`, or the configuration's `models.providers`). Check the address answers from this machine.
- **A task is assigned and no agent works on it.** `setup.readiness` will say a host is missing. Tell the chat to run agents on this computer (`host.local.set`, off until you say so; it counts from the next start). Today that works on Linux with bubblewrap only. Also check the owner has not paused the task or its project.
- **A change you asked for sits waiting.** In the strict profile consequential things ask you first; ask the chat what is waiting for you.
- **Writes are refused as "protected", or the disk is nearly full.** The controller keeps a reserve file (`.nn-reserve` in the data directory) so it can still write its stop and recovery records. When the disk fills, ordinary writes are refused until you free room. Free space, then the reserve is set again.
- **A restore was staged and nothing changed.** A staged restore takes effect when the controller restarts; the owner is told how it gets restarted.

## Talking to the API and the listener

| Symptom | Cause | Fix |
| --- | --- | --- |
| `invalid_command` with `field: "v"` | Version other than 1 | Send `"v": 1`. |
| `invalid_command` with `field: "args.x"` | An argument that operation does not have | Check [api-v1](api-v1.md); a misspelt option is refused, never ignored. |
| `invalid_command` with `field: "commandId"` | A command with no command ID | Add one ([api-guide](api-guide.md)). |
| `command_conflict` | The command ID was used for different content | Use a new ID for a new command, the same ID only to retry the same one. |
| `stale_revision` | Someone changed the record since you read it | Read again, decide again. |
| `unauthenticated` / HTTP 401 | The token is wrong, malformed or revoked | Issue a new credential. The answer never says which. |
| `forbidden` / HTTP 403 | The principal lacks a right, or a host or service credential was used on the conversation listener | Ask the owner for the grant. |
| HTTP 421 | The `Host` header is not one of the listener's own | Use the listener's address; behind a proxy, add the public host names. |
| HTTP 429 | Over the allowance: too many failed sign-ins from the address, or too many requests from one principal | Wait a minute and fix the credential. |
| HTTP 400 `idempotency_key_required` | A change without an `Idempotency-Key` header | Add one of your own choosing ([conversation-and-mcp-protocol](conversation-and-mcp-protocol.md)). |
| HTTP 404 on `/mcp` | The owner switched the MCP door off, or the listener is not running | Ask the chat to switch `conversation.mcp.enabled` back on, or start with `--serve`. |
| HTTP 405 on `GET /mcp` | There is no event stream | Poll with the tools from your cursor. |
| `project.get` and friends say `forbidden` for an agent | A new agent has no grants | Grant it what it needs in that project. |

## Working on the code

| Symptom | Fix |
| --- | --- |
| `Cannot find module ... dist/...` | Build first: `npx tsc --build`. After deleting or renaming a source file also run `npm run clean`, or an old compiled file (and its tests) lingers in `dist`. |
| A test fails with `network access is blocked in offline tests` | Correct: tests must not use the network. Use a loopback fake, or the embedded PostgreSQL the tests start themselves. |
| `npm run licenses:check` fails | A dependency changed. `npm run licenses:write` regenerates [the inventory](implementation-plan/license-inventory.md); a license that is not on the allow-list is a real failure, not a stale file. |
| `npm run check:deps` fails | A package imported something its rules do not allow, or SQL appeared outside the storage folders. Move the code, or ask for a boundary change as its own reviewed change. |
| The API reference test fails | `npm run api:docs:write` **after** a build, then commit the new `docs/nimblenewt/api-v1.md`. Never edit it by hand. |
| A sandbox test is skipped or fails | Needs bubblewrap and user namespaces on Linux. CI sets `NIMBLENEWT_REQUIRE_SANDBOX=1` so a run where nothing could be confined fails instead of skipping. the `sandbox-diagnose` workflow (`.github/workflows/sandbox-diagnose.yml`) and `scripts/seatbelt-diagnose.mjs` collect facts. |
| A QA run failed on a CI cell | `node scripts/qa-diagnose.mjs [qa-output-dir]` prints which tests failed in how many runs, the first lines of each error and what the disk holds. |
| A PostgreSQL test cannot start a server | The embedded server needs a free loopback port and a writable temporary folder; or set `NIMBLENEWT_TEST_POSTGRES_URL` to a disposable server you own. |

## Still stuck

Collect the first lines the controller printed at start-up, the output of `status`, your Node.js version and SQLite or PostgreSQL, **with credentials and private paths removed**, and open an issue ([compatibility-and-support](compatibility-and-support.md)). A suspected vulnerability goes to [SECURITY.md](../../SECURITY.md), not the issue tracker.
