# F04d: storage adapter parity and contention qualification

Records what was run against the controller storage backends, what it showed, and what it does not show. The code is in
`packages/controller/src/storage/` (the shared suites and `qualification/`), the raw measurements are in
[`evidence/f04d-storage-workload-run1.json`](evidence/f04d-storage-workload-run1.json) and
[`run2`](evidence/f04d-storage-workload-run2.json). The decisions these results feed are listed at the end and are for the owner.

**Nothing here measures how many real agents NimbleNewt can run.** The load is synthetic, touches storage only (no model calls, no
workers, no network between controller and database), and the numbers belong to one machine.

**Status.** Implemented. For a while this card was held at "awaiting sign-off" because the PostgreSQL suites failed in CI on one cell (Windows with
Node 22.19): that runner executes jobs as an administrator and PostgreSQL refuses to start under administrative permissions, so the test server is now
started through `pg_ctl` on Windows, and the Windows runs then showed that PostgreSQL's default database encoding there cannot store all legal JSON, so
the adapter now requires a UTF8 database. CI run 39373563539 is green on all six cells. The workload measurements were taken on Linux only.

## 1. Parity: three implementations, one behaviour

`parity.test.ts` runs the same seeded random sequence of storage calls against the in-memory reference store, SQLite and PostgreSQL
and requires every result (or error classification) and, at the end, the complete stored state to be identical: 12 seeds of 500
calls each (about 40% succeed; the rest are refusals of eight kinds: stale revisions, forged claim tokens, reused operation IDs,
stale epochs, duplicate IDs, malformed input, missing things, final effects). Lease and not-before boundaries are hit exactly. It
found one real difference on its first run: when an operation had several things wrong, PostgreSQL reported a different one than the
other two (it reported them in lock order, not contract order). PostgreSQL now collects refusals and reports the first in contract
order. Mutations of lease boundaries, priority, refusal ranking and error choice are caught by it.

Limits of this test: calls run one at a time (no concurrency; that is covered by the conformance and PostgreSQL concurrency tests),
time only moves through explicit lease and not-before boundaries, values are small, the in-memory store steers the sequence (it is
asked for current revisions and live tokens), only error kinds (and the path for invalid input) are compared, not messages, and
results are compared after a JSON round trip.

## 2. Crash at every atomic boundary

For each write path of the storage the writer is killed immediately **before and after every numbered statement** of its
transaction. After each kill a fresh connection must see exactly the state before the action or exactly the state after it, the
action must be durable exactly when COMMIT has executed (never earlier), and what a caller does next must end in the state of an
uninterrupted run (resubmit the operation by its ID; re-issue a claim, takeover or retry and accept the expected refusal if it had
already happened). The complex operation touches every part of the contract: create, update and guard of aggregates; audit; two
outbox messages, one with an ordering key; a new effect and timer; a cancelled timer; a receipt, a timer firing and an effect
settlement.

| Write path | SQLite statements / crash points | PostgreSQL statements / crash points |
| --- | --- | --- |
| `applyOperation` (the complex operation) | 30 / 60 | 26 / 52 |
| `claimDeliveries` | 6 / 12 | 4 / 8 |
| `acquireEpoch` (compare-and-set takeover) | 4 / 8 | 3 / 6 |
| `retryDelivery` | 5 / 10 | 4 / 8 |

Every point passed on both backends, and in every case the action is committed only at "after the last statement" (COMMIT executed,
answer lost). SQLite crashes are made by the child process killing itself (SIGKILL) from a test hook around each statement;
PostgreSQL's by a protocol-aware TCP proxy that cuts the connection before the statement reaches the server, or after the server
processed it but before the client hears. (`claimDueTimers` and timer firing are not swept separately; they share the claim
transaction shape and the firing is part of the swept operation.)

Also tested: SQLite writers killed at six arbitrary moments in a loop (F04b); a SQLite lock holder killed; **a PostgreSQL server
stopped with an immediate shutdown (no clean checkpoint, crash recovery on restart) while a writer loop runs**: nothing acknowledged
is lost, no operation is partly applied, audit numbers stay gap-free, the pool recovers by itself (4 of 4 reruns).
Removing the transaction altogether (autocommit) is caught on both backends.

**Not tested:** a crash during schema creation or upgrade (the migration runners of card F04 are where that is swept); SQLite WAL
checkpoints interrupted by a crash; power loss or storage that lies about flushing (needs hardware or a VM); disk full; corruption.

Interrupted connections, uncertain commits, duplicate messages, stale epochs and per-task ordering are covered by the shared
conformance suite (110 cases on each backend) plus the PostgreSQL proxy tests; see the F04a, F04b and F04c notes.

## 3. Workload: what storage does under load

