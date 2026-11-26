# Standby replication and recovery (card K04)

This guide is for the person who runs a NimbleNewt installation with a second PostgreSQL server (a standby). It is optional. An installation without a standby has none of this and nothing here runs.

## What is and is not covered

- **Database failover** is making the standby's database writable. NimbleNewt asks PostgreSQL to do it (`pg_promote`) and only when the recovery manifest says it is safe.
- **Controller promotion** is deciding which controller may use that database, and keeping the old controller out. That is a separate step and is not done by the database failover: after a promotion the controller's epoch and holder are exactly as they were. Fencing, the recovery login and consent are card K05's. There is no automatic controller failover in the first release.
- NimbleNewt does not copy the log or speak PostgreSQL's replication protocol. The standby is set up and kept running by you, with PostgreSQL's own streaming replication; NimbleNewt only asks PostgreSQL questions (who is connected, how far behind) and asks it to promote.

## Asynchronous or synchronous

- **Asynchronous**: a commit is answered when the primary has it. If the primary is lost, the newest writes can be lost. The loss window is how far behind the standby was. `measureLag` reports it in bytes not yet on the standby's disk (lost with the primary) and bytes on disk but not yet applied (kept).
- **Synchronous**: a commit is answered only when the standby has it on disk, so a write the controller was told succeeded survives losing the primary. If the standby is down, writes wait. The controller sees such a write as uncertain and asks again by its operation ID, so it is applied once. `synchronousSettingsText` prints the server setting; you apply it, NimbleNewt never edits the server's settings.

`verifyStandbyInstallation` compares what you configured with what runs (a standby of this primary, streaming, in the configured mode) and says in words what is wrong.

## The recovery manifest

A database copy does not carry the artifact files, and a copy that lags does not carry the newest workflow state. The recovery manifest is a small folder (`manifest.json`, `aggregates.jsonl`, `blobs.jsonl`) that lists the counters, every record with its revision and every artifact file (digest and size). Write a fresh one often (after every backup is a good time) and keep it, with the artifact files, where the standby's host can reach it. The standby host needs its own copy of the artifact files; PostgreSQL does not send them.

A promotion is refused, with the standby left as it was, when: the manifest is missing or was changed; the node is not a standby; the old primary still answers as a writable database; the standby has received more than it has applied and does not finish; any listed record is missing or at an older revision; the counters are behind; any listed artifact file is missing, has a different size or different bytes. There is no override. If something was removed on purpose after the manifest was written (retention, orphan clean-up), write a new manifest.

## SQLite and backups

SQLite has no standby. Its recovery is the last good backup; `reportRestoredStore` compares the restored store with a manifest written before the loss and says how many audit entries, records and artifact files the backup does not have. Backups are unchanged by all of this: a backup made beside a standby restores into any backend with no standby and no manifest.

## Measuring what a failover cost

After a failover, `measureLoss` compares the writes the controller was told succeeded with what the new primary holds, and reports how many were lost and the stretch of time they cover. A write whose answer never came is uncertain, not failed: ask for it again by its operation ID on the new primary.
