# What survives a crash: flush guarantees

This page says, for each kind of stored thing, what NimbleNewt guarantees after (1) the **controller process crashing** (killed, out of memory, a bug), (2) an **orderly shutdown**, and (3) **power loss** (or a kernel crash or the machine being reset: the operating system's caches are lost). It also says what is not verified. A successful kill test is never taken as a power-loss guarantee: the three are different, and the third cannot be tested by a program on the machine it runs on.

The one-sentence version: **when the controller has answered that something was accepted, it is on stable storage for the controller's own database; an interrupted operation is either wholly there or wholly not there, never half; the stores NimbleNewt does not own (the agent runtime's conversation history) are weaker, and this page says exactly how.**

## The controller database

### SQLite (the default)

The controller opens its database in write-ahead-log mode with `synchronous = FULL` and reads the settings back; **it refuses to run if they did not take effect** (a file system that cannot do the log, such as a network share, is refused at open). Every change is one `BEGIN IMMEDIATE ... COMMIT` transaction, and the log is flushed to disk before the `COMMIT` returns, which is when the controller acknowledges anything. `settings()` reports what is in force. Source: `packages/controller/src/storage/sqlite/storage.ts`.

| Event | What you can rely on |
| --- | --- |
| Process crash | Everything acknowledged is there. A transaction in progress is rolled back whole at the next open. Checked by killing the process before and after every statement of the write paths (`storage/qualification/boundaries.ts`) and requiring exactly the state before or exactly the state after. |
| Orderly shutdown | Same, and the database is closed so the log is folded into the main file. Nothing depends on that fold: it is housekeeping. |
| Power loss | Everything acknowledged is there, **provided the operating system and the disk honour a flush request** (SQLite's documented behaviour with `synchronous = FULL` in WAL mode). The transaction in flight at the moment of the cut is lost whole, never part. A drive that lies about having flushed its own cache (some cheap or misconfigured ones) can break this for any database; NimbleNewt cannot detect that. |

Not verified by our own testing: real power loss. We rely on SQLite's guarantee plus the settings check above.

### PostgreSQL

The server must be configured for durable writes: at start the controller reads `fsync`, `full_page_writes` and `synchronous_commit` and **refuses to store controller state** on a server where `fsync` or `full_page_writes` is off, or where `synchronous_commit` is not `on`. Every connection also sets `synchronous_commit=on`, so a commit is flushed before it is acknowledged. Source: `packages/controller/src/storage/postgres/storage.ts`.

| Event | What you can rely on |
| --- | --- |
| Controller process crash | Acknowledged work is there; an open transaction is rolled back by the server. A connection cut between the commit and its answer is resolved by the operation ID, so a retry neither repeats nor loses it (`uncertain_commit`). |
| Orderly shutdown | Same; the controller closes its connections. |
| Power loss of the controller machine | The server keeps the data; nothing is held only in the controller. |
| Power loss of the **server** machine | As for any PostgreSQL with those three settings on: flushed commits survive. **Standby servers and replication are not covered**: a commit is flushed on the primary only, and we have not verified failover. |

### Moving between them, backups

A transfer between SQLite and PostgreSQL and a restore are written so that a failure before the switch leaves the source untouched. The files that decide which database is the real one (the authority file, the journal) are written to a temporary name, flushed, renamed over the real one and the directory flushed (not possible on Windows; see below). Backups are written by the controller's own backup code with the same flush discipline: file flushed, then directory.

## Files outside the database

| Thing | How it is written | After a power cut |
| --- | --- | --- |
| Artifact content (`artifacts/blobs.ts`) | Written to a temporary file, **flushed**, renamed to its content-hash name, directory flushed. | A file at its final name is complete and has the right hash; a leftover temporary file is cleaned up later. A name that holds the wrong bytes is detected by the hash and replaced. |
| Backups (`backup/`) | Archive, manifest and signature each flushed; the directory flushed afterwards. | A backup either verifies against its manifest or is reported as damaged; it is never trusted unverified. |
| Secrets in a protected file (`config/secret-stores/protected-file.ts`) | Written and flushed. Only used where the operating system has no secret store. | Complete or absent. |
| Release records and the update manifests (`release/`) | Written, flushed, directory flushed. | The launcher falls back to the last known good release if the new one is not confirmed. |
| The outside watchdog's record (`notifications/watchdog.ts`) | Written and flushed, best effort. | May miss the last entry; it is a hint, not a record of truth. |
| Logs | Ordinary writes. | The tail may be missing. Logs are never the source of truth. |

**Windows and directory flushes.** Windows cannot flush a directory the way Linux and macOS can. NimbleNewt flushes file contents everywhere, flushes directories where the platform allows it, and ignores the refusal where it does not. The consequence on Windows after a power cut is that a file that was just renamed into place may still carry its old name or be missing, never that its contents are partial. Windows is qualified on CI runners only, not on installed machines.

**Network and unusual file systems** are refused for the data directory (an NFS, SMB or FUSE share cannot be trusted to flush); see [compatibility and support](compatibility-and-support.md).

## What NimbleNewt does not own: the agent runtime's history

Pi Durable, the agent runtime, keeps each agent's conversation history in its own SQLite store. NimbleNewt does not change that store's setting, which is SQLite's default, `synchronous = NORMAL`. In that mode:

- after a **process crash** nothing acknowledged is lost;
- after an **orderly shutdown** nothing is lost;
- after **power loss** the database is not corrupted but the **last few moments of an agent's history may be gone**. The controller's own records (tasks, calls, results, hand-offs, checkpoints) are in the controller database with the guarantees above, so what was accepted is not lost even if the agent's private transcript lost its tail. How well a resumed attempt copes with a shortened transcript has not been tested against a real power cut.

If you need power-loss safety for the agent history itself, put the machine on a UPS or set the store to a stricter mode: that is a runtime setting and is **not** done by NimbleNewt today.

## How a developer keeps these guarantees

- Never write a durable file with a plain `writeFile` and call it done. Follow the pattern in `artifacts/blobs.ts`: write a temporary file in the same directory, flush it, rename it over the final name, flush the directory (ignoring a platform that cannot).
- Never write SQL outside `storage/sqlite/` and `storage/postgres/`; `npm run check:deps` enforces this. A new write goes through the storage contract so it gets the transaction and the flush for free.
- A new multi-step operation needs a crash test at every step (`storage/qualification/boundaries.ts` is the pattern) on **all four** storage implementations.
- If you add a store that is not the controller database, add a row to the table above, saying what is flushed and what a power cut can lose.
