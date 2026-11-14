# Migration recovery and rollback limits (card K03)

This guide says what happens to the database and to the running release when an upgrade goes wrong, what can be undone, and what to ask NimbleNewt in chat. Every control below is reachable by free-form chat; the operation names are for the API and for the interpreter.

## What is protected

- **An interrupted migration recovers.** Each migration is journaled (F04). A migration that stops half-way is rolled back by the database and run again at the next start; the journal says what ran. Checked on all four storage backends.
- **A schema downgrade is blocked.** A release that does not understand the schema version the data is at is not started, and the launcher will not fall back to it (K02d). Going back across such an upgrade means restoring the snapshot taken just before it (K01).
- **Additive and destructive migrations.** Each migration is `additive` (adds tables, columns, indexes; the release before this one still works) or `destructive` (drops or reshapes data the previous release reads). Only additive migrations run on their own.
- **Destructive migrations wait.** The first destructive migration, and every migration after it, is deferred and listed by `migration.status`. It runs only after the owner allows it with `migration.contract.approve` (through a number), which is refused while the rollback period is open, when no pre-upgrade snapshot would be made, or when nothing destructive waits. The approval is kept in `migration-gate.json` in the data directory because it must be known before the database opens. After it runs the approval clears.
- **Rollback period.** After an upgrade with only additive migrations the release before it may come back for `rollbackPeriodDays` (default 14, 1 to 365).
- **Code rollback only to a tested pair.** `release.rollback` goes only to a release that has really started healthy on this schema (a tested pair), when every migration since is additive and the period is open. `release.rollback.check` says the same without moving anything, with the reasons.
- **Restore says what the world did meanwhile.** A restore puts data back, not the outside world. The restore preview counts, from the live data, what finished outside after the backup (actions, uncertain actions, failed ones, messages delivered) and names the targets to check before anything is repeated. What the backup itself held as only intended is a separate figure.
- **The watchdog blames the right party.** The controller exits 76 when the machine stopped it (disk full, no write permission, port or file taken, out of memory, database server down) and 77 when a provider it needs is down. The launcher also probes the data folder (free space, writable) and memory. Machine or provider trouble is counted and retried with back-off, never quarantines a release, and after `hostRetries` starts in a row the owner is told the installation needs attention. Only the release's own failures count against it.
- **Probation and stopping a rollout.** A newly confirmed release can be watched for `probationMinutes` (default off in the launcher; 0 means no watch). At `maxReleaseFailures` of its own failures (default 3) the watch fails, the release is set aside and the one before it, kept as `probation.prior`, runs. `release.rollout.stop` ends the watch and leaves the release running.

## Asking in chat

Examples: "how long can we go back after the upgrade", "watch new releases for an hour and fall back if they crash three times", "is the old release safe to go back to?", "allow the destructive migration", "stop watching this release". Settings and the destructive approval are shown first and apply only when you agree; withdrawing the approval and stopping a rollout apply at once. The status view for releases carries the schema, what waits for approval, whether the rollback period is open, the watch and any machine/provider trouble.

## When something goes wrong

1. Read `migration.status` and `release.status`. The first says what ran, what is deferred and why; the second says what the launcher did.
2. A start refused for the schema: the data is ahead of that release. Run a release that understands it, or restore the pre-upgrade snapshot (`backup` restore preview first; it lists what happened outside since).
3. Repeated starts failing with "the machine" or "the provider": fix the disk, permissions, database server or provider. Nothing needs rolling back, and no release is set aside for it.
4. A release set aside by probation: the earlier release is running; read the reason in the release history, fix, and stage a new release.
5. After a destructive migration has run, the earlier release cannot come back. The way back is the snapshot.
