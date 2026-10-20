# F04g: which PostgreSQL versions the controller storage works with

Records what was run, on which servers, and what the support statement is. The mechanism is `scripts/postgres-versions.mjs` (one major version per run), the pinned installs in `scripts/postgres-versions/<major>/` and the hand-started workflow `PostgreSQL versions` (`.github/workflows/postgres-versions.yml`).

## The support statement

**PostgreSQL 17 and above is supported** (the owner's decision of 2026-10-20). The adapter now refuses a server older than 17 at open, with a message naming the minimum (the code floor was 14 before this card). PostgreSQL 14, 15 and 16 are run through the same suites and reported below; a pass there is information, not a promise. Whether to narrow support to the two most recent majors is a later owner decision; this card does not make it. Later decisions (2026-10-20, see the G01 record): an older server will refuse to start unless explicitly overridden, with instructions on how to test that version (card F04h; today there is no override), and before launch every major released in the last three years is to be validated.

## What is run

For each major the latest minor of that major available as an `embedded-postgres` build (exact version and integrity hash in the major's lockfile; installed with install scripts disabled into its own folder, not into the workspace) is started on a free loopback port. The controller's PostgreSQL-dependent test files then run against it, unchanged: the shared storage conformance suite (plain and upgraded through the synthetic migrations), the pool, timeout, durability-setting and settings-verification tests, the crash matrices (connection cut before and after every statement, four write paths), the immediate-shutdown recovery test, the committed layout-1 fixture upgrade, the journaled migration tests, the seeded differential parity test against the reference store and SQLite, and the synthetic workload smoke tests. For 14 to 16 the adapter's version floor is lowered for the run only (`postgres/testing/older-servers.ts`, loaded with `--import`); the normal suites never lower it, and a test checks that a 16 server is refused by default (`postgres/version.test.ts`).

The server version is read from the running server, not taken from the package name, and the run stops without running anything or writing a result if that version cannot be read or is a different major than the one requested (an externally supplied server, `NIMBLENEWT_TEST_POSTGRES_URL`, is removed from the environment of the run so it cannot stand in for the pinned one).

## Results

Linux x64 (Ubuntu 26.04, Node 22.23), run on the development machine:

| Major | Server | Status | Result | Tests | Time |
| --- | --- | --- | --- | --- | --- |
| 14 | 14.23 | verified only | passed | 236 of 236 | 45.7 s |
| 15 | 15.18 | verified only | passed | 236 of 236 | 46.5 s |
| 16 | 16.14 | verified only | passed | 236 of 236 | 46.6 s |
| 17 | 17.10 | supported | passed | 236 of 236 | 46.6 s |
| 18 | 18.4 | supported | passed | 236 of 236 | 46 s |

All five majors passed every test, so nothing here shows a reason to exclude 14, 15 or 16 on functional grounds; that is the evidence for the owner's later decision on how far back to support.

All three operating systems, from the hand-started `PostgreSQL versions` workflow (run 39438475744, commit `c2574d7`, GitHub-hosted runners, Node 22.19.0; 236 of 236 tests in every cell):

| Major | Server | Linux x64 | macOS arm64 | Windows x64 |
| --- | --- | --- | --- | --- |
| 14 | 14.23 | passed | passed | passed |
| 15 | 15.18 | passed | passed | passed |
| 16 | 16.14 | passed | passed | passed |
| 17 | 17.10 | passed | passed | passed |
| 18 | 18.4 | passed | passed | passed |

The first run of the workflow (39436717586, commit `b63ec1d`) had one failure, 18 on Windows, in a test of the PostgreSQL crash-recovery suite that asserted a storage call had failed during a server restart even when the process had been blocked by the restart and no call was in flight. That assertion was a test defect, not a PostgreSQL 18 problem (it had also failed intermittently on Windows with Node 24 in the QA runs of the whole suite), and it was replaced by a check that the store held connections when the server was killed and then recovered and lost nothing; every cell passes since.

## Not established

* Performance and contention on any version other than 17.10 (the F04d workload was run only on 17.10); behaviour with TLS or remote servers; replicas and failover; extensions; non-`embedded-postgres` builds (distribution packages, managed services), which differ in settings such as `fsync` defaults the adapter verifies at open.
* Minor versions other than the latest of each major. The adapter has no known minor-version dependence, but only these were run.
* PostgreSQL 19 and later, until they exist as `embedded-postgres` builds and are added to the matrix.

## Run it

`npm ci && npm run build`, then `node scripts/postgres-versions.mjs 17` (any of 14 to 18; `--out=<dir>` for the evidence files). Majors from 17 up exit non-zero on any failure; older majors exit 0 and print their result.