Machine: linux 7.0.0-38-generic, 12 x 12th Gen Intel(R) Core(TM) i5-12400, 123 GiB RAM, Node v24.21.0. Data on **ext4** (NVMe) in
`/home/rob/.cache/nimblenewt-bench`. The machine was shared with other work (load average about 10 on 12 cores); two runs are shown to give a
sense of the noise. A first attempt on `/tmp` was discarded: it is a RAM file system where flushing costs nothing, and the report now
records the file system and prints a warning for `tmpfs`/`ramfs`.

SQLite settings: WAL, `synchronous = FULL`, SQLite 3.53.4. PostgreSQL: 17.10 on the loopback interface (no network
latency), `fsync = on`, `synchronous_commit = on`, READ COMMITTED, pool of 10 connections.

Scenarios (15 s measured after 2 s warm-up, one process): **agents** are concurrent loops, each transitioning its own task (update +
audit + outbox message) twice and then claiming and completing messages (a receipt per message, with audit), pausing 0-10 ms between
steps; **idle hosts** each send one heartbeat update every 2 s; **inquirers** read one aggregate and a page of the audit log every
20 ms. "Baseline" is 4 agents; "stress" is 32 agents (the "32-active-equivalent synthetic storage workload"); both with 100 idle
hosts and 2 inquirers. "Hot row" adds one shared record that every transition also updates by revision, the worst case for conflicts.
The invariants hold in every run: audit numbers gap-free, delivery numbers unique and gap-free, every task's revision equals the
transitions applied to it (no lost update), no delivery claimed twice.

How to read the tables: a step is counted if it **starts** inside the 15 s window and its rate is its count divided by 15 s; latency
is measured end to end for the step, including retries inside it; percentiles are nearest-rank over all samples. The loops are
**closed** (each waits for its previous call), so under saturation the offered load drops instead of queueing, which understates
latency compared with a fixed arrival rate (coordinated omission); the load generator and the store share one Node process, which
couples SQLite's event-loop stall to the generator itself. An inquiry that is starved appears as a low count, not a high latency, so
read the count next to the percentiles.

### Transition (end-to-end, including retries inside the step)

| Backend | Scenario | Run | Per second | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | baseline: 4 active, 100 idle hosts | 1 | 38.67 | 6.36 | 10.65 | 13.52 | 20.43 |
| sqlite | baseline: 4 active, 100 idle hosts | 2 | 37.87 | 6.28 | 12.2 | 13.1 | 24.27 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 1 | 48.13 | 6.19 | 6.92 | 12.34 | 13.42 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 2 | 43.6 | 6.3 | 11.65 | 12.67 | 13.66 |
| sqlite | hot row: 32 active all updating one shared record | 1 | 42.87 | 6.39 | 9.26 | 13.78 | 16.87 |
| sqlite | hot row: 32 active all updating one shared record | 2 | 41.67 | 6.39 | 11.87 | 12.88 | 15.59 |
| postgres | baseline: 4 active, 100 idle hosts | 1 | 177.47 | 6.58 | 13.02 | 18.01 | 33.93 |
| postgres | baseline: 4 active, 100 idle hosts | 2 | 175.73 | 6.96 | 12.67 | 15.87 | 36.79 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 1 | 167.53 | 68.59 | 133.5 | 179.33 | 290.25 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 2 | 129.93 | 88.48 | 194.64 | 280.73 | 563.49 |
| postgres | hot row: 32 active all updating one shared record | 1 | 94.27 | 206.36 | 905.72 | 1407.5 | 2864.56 |
| postgres | hot row: 32 active all updating one shared record | 2 | 37.47 | 461.08 | 2448.25 | 3328.35 | 5376.15 |

### Claim and complete

| Backend | Scenario | Run | Per second | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | baseline: 4 active, 100 idle hosts | 1 | 19.4 | 19.96 | 33.43 | 45.1 | 60.72 |
| sqlite | baseline: 4 active, 100 idle hosts | 2 | 19 | 24.18 | 37.56 | 43.96 | 49.39 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 1 | 25.87 | 24.51 | 27.1 | 37.74 | 49.03 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 2 | 24 | 24.69 | 33.35 | 42.91 | 52.03 |
| sqlite | hot row: 32 active all updating one shared record | 1 | 23.73 | 24.92 | 33.57 | 39.76 | 44.24 |
| sqlite | hot row: 32 active all updating one shared record | 2 | 22.07 | 24.71 | 34.32 | 40.56 | 51.53 |
| postgres | baseline: 4 active, 100 idle hosts | 1 | 88.93 | 15.86 | 34.42 | 45.77 | 61.16 |
| postgres | baseline: 4 active, 100 idle hosts | 2 | 88.13 | 15.54 | 32.28 | 39.55 | 60.05 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 1 | 84.6 | 228.69 | 377.71 | 503.09 | 668.81 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 2 | 65.73 | 254.22 | 593.96 | 715.1 | 952.42 |
| postgres | hot row: 32 active all updating one shared record | 1 | 49.27 | 30.78 | 49.73 | 59.11 | 75.26 |
| postgres | hot row: 32 active all updating one shared record | 2 | 20.8 | 48.03 | 125.33 | 149.64 | 193.87 |

