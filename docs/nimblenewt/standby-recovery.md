# Standby replication and recovery (card K04)

This guide is for the person who runs a NimbleNewt installation with a second PostgreSQL server (a standby). It is optional. An installation without a standby has none of this and nothing here runs.

## What is and is not covered

- **Database failover** is making the standby's database writable. NimbleNewt asks PostgreSQL to do it (`pg_promote`), and only when the standby holds everything the recovery manifest lists and the checks below pass.
- **Controller promotion** is deciding which controller may use that database, and keeping the old controller out. That is a separate step and is not done by the database failover: after a promotion the controller's epoch and holder are exactly as they were. Fencing, the recovery login and consent are card K05's. There is no automatic controller failover in the first release.
- NimbleNewt does not copy the log or speak PostgreSQL's replication protocol. The standby is set up and kept running by you, with PostgreSQL's own streaming replication; NimbleNewt only asks PostgreSQL questions (who is connected, how far behind) and asks it to promote.

## Asynchronous or synchronous

- **Asynchronous**: a commit is answered when the primary has it. If the primary is lost, the newest writes can be lost. The loss window is how far behind the standby was. `measureLag` reports it in bytes not yet on the standby's disk (lost with the primary) and bytes on disk but not yet applied (kept).
- **Synchronous**: a commit is answered only when the standby has it on disk, so a write the controller was told succeeded survives losing the primary. If the standby is down, writes wait. The controller sees such a write as uncertain and asks again by its operation ID, so it is applied once. `synchronousSettingsText` prints the server setting; you apply it, NimbleNewt never edits the server's settings.

`verifyStandbyInstallation` compares what you configured with what runs (a standby of this primary, streaming, in the configured mode) and says in words what is wrong.

## The recovery manifest

A database copy does not carry the artifact files, and a copy that lags does not carry the newest workflow state. The recovery manifest is a small folder (`manifest.json`, `aggregates.jsonl`, `blobs.jsonl`) that lists the counters, every record with its revision and every artifact file (digest and size). Write it from the primary's store, not from the standby (a manifest written from the standby only describes the standby, so it would pass against it). Write a fresh one often (after every backup is a good time) and keep it, with the artifact files, where the standby's host can reach it. The standby host needs its own copy of the artifact files; PostgreSQL does not send them.

A promotion checks only what the manifest lists. Anything written after the manifest was written is not checked, so an old manifest checks little and a manifest written from an empty store checks nothing; the result's notes give the manifest's time. The manifest's checksums show that it was not damaged or edited by accident since it was written. They are not a signature: anyone who can write the folder can write a new, consistent manifest, so keep the folder writable only by the account that runs NimbleNewt. The manifest does not record which installation it came from, so do not point a promotion at a manifest of another installation.

A promotion is refused, with the standby left as it was, when: the manifest is missing, was changed or is not in the form NimbleNewt writes; the node is not a standby; the old primary's address is left out (give it, or say that it is not known); an address has no host (it would otherwise be completed from the PostgreSQL environment variables and local defaults, which may name another server); the old primary still answers and is not itself in recovery, even if it is only read-only by default, or it is not the primary this standby copies; another standby you name answers and is not in recovery (it was already promoted); the standby has received more than it has applied and does not finish; any listed record is missing or at an older revision; the counters are behind; any listed artifact file is missing, has a different size or different bytes. There is no override. If something was removed on purpose after the manifest was written (retention, orphan clean-up), write a new manifest. An old primary that does not answer is not proof that it has stopped: the result then says so in its notes, and making sure it stays stopped is up to you (fencing comes with card K05).

The old primary and the other standbys you name are asked twice: before the checks and again just before the promotion, because the checks can take minutes. A node can still come back in the moment between that last question and the promotion, and a standby you did not name is never asked. Only fencing the old primary closes that gap. With more than one standby, name the others every time, and promote one at a time.

If the answer to the promotion request is lost, the result says the outcome is not known: the standby may have been promoted. Check the node's role before doing anything else, and do not point the controller at a different node meanwhile.

A new manifest replaces the old one in the same folder. If the machine stops during that swap, the folder holds no manifest and a promotion is refused until a new one is written. A mix of old and new files does not match the checksums and is refused the same way.

## SQLite and backups

SQLite has no standby. Its recovery is the last good backup; `reportRestoredStore` compares the restored store with a manifest written before the loss and says how many audit entries, records and artifact files the backup does not have. Backups are unchanged by all of this: a backup made beside a standby restores into any backend with no standby and no manifest.

## Measuring what a failover cost

After a failover, `measureLoss` compares the writes the controller was told succeeded with what the new primary holds, and reports how many were lost and the stretch of time they cover. A write whose answer never came is uncertain, not failed: ask for it again by its operation ID on the new primary.

## What is not here yet

- Nothing in this guide can be reached from chat, the status page or the API yet, and nothing runs it on a schedule: card K05 adds the recovery chat, the endpoint, fencing of the old controller and the consent step. Until then these are building blocks, not a feature you can use.
- There is no automatic failover. Nothing promotes a standby by itself.
- It has been tested with both servers on one machine, talking over the local loopback address. A standby on another host, a slow or broken network (including one that is neither up nor down), separate clocks, TLS and connection poolers have not been tested.