### Heartbeat from an idle host

| Backend | Scenario | Run | Per second | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | baseline: 4 active, 100 idle hosts | 1 | 48.47 | 6.33 | 10.79 | 15.82 | 23.63 |
| sqlite | baseline: 4 active, 100 idle hosts | 2 | 48.87 | 6.25 | 12.17 | 12.61 | 15.96 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 1 | 37.6 | 6.18 | 6.83 | 12.41 | 13.39 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 2 | 39.6 | 6.28 | 11.92 | 13.25 | 18 |
| sqlite | hot row: 32 active all updating one shared record | 1 | 39.47 | 6.31 | 9.38 | 12.31 | 13.91 |
| sqlite | hot row: 32 active all updating one shared record | 2 | 40.4 | 6.3 | 11.94 | 13.39 | 22.05 |
| postgres | baseline: 4 active, 100 idle hosts | 1 | 49.53 | 3.62 | 7.07 | 8.77 | 13.43 |
| postgres | baseline: 4 active, 100 idle hosts | 2 | 49.6 | 3.71 | 5.86 | 8.46 | 11.62 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 1 | 48.13 | 52.61 | 94.88 | 108.57 | 129.58 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 2 | 47.4 | 69.8 | 122.21 | 138.05 | 146.27 |
| postgres | hot row: 32 active all updating one shared record | 1 | 49.27 | 7.98 | 13.73 | 17.84 | 25.67 |
| postgres | hot row: 32 active all updating one shared record | 2 | 49.93 | 20.21 | 40.62 | 54.13 | 63.94 |

### Inquiry (read one aggregate and a page of audit)

| Backend | Scenario | Run | Per second | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | baseline: 4 active, 100 idle hosts | 1 | 23.2 | 0.11 | 0.24 | 0.33 | 0.46 |
| sqlite | baseline: 4 active, 100 idle hosts | 2 | 23.07 | 0.07 | 0.21 | 0.28 | 0.31 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 1 | 3.6 | 0.13 | 0.21 | 0.22 | 0.22 |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 2 | 3.2 | 0.12 | 0.25 | 0.36 | 0.36 |
| sqlite | hot row: 32 active all updating one shared record | 1 | 3.2 | 0.15 | 0.33 | 0.4 | 0.4 |
| sqlite | hot row: 32 active all updating one shared record | 2 | 3.2 | 0.12 | 0.3 | 0.34 | 0.34 |
| postgres | baseline: 4 active, 100 idle hosts | 1 | 97.6 | 0.4 | 1.53 | 3.94 | 5.95 |
| postgres | baseline: 4 active, 100 idle hosts | 2 | 97.47 | 0.52 | 1.24 | 2.42 | 5.22 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 1 | 16.13 | 97.6 | 165.65 | 193.91 | 197.64 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 2 | 12.73 | 117.71 | 223.6 | 250.42 | 262.55 |
| postgres | hot row: 32 active all updating one shared record | 1 | 69.93 | 8.54 | 14.08 | 17.76 | 38.59 |
| postgres | hot row: 32 active all updating one shared record | 2 | 43.87 | 26.27 | 47.46 | 65.06 | 72.18 |

### Contention, stalls and pool pressure

| Backend | Scenario | Run | Event-loop delay p99 / max ms | Inquiries completed | Conflicts retried by caller | Pool peak (connections / waiting) |
| --- | --- | --- | --- | --- | --- | --- |
| sqlite | baseline: 4 active, 100 idle hosts | 1 | 83.36 / 214.56 | 348 | 0 | - |
| sqlite | baseline: 4 active, 100 idle hosts | 2 | 81.85 / 135.79 | 346 | 0 | - |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 1 | 395.84 / 613.94 | 54 | 0 | - |
| sqlite | stress: 32 active equivalents, 100 idle hosts | 2 | 423.36 / 722.99 | 48 | 0 | - |
| sqlite | hot row: 32 active all updating one shared record | 1 | 430.44 / 697.3 | 48 | 496 | - |
| sqlite | hot row: 32 active all updating one shared record | 2 | 416.81 / 833.09 | 48 | 496 | - |
| postgres | baseline: 4 active, 100 idle hosts | 1 | 2.36 / 5.09 | 1464 | 0 | 8 / 0 |
| postgres | baseline: 4 active, 100 idle hosts | 2 | 2.1 / 7.7 | 1462 | 0 | 7 / 0 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 1 | 1.91 / 7.84 | 242 | 0 | 10 / 33 |
| postgres | stress: 32 active equivalents, 100 idle hosts | 2 | 2.35 / 9.02 | 191 | 0 | 10 / 36 |
| postgres | hot row: 32 active all updating one shared record | 1 | 1.9 / 5.39 | 1049 | 39672 | 10 / 26 |
| postgres | hot row: 32 active all updating one shared record | 2 | 3.01 / 6.59 | 658 | 15463 | 10 / 32 |

## 4. What the numbers show

1. **SQLite: a synchronous commit costs about 6.3-6.4 ms here, and it happens on the main thread.** `node:sqlite` is synchronous and
   `synchronous = FULL` waits for the disk, so every commit blocks Node's event loop for its duration. Storage writes (operations
   plus claims) run at about 145-146 a second at baseline and 154-160 under stress (counted over the whole run), the rate at which this disk flushes, not a CPU
   limit. With 4 agents the event loop is delayed 81.8-83.4 ms at p99; with 32 loops queuing commits it is delayed
   396-423 ms at p99 and up to 723 ms, and inquiries nearly stop (48-54 completed in
   15 s against 346-348 at baseline). Per-call latencies stay small (the call itself is fast) while everything else on the loop
   waits: **the event-loop delay, not the call latency, is the cost.**
2. **PostgreSQL: parallel writers, but bounded by the pool and the flush, and inquiries suffer too.** The event loop is not blocked
   (p99 1.9-2.4 ms under stress). At 4 agents a transition takes about 6.6-7 ms. At 32 loops sharing a 10-connection pool,
   up to 33-36 callers (agents, hosts and inquirers) wait for a connection at a time and transition latency rises to 68.6-88.5 ms (p50) and 179-281 ms (p99);
   throughput is 130-168 transitions a second, not higher than with 4 agents (176-177), so adding agents adds waiting, not work: on this machine the pool and
   the per-commit flush, not the number of agents, set the limit. **Inquiries degrade sharply as well**: from 1,462-1,464 completed
   (p50 0.4-0.5 ms) at baseline to 191-242 (p50 97.6-118 ms, p99 194-250 ms) under stress, because they wait for the same
   pool. These are loopback numbers; a remote database adds a round trip to every statement of every transaction (a transition in
   this workload is about ten statements: begin, epoch fence, operation row, aggregate update, counter row, audit, delivery, result,
   commit).
3. **Contention on one shared record is expensive on PostgreSQL.** With every agent updating one row by revision, conflicts retried
   by the caller were 15,463-39,672 in about 17 s while successful transitions fell from about 130-168 to 37.5-94.3 a second and p99 rose to
   1,408-3,328 ms; SQLite showed about 496 conflicts (its writes do not interleave) with little change in throughput (41.7-42.9 against
   43.6-48.1 a second without the hot row). The design should avoid a single hot aggregate written by many agents, or the caller needs backoff
   rather than immediate retry.
4. **The two backends do not behave the same under load even though they behave the same in every other respect** (section 1): SQLite
   trades loop stalls for simplicity and low call latency; PostgreSQL trades call latency for isolation of the loop and parallelism.

## 5. Not established

Two earlier runs, made before the sampling window was corrected (their rates were divided by the whole run time, about 13% too low), are not included.

Real-agent capacity; behaviour with model calls and real workers; remote or TLS PostgreSQL; PostgreSQL versions other than 17.10;
Windows and macOS performance (the functional suites run there in CI, the workload was run on Linux only); power loss; long runs
(each scenario is 15 s, so checkpoint and vacuum behaviour over hours is unmeasured); the effect of the other load on this machine:
between the two runs, throughput differs by up to 22% in every scenario except the PostgreSQL hot-row one, which differs by 60% and is the least repeatable result here; p95 latencies differ by up to 66% and single maxima by up to a factor of 3;
priority starvation of low-priority messages under sustained high-priority load (inherent to the contract's rule, not measured
here); query plans at volume (the open-deliveries indexes lead with destination and due time while the claim orders by priority and
sequence; check at hundreds of thousands of rows).

## 6. Decisions for the owner and follow-ups

* **SQLite and the event loop.** If the SQLite backend is to serve a controller that also serves HTTP and inquiries, its commits
  should run off the main thread (a worker thread owning the connection) or be grouped, or `synchronous = NORMAL` could be accepted
  (with its power-loss tradeoff, which G01 does not yet decide). This is a design change, not done here.
  **Decided by the owner 2026-10-20:** worker thread, `synchronous=FULL` kept; tracked as card F04f.
* **Pool size and hot aggregates** for PostgreSQL deployments, and whether the design needs a rule against many agents writing one
  record.
* **Minimum hardware and supported database versions:** the owner decided on 2026-10-20 to support PostgreSQL 17 and above (verification on older majors is card F04g) and to claim only the platforms CI covers (see G01). This record gives one data point; the numeric defaults remain provisional and unvalidated.
