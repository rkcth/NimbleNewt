# Proposed Paperclip execution cards

**Current task definitions; execution held at N00. Live Paperclip import status is recorded separately in paperclip-sync-status.md.**

> **Implementation began on the owner's instruction of 2026-10-19 to begin working on the project, on the Pi-first path; N00's formal scope and budget record is still an open owner item.** This file is generated; run `python3 scripts/generate_task_plan.py` then `npm run roadmap:write`.

The existing 23 issues remain workstream parents. N00/AII-250 remains the explicit implementation gate; it is not a coding task. The cards below are proposed children, not replacements for existing history. Parent IDs refer to the current planning backlog. Machine-readable source: [task-plan.json](task-plan.json).

## Execution rules applying to every card

Each card inherits the current design, permissions, isolation, versioning, and release contracts. Tests must invoke actual NimbleNewt implementation; historical probes are feasibility evidence only. Deliverables and verification below are specific to the card; all must also follow these rules:

1. **Admission:** check prerequisites, current approved design revision, exact grant, budget, repository/workspace and target versions. Planning synchronization is authorized. G07 records the current architecture and executable manifest; actual-code qualification follows component implementation. Opening N00 requires a separate explicit owner decision.
2. **Scope:** aim for one independently verifiable artifact per work window. Provisional window: 60 minutes, checkpoint at 45, final 15 for validation and continuation. These are execution controls, not effort estimates or promises that a subsystem takes one hour. Cards spanning multiple OSes or fault cases must be parameterized into individual case runs before dispatch. If preflight shows multiple substantial implementation units, split before starting; preserve the parent's outcome and cross-links.
3. **Continuity:** write immutable artifact/checkpoint references, changes made, checks run/results, remaining acceptance items, unresolved effects, workspace/branch, and a concrete next action. Budget exhaustion ends an attempt, not the task. A retry resumes existing work; it does not start a replacement task that loses context.
4. **Acceptance:** attach exact artifact/test versions and reproducible commands/environment. Required independent review must inspect those versions. Record known limitations. Historical experiments do not satisfy product acceptance. Unit/integration tests may use fake external models/services, but must execute the real component under test.
5. **Dependencies:** IDs below are leaf-level blockers. Do not inherit aggregate parent dependency edges mechanically; that can create cycles. A parent completes only when its approved children and inherited requirements are accepted. The validated leaf DAG is authoritative for execution ordering. Before activating children, reconcile legacy aggregate-parent blocker edges; parent grouping must not introduce ancestor deadlocks.
6. **Parallel work:** only disjoint workspaces/ownership with satisfied prerequisites. Shared schema/contract changes require the appropriate owner and integration review. Concurrency is a policy/capacity decision, not permission to bypass blockers.
7. **Stop conditions:** pause dependent work after a failed architectural assumption, unresolved effect, missing permission, incompatible checkpoint, or exhausted budget. Preserve progress and record a typed blocker with a resolver and next review time.
8. **Branch choices:** Remote workers (H02) are accepted first-release scope. Responsive browser access over private networking (U07) is also accepted first-release scope; no dedicated mobile app is required. Pi-first milestone: F01/F03 then F05/F06, followed by G02/G03 against the actual adapter, before F02/F04a and the controller foundation. G09 later tests integrated context switching and G04 the integrated controller on both databases. G10 evaluates optional engine caching; C06 can use the no-cache fallback for unsupported engines. Do not build two scheduling backends. No other accepted feature disappears by implication.

## Import and activation procedure

Under the authorized planning sync, read current project/issue revisions, reconcile edits, and import children using a stable `NimbleNewt-plan-20261016/<id>` marker. Save the created issue ID before the next mutation; recover interrupted import by searching for that marker. Use native parent/blocker relations and read them back. Validate all issue mappings and the resulting DAG, retain all tasks unassigned Backlog, and attach the plan revision. N00 remains closed until implementation authorization specifies scope and budget. Record G01/G07, then after N00 activation build foundation/adapters and run their actual-code tests. Require S09 before broad feature rollout, and the full X/D tranche before release.

## Coverage by existing workstream

| Existing parent | Proposed children |
| --- | --- |
| N00 / AII-250 | Owner-controlled implementation activation gate |
| N01 / AII-251 | G01, G04, G07, G08 |
| N02 / AII-252 | F01, F02, F03, F04a, F04b, F04c, F04d, F04, F04f, F04g, F04h, F04i, F04j, F04k, F04e, F09 |
| N03 / AII-253 | G02, G03, G09, G10, G11, F05, F06, F07, F08, C06, C06b |
| N04 / AII-254 | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, C03 |
| N05 / AII-255 | L05, L05b, L01, L01b, L02, L03, L04, L06, H08 |
| N06 / AII-256 | G05, A01, A02, A03, A03b, A04, A05, A06, A07, A07b, A07c, A07d, A08, A08b, A08c, A09, A10, A10b |
| N07 / AII-257 | C01, C01b, C02, C04, C05, C07, C07b, C07d, C08, C09 |
| N08 / AII-258 | R01, R02, R03, R04, R05, R05b, R05c, R05d |
| N09 / AII-259 | U03, U03d, U04, U05, U06, U03b, U03c, U07, U09, U08, U10, U11, U11b |
| N10 / AII-260 | H01, H02, H03, H04, H05, H05b, H06, H06b, H06c, H07, H09, H10, H11, H12, H12a, H12b, H12c, H12d, H12e, H12f, H12g, H12h, H12i, H12j, H12k, H13 |
| N11 / AII-261 | V01, V01b, V02 |
| N12 / AII-262 | M00, M01, M02, M03, M04, M05, M05b, M06 |
| N13 / AII-263 | T01, T02, T03, T06, T06b, T07, T07b, T08, T09 |
| N14 / AII-264 | P01, P02, P02b, P03, P04, P05, P06, P07 |
| N15 / AII-265 | Q01, Q02, Q03, Q04 |
| N16 / AII-266 | B01 |
| N17 / AII-267 | K01, K01b, K01c, K01d, K02, K03, K04, K05, K06, K06b, K07 |
| N18 / AII-268 | G06, X11, X09, X10, X01, X02, X03, X04, X05, X06, X07, X08, Y01, Y02, Y03 |
| N19 / AII-269 | D01, D02, D03, D04, D04b, D05 |
| N07a / AII-519 | U01, U13, T04 |
| N10a / AII-520 | U02, U02b, U12, T05 |
| N16a / AII-615 | B02, B03, B04, B05, B06 |

## Cards

### G01 — Record accepted scope and experiment prerequisites

- **Parent:** N01 / AII-251.
- **Status:** implemented; commits `5e2953f`; CI runs 39358055788; record [g01-decision-record.md](g01-decision-record.md).
- **Progress note:** Consolidates the owner-accepted D1-D7 and the limits; the production/N00 budget, supported PostgreSQL versions and minimum OS versions are open owner decisions listed in the record.
- **Blockers:** Owner scope/decision input; no implementation activation.
- **Deliverable:** Decision records for D1-D7, supported versions, workload envelope and budget.
- **Acceptance and verification:** Record current decisions, dual database support, remote topology, operating limits and owner planning-sync authorization; preserve N00 execution hold.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G02 — Accept the Pi adapter first milestone

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `fe494f9`; CI runs 39356097952; record [g02-acceptance.md](g02-acceptance.md).
- **Progress note:** Acceptance suite and record written and CI green on all six cells; the hand-started QA workflow passed all repeats on all six cells at c2574d7; owner signed off 2026-10-22; real macOS/Windows hardware QA is carried out under D04.
- **Blockers:** F05, F06, F03.
- **Deliverable:** Tests importing the actual NimbleNewt Pi adapter with pinned runtime and deterministic providers on Mac/Linux/Windows.
- **Acceptance and verification:** Semantic tool output reaches next model step; exact inquiry fork leaves parent unchanged; unchanged and selective-update resumes; task A/B context separation; abort during streaming and partial tool arguments; no unfinished tool action; queued input retained; real process kill and fresh-process restoration; same request ID deduplicated; compaction preserves historical branch recovery; typecheck and lockfile retained; actual adapter code, not a parallel probe; record unsupported capabilities and block dependent feature acceptance.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G03 — Qualify forward migration and compatibility rejection

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `a721db3`; CI runs 39357582142; record [g03-compatibility.md](g03-compatibility.md).
- **Progress note:** Compatibility gate qualified with real Pi 1.0.1/1.2.0/1.3.0 and earlier-adapter fixtures: storage marker, explicit adoption after a read-only scan, checkpoint format 2 with a pure upgrade from format 1, failed adoption leaves the original unchanged. No Pi-to-Pi storage migration was needed or built; see the record for what is not covered.
- **Blockers:** G02.
- **Deliverable:** Actual Pi adapter checkpoint version, extension and compaction migration fixtures.
- **Acceptance and verification:** Resume supported old checkpoints and reject incompatible ones without mutation; prove failed migration preserves originals; explicitly test extension and compaction fixtures; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence; independent of controller schema migrations, which are covered by F04.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G04 — Prove supporting durable engine integration

- **Parent:** N01 / AII-251.
- **Blockers:** S09, F04d, F04f, F04g, G09.
- **Deliverable:** Actual embedded controller and Pi integration on SQLite and PostgreSQL.
- **Acceptance and verification:** Kill worker and controller around admission and result; no lost acknowledged request or duplicate protected effect; wait survives service restart; exercise both real controller databases, connection loss and ambiguous commits; validate the mechanism decisions in design proposal section 3; classify any failure as an implementation defect or evidence against the selected architecture; do not defer backend selection to this task; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G05 — Prove selected isolation boundary per OS

- **Parent:** N06 / AII-256.
- **Blockers:** A03, A04.
- **Deliverable:** Actual NimbleNewt component/integration tests: Disposable containment fixtures and capability matrix.
- **Acceptance and verification:** Deny outside-workspace writes, symlink escape, credential reads and uncontrolled network routes; record trusted-host exceptions; run on available platforms and require Windows before release; prove launch/exec/results/teardown under actual unattended service identity after logout and reboot; feature-enabled or interactive-session smoke success alone is insufficient; include mapped-output ACL positive/negative controls and packaged controller working-directory checks; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence; the real-hardware sign-off records the macOS version the boundary was proven on and that the macOS boundary is weaker than Linux's.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G06 — Qualify actual Windows implementation

- **Parent:** N18 / AII-268.
- **Blockers:** G02, G03, G05, F03.
- **Deliverable:** Actual NimbleNewt component/integration tests: Windows host evidence and reproducible commands.
- **Acceptance and verification:** Repeat crash, output, migration and containment cases on supplied host; document OS/runtime/filesystem; no Mac/Linux substitute; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence; path cases include Unicode, case-insensitive collisions, drive roots, paths over 260 characters and junctions.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G07 — Record current architecture and executable task manifest

- **Parent:** N01 / AII-251.
- **Status:** implemented; commits `5e2953f`; CI runs 39358055788; record [g07-architecture-and-coverage.md](g07-architecture-and-coverage.md).
- **Progress note:** Architecture summary, requirement-coverage matrix (31 accepted areas to cards, with gaps named) and a DAG validation test (scripts/plan.test.mjs).
- **Blockers:** G01.
- **Deliverable:** Current design, requirement coverage and validated implementation DAG.
- **Acceptance and verification:** Record owner planning-sync authorization; actual-code qualification follows implementation dependencies; no standalone probe gate; N00 execution authorization remains separate.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G08 — Prove remote stop and failover authority contracts

- **Parent:** N01 / AII-251.
- **Blockers:** H09, K05.
- **Deliverable:** Actual remote-worker and recovery components with external failure observer.
- **Acceptance and verification:** Blackhole traffic and kill supervisor; externally measure hard stop; reject stale renewal; exercise selected recovery policy and prove old primary cannot issue accepted work; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G09 — Prove retained-context inquiry and mid-generation interruption

- **Parent:** N03 / AII-253.
- **Blockers:** C05, L05, L05b.
- **Deliverable:** Actual NimbleNewt component/integration tests: Typed pause/branch/resume/suspend fixture with exact context manifests.
- **Acceptance and verification:** Inquiry sees original current context without polluting parent; unchanged and updated resumes correct; stream interruption and partial tool calls cannot admit stale actions; context survives restart without summary reconstruction; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence; continuity is also validated across a provider change and the correction of an old owner decision; the resume record labels native restore, reconstruction or restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G10 — Benchmark native backend caching and branch markers

- **Parent:** N03 / AII-253.
- **Blockers:** C06.
- **Deliverable:** Actual NimbleNewt component/integration tests: Pinned Strata (latest source)/Radiance/vLLM/llama.cpp capability matrix, plus the hosted OpenAI-compatible and Claude caches measured through their usage fields (the owner is moving the local model from Strata to Radiance on two GPUs once new hardware arrives, owner statement 2026-10-22; standalone Radiance, not the deprecated vllm-radiance fork, is the intended engine for two R9700 cards; it is added and measured when it is running, including its OpenAI-compatible endpoint, prefix caching (read from each response's cache_n and prompt_n and from /sessions, with the host tier and the hybrid model's linear-state snapshots sized so a long shared transcript is not dropped and re-prefilled), the eight-sequence concurrency limit of the Flash-Next recipe, its FP8 KV cache, its pinned host memory needs and its container settings (unconfined seccomp, device access, host networking, so run it on a trusted network with an API key), and nothing may depend on a Strata-only feature) and available-hardware measurements.
- **Acceptance and verification:** Audit exact backend APIs: llama slot save waits for idle, vLLM keep pauses whole engine; qualify cache-preserving options and avoid development-route exposure. Separate cold/native/retained-marker runs; verify tokens reused and context fidelity; report memory, TTFT, switch latency and cache-miss fallback; unavailable backends marked unqualified; no production changes; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence; the responses of each running backend are captured and kept as fixtures, and the C06 profiles are re-tested against them.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G11 — Qualify the Pi Durable runtime upgrade path

- **Parent:** N03 / AII-253.
- **Blockers:** G03, F07, K07.
- **Deliverable:** Runtime upgrade procedure: upstream inventory and explicit compatibility map, registry check including native commands and wire names, fixtures with paused and suspended agents, pending decisions, queued commands, interrupted effects and branches, and staged version-set activation (runtime-compatibility-and-namespaces 38-61; README 269).
- **Acceptance and verification:** An unknown mapping blocks activation; a name-only mapping fails when semantics change; a native collision blocks activation; the G02 and G03 suites, a reserved-name conflict scan and rollback to the previous pinned runtime run before activation; the full version set is recorded with each environment and checkpoint and old-version metadata is retained for long-suspended work; agents resume only after verification; run on macOS, Linux and Windows with fake services.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F01 — Create TypeScript package boundaries

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `9318464`.
- **Progress note:** Delivered with F03/F05 on the Pi-first path; boundary checker, strict TypeScript, locked dependencies.
- **Blockers:** G07.
- **Deliverable:** Minimal TypeScript Pi adapter package, shared contracts and test runner; other packages are boundary placeholders.
- **Acceptance and verification:** Clean typecheck/build and dependency checks; real adapter test entry point; no controller or database implementation required to begin Pi work.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F02 — Implement versioned configuration and secret references

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `d9c75db`; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** New dependency-free packages/config: schema-versioned configuration with a loader, migration chain, path-addressed validation errors, secret references with redacting resolvers, and a sanitized export/import with preview and mapping. Config history, drafts and concurrent-edit control belong to the controller-backed configuration service (U04).
- **Blockers:** F01, G02, G03.
- **Deliverable:** Configuration loader, migrations and example public/private profiles.
- **Acceptance and verification:** Invalid or unsupported config fails clearly; secrets absent from exported config/logs; private grants excluded from public defaults.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F03 — Establish portable CI and test fixtures

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `10b12c5`, `bfbaeb2`; CI runs 39341276543.
- **Progress note:** Matrix CI, offline guard, offline fixtures, license inventory; the first run failed on Windows and was fixed in bfbaeb2.
- **Blockers:** F01.
- **Deliverable:** macOS/Linux/Windows pipelines and offline fixtures.
- **Acceptance and verification:** Fresh checkouts build and run offline smoke tests on all selected versions; locked dependencies and license inventory captured.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04a — Define transactional controller storage contract

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `b5229b8`; CI runs 39360216342; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Typed storage contract, canonical JSON/hash/validation rules, error classification, bounded retry with ambiguous-commit resolution, in-memory reference store, fault injector, shared conformance suite (about 90 cases, including epoch fencing of every write and atomic receipt/timer/effect reconciliation) and a build check that keeps SQL and drivers out of non-adapter code. Verified against the reference store only; real SQLite/PostgreSQL conformance is F04b/F04c.
- **Blockers:** F01, G02, G03.
- **Deliverable:** Typed domain operations and shared semantic fixtures.
- **Acceptance and verification:** Atomic transition plus audit/outbox; unique IDs and payload mismatch; revision/epoch checks; consistent data types, transaction boundaries and ambiguous-commit resolution; no raw SQL in domain services.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04b — Implement SQLite controller storage adapter

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `8aed518`; CI runs 39362190327; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** SQLite controller storage adapter on node:sqlite: WAL, synchronous FULL, bounded busy timeout, BEGIN IMMEDIATE writes, schema-level uniqueness, best-effort network-filesystem refusal. Passes the shared conformance suite and multi-process contention and SIGKILL tests on Linux. Power-loss durability, Windows/macOS runs (CI) and throughput are not yet evidenced.
- **Blockers:** F04a.
- **Deliverable:** Local SQLite adapter and schema with explicit durability settings.
- **Acceptance and verification:** Shared semantic fixtures pass; bounded busy handling and rollback; no network filesystem; short transactions and process-crash recovery verified.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04c — Implement PostgreSQL controller storage adapter

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `257e630`; CI runs 39373563539; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** PostgreSQL controller storage adapter on pg 8.23.1: bounded pool, READ COMMITTED with row-level rules (ON CONFLICT, conditional UPDATE, FOR SHARE epoch fence, SKIP LOCKED claims, counter-row sequence numbers), explicit verified server settings, driver-error classification. Passes the shared conformance suite and PostgreSQL-specific concurrency, deadlock, lock-timeout, pool-bound and connection-cut tests against a real PostgreSQL 17.10 server. Only 17.10 qualified; supported versions are an open owner decision; Windows/macOS runs and throughput not yet evidenced. The PostgreSQL suites were red on windows-latest until the embedded test server was started through pg_ctl (the runner is an administrator) and the database was required to be UTF8; CI run 39373563539 is green on all six cells.
- **Blockers:** F04a.
- **Deliverable:** PostgreSQL adapter and schema with bounded pool and retry policy.
- **Acceptance and verification:** Shared fixtures pass on real PostgreSQL; competing claims preserve ownership and ordering; deadlock/serialization retries and ambiguous commit handled without duplicated admission.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04d — Qualify storage adapter parity and contention

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `c0f714f`; CI runs 39373563539; record [f04d-storage-qualification.md](f04d-storage-qualification.md).
- **Progress note:** Parity (seeded differential test across the reference store, SQLite and PostgreSQL), crash at every statement boundary on both backends, PostgreSQL immediate-shutdown recovery, and a workload report (4 active, 32-active-equivalent, 100 idle hosts, hot row) with latency, event-loop stalls, conflicts and pool pressure; a synthetic storage-only load on one Linux machine, no claim about real-agent capacity. Windows/macOS performance, power loss and remote PostgreSQL not evidenced. CI run 39373563539 is green on all six cells (the workload report itself was run on Linux only).
- **Blockers:** F04b, F04c.
- **Deliverable:** Identical fault suite and workload reports for both backends.
- **Acceptance and verification:** Crash at every atomic boundary; interrupted connection and uncertain commit; duplicate messages, stale epochs and per-task ordering; baseline four active and 32-active-equivalent stress plus100 idle; record latency/contention without claiming real-agent capacity.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04 — Define storage schema migration runners

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `cd35ff3`; CI runs 39374886124; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Journaled, checksummed schema migrations on both backends: transactional and idempotent non-transactional steps, refusal of newer databases, edited migrations, journal gaps and foreign databases, advisory-lock serialisation on PostgreSQL, committed layout-1 fixtures. Upgrade behaviour is qualified with synthetic later layouts (the production list has one migration), including a crash at every statement of an upgrade on both backends. CI run 39374886124 is green on all six cells.
- **Blockers:** F04d.
- **Deliverable:** Backend-specific versioned schema migration journals.
- **Acceptance and verification:** Interrupted schema migration recoverable on both databases; incompatible downgrade rejected; constraints enforce unique operation and delivery IDs; upgrades preserve fixture state.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04f — Move the SQLite adapter off the main thread

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `d4d824a`; CI runs 39433503180; record [f04d-storage-qualification.md](f04d-storage-qualification.md).
- **Progress note:** The SQLite adapter runs on its own worker thread with synchronous=FULL kept: p99 event-loop delay under 32 concurrent loops fell from about 440 ms to about 2 ms in two real-disk Linux runs; throughput is no lower. Costs recorded: calls queue first-in-first-out so per-call latency rises, reads wait behind commits (a separate read connection is a follow-up), and hot-row contention is no longer masked. Conformance, parity and crash-boundary suites pass unchanged; a worker that stops mid-write fails the waiting write as uncertain_commit. Linux only measured. CI run 39433503180 is green on all six cells.
- **Blockers:** F04.
- **Deliverable:** Worker-thread SQLite adapter behind the unchanged ControllerStorage contract, with synchronous=FULL kept.
- **Acceptance and verification:** Conformance, parity and crash-boundary suites pass unchanged against it; event-loop delay under the 32-active-equivalent workload is measured with the F04d method and compared with the in-thread adapter; worker crash, startup failure and shutdown surface as typed storage errors and never lose or duplicate an acknowledged commit; ambiguous commits still resolve by operation ID; no weakening of durability settings.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04g — Verify supported PostgreSQL versions

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `b63ec1d`; CI runs 39436696991; record [f04g-postgres-versions.md](f04g-postgres-versions.md).
- **Progress note:** PostgreSQL 17 and above is the supported range and the adapter refuses older servers at open. The six PostgreSQL-dependent test files were run against the latest build of each of 14, 15, 16, 17 and 18 (exact locked installs): all pass 236/236 on Linux, macOS and Windows (hand-started workflow run 39438475744). 14 to 16 are verified and reported, not supported; narrowing support to the two most recent majors is the owner's later decision. CI run 39436696991 is green on all six cells.
- **Blockers:** F04.
- **Deliverable:** Qualification run of the PostgreSQL adapter on the latest minor of each major from 14 to current, and the supported-version statement.
- **Acceptance and verification:** Conformance, parity, crash and migration suites run per major; 17 and above is the claimed support, each lower major is reported as passed or failed without claiming support; the code version floor matches the claim; server version and platform recorded; owner decides later whether to narrow support to the two most recent majors.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04h — Refuse unsupported environments unless explicitly overridden

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `ae3b81b`; CI runs 39490486463; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** One list of supported environments (SUPPORTED_ENVIRONMENT); an uncovered OS, architecture, Node or PostgreSQL version is a hard stop whose message names what was found, what is supported, how to run the project's own verification and the exact override (--allow-unsupported-environment or NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT); the override starts normally, prints a notice and writes an audit record once per epoch. The PostgreSQL adapter refuses an old server before creating anything and, with allowUnsupportedServer, opens unchanged; the floor cannot be lowered any other way outside the F04g verification run. Tested on the reference store, SQLite, SQLite on a worker thread and PostgreSQL. The OS release floors are the lowest releases seen in CI and are for the owner to confirm; no controller executable exists yet, so the start-up call sequence is carried forward to U01. CI run 39490486463 (commit 4c26cd2) is green on all six cells; the run for ae3b81b itself failed one Windows cell on a racy S05 test, fixed in 4c26cd2.
- **Blockers:** F04g.
- **Deliverable:** Startup check of the PostgreSQL server version and of the operating system, architecture and Node version against the supported list, with a documented override switch.
- **Acceptance and verification:** An unsupported PostgreSQL major, OS or Node version makes the controller refuse to start with a message that says what was found, what is supported, how to run the project's own verification against that version (the per-major PostgreSQL qualification and the QA script) and the exact switch that overrides it (owner decision 2026-10-22: every refusal that can be overridden tells the owner how to override that specific error; one switch may cover several refusals as long as the message names it); the override starts the controller, records the override in the audit log and in startup output, and never changes behaviour otherwise; the refusal is a hard stop, not a warning, because warnings are missed; tested for supported, unsupported and overridden cases on every storage backend; the supported list lives in one place.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04i — Refuse unsupported filesystems unless explicitly overridden

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `2575465`, `dea2e5b`; CI runs 40411682946; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The filesystem check and its override are built and tested; passing workspace roots to it at start is F04k.
- **Blockers:** F04h.
- **Deliverable:** Startup check of the filesystem under the data directory and workspaces against the supported list (Linux: ext4, xfs, btrfs; macOS: APFS; Windows: NTFS; network filesystems are not supported for the data directory), reusing the F04h override switch (owner decision 2026-10-22: error, and allow an override).
- **Acceptance and verification:** An unsupported or network filesystem makes the controller refuse to start with a message that says what was found, what is supported and the exact switch that overrides it, which is the F04h switch (owner decision 2026-10-22: the message always tells the owner how to override that specific error); the override starts the controller, records the override in the audit log and in startup output and never changes behaviour otherwise; the refusal is a hard stop, not a warning; case-insensitive and normalising filesystems are handled by the workspace bridge and tested; tested for supported, unsupported, network and overridden cases; the supported list lives in one place with the F04h list.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04j — Check required tools and libraries instead of distribution names

- **Parent:** N02 / AII-252.
- **Blockers:** F04i, A03.
- **Deliverable:** Startup check of what the controller and sandbox actually need rather than which Linux distribution runs them (owner decision 2026-10-22: there are too many distributions to list): the Node version, git, the sandbox launcher's required tools and kernel features, a systemd user session where resource limits need one, and the database client libraries, each found by probing, never by the distribution's name; the distribution is only recorded in the audit log and the startup output.
- **Acceptance and verification:** A missing or too-old prerequisite makes the controller refuse to start (or the named feature refuse to run, where only one feature needs it) with a message that says what was found, what is required, how to install it and the exact switch that overrides it (owner decision 2026-10-22: the message always tells the owner how to override that specific error); a missing hard prerequisite (git, the sandbox tools) cannot be overridden because the feature cannot run without it, and only a too-old version can be; the Node version is checked from F04h's single list and not a second one; no behaviour depends on a distribution name or version string; tested with prerequisites present, missing, too old and overridden, on every supported operating system; the list of required prerequisites lives in one place.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04k — Pass workspace roots to the startup filesystem check

- **Parent:** N02 / AII-252.
- **Blockers:** F04i, U01.
- **Deliverable:** Split from F04i (audit 2026-10-26): the check of workspace file systems exists and is tested, but the controller checks workspaces only when StartOptions.workspaceRoots is passed and no production start passes it, so an unsupported workspace file system does not stop start-up today.
- **Acceptance and verification:** A real start with a workspace on tmpfs, exFAT or a network file system is refused with the F04h message and its override switch; the override starts the controller and is audited; the workspace roots come from the registered projects' checkouts, not from a hand-built option.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04e — Implement chat-controlled controller database transfer

- **Parent:** N02 / AII-252.
- **Blockers:** F04, K01, F06.
- **Deliverable:** SQLite to PostgreSQL and reverse logical transfer with maintenance journal.
- **Acceptance and verification:** Drain work and fence admissions; validate IDs, policy, receipts, uncertain effects, timers, artifacts and Pi checkpoint references; injected transfer failures preserve source; destination authority is unique; reverse transfer checks capacity; no unsafe rollback after new effects.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F05 — Implement pinned Pi adapter submission contract

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `24019e5`; CI runs 39343771217.
- **Blockers:** F01.
- **Deliverable:** Typed adapter mapping request IDs and semantic results.
- **Acceptance and verification:** Duplicate submit returns original result; output sentinel retained; unknown tool/command and unsupported runtime fail explicitly.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F06 — Implement adapter checkpoints and cancellation mapping

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `b764bef`, `51e545c`, `b3b6e0f`, `e559db0`, `23eb5f3`, `8abbb11`, `faf4738`, `12d1db7`, `7c85449`; CI runs 39344954150, 39346341366, 39347068717, 39347963920, 39349319911, 39350464195, 39350846384, 39351488611, 39355119190.
- **Progress note:** Delivered in nine reviewed pieces: F06a handles/restart, F06b branches/updates, F06c1 abort/readmission, F06c2a hold, F06c2b context decisions, F06c2c branch lifecycle, F06d1 checkpoints, F06d2 controller boundary/audit/recovery, F06e independent tasks.
- **Blockers:** F05.
- **Deliverable:** Real Pi adapter branch, checkpoint, abort and fresh-process restoration APIs; typed controller integration boundary.
- **Acceptance and verification:** Retain parent context across inquiry branch; selective update applied once; adapter-owned queued input survives cancellation; incomplete tool calls never execute; retained commands require later controller readmission; no controller database prerequisite; controller inbox bridge is integrated and tested in S09.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F07 — Enforce immutable extension and namespace registration

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `1015b01`; CI runs 39430658838; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Dependency-free @nimblenewt/registry: strict canonical names with an injective provider wire-name mapping; trusted, per-agent and read-only capabilities; immutable, increasing, revocable versions; a sealable protected namespace; pin sets that restore the exact pinned versions or block, never substituting; reserved-set integrity check; history replay through the same rules. Not yet wired into the adapter or workers (S02, T01, A05 carry that forward; see the F07 notes). CI run 39430658838 is green on all six cells after a rerun: the first attempt failed one Windows/Node 24 cell on an unrelated flaky assertion in the in-thread SQLite smoke test, fixed in F04f.
- **Blockers:** F05, F02.
- **Deliverable:** Protected registry facade and artifact version selection.
- **Acceptance and verification:** Personal extension cannot replace reserved system tool; paused attempt restores pinned version or blocks on revocation.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F08 — Declare harness capabilities and enforce per-task recovery requirements

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `a6aec3e`; CI runs 39617517980; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Harness capability declarations: a harness states whether it continues a conversation natively, can have it rebuilt from exported records, can export checkpoints and what an abort stops; the Pi declaration is derived from the G02 capability lists (native continuation yes, portable reconstruction no, whole-conversation abort) and the controller's checks run on it in the integration tests. A harness with neither recovery path is unsupported for durable tasks. A task's contract carries the recovery it needs (default native continuation; lowering it needs planning authority), and attempt admission refuses a harness that lacks it with the missing capability named; with a gate configured every attempt is checked and an unnamed harness is accepted only for work that may be lost. The installer builds the catalog (Pi only ships). The "fake second harness" is met at the level of declarations, not a running second runtime; the reading of "state export" as "no way to recover" is an open owner decision (G01 record). A contract revision changed at the same moment as an admission is not checked (noted gap). CI run 39617517980 is green on all six cells.
- **Blockers:** F06, S02.
- **Deliverable:** Harness adapter capability declaration (native continuation, portable reconstruction, checkpoint export, abort semantics) with the Pi declaration taken from the G02 record, and a per-task recovery requirement checked at admission (README 59, 85-87, 193).
- **Acceptance and verification:** A fake second harness passes the same contract suite through its declaration; admission refuses a durable task whose recovery requirement the selected harness lacks, with a visible reason; a harness without state export is marked unsupported for durable tasks; the Pi declaration matches the G02 record including its unsupported capabilities; only the Pi adapter is a shipped harness unless the owner widens scope.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F09 — Implement per-OS secret store backends

- **Parent:** N02 / AII-252.
- **Status:** implemented; commits `d8c4918`, `be686fa`; CI runs 39705612613; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Secret stores behind the configuration's secret references: the macOS Keychain, Windows DPAPI for the running account, the Linux Secret Service, and a permission-checked owner-only file store for hosts without one. A secret is written through standard input, never returned from a write, never put on a command line or in an error or log; a missing, locked or damaged store fails with an error naming the reference; a rotated secret is used at the next resolution; the first choice of store is recorded and never quietly replaced. The macOS store keeps a value as short chunks under a generation with a digest header, reads back every write, and refuses a damaged or half-written entry (tested on every platform against an in-memory stand-in and on the hosted macOS job against the real tool, including a 16 KiB value); the DPAPI store ran on the hosted Windows jobs. Not verified (real hardware, QA checkpoint Y02): references resolving under an unattended service account after logout and reboot. The write path through the API, chat or UI is U08. Reviewed and approved by an AI review session (Claude Opus) after four rounds; six-cell CI green.
- **Blockers:** F02, A01.
- **Deliverable:** Secret backends behind the F02 secret-reference resolver: macOS Keychain, Windows Credential Manager/DPAPI, Linux Secret Service with a documented, permission-checked file fallback (portability-and-configuration 31, 75).
- **Acceptance and verification:** A secret is written through the API, chat or UI and never returned, echoed or logged; references resolve under the unattended service identity on macOS, Linux and Windows after logout and reboot; a missing or locked store fails with a clear error naming the reference; export and backup carry references only unless encrypted backup (K01b) is on; a rotated secret is used from the next resolution without restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S01 — Implement project/task records and revisioned commands

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `c2574d7`; CI runs 39438460593; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** ProjectService: project and task records changed only by idempotent, revisioned commands (derived stable IDs, command digest kept in the audit entry, duplicates answered with the recorded result including concurrent ones, stale revisions and reused command IDs rejected, task lifecycle, optional repository). Tested on the reference store, SQLite, SQLite on a worker thread and PostgreSQL. No assignment (S02), outbox (S03) or permissions (A01) yet. CI run 39438460593 is green on all six cells after a rerun of one cell that GitHub cancelled for lack of a macOS runner.
- **Blockers:** F04.
- **Deliverable:** Domain commands, stable identities and optimistic revisions.
- **Acceptance and verification:** Duplicate identical command applies once; conflicting key payload and stale revision rejected; task may exist without repository.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S02 — Implement assignment generations and attempt admission

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `168e35d`; CI runs 39485674692; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Assignment per task with generations and an immutable history, attempts with a single active writer, fenced task writes whose check is atomic with the change, observed activity kept apart from ownership, assignment events written in the same transaction. Tested on four backends including concurrent first assignments, concurrent admissions and fenced writes racing transfers. Unfenced ProjectService commands remain until permissions (A01); the worker and adapter do not check fences yet. CI run 39485674692 is green on all six cells.
- **Blockers:** S01, F05.
- **Deliverable:** Assignment history, attempt records and fencing checks.
- **Acceptance and verification:** Two competing admissions yield one valid writer; old generation cannot mutate task after transfer; observed activity separate from owner.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S03 — Implement durable transition delivery

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `08c438b`; CI runs 39484786735; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Task commands write their event (a snapshot of the new revision) in the same transaction as the change, so there is no message without its change or the reverse; a DeliveryDispatcher claims messages in commit order per task, hands them to a handler and records the receipt in one transaction, at least once, with backoff, takeover handling and stale-epoch stop; reconcileTaskEvents repairs a task whose current revision has no message. Tested on four backends and with a real SIGKILL before and after the task commit and before and after the receipt. Not yet consumed in production (the inbox is S04) or called by a periodic scan (S07). CI run 39484786735 is green on all six cells.
- **Blockers:** S01.
- **Deliverable:** Selected engine delivery mechanism and domain outbox bridge where needed.
- **Acceptance and verification:** Kill before/after commit and receipt; committed intent is eventually found; no event for rolled-back transition; cross-store gap reconciled.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S04 — Implement durable inbox and duplicate handling

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `e1b582b`; CI runs 39486830124; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Durable inbox: a message is held before it is acknowledged, one record per delivery, a changed payload under the same delivery ID is refused; assignment messages are admitted from the current assignment through an attempt command derived from the message, so duplicates, out-of-order arrivals, concurrent callers and a crash between steps never create a second attempt, and a no-attempt decision cannot contradict an attempt another caller created. Closed tasks settle as task_closed; not-yet-ready tasks are deferred. Tested on four backends. CI run 39486830124 is green on all six cells.
- **Blockers:** S03, S02.
- **Deliverable:** Receipt, admission and settlement records.
- **Acceptance and verification:** Duplicate/out-of-order delivery cannot create second attempt; acceptance acknowledges only durable receipt; changed payload rejected.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S05 — Implement effect ledger and idempotent bridge

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `99b902f`, `4c26cd2`; CI runs 39487923883, 39490486463; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Effect ledger and idempotent bridge: intent (ledger row, full input, stable key, fence checked in the same transaction) recorded before anything is done; execution under a leased, revision-guarded claim by a bridge that declares whether its target is idempotent or can be asked; after a crash or doubt a started effect is reconciled, retried with its key or becomes uncertain and is refused for retry until a person resolves it; a vanished executor never causes a blind second execution and a late result is not recorded over another holder's. Tested on four backends and with real SIGKILL after the outside success and before the result was saved. CI run 39487923883 is green on all six cells after rerunning one macOS cell GitHub cancelled; one Windows test that raced was fixed in 4c26cd2 (run 39490486463 green).
- **Blockers:** S02, S04.
- **Deliverable:** Effect intents, external keys and reconciliation interface.
- **Acceptance and verification:** Kill after external success before result save; protected effect occurs once; unsupported target becomes uncertain and blocks blind retry.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S06 — Implement artifact publication and integrity

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `659f1be`; CI runs 39440347235; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Immutable content-addressed blobs and artifact manifests: blobs stored and flushed first, the manifest committed last as one idempotent command, so a crash between leaves no accepted dangling reference (real SIGKILL at four exact points); missing, truncated or altered blobs block resuming; reads return only verified bytes; orphan cleanup is grace-period, lock and epoch guarded. One process owns a blob store (not enforced on disk). CI run 39440347235 is green on all six cells after a rerun of one Windows cell that failed on a flaky smoke-test threshold, hardened since.
- **Blockers:** F04.
- **Deliverable:** Immutable blob/manifest storage and hash verification.
- **Acceptance and verification:** Crash between blob and manifest leaves no accepted dangling reference; corrupt/missing blob blocks resume; orphan cleanup safe.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S07 — Implement startup and periodic reconciliation

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `40bd4bd`; CI runs 39494505537; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Startup and periodic reconciliation: a Reconciler pass reads durable state only (no wake-ups, no model) and announces tasks lacking an event, delivers due messages with bounded retry, admits received inbox messages and recovers started effects; scans keep durable cursors; each step and item is isolated so one bad record cannot stop a pass; handler failures are counted and a message that keeps failing is held with one visible blocker that a person resolves; manual holds are respected and never cleared by a pass; a trouble that returns after a blocker was resolved opens a new blocker. Tested on four backends. CI run 39494505537 is green on all six cells.
- **Blockers:** S03, S04, S05.
- **Deliverable:** Deterministic repair scan, cursors and bounded retry.
- **Acceptance and verification:** Drop wakeups and restart dispatcher; pending work found without LLM; manual hold preserved; exhausted retries create visible blocker.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S08 — Implement typed waits and deadline settlement

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `8544c5c`; CI runs 39497378879; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Typed waits and deadline settlement: a wait names its reason, resolver, summary and next action and either a deadline with what happens at it (resume, cancel, escalate) or an explicit indefinite hold with its owner; opening it blocks the task, schedules the deadline and announces the change in one transaction; only the named resolver can answer while the wait is open and the task is still blocked; a late answer to a closed wait or cancelled task is refused and revives nothing; an answer racing a deadline yields one outcome; the reconciler settles deadlines, closes waits whose task is no longer blocked, opens overdue blockers and flags blocked tasks nothing explains. Tested on four backends. CI run 39497378879 is green on all six cells.
- **Blockers:** S04, S07.
- **Deliverable:** Wait reasons, resolver IDs, deadlines and terminal outcomes.
- **Acceptance and verification:** No waiting task lacks next action or explicit indefinite owner hold; late answer cannot revive cancelled operation.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S09 — Verify the durable vertical slice

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `6c7b5b2`; CI runs 39499789791; record [s09-acceptance-report.md](s09-acceptance-report.md).
- **Progress note:** Integrated fault harness and first acceptance report: the path from a chat-command stub to a worker result (assignment, delivery, inbox admission, the controller inbox bridge to a conversation, a fenced effect through the ledger, an artifact, a recovery point, completion) is crashed at each of 129 enumerated boundaries (every storage write including taking the epoch, blob steps, the outside effect, the conversation, the bridge), restarted under a new epoch and required to equal a clean run: all 129 on the reference store and SQLite, 20 on SQLite on a worker thread and on PostgreSQL, 10 real SIGKILLs, and 18 real SIGKILLs with the real Pi adapter (tests-only packages/integration) including with the model request in flight. Adds ConversationBridge and RecoveryPoints; found and fixed an unbounded retry loop in the effect ledger. Waits, timers and delivery retries are not on the crash path; the cross-OS and real-hardware parts of QA checkpoint Y01 are not claimed by this card. CI run 39499789791 is green on all six cells.
- **Blockers:** S05, S06, S07, S08, F06, G02, G03.
- **Deliverable:** Integrated fault harness and first acceptance report.
- **Acceptance and verification:** Chat-command stub through worker result survives every enumerated crash boundary; exact effects and owner generation agree after restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S10 — Implement task contracts and the task dependency graph

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `2e75b44`; CI runs 39615958968; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Versioned task contracts (expected result, acceptance criteria, priority, difficulty, budget, P or PC class, required evidence, permissions): every change stores a new version and keeps the old ones, a task with none reads as the defaults, and priority, difficulty, the class and the general fields each need their own authority (narrowable to one task). Dependencies between tasks of a project are refused when they would make a cycle, also when added at the same moment (one registry record per project). A task-level wait-for graph over dependencies and open inquiries finds circular waits and opens one blocker per ring (a ring that re-forms gets a new one); one agent working through its own dependent tasks is not a ring. Two clauses are carried by other cards and named in their acceptance: reviews in the wait-for graph (H05, through the extraEdges hook) and a priority change reordering already-queued requests (H12); the permission list is stored, and enforced by the tool path (T06, H12). Seven API operations (api-v1.md regenerated). CI run 39615958968 is green on all six cells.
- **Blockers:** S01, S08, A02.
- **Deliverable:** Versioned task contract fields (expected result, acceptance criteria, priority, difficulty, budget, P/PC class, required evidence, permissions) and task dependency edges with responsible agents, changed only by revisioned commands (README 148, 159; operational-contracts 17; production-and-capacity 9; pitfalls-and-safeguards 65).
- **Acceptance and verification:** A contract change creates a new revision with history; dependency cycles rejected; an agent without a grant cannot edit another team's dependencies or a task's difficulty; a wait-for graph across task dependencies, inquiries and reviews detects circular waits beyond reviewer cycles and opens a blocker naming who can unblock; a priority change takes effect at the next admission decision without rewriting history; a P/PC class change is an audited command needing planning authority; tasks created before the new fields keep working.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A01 — Implement authenticated principals and capabilities

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `d502980`; CI runs 39537287118; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** One installation owner and enrolled agents and hosts, each with per-project grants; credentials are shown once and stored only as a scrypt hash, and every authentication failure reads the same. SecureApi takes the actor from the authenticated principal, checks the project from the stored record (a refusal on another project's record reads exactly like a missing one), ties command IDs to the principal, and offers the tool gate; secrets are redacted from its error messages. Limits stated in the notes: the tool gate is not yet called by any tool path (T01, A04, A05), stored content is not redacted by the services, and only projects, tasks and assignments are behind SecureApi so far. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** S01, F02, S09, Y01.
- **Deliverable:** Owner/agent/host identities and scoped capability checks.
- **Acceptance and verification:** Spoofed actor and cross-project access rejected; permission checks cover API and tool paths; secrets redacted.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A02 — Implement revisioned grants and restrictions

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `9d9bd0f`; CI runs 39539534019; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Direct and standing grants (action, project, optional single resource, optional window, the wording they came from) with revisions and owner-only revocation; derived grants that rest on a grant the holder has, can never be wider or outlive it, and fall with it; restrictions that beat every grant, can be limited to one resource or apply to everyone but the owner, and can be lifted or expire. Authentication returns the principal with its grant records and restrictions already loaded, and a non-owner with no snapshot is refused. Limits stated in the notes: changes show from the next snapshot, the grant-record readers are not access-checked until an API exposes them, and nothing yet creates derived grants automatically. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** A01.
- **Deliverable:** Direct, derived and standing grants with expiry/revocation.
- **Acceptance and verification:** Necessary scoped actions covered without redundant approval; unrelated resource and expired scope denied; conflicting restriction wins.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A03 — Implement selected sandbox launcher

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `d8c4918`, `be686fa`; CI runs 39705612613; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The sandbox launcher for Linux (bubblewrap) and macOS (Seatbelt): fixed recipe recorded as a revision at every launch, escape fixtures denied on each OS that has a backend, mode visible in audit, trusted-host mode only with configured authority, capacity advertised only after a real confined probe, killable process tree, and the quarantine: work under a path the agent lost is moved read-only with a manifest, never deleted or silently merged (a failure after the move keeps the work, a cross-filesystem copy is verified by content digest before the original goes). The Windows Sandbox launcher and its session-dependent items moved to the new card A03b (owner to confirm the split). Reviewed and approved by an AI review session (Claude Opus) in three parts; six-cell CI green with the sandbox tests running on Linux and macOS.
- **Blockers:** A01, F03.
- **Deliverable:** OS-specific constrained worker launch and trusted-host mode.
- **Acceptance and verification:** Escape fixture denied on each OS that has a backend (Linux and macOS here; Windows is A03b); mode visible in audit; trusted-host option requires explicit configured authority; advertise capacity only after launcher health checks; the Linux launcher uses bubblewrap (G01 decision 2026-10-21) and refuses to advertise capacity when unprivileged user namespaces are unavailable; the sandbox recipe (mounts, network, limits) is fixed at launch and every launch records it as a revision; changing the recipe, wider or narrower, restarts the sandbox with the new recipe (the freeze, settle and checkpoint order around that restart is H12's); nothing durable lives only inside the sandbox (checkout, home and scratch are host-side and survive a sandbox restart); work under a path the agent just lost is quarantined read-only for the owner, never deleted or silently merged; a hard kill is reserved for an emergency stop (G01 decision 2026-10-21); the macOS launcher uses Seatbelt profiles (deny by default, scoped files, controlled network, killable process tree), fails closed with no advertised capacity if the profile cannot be applied, and documents that macOS confinement is process-level, shows denied paths as present but unreadable, and has weaker CPU, memory and process limits than Linux.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A03b — Implement the Windows Sandbox launcher

- **Parent:** N06 / AII-256.
- **Blockers:** A03.
- **Deliverable:** Windows Sandbox launcher and its session-dependent lifecycle.
- **Acceptance and verification:** Escape fixture denied on Windows; mode visible in audit; fail closed when the Windows session/client is unavailable; keep supervisor code outside guest-writable staging; provision narrow per-job share ACLs; verify package publisher/version and working directory; qualify VM fallback only if Sandbox cannot meet service lifecycle needs; support explicit owner-opt-in auto-login/lock mode with local credential entry, verified lock gating and clear session-dependent capability; never enable it by default; (split from A03 on 2026-10-22 so the Linux and macOS launcher, the recipe and the quarantine could be finished and relied on; the Windows launcher needs real Windows hardware to qualify).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A04 — Implement protected filesystem and Git bridge

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `b36d663`, `fa7ce12`, `5446d93`; CI runs 39713762083; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Agents edit only their own host-side checkout, and changes reach the shared workspace only through the bridge. Paths are plain relative paths; Git's own data is recognised in every spelling a filesystem might treat as the same name (case, Unicode, trailing dots, stream names, short names) and refused for every operation; links, junctions, hard links and spelling collisions are refused. A write names the version of the file it was based on, check and write are one step under a lock, and a file changed meanwhile is not overwritten: the agent's change is kept whole for review and the owner applies or discards it against the version they reviewed. The Git bridge gives each checkout no .git (its repository lives elsewhere), runs git with a fixed environment and command-line overrides so no hook, filter or external program runs, refuses a checkout holding any Git-named entry, treats files the agent's own ignore rules match as work, never replaces dirty work, and carries only plain files within the size limit. Two races found by the full CI run (a stale-lock takeover and an inbox admission) and a macOS index refresh were fixed on the way. Limits stated: the dispatcher (H12) must keep the separate git directory outside every sandbox's mounts and freeze the agent before integrating; file modes are not carried; the Windows junction tests ran on the hosted Windows jobs, not on real hardware. Reviewed and approved by an AI review session (Claude Opus) after three rounds; six-cell CI green.
- **Blockers:** A03, S05.
- **Deliverable:** Workspace access, expected-version writes and protected Git operations.
- **Acceptance and verification:** Symlink/path replacement and indirect .git writes denied; dirty work preserved; target change rejects conditional write; .git protection also covers deletion, replacement, renaming, truncation, permission changes, ancestor move or delete and both the worktree .git entry and the backing metadata; agent-written hooks or Git configuration never run with service privileges; a rejected conditional write keeps the pending change for review; Unicode, case-insensitive collisions, drive roots, long paths and Windows junctions handled; dirty work under a path whose access was revoked is kept in read-only quarantine for the owner (G01 decision 2026-10-21); workspace editing is mediated (G01 decision 2026-10-21): an agent writes only in its own host-side per-task checkout, mounted into its sandbox, no shared workspace or .git is mounted writable into any sandbox, and changes reach shared files only through the bridge's expected-version write.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A05 — Implement exact-operation review admission

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `2b1c861`; CI runs 39544119701; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A review is bound to one operation: the tool, its arguments, its script, its target and a digest of the grants and restrictions that bear on it, worked out from stored state. Just before the operation runs, admission recomputes all of it and refuses, naming what changed, if anything differs, if the approval has expired, been withdrawn or used, or if the executor no longer holds the grant itself: an approval waives the review and adds no capability. An approval admits one execution, safe under concurrency. Limits stated: the target is bound by name, not version; one admission can slip through at the instant a grant is revoked; the controller-side executor, not the agent, must call admit, and nothing calls it yet. Reviewed and approved by an AI review session (Claude Opus); CI: the first run failed one cell (Windows, Node 24) in a different, flaky storage-workload assertion about scheduling in a 1.5 s timed run; the re-run of that job (same commit, so the old assertion) passed, which shows the failure was intermittent. The assertion was relaxed in a later commit; that commit needs its own green run.
- **Blockers:** A02, S05, F07.
- **Deliverable:** Review binding to command, script, target and policy versions.
- **Acceptance and verification:** Changed arguments/script/resource/revocation invalidates verdict before execution; reviewer cannot expand capability.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A06 — Implement human pre-commit gate and attribution

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `9004a56`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Human pre-commit gate: a commit permit bound to the staged tree, base and the file list; actor provenance and trailers the agent cannot forge; review-before-commit and external-review acceptance; integration recorded. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** A04, A05.
- **Deliverable:** Staged-tree/base review and actor provenance.
- **Acceptance and verification:** Reviewed tree commits; changed staged content/base requires new review; developer, agent, executor and reviewer identities retained; attribution also records grant source, commit identity and later integration history; externally verified review references are accepted; no forged authorship; a reviewer who commits to the version under review is recorded as a contributor automatically (H05 contributors are self-reported until then).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A07 — Implement action classes, default policy and effective-policy view

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `22f87e4`; CI runs 39691755734; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Twelve action classes in four environments (development and testing free, staging guarded, customer-live live) and three profiles (strict, derived, autonomous) decide whether an action runs, goes to an independent agent review or asks the owner; the owner sets the installation profile and per-project environment, overrides and locks, previews a change in plain words, and can switch on an all-command gate. Things that stay the owner's decision (changing access, a customer-live deployment, a protected branch, spend beyond the estimate, irreversible actions, an audience nobody named) are waived only by an approval grant that names the tool or class exactly; capability grants never waive asking; the instruction's scope (ceiling, who set it, estimate) is read from the task's stored contract. Limits stated: the dispatcher (H12) does not call it yet. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** A02, A05, F02.
- **Deliverable:** Action-class catalogue (inspect, mutate, external send, publish, spend, install executable, access change, commit, push, merge, deploy), the derived profile (authorization flows from the instruction and its scope; its starter preset leans toward less asking), the strict profile a new installation starts in, presets (direct approval, delegated agent review, automatic) and the autonomous profile, an optional all-command human gate, approval grants (a separate family from capability grants) with fields for spend limit, environment, maintenance window, audiences, delegation allowance and conditions, and an effective-policy and preview query (authorization-and-delegation 3-19, 37; operational-contracts 87; README 106).
- **Acceptance and verification:** A fresh install starts strict and the owner's own installation starts derived (private deployment configuration); the derived profile works so: an explicit instruction (build, fix what fails, integrate) authorizes the reasonably necessary steps inside its scope, including fixing and retrying, merging into the integration branch and deploying to development and test environments, without asking again; the scope is recorded and shown with the work; a project whose environment is testing flows freely, within its own repositories, the integration branch and its development and test environments, with sandbox, protected-filesystem and Git-bridge rules unchanged and never a protected branch, the main release branch or another project; a customer-live environment, access changes, new external access, publishing to a new audience, spend beyond the estimate and destructive irreversible actions still need a decision unless the instruction named them; the strict profile asks at every consequential step; an unknown action goes to review, never auto-allowed; enabling the all-command gate gates every execution; drafting never publishes, and publish, external send and spend are granted separately per account and audience; relaxation scoped by environment, window or budget changes only that scope; a preset change keeps narrower human-review rules; a permissive project cannot weaken a locked installation restriction; effective policy shows source grants, inherited restrictions and effect time, and preview reports the practical effect before apply; a materially broader action, likely danger or unexpected spend needs a new decision while a standing grant survives handoff and restart without a prompt; a conversation action request (U02 stores it with needsAuthorization) is evaluated as a request under the effective policy, and nothing is executed because a message asked; approval load (authorization-and-delegation, 'Approval load is a design target'): the chosen preset says which classes reach the owner (where it places them, low-risk runs without asking, middle goes to delegated agent review with the owner shown a sample afterwards, only consequential or irreversible asks the owner); a change of profile keeps the cells, locks and reserved tools the owner set (tested); the owner's own installation starts derived from its private configuration, applied at first run by the setup card (U08); only an approval grant waives asking, never a capability grant, and for what stays a decision it must name the tool or class exactly (a customer-live deployment also the environment); the instruction's scope (ceiling, who set it, estimate) is read from the task's stored contract and a ceiling the acting agent wrote itself is ignored (tested).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A07b — Implement standing-rule proposals and approval-load measurement

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `56b9ae7`; CI runs 39694347201; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Repeated approvals become one proposal for the owner instead of a pile of questions: three approvals by the owner of the same class of action for the same agent in the same project in a free environment (development or testing), within 90 days, open a proposal that lists exactly the approvals it is drawn from and suggests an expiring approval grant for that class, requester, project and environment. Never proposed for access changes, spending or installs, for tools the project reserves for the owner or for unclassified tools; accepting makes the grant (replay-safe, no second grant on a retry) and dismissing keeps the proposal quiet for 30 days and then only after a newer approval; an accepted one returns only after its grant has ended and the owner approves again. A standing grant, including a copy derived from it, never waives what stays a decision. Approval-load figures for the owner: decisions per day, how long asks waited, how much ran by rule, grant, agent review or owner, and every ask still waiting with its age. Limits stated: nothing records decisions yet (H12) or shows the figures (U08, U11). Reviewed and approved by an AI review session (Claude Opus) after three rounds; six-cell CI green.
- **Blockers:** A07, A05, H05.
- **Deliverable:** Owner-decision tally, standing-rule proposals and the pending-asks and approval-load views.
- **Acceptance and verification:** Approving the same class in the same scope repeatedly (provisionally three times) produces a standing-rule proposal scoped to project, class and environment, expiring and revocable, with a preview of what it would have covered; the owner accepts it into a standing grant or dismisses it; it is never applied unasked and never proposed for a class the policy reserves for the owner or one that needs an exact-operation review (tested: a mandatory-human tool is never proposed); the effective-policy view shows how many asks each rule would have caused; owner decisions per day, how long asks wait, the share decided by rule, agent review and owner, and every pending ask with its age are recorded and returned for the approval-load view (U08); an accepted proposal (a suggestion, not an instruction) never authorizes a downstream push, merge or deploy (the proposal workflow cards T08 and P02 carry that clause); a proposal can also be answered by switching the installation to the derived profile instead of the suggested grant (permanent by default, or a trial), which makes no grant.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A07c — Implement the strict-to-derived profile suggestion

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `c1ecbdf`; CI runs 39705612613; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A strict installation asks the owner, after every third approval the owner gives, whether to move to the derived profile, showing in plain words what would change. Only the owner's own approvals count; nothing is ever switched automatically; "not now" is not asked again until three further approvals; it is never asked in the derived or autonomous profile, so an installation that starts derived never sees it. The answer is judged on one read, a switch that was recorded but not carried out can be finished, and a late replay changes nothing. Limits stated: the question is delivered through the digest and settings views (U11, U08); there is no way to lock the profile itself. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** A07, A07b.
- **Deliverable:** Profile-switch suggestion.
- **Acceptance and verification:** On an installation in the strict profile, after every third approval the owner gives (provisional; the same count as standing-rule proposals) the system asks once whether the owner wants to change to the derived profile, showing in plain words what would change (the effective-policy preview of A07); the answer is recorded, a "not now" is not asked again until three further approvals, nothing is switched automatically, and the suggestion is never made in derived or autonomous profiles or when the installation locks the profile; the owner's own installation (started derived by private configuration) never sees it; the suggestion is delivered through the digest (U11) and the first-run/settings views (U08) (tested: counts only owner approvals, repeats only after three more, a switch is made only by the owner's explicit answer); the answers are switch permanently (the default), a seven-day trial of the derived profile, or not now; when a trial ends the owner is asked again (keep permanently as the default, seven more days, or back to strict) and an unanswered trial stays derived (owner decision 2026-10-22; tested).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A07d — Offer a choice of standing-grant lengths with a system-chosen default

- **Parent:** N06 / AII-256.
- **Blockers:** A07b, A07c, C09.
- **Deliverable:** Choice of how long a proposed standing grant lasts (owner decision 2026-10-22): the owner picks a length from a set of options or states one in words, and the default option is that the system decides the length from named inputs (how long earlier grants of the same class were approved and stayed in use, any limit the owner stated in words, and whether the work is marked one-off), the options are a few fixed lengths set in policy (provisionally one day, one week, 30 days and 90 days) and a derived length never exceeds the longest option, and it tells the owner the length it chose and why in plain words.
- **Acceptance and verification:** A standing-rule proposal shows the length options and a system-chosen default; choosing the default sets a length derived from the pattern of earlier approvals, any limit the owner stated in words (which always wins over the pattern) and the nature of the work, and the explanation of the choice is recorded (C09) and shown with the grant, shown beside the profile-switch answer of A07c because both are answers to the same proposal; an owner-chosen length is used exactly; the grant stays expiring and revocable and a class the policy reserves for the owner or one that needs an exact-operation review is still never proposed; when nothing can be derived the 30-day length of A07b is the fallback (owner decision 2026-10-22); tested with a scripted model: derived from approvals, wording overriding the pattern, a derived length capped at the longest option, an explicit length, the fallback, and a reserved class never offered.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A08 — Implement per-agent environments

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `9004a56`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Per-agent environments: numbered manifest revisions, activation integrity, pins, rollback, resource-limit validation and home authorization. The limits themselves are enforced by A08b. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** A03, T01, H11.
- **Deliverable:** Common maintained base plus per-agent persistent home, configuration, package area and skill library; environment manifest (installed versions, approved capabilities, configuration revisions) whose revisions are referenced by attempts and checkpoints, with package artifacts or reproducible inputs retained; per-agent CPU, memory, disk and process limits (README 62, 146, 339-349, 637; pitfalls-and-safeguards 87).
- **Acceptance and verification:** Changing agent A's environment leaves B's tools, configuration and files unchanged; each attempt and checkpoint records the environment revision it ran with and resumes on it after restart; rollback to a prior revision works; another agent's home is denied; protected extensions load only from controller-owned read-only artifacts and the loader configuration is not agent-writable; reserved-tool integrity is verified before an environment is accepted and activation stops on failure.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A08b — Enforce per-agent resource limits in the sandbox

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `8c2f91c`, `632888f`, `4bf38fc`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Per-agent resource limits in the sandbox: memory, process count and CPU through a user systemd scope with address-space and affinity fallbacks, disk as a per-file cap, headroom reserved for the controller, and every launch records per limit whether it was enforced in full, in part or not at all. The first CI run found that older systemd versions do not expand dollar signs in a scope's command line; the capability probe now finds out by trying (632888f). The same run's Windows Node 24 cell exceeded the 30-minute job limit and a timing-dependent long-poll test; the limit is now 50 minutes and the test no longer depends on runner speed (4bf38fc). Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green. Windows and macOS enforcement are not built and are reported as not enforced.
- **Blockers:** A08, A03.
- **Deliverable:** CPU, memory, disk and process-count limits carried into the sandbox recipe and enforced per OS.
- **Acceptance and verification:** CPU, memory, disk and process-count limit fixtures enforced with headroom reserved for the controller; each launch records which limits were enforced and by what, and a limit the host cannot enforce is reported, never silently skipped; (split from A08 on 2026-10-22: A08 holds the environment manifests, revisions, pins, rollback, integrity checks and limit validation).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A08c — Enforce per-agent resource limits on macOS and Windows (after the first release)

- **Parent:** N06 / AII-256.
- **Blockers:** A08b, A03b.
- **Deliverable:** A macOS mechanism and a Windows Job Object that carry the CPU, memory, process-count and disk limits of A08b into the sandbox on those systems (owner decision 2026-10-22: the first release accepts that no per-agent limit is enforced there, and every launch records that; this card closes the gap afterwards).
- **Acceptance and verification:** Limit fixtures run on real macOS and Windows hardware (the own-hardware runners, or an equivalent real machine the owner provides) with headroom reserved for the controller; a runaway agent is stopped at its limit and the others keep running; the launch record says which limits were applied on that system and which were not; a platform without a mechanism still records that no limit was applied instead of claiming one.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A09 — Implement reviewed environment changes and maintenance requests

- **Parent:** N06 / AII-256.
- **Blockers:** A08, A05, H05, L02, T06.
- **Deliverable:** Durable environment-maintenance requests issued through the bridge, change-class policy (skill draft allowed and recorded; extension or executable dependency via preapproved catalogue or supervisor review; broader access via scoped review; host policy, protected rules and shared base via owner or administrator), disposable trial and staged activation (README 327, 343-345, 367-374).
- **Acceptance and verification:** The request returns a maintenance ID before the requesting worker is replaced; stage, trial in a disposable environment, Suspend without release, checkpoint, reload or restart, validate and restore, keeping session and compaction state and prior Pause or Suspend intent; failed activation rolls back; unsupported safe restoration leaves the change pending; install scripts never run before exact-artifact approval and run inside the boundary; the reviewer sees exact package version, source, access, install behaviour and rollback plan; standing permission causes no redundant approval; skills and extensions cannot self-grant; a supervisor role alone cannot change the protected base; a review outage leaves the change pending while the approved environment keeps working.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A10 — Implement private-record inspection and cross-project information boundaries

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `db15b09`; CI runs 39685681421; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The owner reads everything on any desk the ordinary way, with no reason asked (owner decision 2026-10-22, which replaced the first design where scratch and drafts were read only by recorded inspection); an inspection remains as an optional recorded look kept where the agent can see it, and the inspection policy now governs only the scratch-read grants of agents. The recovery service is a service principal that only the owner creates, holds only recovery actions and cannot be reached by an agent, a conversation or the conversation transport. Records move between projects only along one-way paths the owner opens; copies keep the original's identity at their root, are never more public than their source and count with it as evidence; another desk's content, and copies of it, cannot be registered as a skill or tool; scratch-read grants are bound by the inspection policy. Per-task credentials are the new card A10b; the clauses for indexes and embeddings sit on C07 and K06. The CI run named is the first green one at or after this commit (the commit's own run failed only on Windows tests of the neighbouring sandbox work, fixed since). Reviewed and approved by an AI review session (Claude Opus) after two rounds.
- **Blockers:** C02, A02, H11.
- **Deliverable:** Owner inspection policy for agents' private desks and scratch (as decided by the owner before release), a trusted recovery-service principal, source-project labels on desk records and derived data, publication paths between projects, and provenance for copies (operational-contracts 91-95; README 247, 253-257, 261; organization-and-workers 15).
- **Acceptance and verification:** Owner inspection follows the recorded policy and is audited; the recovery service reads scratch and recovery records under a service principal no peer or conversation can use; a desk record carrying restricted-source references cannot be published into another project's scope; copies, embeddings, summaries and indexes inherit source restrictions; a record cites its original source identity and copied claims do not count as independent evidence; content read from another desk cannot be registered or executed as a skill or tool.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A10b — Implement per-task credentials for agents serving several projects

- **Parent:** N06 / AII-256.
- **Status:** implemented; commits `99147e5`; CI runs 39697698169; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Credentials are issued per agent and task by the owner, not per agent: a task credential carries only the grants of the task's project (a grant for every project is narrowed to it, a grant for another task is dropped) and the access checks refuse any other project, any other task where a check names the task and every action that belongs to no project, even for a principal whose grants were not cut down. Rules that decide by who owns a record, and services that look the caller up again by ID, keep the credential inside its task (desks, reviews, conversations, inquiries, inspections, grant derivation). It ends at once when revoked, expired, its task is done or cancelled, or the agent is disabled; reissuing replaces the old one; the secret is stored only as a hash and one task's secret is no use for another. The state API accepts it. Limits stated: within the task's project it is no narrower than the agent; credentials are not ended actively when a task completes; the configuration own-layer refusal has no test. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** A10, A01.
- **Deliverable:** Task-scoped credentials and retrieval.
- **Acceptance and verification:** Credentials are issued per task, not per agent: a task credential carries only the grants of the task's project and the task, and no other project's records, grants or credentials can be reached with it; a credential ends with its task or when revoked and is refused at once afterwards; an agent serving two projects holds a separate credential for each task and one cannot be used for the other; retrieval and publication use the task credential (operational-contracts 91-95, split from A10).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C01 — Implement separated task/chat/meeting histories

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `b44bb35`; CI runs 39537726497; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Per-agent desks (owner-only writes, drafts, committed records superseded rather than edited, private scratch readable only with an exact grant) and task, chat and meeting histories (gap-free sequence, entry role taken from the principal, chat participants must hold the project's history access, scopes isolated). Installation-owner read rules are stated in the notes as choices open to the owner. Retrieval over them is C02. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** S01, S06, A01, F06.
- **Deliverable:** Scoped durable histories and desk ownership.
- **Acceptance and verification:** Peer can read allowed desk but cannot write it or read private scratch; side chat does not pollute task history.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C01b — Implement the shared working-notes tier

- **Parent:** N07 / AII-257.
- **Blockers:** C01, A02, A10.
- **Deliverable:** A second desk tier beside private scratch (owner idea 2026-10-22): shared working notes, entries an agent writes on purpose for others in its project to read while work is still in progress and not yet in the codebase (what it is doing, decisions with their reasons, measurements, hand-off state), readable by default by the project's members, the chair of a meeting in the project and the owner, and by other projects only through an open A10 path.
- **Acceptance and verification:** A member of the project can read an agent's shared notes but cannot write them and cannot read its private scratch or drafts; shared notes are versioned (each entry has a revision and author) and bounded in size; an entry that matches the credential-pattern list is refused at write time (this card defines the list; a later card may reuse it); an agent can mark a note private again and promote a note into the codebase or documents through the normal review path; a note read by a peer or the chair carries its record and revision; an agent in a long-running command keeps its shared notes readable without being woken or interrupted; a project's shared notes are not visible to another project without an A10 path; the owner can read, correct and delete shared notes and the deletion is recorded.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C02 — Implement bounded source-backed retrieval

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `a0cde39`; CI runs 39541408250; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Word search over the desk records and histories the caller may read, with a validated cursor, a scan cap and snippets cut on character boundaries; links that resolve to the original only for a reader who may read it (missing and unreadable look alike); summaries that keep a digest of each original (text, title, status), report current, changed or unavailable, and are withheld from a reader who cannot read every original; and context assembly that fills a character budget in order and lists everything it left out. Everything reads through the desk and history services, so permissions are checked at read time. Limits stated: word matching only, not ranked or semantic; the 2,000-item scan cap is implemented but not exercised by a test. The first CI run failed one Windows cell in an unrelated Pi adapter test (a fixed sleep assumed the stream had started); the re-run of that job passed and the test was made deterministic in 2b1c861. Reviewed and approved by an AI review session (Claude Opus); CI green on the re-run.
- **Blockers:** C01.
- **Deliverable:** Cursor retrieval, summaries and full-source links.
- **Acceptance and verification:** Summary resolves original evidence; permissions enforced on search/snippets/links; context budget bounded without hiding missing sources.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C03 — Capture read/write/search dependency manifests

- **Parent:** N04 / AII-254.
- **Status:** implemented; commits `f3c3d51`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Dependency manifests per task: file, directory, search, record, decision, tool-version, environment, external, MCP resource and negative lookups, judged only for readers who may read what they name; unobserved entries are never reported unchanged; entries recorded for unreadable records are marked unverified. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** S06, A04, C01.
- **Deliverable:** Resource identities, hashes, query scopes and event cursors.
- **Acceptance and verification:** Detect changed/deleted/non-Git inputs and new directory members; unknown coverage and expired cursor remain explicit; dependency kinds include decisions, shared records, tool and environment versions, external resources and negative lookups; MCP resource reads are recorded with server, URI, hash or ETag and observation time; external dependencies use conditional reads or authoritative queries, otherwise freshness uncertainty is recorded.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C04 — Implement safe-boundary continuation capture

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `972884e`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Safe-boundary continuation capture: checkpoint reference, artifacts, decisions, pending effects, budget, next step and manifest; no secrets; complete only when a host verified durability; resume keeps the conversation identity across restart and model change; scratch read for recovery only through InspectionService.recoveryRead. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** C02, C03, F06.
- **Deliverable:** Checkpoint manifest and structured continuation builder; the manifest also holds summary lineage, source ranges, compression state, branch relationships, message cursor, routing and environment revisions and adapter metadata, with credentials only as references.
- **Acceptance and verification:** Timeout preserves artifacts, decisions, pending effects, budget and next step; non-checkpointable tool exposure explicitly recorded; resume after restart and after a model change continues the same conversation identity; a disk-full or failed durability check never yields a checkpoint reported complete; no secret appears in a checkpoint; the recovery service reads scratch and recovery records only through InspectionService.recoveryRead, which leaves a record the agent can see.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C05 — Implement retained context branches and selective updates

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `638afd5`, `8c91821`; CI runs 40375987136; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Retained context branches are composed at controller start and offered through twelve branch operations (open, get, apply, suspend, switch, restore, resume, redirect, append, history, pending, delegate); carrying a restore into the Pi conversation at dispatch remains G09 work.
- **Blockers:** C04, H04.
- **Deliverable:** Immutable parent context, inquiry branch and revisioned update application.
- **Acceptance and verification:** Inquiry has permitted current context; parent unchanged after status question; selected updates applied once; suspend/switch/restore preserves exact available history; a branch records its return destination, which persists until resumed or explicitly changed and survives a newer urgent task; a delegated child task receives only selected context references, not a fork of the parent context.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C06 — Implement inference-cache adapters with per-backend tuning

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `d6b9da8`, `a6d6474`; CI runs 40382971081; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Per-backend cache adapters and markers for llama.cpp, vLLM, Radiance, Strata, OpenAI-compatible services and Claude, wired through the composer. Tests use responses simulated from each backend's documentation or source; capturing responses from running servers moved to G10.
- **Blockers:** C05.
- **Deliverable:** Per-backend tuning profiles (owner decision 2026-10-22: NimbleNewt must work well with llama.cpp, vLLM, Radiance, the latest Strata, OpenAI and compatible services, and Claude, each with its own tuning, because switching context between agents is what makes NimbleNewt different): backend capability negotiation, opaque markers and bounded retention policy, and for each backend a profile that declares what it can do, the request settings that make its cache work and how to read its hits.
- **Acceptance and verification:** Profiles exist for llama.cpp (slot reuse and slot save and restore), vLLM (automatic prefix caching and cache salt), Radiance (prefix cache, host tier and the hybrid model's state snapshots), Strata (inspected from its latest source, which differs from the installed version), OpenAI and compatible services (automatic prefix caching, prompt cache key and retention) and Claude (cache breakpoints, five-minute and one-hour lifetimes, model minimum lengths); an unknown backend gets a generic profile that assumes nothing; the profile is chosen from endpoint and model configuration, never guessed from a name; each profile reads its cache hits from the response (cached_tokens, cache_n and prompt_n, cache_read_input_tokens) and reports them to the usage ledger (R05); cache eviction or incompatibility falls back without context loss; quota and privacy enforced; pin, fork and decoder-resume advertised separately; each profile has tests against simulated responses built from the backend's documentation or source (responses captured from running servers are G10's); engine changes require a measured gap and a separate scoped patch.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C06b — Make Pi agent prompts cache-stable across context switches

- **Parent:** N03 / AII-253.
- **Status:** implemented; commits `a6d6474`; CI runs 40382971081; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Cache-stable Pi prompts across context switches and stored thinking replay, measured on simulators; real measurements are G10's.
- **Blockers:** C06, F05, F06.
- **Deliverable:** Owner decision 2026-10-22: the cache-ability of Pi Durable prompts is a serious performance issue to resolve, because context switching is the core of NimbleNewt. Audit and measure Pi Durable 1.3.0's actual prompt layout (Pi stores system sections and tool changes as appended positional entries, but before each request it replays them into one leading system message, so any change to a section or the tool set rewrites the head of the request and loses every cached prefix after it; the layout therefore suits an agent's growing history only while its sections and tools stay unchanged, and it shares no prefix between agents; pi-ai places Anthropic cache breakpoints on the system blocks, the last tool and the last user message and derives the OpenAI cache key from the session ID), then fix it on the NimbleNewt side or with a pinned, scoped Pi patch; model thinking on a context switch (owner decision 2026-10-22): when a conversation is resumed or switched, the model's thinking and reasoning items that the provider returned or requires are kept as part of the stored conversation and replayed to the model in order, so the model keeps its own reasoning and the provider accepts the history (for example Anthropic thinking blocks and OpenAI reasoning items, which are only valid in the conversation that produced them); stored thinking is readable only by the owner and never by peers, under the A10 inspection policy and with the same secret redaction as private scratch; its display in the owner's timeline (U09) and its deletion after the task (K06) are carried by those cards.
- **Acceptance and verification:** The audit records what Pi renders first, how sections and tools are ordered, what changes between turns and what a suspend, resume, branch, inquiry or compaction does to the prefix; NimbleNewt orders every prompt stable-first (sorted tool declarations and a common preamble, then project context, then agent-specific sections, then volatile content) with no timestamps or random IDs early; agents that can share a prefix do, with the cache key chosen per shared prefix (for example per project or per meeting) and not per session; volatile content goes into appended user or context messages and never into system sections, and the system sections and tool set stay fixed for an agent's session and change only at deliberate boundaries; cache lifetime settings and session keys are set per backend profile (C06); compaction is bounded so it does not silently discard the prefix and its cost is reported; a test checks that the bytes of the provider request's prefix are unchanged across turns and context switches (not only the Pi log), and after a context switch the reusable prefix is reused on each qualified backend, measured with the backend's own hit fields and compared with the unmodified Pi layout; a change to Pi is a separate scoped patch against the pinned version with an upgrade test; results are recorded for G10; a resume after restart and after a harness change replays the stored thinking unchanged and the provider accepts the history; a provider that rejects stored thinking after a model change is handled by dropping only the invalid blocks and recording that; stored thinking is excluded from exports unless the owner turns that on; a peer or another conversation cannot read stored thinking and the A10 inspection policy and redaction apply to the owner's read.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C07 — Implement context budgets, the startup builder and stall-proof helpers

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `70edf25`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Context budgets and stall-proof helpers: per-model budgets, the startup builder with cut-and-archive and a blocker, resume guard, tool-output limiting with paging, hand-off from durable facts, context_overflow classification and inquiry-branch planning. The Pi-side and dispatch wiring is the new card C07b. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** C04, R01.
- **Deliverable:** Per-model context budgets, a single startup-context builder with cut-and-archive, a resume guard, tool-output caps with paging, hand-off from durable facts, overflow as its own failure class, and budget-aware inquiry branch planning (requirements 1, 2, 3, 5, 6, 7 and 8 and the budget numbers of context-window-stalls.md; split on 2026-10-22: the Pi-side and dispatch wiring is C07b).
- **Acceptance and verification:** Using a small context window (131,072 tokens): a first prompt over 25% of the window is cut by the builder (newest items, human words, permissions and goal kept whole, the cut archived with a matching digest) or refused with a blocker, never sent, and the fixed part of the first call counts; an attempt over 60% of the window is not resumed but restarted from the continuation record; a tool result larger than the per-tool limit (about 16,000 characters on that window, with images and other non-text results counted) is truncated with the remainder kept and paged; a hand-off is written from the ledger, artifacts, checkpoint and last state with credentials removed; context failures are classified as context_overflow; an inquiry on a task over its model's budget uses the compaction boundary plus retrieval and says so; shares and characters per token are configurable and validated.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C07b — Wire context budgets into dispatch and bound compaction

- **Parent:** N07 / AII-257.
- **Status:** implemented; commits `d31e7a6`, `2c36a5b`, `f004287`, `9a31e13`, `6c68147`, `616dcf0`, `75ca210`; CI runs 40382971081; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Context budgets are enforced at dispatch: first-call admission, the provider's reported size recorded and used to calibrate, bounded compaction with an extractive fallback, tool output limits for Pi's tools and framed, bounded MCP results, overflow blockers and the hand-off at the end of an attempt. The route change to a smaller window and window-scaled MCP limits moved to C07d.
- **Blockers:** C07, C04, R01.
- **Deliverable:** Enforcement at dispatch of the C07 budgets (the startup limit and the working limit: startup plus likely tool output plus the reply reserve at most 60% of the window) with the first call measured against the provider's reported usage (Pi's system prompt and tool schemas included) and the reply reserve; explicit stream timeouts and retries, a short summary limit and a fallback summariser through Pi's beforeCompact hook, restart-safe; tool output limits applied to Pi's tools and to MCP tools; repeated overflow ends in a visible blocker; the hand-off written when an attempt ends without one (split from C07 on 2026-10-22).
- **Acceptance and verification:** A summariser that hangs hits its own short timeout and either uses the fallback route or ends the attempt as context_overflow without hanging; a restart in the middle of the hook neither duplicates nor loses the summary; the first call's size includes Pi's system prompt and tool schemas and is checked against the provider's reported usage; a second compressor on the same context is refused at registration; summary lineage is recorded and earlier owner decisions stay retrievable after repeated compactions and after model fallback; any compressed view, index or embedding keeps the source project and origin and is readable only by someone who can read every source (A10); a crash after a confirmed effect and before the hand-off still yields a hand-off written from the ledger and artifacts; repeated overflow stops with a visible blocker.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C07d — Rebuild the context view when a model route changes to a smaller window, and scale MCP result limits to the window

- **Parent:** N07 / AII-257.
- **Blockers:** C07b, R02, H12.
- **Deliverable:** Split from C07b: when the route of a running task changes to a model with a smaller window (a fallback, a cutover or a re-admitted attempt), the startup context is built again for that window and that route's fixed part (system prompt and tool schemas); tool output limits and the spill of an MCP result's remainder follow the window of the attempt's route instead of one fixed bound.
- **Acceptance and verification:** Falling back to a smaller-window route rebuilds the context view and blocks with a visible reason if essential constraints do not fit; the cut text is archived; repeating the change gives the recorded decision; an MCP result longer than the window's tool limit is cut and the rest can be read in pages, as for Pi's tools.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C08 — Implement owner decision records and correction propagation

- **Parent:** N07 / AII-257.
- **Blockers:** C03, C07, U03, H06.
- **Deliverable:** Owner decision records (source utterance, scope, version, supersedes, authenticated origin) kept apart from agent conclusions; links from plans, task contracts, reviews and pending actions to the decisions they rely on; a versioned context record of current decisions, permissions, pending questions and goals supplied by the C07 startup builder (README 72, 204, 213-221, 607, 636; pitfalls-and-safeguards 81; operational-contracts 85-87).
- **Acceptance and verification:** A correction supersedes only the conflicting decisions in its scope and is authoritative at once; dependent plans, reviews and queued actions are marked superseded, owning agents notified and each affected task's next action blocked until revalidated, including busy, paused and suspended agents on resume and after restart; completed external effects are recorded with corrective follow-up and never claimed undone; brainstorming, hypotheticals, quoted text and an agent's paraphrase create no decision and a decided choice is not re-asked; conflicting instructions on one decision from concurrent owner sessions or devices are surfaced and block the disputed action, never settled by arrival order or agent vote; a planning-only instruction or implementation hold is a binding gate that admits no work; agent agreement or a team vote cannot restore superseded guidance; superseded decisions stay visible marked non-authoritative; the context record and links to original wording survive repeated compaction; applying or reloading configuration (U10) leaves pending decisions in place.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C09 — Capture activity records and decision explanations

- **Parent:** N07 / AII-257.
- **Blockers:** C04, C08, T06, S05.
- **Deliverable:** Unified per-step activity record (owner and agent messages, delivered instructions, retrieved source references, model and harness selections, tool inputs and results, approvals, artifact versions and diffs, compression events, branches, meeting decisions, lifecycle and ownership changes) holding the exact context manifest used at each step, plus decision-explanation records written at material choices (README 237-247, 608).
- **Acceptance and verification:** Each step stores the context references and versions actually supplied, including which summary; sensitive payloads are stored under access control and redactions and missing data are marked; decision explanations record alternatives, key evidence and uncertainty as user-facing statements, never chain-of-thought, and provider thinking or hidden reasoning is not captured as an explanation; an explanation requested later is a separate explicit operation, labelled retrospective, grounded only in records, and says so when the records cannot explain; corrections append provenance and never rewrite history; archived, deleted or unavailable ranges stay referenced and are marked unavailable.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L05 — Implement generation interruption and late-result handling

- **Parent:** N05 / AII-255.
- **Status:** implemented; commits `9be98d4`, `80b7ce5`; CI runs 40382971081; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Generation interruption and late-result handling in the generation service, with the pause guard used in production. Feeding the model stream into revision-bound generation moved to L05b; decoder resume stays unsupported and separate.
- **Blockers:** C05, F06, A02.
- **Deliverable:** Finish-and-hold/cancel controls and revision-bound partial streams.
- **Acceptance and verification:** Pause blocks new effects immediately; partial tool calls never execute; late response cannot override correction; optional decoder resume qualified separately.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L05b — Feed the model stream into revision-bound generation

- **Parent:** N05 / AII-255.
- **Blockers:** L05, H12.
- **Deliverable:** Split from L05: the worker reports the model stream's events (partial text, tool-call fragments, the end) to the generation service so that each generation is begun, recorded and completed against the revision it started under; a late or superseded stream is held, never applied.
- **Acceptance and verification:** A partial tool call never runs and a late response cannot override a correction, shown with a real worker process: the owner corrects a task mid-generation, the earlier stream is held with a visible reason, and the next generation starts under the new revision.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L01 — Implement Pause and background settlement

- **Parent:** N05 / AII-255.
- **Status:** implemented; commits `e854544`, `8d51e29`, `b86a5d7`; CI runs 40390419891; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Pause gates, background settlement and the availability hook are composed at controller start; stall detection is built with the pause lookup. Running the reconciler and the stall scan in production, and calling the retention check on reassignment, moved to L01b.
- **Blockers:** C04, A02, S08, L05.
- **Deliverable:** Durable pause gates and permitted background result collection.
- **Acceptance and verification:** Pause retains owner and blocks new foreground work across restart; background result recorded without unpausing; observed execution state (pausing, stopping, recovery-required, unreachable) is recorded apart from lifecycle intent; agent-level Pause spans all the agent's task contexts while a task-level Pause still allows a separately authorized response or meeting task; a manual Pause never gains an automatic return; queued messages and state updates reach a paused agent's inbox without resuming it; each request records actor, scope, mode, operation ID and policy revision; a paused agent keeps its tasks despite an idle replacement, an urgent deadline or elapsed time; supplies the conversation availability hook, so a paused agent's messages are queued and an incoming message never lifts a hold; applying or reloading configuration (U10) leaves a pause in place.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L01b — Run the reconciler and stall detection in the controller with the pause gates

- **Parent:** N05 / AII-255.
- **Blockers:** L01, H12.
- **Deliverable:** Split from L01: the controller builds the reconciler (with the pause lookup, so an inbox message for a paused task stays received) and runs it, and runs stall detection (scan) in the dispatcher's tick under a new dedicated stall-scan right (owner decision 2026-10-26: the narrower right, not recovery-read everywhere); the dispatcher principal holds no grants today and scan accepts only the owner or a recovery-read service.
- **Acceptance and verification:** A paused task is not reported as stalled and its inbox messages are held, not admitted, across a controller restart; a task that stops making progress while not paused is reported as a suspected stall in the status view; the stall-scan right is a new action in the recovery family named `recovery.stall-scan` (service principals may hold only recovery actions), added to the action list and accepted by scan alongside the owner and the broad recovery-read; it permits only the scan, grants no read of unpublished records, adds no other action, and a service holding it can run a scan and nothing else, and a controller without it says so instead of failing every tick; reassigning a task goes through the pause service's retention check (a paused agent keeps its tasks), which nothing calls in production today; the reconciler waits on its delivery destinations and bridges, which are not built, rather than on a right.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L02 — Implement Suspend and graceful Stop

- **Parent:** N05 / AII-255.
- **Blockers:** L01, T07.
- **Deliverable:** Bounded preparation, checkpoint and process shutdown.
- **Acceptance and verification:** Kill during preparation resumes shutdown intent; uncooperative tool classified; force stop explicit and auditable; Stop leaves assignments unchanged and never cancels the task goal; task cancellation needs task-scoped authority and settles or reports pending and uncertain effects and children while keeping history; stopping, stopped and recovery-required are separate from task completion, completed preparation is reused and Stop never resumes execution to shut down; cleanup has a configured deadline and spend budget and may use an eligible backup model; an unsettleable operation offers wait, restart from an earlier boundary or Force Stop and is never labelled safely suspended to meet a deadline; only scoped cleanup runs during preparation; the inventory covers foreground operations, local processes, T07 jobs and delegated child work; Suspended is reported only after checkpoint and artifact durability checks pass; agent-originated lifecycle requests without the grant are refused; Stop during preparation, model loss during cleanup and deadline expiry are tested and restart reports graceful versus forced.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L03 — Implement prepared release and reassignment

- **Parent:** N05 / AII-255.
- **Blockers:** L02, S02, S05.
- **Deliverable:** Transfer protocol and retained continuation.
- **Acceptance and verification:** Crash before/after transfer yields one owner; no recipient leaves durable unassigned work; returning worker fenced; the handoff package carries brief, acceptance criteria, exact versions, outstanding questions, audience, completed and unfinished work, drafts, uncommitted changes, results, background operations, locks released or transferred, risks and next action within sharing scope and without wholesale private scratch; handoff readiness is reported explicitly; forced takeover or authorized emergency reassignment needs fenced exclusive authority and is a visible exception listing missing cleanup and uncertain effects; a temporary reassignment may carry an authorized auto-return that re-checks eligibility and keeps manual holds; responsibilities are released like tasks.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L04 — Implement checked resume and evidence invalidation

- **Parent:** N05 / AII-255.
- **Blockers:** C03, L02, A02.
- **Deliverable:** Collect/verify/review/commit resume pipeline.
- **Acceptance and verification:** Input change between review and commit blocks stale continuation; revoked content not leaked; uncertain effects resolved first; resume records whether native history or reconstruction was used and its fidelity limits; resume statuses collecting, verifying, reviewing, ready, blocked and executing carry the verified revision set; a permission-filtered delta packet shows old and new versions and affected assumptions with a recorded relevance verdict and rationale; unchanged dependencies avoid a rebuild; bounded retries surface churn as a blocker; missing critical context yields a typed blocker; a deep-history constraint is recovered after restart on a different model route.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L06 — Implement team and system shutdown, reboot and resume policy

- **Parent:** N05 / AII-255.
- **Blockers:** L02, L03, H08, U06, H11.
- **Deliverable:** Lifecycle commands at agent, team and installation scope with explicit descendants and jobs, an aggregated shutdown readiness report, a reboot procedure, a resume-condition policy and an authenticated non-chat Stop and Force Stop command (README 65, 191, 382, 398, 404, 420-429, 605; pitfalls-and-safeguards 111).
- **Acceptance and verification:** Installation shutdown reports ready only when every affected agent and job is, listing unsettled and permitted remote jobs as tracked exceptions; bookkeeping after preparation completes with no model available, and the last model failing mid-preparation leaves a mechanically recoverable checkpoint and reports the missing briefing; reboot preserves assignments and pause intent and schedules no paused work; resume happens only on explicit owner action or a recorded authorized condition; gates at task, agent, team and installation scope stack and resuming one never lifts another; Stop and Force Stop work through the non-chat command with every model route down.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H01 — Implement worker enrollment and observation

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `c521b1e`; CI runs 39540257755; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A host is an enrolled host principal that announces its capabilities and sends heartbeats with increasing sequence numbers, stamped with the controller's own clock; status reports identity (active or revoked) and freshness (fresh, stale, unknown). Rotating a credential ends objects obtained before it; a revoked host is refused even with an object it still holds; a host on a new credential restarts its sequence. Nothing in the service writes an assignment, so a silent, rotated or revoked host never silently releases its tasks (tested). Limit stated: any host with attempt.work in a project can report progress on its tasks until H03/A04 link workers to hosts. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** A01, S02.
- **Deliverable:** Host identity, heartbeat/progress reports and freshness.
- **Acceptance and verification:** Disconnected host shown stale; identity rotation and revoked host denied; ownership not silently released.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H02 — Implement subordinate remote work/artifact transport

- **Parent:** N10 / AII-260.
- **Blockers:** H01, S06, A03, H12.
- **Deliverable:** Authenticated remote admission and artifact fetch; workers use the H12 dispatch contract and negotiate a controller-worker protocol version.
- **Acceptance and verification:** Network partition and delayed packets preserve fencing; no shared database mount; unsupported host fails visibly; remote workers cannot self-promote or admit independent work; relocating an attempt to another host fences the old attempt, transfers checkpoint and artifacts with integrity checks and refuses when platform, path, credential or data-location policy is unmet; the native Pi store has one exclusive owner host; an incompatible worker protocol version is refused visibly.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H03 — Implement priority admission and reserved control capacity

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `3bede99`; CI runs 39542360108; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** One durable admission record: four productive attempts in total, two per host and two places reserved for inquiries and reviews, with each host's declared CPUs and memory counted for productive work, a bounded queue ordered by priority then arrival, and a patience rule so a request passed over too often is served first and holds back only what it waits for (its own host, or the lane). Stopping never needs capacity. Waiting requests whose host is lowered or disabled are withdrawn with a reason instead of waiting for ever. Spawning is bounded by depth and live children. Limits stated: the requested figures are counted, not measured; the dispatcher names the host and checks its freshness; the single record serialises decisions; callers are plain actor strings until the API wrapper. Reviewed and approved by an AI review session (Claude Opus) after two rounds, which found and fixed three real defects (cross-host blocking by a starved request, a request waiting for ever after capacity was lowered, reviews waiting behind productive work on a busy host); six-cell CI green.
- **Blockers:** S08, H01.
- **Deliverable:** Fair bounded queue with accepted initial 4 productive attempts total, 2 per host and 2 inquiry/review capacity.
- **Acceptance and verification:** Workload saturation cannot starve stop/revoke or review; limits apply to CPU/memory/concurrency; no unbounded recursive spawning.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H04 — Implement durable inquiries and correlation

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `e9e49bf`; CI runs 39543357347; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A principal working on a task asks another a question carried in a side chat that never enters the task's history; the inquiry is a durable record whose ID is the correlation in every step; the addressee alone answers, the asker closes or withdraws it, and an open typed wait on the task is answered with it. Asking, waiting and answering never touch the assignment (tested). A crash part-way through an answer is finished by a retry under any command ID (tested by making the chat step die once). Context is links resolved per viewer, so what a viewer may not read is absent; open inquiries per asker per task are bounded under concurrency. Limits stated: nothing starts the addressee's work or asks the admission service for a place; no expiry of unanswered inquiries; withdrawing does not cancel a linked wait. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** S04, C01, H03.
- **Deliverable:** Side-conversation requests, replies and completion.
- **Acceptance and verification:** Ask/answer while main attempt waits without ownership transfer; restart preserves correlation; unauthorized context absent.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H05 — Implement review routing and wait-cycle prevention

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `a1190a4`; CI runs 39666500873; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A project policy (independence, designated reviewers, authorized fallbacks, deadline, tools reserved for the owner) decides who may review. A request is routed at once to the least-loaded eligible reviewer (never the requester or a contributor) or waits; nothing is approved by waiting, and a late review moves to the next reviewer and finally to the owner. Four verdicts; allow needs the essential context; contributors cannot approve and an approver who becomes one is withdrawn; a tool the owner reserves stays the owner's even for reviews already open or approved; repeat requests are cleared against an unexpired unused approval; figures kept; reviewer edges feed the S10 wait graph and a ring through a review is found. The pause and hold behaviour is split into H05b. Limits stated in the notes: contributors are self-reported, essential context is the requester's word, no state-API operations or timer yet. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** H04, A05.
- **Deliverable:** Independent reviewer selection, fallback and wait graph.
- **Acceptance and verification:** Self-review rejected when independence required; cyclic reviewers detected; outage waits or uses authorized fallback; no implicit approval; a review request carries tool version, arguments, working directory, environment revision, affected resources, script hashes, expected effects, authority source, budget and bounded context with secrets redacted, and missing essential context forbids allow; verdicts are allow, deny, request-context or requires-owner-decision; requests carry a deadline and escalation and block only the gated change; a reviewer who commits to the version under review becomes a contributor and cannot approve it; queue delay, latency, false blocks, missed hazards and cost are recorded; a redundant request matched to an unexpired, unused approval of the identical operation is cleared with recorded authority and a mandatory human gate is never converted to an agent gate; reviewer edges are supplied to the S10 wait-for graph (WaitGraphService extraEdges: a task waiting for a review waits on the reviewer's unfinished tasks), and a ring through a review is found by the circular-wait detector, shown by a test.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H05b — Implement reviewer pause and hold behaviour

- **Parent:** N10 / AII-260.
- **Blockers:** H05, L01.
- **Deliverable:** Lifecycle-aware reviewer routing.
- **Acceptance and verification:** A reviewer reaches a safe boundary and pauses its own task without reassignment (the review it was on waits for it); held, paused or stopped reviewers are never woken to review and are skipped when a reviewer is chosen; a review whose reviewer is then held keeps its place and moves on under the project policy when the deadline passes, never by implicit approval; a lost reviewer host is told apart from a slow reviewer; split from H05, whose routing, verdicts, contributors, escalation and figures do not need the lifecycle.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H06 — Implement event subscriptions and gap recovery

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `0df5bc6`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Event subscriptions with gap recovery: numbered per-stream events, cursors with batching and key collapsing, reconcile on missing, skipped or expired events, no wake through a manual hold or cooldown, causation chains with loop suppression, backpressure from subscribers the controller relies on. Limits stated: no idle expiry of abandoned critical watchers. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** S07, C03.
- **Deliverable:** Scoped subscription cursors, dedup and batching.
- **Acceptance and verification:** Missing/duplicate/out-of-order events and retention expiry trigger reconciliation; incoming event never lifts manual hold; per-subscription cooldowns; the causation chain is recorded and self-triggered loops suppressed; producers are slowed when queues are full.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H06b — Expire idle event subscriptions

- **Parent:** N10 / AII-260.
- **Blockers:** H06.
- **Deliverable:** Idle expiry for event subscriptions (owner decision 2026-10-22: the system drops an abandoned subscription itself, so the owner is not asked to cancel it): a subscription with no acknowledgement or activity for an owner-settable time is expired, its producers stop being held back, and the drop is recorded with its cursor so the subscriber can resume from the last acknowledged event.
- **Acceptance and verification:** A host that crashes while subscribed no longer holds producers back beyond the idle time; the expiry time is a setting with a default and the owner can still cancel a subscription at any time; an expired subscription resumes from its cursor without losing or repeating events, or, if its cursor has passed retention, reconciles as H06 does; every expiry is recorded and appears in the activity record and, if work was affected, as a Notice (U11b); a live but slow subscriber is not expired while it acknowledges within the time; tested with a crashed host, a slow host and a restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H06c — Deliver idle-expiry notices in the running controller

- **Parent:** N10 / AII-260.
- **Blockers:** H06b, U11.
- **Deliverable:** Split from H06b (audit 2026-10-26): expiry is built and recorded in the audit trail, but the composed controller passes no notifier to the event service, so no notice is sent in production; and subscriptions created before H06b were never given an idle time.
- **Acceptance and verification:** Expiring an idle subscription that had events waiting produces exactly one owner notice in a dispatch-compose test; the expiry appears in the activity record (U09) and as a U11b notice when those exist; subscriptions that predate idle expiry are given the default idle time at start, once; the owner can set the idle time and cancel a subscription through the state API (the service has both; no operation exposes them yet).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H07 — Implement idle host polling and capability placement

- **Parent:** N10 / AII-260.
- **Blockers:** H02, H03.
- **Deliverable:** One bounded poll per host, jitter/backoff and capability-indexed queue.
- **Acceptance and verification:** 100 simulated idle hosts and reconnect burst stay within measured resource limits; unavailable platforms wait visibly; no per-agent idle polling storm; placement filters on data-location policy and repository access, and credentials are delivered per attempt only to eligible hosts.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H08 — Implement remote disconnect watchdog and hard stop

- **Parent:** N05 / AII-255.
- **Blockers:** H02, L02.
- **Deliverable:** Independent lease watchdog and contained process termination.
- **Acceptance and verification:** Explicit and silent loss stop productive actions within bound; supervisor death and sleep/wake fail closed; no delayed renewal extends stale authority.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H09 — Implement reconnect reconciliation and primary epochs

- **Parent:** N10 / AII-260.
- **Blockers:** H08, L04, S05.
- **Deliverable:** Epoch-bound admission and recovery handshake.
- **Acceptance and verification:** Old-primary response cannot renew work; uncertain effects block replacement; reconnect never automatically resumes cached attempt.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H10 — Implement distributed agent capacity and fan-in limits

- **Parent:** N10 / AII-260.
- **Blockers:** H07, H09, H03, R05.
- **Deliverable:** Host/global quotas, spawn admission and bounded coordination.
- **Acceptance and verification:** Swarm cancellation settles children; exhausted slots/budgets block expansion; stop/review control traffic remains responsive; parents assign outcomes and acceptance criteria and children spend only sub-budgets delegated through R05.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H11 — Implement agent, team and role records

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `ee0f13c`; CI runs 39613734451; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Agent, team and role records: an agent has a computer-assigned ID (made from its creating command, so a retry names the same agent) and its own identity 'agent:<ID>'; the friendly name is a label that may change and repeat, so a rename moves no desk record, grant, credential or history. Roles name a capability bundle and exclusions but grant nothing; conflicting roles (author and independent reviewer) cannot be held together, also after a role is redefined. Supervisor and team parent give no desk write or scratch read and touch no task or assignment; reporting and team cycles are refused. Retiring disables the identity and never frees the ID; clone and import mint new IDs and refuse collisions. Managing needs the owner or agent.manage, creates agents with no grants. Every organisation change goes through one registry record so cycle, role-conflict and retire checks hold under concurrent commands (tested against the unprotected version); checks that read every agent fail closed. Nine operations in the state API (api-v1.md regenerated). CI run 39613734451 is green on all six cells.
- **Blockers:** A02, C01, R01, U01.
- **Deliverable:** Agent records (durable computer-assigned ID, editable friendly name, roles, team, supervisor link, default execution profile, permitted overrides, environment selection, desk and inbox), team hierarchy, role templates mapped to capability bundles and explicit role-combination rules, created, edited and retired through revisioned state API commands (README 7, 59, 91, 142, 155, 257, 523; operational-contracts 12, 23, 89; organization-and-workers 9, 37; runtime-compatibility-and-namespaces 24, 56-57; portability-and-configuration 51).
- **Acceptance and verification:** A role name grants nothing beyond its capability bundle; parentage gives no write to a child's desk, no read of its scratch and no toolbox or release authority; conflicting combinations such as author and independent reviewer of the same work are rejected; parent cycles rejected; re-parenting or cross-team advice changes no task dependency or assignment; renaming keeps commands, queued targets, ownership and history; two agents with the same friendly name stay distinct; retired IDs are never reused; a clone or import gets a new ID and collisions are rejected; an agent keeps the same identity and desk when its model or harness changes; persona fields have no authorization effect; hierarchy changes are revisioned and audited.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12 — Implement the local worker runtime and attempt dispatcher

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `ccc9f5e`, `b86a5d7`; CI runs 40390419891; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The local worker runtime and attempt dispatcher: admission, credentials, tool gate, ledger, checkpoints, pause and message guards, quiesce, restart from a checkpoint shown with the real launcher. The Needs-you item for a missing grant belongs to U11b; composing quarantine with quiesce and OS launcher cells stay with H12b and H12d.
- **Blockers:** A03, A05, R01, C07b, C06b, S05, C04, F08, H03.
- **Deliverable:** Local worker loop that asks admission (H03) for a place on a fresh host (H01) before every start and takes an admitted attempt, launches the sandboxed worker (A03), selects a route (R01), runs the Pi adapter and sends every tool call through the A01 tool gate, A05 admission and the S05 effect ledger, with checkpoint capture (C04) (operational-contracts 13, 20, 61, 66-68; organization-and-workers 53); the dispatcher issues the task credential (A10b) when it admits the attempt, from the owner's instructions and the standing policy, and the owner is never asked to grant one (owner decision 2026-10-22: the owner gives direction and management decides the details, and the owner is asked only when something cannot be determined).
- **Acceptance and verification:** An admitted attempt runs a real Pi turn with the scripted offline model; the attempt records harness, model route, policy, decision and environment revisions, worker version and expiry; every tool call, read-only and MCP included, gets a durable operation ID linked to project, task, agent and attempt with exact tool or server version, invocation, in-progress, confirmed, failed, cancelled or uncertain state, start and end, diagnostics and resource use, and restricted payloads are redacted in summaries; a tool call alone never marks progress; a call is refused when a gate, decision revision, budget, provider eligibility or grant changed; a stale generation cannot dispatch; a kill mid-tool resumes through the ledger with no duplicate effect; a failed attempt leaves the task outcome unchanged; H02 remote workers use the same dispatch contract; a start without an admission place, or on a stale or revoked host, is refused; the dispatcher reads ContractService.priorityOf at each admission request, and a contract priority change reorders the waiting queue at the next admission decision without rewriting stored versions (S10 acceptance clause carried here); the contract's permission list is enforced on the task's tool path; every admission names the harness and passes the F08 recovery gate, and an attempt that names none is refused unless the task's recovery requirement is none; a recipe change on a running agent follows the G01 decision of 2026-10-21: controller-side grant changes apply at the next call with no restart; for a sandbox-level narrowing the dispatcher freezes new calls, lets in-flight calls settle (cancelled or uncertain ones recorded in the S05 ledger), checkpoints (C04), then restarts the A03 sandbox with the narrower recipe before the agent's next action; a widening resumes from a checkpoint in a new sandbox and tells the agent; conversation context survives both; only an emergency stop skips settle and checkpoint; approving a task contract approves the actions inside its permission ceiling, and only an action beyond the ceiling asks again, except that a tool the policy reserves for the owner (H05 mandatoryHuman) or one that needs an exact-operation review (A05) still goes to the owner inside an approved ceiling (tested); a gated step parks that task's change and the dispatcher takes other work; with twenty asks pending, unrelated tasks still dispatch and run (tested); the dispatcher asks the approval policy through PolicyService.evaluate only, and the spend it reports so far comes from budget accounting (S05) rather than from the agent; the agent's separate git directory (from the Git bridge) is added to the sandbox's protected paths and only the checkout is mounted; the agent is frozen or settled before its changes are integrated or its checkout is refreshed or quarantined; a worker that connects to a remote MCP server (or any outside address) refuses an address that is internal after name resolution, so a public name pointing at a private address (DNS rebinding) is not reached; it takes the host facts it reports to the catalog from its own registration; a task credential is issued by the dispatcher without any owner step when the task's instructions and the policy determine the grants, and an owner question is raised only when they do not (for example the task needs a grant nobody has given), as a Needs-you item (U11b); the credential is issued with only the grants of the task's project and the task, ends with the task, and its issue is recorded; the dispatcher acts as a service principal that no agent or conversation can use, issues a credential only for an admitted attempt by the agent assigned to that task, gives grants no wider than the agent's project grants and the task contract's limit, and the issue path refuses every other non-owner caller; tasks within one project are not separated from each other by the credential (A10b).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12a — Carry the dispatch contract to remote workers

- **Parent:** N10 / AII-260.
- **Blockers:** H12, H02.
- **Deliverable:** The H12 dispatch contract (begin/report, tool gateway calls, acknowledgements) carried over the H02 authenticated remote transport.
- **Acceptance and verification:** A remote worker runs an attempt through the same admission, credential, tool gate and ledger path as a local one; a lost link fences the attempt and reconciles with no duplicate protected effect; a remote worker can call the gateway acknowledgement path to recover from a decision-version change; the controller never trusts a worker-supplied credential or result without the fence; tested with delayed, duplicated and dropped messages.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12b — Bind the real sandbox launcher and worker process to the local runtime

- **Parent:** N10 / AII-260.
- **Blockers:** H12, A03, A08.
- **Deliverable:** Bind the A03 SandboxLauncher and the A08 resource-limit recipe to the H12 SandboxPort, protect the separate git directory with the attemptSandbox rules and build the real worker process that runs the Pi adapter inside the sandbox, which has no network and talks to the controller over one channel; a narrow relay, its own replaceable component, makes the worker's model calls for it: it reaches only the model endpoints the routing table allows and adds the provider credentials itself (owner decision 2026-10-25).
- **Acceptance and verification:** A real attempt runs in the selected sandbox with only the checkout mounted and the git directory protected; resource limits apply as A08 states; the worker process exits and is reaped on completion, pause, stop and loss; a crash leaves no running tool process; the integration test uses the real launcher on Linux and the OS-specific launchers on their CI cells; the composer passes the cache policy to the Pi adapter and each turn's cache figures into the usage report, with a worker-side turn sequence unique across all placements of one attempt, and a missed pin marker is recorded as lost; from inside the sandbox only the allowed model endpoints can be reached, through the relay, and any other destination fails; no provider key, and nothing but the task credential, is present in the worker process, its environment, its files or its output; the relay can be replaced without changing the worker, and a model stream is relayed as it arrives, not buffered whole; a sandbox-level narrowing and a widening of a running attempt are applied by the real launcher with a really narrower or wider recipe, the conversation context survives both, and the agent is told on a widening (carried from H12).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12c — Compose the dispatcher at controller start with a durable scan cursor

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `9dc394d`; CI runs 40390419891; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The dispatcher is composed at controller start with its loops, a driver with a timer and graceful shutdown, fencing on epoch change, bounded error records and a durable scan cursor.
- **Blockers:** H12.
- **Deliverable:** start() builds the dispatcher, its loops (tick, release, settleDue, sweeps) and the gateway acknowledgement path; the scan cursor becomes durable.
- **Acceptance and verification:** After a controller restart no admitted attempt is rescanned unsafely or lost; the loops run under an injected clock in tests and a real timer in production with graceful shutdown; a second controller instance does not run the loops (epoch); the loop errors are recorded and bounded, never silent.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12d — Quiesce attempts before integration, refresh and quarantine

- **Parent:** N10 / AII-260.
- **Blockers:** H12, A04, A06.
- **Deliverable:** Call the H12 quiesce (freeze, settle, checkpoint) from the A04 integration, A06 release and refresh paths and from quarantine.
- **Acceptance and verification:** Integration, refresh or quarantine never runs while an attempt has an unsettled tool call; the attempt checkpoints and resumes after; a failed settle blocks the operation with a typed blocker; tested with a call in flight.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12e — Route Pi model calls through the cache adapter

- **Parent:** N10 / AII-260.
- **Blockers:** H12, C06b.
- **Deliverable:** Pi's own HTTP calls go through the C06 CacheAdapter and its per-endpoint state so slot partitioning, markers and pins apply.
- **Acceptance and verification:** Slotted servers get real reuse for the same project and none across projects; the degraded no-reuse mode is used only when the adapter is unavailable; cache hit figures from the backend reach the budget accounting; tested against the simulated servers.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12f — Wire context enforcement, pause observation and message boundaries into the runtime

- **Parent:** N10 / AII-260.
- **Blockers:** H12, C07b, L01, U12.
- **Deliverable:** The runtime calls C07b admit at start and resumeDecision at resume, reports L01 PauseService.observe so a paused attempt shows as paused, and delivers U12 boundary reads (interrupt, advice) to the running attempt.
- **Acceptance and verification:** A context over budget is compacted or refused at start; a paused attempt is reported paused only once its calls have settled; an interrupt message reaches only an eligible running attempt and never a paused one; tested with a message and a pause arriving mid-turn.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12g — Use the DNS-rebinding guard in the remote MCP client

- **Parent:** N10 / AII-260.
- **Blockers:** H12, T03.
- **Deliverable:** The remote MCP client connects only through the H12 resolvePublic/connectPublic guard.
- **Acceptance and verification:** A remote MCP address that resolves to a private or changing address is refused; the connection uses the checked address; a revoked connection blocks new calls; tested with a rebinding resolver.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12h — Route owner-mode reviews only to the owner

- **Parent:** N10 / AII-260.
- **Status:** implemented; commits `3944018`; CI runs 40390419891; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Owner-mode reviews are visible to and decidable by the owner only, on every review route.
- **Blockers:** H12, A05.
- **Deliverable:** The review service sends an exact-operation review that is owner-mode only to the owner and rejects an agent reviewer for it.
- **Acceptance and verification:** An agent reviewer cannot decide or receive an owner-mode review; the dispatcher accepts only the owner's decision for it; tested for every review route.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12i — Give tasks controlled network routes through the worker relay

- **Parent:** N10 / AII-260.
- **Blockers:** H12b, A07, T01, T03, A03b.
- **Deliverable:** A task may be granted specific network destinations (internet research through a controller-side web tool, QA against a named server or a local port) that the sandboxed worker reaches only through the relay H12b builds for model calls; there is no other route out of the sandbox (owner decision 2026-10-25). The web tool is built here as a catalogue tool (T01) classified by the approval policy (A07) and reusing T03's connection record and credential-reference pattern. Inside the sandbox the route appears as a proxy endpoint served by a forwarder over the controller channel (a new recipe field, so the recipe revision records it; the sandbox itself still has no network interface); a grant is enforced in the relay, so granting or revoking one applies at the next connection with no sandbox restart.
- **Acceptance and verification:** A grant names the task, the destination (host and port, or a local service) and who approved it, and is judged by the approval policy (A07) like any outside action; a connection to a destination that is not granted, or that resolves to a private or changing address unless the grant names it, is refused and recorded; every connection is logged with task, attempt, destination and bytes; a grant ends with the task; a revoked grant stops new and open connections; the relay adds no credential the grant does not state and the agent never holds a provider key; a browser or command-line client in the sandbox works against a granted destination through the proxy endpoint and fails against any other; the proxy and the grant checks behave the same on Linux, macOS and Windows (Windows proven on the A03b launcher); the web tool is refused a private or rebinding address; tested with a rebinding resolver and a hostile destination list.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12j — Close the H12b worker-process gaps

- **Parent:** N10 / AII-260.
- **Blockers:** H12b.
- **Deliverable:** The worker process is reaped when its attempt is paused, stopped or lost; a missed pin marker is recorded as lost; no provider key can appear in the worker's files, environment or output; the launcher is exercised on all six CI cells.
- **Acceptance and verification:** Pause, stop and loss each leave no worker process behind (tested with a real process); a pin marker that never arrived is recorded as lost, not as kept; a scan of the worker's home, scratch, environment, channel traffic and logs finds none of the provider keys the relay uses; the process tests run on Linux, macOS and Windows.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H12k — Compose the local worker host in the controller

- **Parent:** N10 / AII-260.
- **Blockers:** H12b, H12c, H12d, H12f, H12g.
- **Deliverable:** Controller start-up builds the local worker host with the model relay, the message and pause guards, the context checks, the quiesce coordinator and the remote MCP connector, and an MCP transport that connects to the checked address.
- **Acceptance and verification:** An end-to-end test starts a controller, runs an attempt through the real relay, guards and bridge, quiesces it around an integration, and connects to a remote MCP server only at a checked public address (owner decision 2026-10-26).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X11 — Split the test suite into a typical and an exhaustive tier

- **Parent:** N18 / AII-268.
- **Blockers:** G04.
- **Deliverable:** Every push runs a small tier on the packages that changed and the packages that depend on them; milestones and releases run the exhaustive tier.
- **Acceptance and verification:** The typical tier (Linux, Node 22, reference store and SQLite, changed packages and their dependents) finishes in about 10 minutes; the exhaustive tier (six OS and Node cells, every backend, sharded) finishes within 30 minutes per cell; both are one command locally; the exhaustive run is the evidence for status changes and releases (owner decision 2026-10-26).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H13 — Implement event source adapters and watchers

- **Parent:** N10 / AII-260.
- **Blockers:** H06, H01, R02.
- **Deliverable:** Event source adapters for timers, task completion, file and repository changes (watchers as hints), service failures and model availability feeding H06 subscriptions, and event-to-inbox scheduling of the owning agent (README 70, 586-588; resume-reconciliation 11, 39).
- **Acceptance and verification:** Each source produces deduplicated events with causation links; a subscribed event creates an inbox item that schedules the owning agent, subject to holds, to revise its plan; dropped or duplicated watcher events are still caught by the direct version check at resume; event payload text cannot invoke tools or grant authority; a self-triggering loop is detected and held; an event storm leaves unrelated work responsive; failed handling attempts can be listed and inspected from chat and API.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R01 — Implement model routing and capability policy

- **Parent:** N08 / AII-258.
- **Status:** implemented; commits `e7a294e`; CI runs 39540870400; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** One durable routing table (providers, routes with context size and capabilities, ordered profiles, role-to-profile) with owner-only changes that need the current revision and exclusions of providers or routes. Selection reads the table at each dispatch, so a disabled or excluded provider is out of the next attempt, retry or helper call; routes that cannot carry the context or lack a capability, cloud routes for data that may not leave, and paid routes without spending authorization are skipped with the reason; with no eligible route nothing is invented. A new table cannot drop or rename an excluded name. Limits stated: the caller supplies the data-sharing and spending authorizations, reading the configuration document into a table is a later step, and nothing probes route health. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** F05, A02, F02.
- **Deliverable:** Role-aware ordered routes and exclusion rules.
- **Acceptance and verification:** Disabled provider excluded immediately for new dispatch; incompatible context/tool capability skipped; data-sharing restrictions honored.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R02 — Implement fallback and cumulative budget accounting

- **Parent:** N08 / AII-258.
- **Status:** implemented; commits `c463aff`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Provider failure classification, bounded fallback and task budgets: credit, rate-limit and outage failures choose the next eligible route (four attempts at most), hopeless failures are not retried elsewhere, exhausted routes are a visible wait, an uncertain effect holds the call and confirmed effects are never repeated, spend is summed per task and a task over its budget does not begin a call. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** R01, S05, C04.
- **Deliverable:** Provider failure classification and bounded fallback.
- **Acceptance and verification:** Credit/rate/outage failures choose eligible route; exhausted routes become visible wait; no repeated external effect on fallback.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R03 — Implement difficulty profiles and escalation

- **Parent:** N08 / AII-258.
- **Blockers:** R02, S10, H11.
- **Deliverable:** Difficulty-to-profile mapping separate from priority with no built-in provider defaults; profile fields for harness, provider, model, reasoning settings, context needs, tool permissions and spending limit; child escalation requests (README 9, 67, 74, 148, 441-453; portability-and-configuration 15, 49).
- **Acceptance and verification:** The parent-set difficulty selects the configured profile at dispatch and a changed mapping affects only the next dispatch; changing priority does not change the profile or the reverse; no tier implies locality, provider or model; a non-parent without a grant cannot set difficulty; a blocked or repeatedly failing child escalates within its delegated ceiling or to its parent; retry and total budgets stop an escalation loop; routing decisions and reasons are persisted and queryable.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R04 — Implement provider drain, cutover and failback policy

- **Parent:** N08 / AII-258.
- **Blockers:** R02, L05.
- **Deliverable:** Fallback-list validation for every model-using role including the coordinator and safety supervisor; exclusions at model, endpoint, account, provider and local-service level with alias resolution; persisted list position and attempt history; planned-drain and immediate-cutover modes; cooldowns and a separate failback policy (README 459-476; pitfalls-and-safeguards 119; design-decisions 55).
- **Acceptance and verification:** A role without a valid list is rejected at configuration; an alias to a disabled service is excluded; no recursion into a fallback's own list and no cycles; list position survives restart; drain reports routing applied, in-flight requests remaining and service safe to stop as separate facts, including when no local route is in use; cutover cancels in-flight attempts, rejects late responses and records possible outstanding charges; an account-wide block is distinguished from an endpoint failure; a tool error or bad answer does not trigger failover; an explicitly disabled route stays disabled despite probes; failback follows its own policy without flapping; local-only, cloud-only and mixed configurations exercised across restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R05 — Implement cost and resource attribution and delegated budgets

- **Parent:** N08 / AII-258.
- **Blockers:** R02, H03, S10.
- **Deliverable:** Usage ledger attributing provider spend (currency) and local compute (occupied worker-slot time) to task, agent and project, atomic budget reservation across the task tree, delegated sub-budgets and a request-more-budget flow (README 604, 638; pitfalls-and-safeguards 101; production-and-capacity 19-21).
- **Acceptance and verification:** Spend is reserved before dispatch and reconciled to actual usage; concurrent children cannot spend the same allocation; uncertain in-flight and outstanding charges are shown; currency and compute are tracked separately; background jobs, meetings and supervision are attributed to their work or an explicit shared-overhead category; a request for more budget goes to the owner or delegated authority; provider ceiling enforceability is stated honestly.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R05b — Reserve before dispatch and settle after in the dispatcher

- **Parent:** N08 / AII-258.
- **Blockers:** R05, H12.
- **Deliverable:** Split from R05 (audit 2026-10-26): the budget service reserves and reconciles, but the dispatcher only checks accounting before a call and charges after it, so spend is not reserved before dispatch.
- **Acceptance and verification:** A dispatch test shows a reservation before the attempt starts, settlement to actual use when it ends, an uncertain mark when the call is lost, and the three ceilings (the task contract's maximum cost, R02's cumulative budget and R05's reservation) agreeing; two attempts of sibling tasks cannot reserve the same allocation.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R05c — Budget requests reach their addressee and budgets are exposed in the API

- **Parent:** N08 / AII-258.
- **Blockers:** R05, U11.
- **Deliverable:** Split from R05 (audit 2026-10-26): request-more-budget is routed and stored, but nothing tells the owner or the delegated holder and no operation lets anyone see budgets or decide a request.
- **Acceptance and verification:** A request for more budget produces a notice for the owner or the delegated holder; budget report, usage, request, decide and pending requests are API operations with rights and tests; outstanding and uncertain charges are visible through them.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R05d — Charge meetings, supervision and background jobs to their work or a shared category

- **Parent:** N08 / AII-258.
- **Blockers:** R05, M01.
- **Deliverable:** Split from R05 (audit 2026-10-26): the ledger takes any charge, but the only production caller charges model calls.
- **Acceptance and verification:** Meeting turns, supervisor activity and background jobs are charged to the task they serve or to a named shared-overhead category by their own services, tested end to end; nothing is charged twice; the measurement basis for local compute is stated.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U01 — Implement versioned state query/write API

- **Parent:** N07a / AII-519.
- **Status:** implemented; commits `ec294b3`; CI runs 39545034241; record [api-v1.md](api-v1.md).
- **Progress note:** One door for chat and API clients: StateApi authenticates a credential, scopes every fact to the principal's grants and answers in one strict envelope (version 1, idempotent command IDs, revision checks, pagination, errors with codes); a command's response separates accepted from completed (assigning a task is accepted but not completed until the worker acts). The contract document is generated from the operation table and a test fails if it is stale. startController is the first start-up path: it runs the environment check before opening anything, refuses an unsupported environment or PostgreSQL server unless the override is given, prints the notice and audits the override once per epoch. Limits stated: no network listener, TLS, sessions, rate or size limits (the transport cards); the operation set is the state that exists today. Reviewed and approved by an AI review session (Claude Opus); six-cell CI green.
- **Blockers:** S01, A01, C02.
- **Deliverable:** Documented contracts, pagination and command results.
- **Acceptance and verification:** Chat/API clients see same scoped facts; stale revisions and duplicate command semantics verified; accepted differs from completed; the controller start-up path (first built here) runs the F04h environment check: detectEnvironment with the PostgreSQL server version, startupCheck with the override from overrideRequested, print its output, pass allowUnsupportedServer to the PostgreSQL adapter, call recordOverride; an unsupported environment refuses to start and an overridden one is audited.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U02 — Implement durable conversation service (threads, messages, cursors, delivery states)

- **Parent:** N10a / AII-520.
- **Status:** implemented; commits `48a909e`; CI runs 39669384652; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The durable conversation service: threads, messages (named by thread and sequence, so retries are safe), per-reader cursors and distinct accepted, delivered, handled and answered states, all in the controller store so no connection owns history. External agents are a new principal kind that can hold only conversation actions, so joining a thread gives no tool, task or file capability; the authenticated sender is recorded apart from a client's claimed sender. Content is untrusted and credentials in it are replaced; an action request is only stored as a request (A07 carries evaluating it). Limits on message size, recipient queue, sender rate, reply depth and runs without the owner; a participant sees only messages sent by or to it (an open owner decision is recorded); revoking grants ends access at once; paused, suspended or stopped recipients have messages kept and reported as queued through an availability hook that L01 supplies. The HTTPS transport, opt-in remote listener and TLS are the new card U02b. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** U01, H04.
- **Deliverable:** Thread/message/cursor service with delivery states, limits and client principals.
- **Acceptance and verification:** Either side initiates; disconnect/restart resumes without duplicate turns; live connection never owns history; scoped revocable client credentials for external agents (a client principal that can hold only conversation actions), with the authenticated client recorded apart from the claimed sender; an external client gains no tool, task or filesystem capability; sender, recipient discovery, project scope, message type and delegated authority are checked, content is treated as untrusted and action requests go to authorization; message size, recipient queue, per-sender rate, reply-chain depth and no-owner run limits bound traffic; accepted, delivered, handled and answered are distinct states; a message to a paused, suspended or stopped recipient is kept and reported as queued and a sender that is not available cannot send (the lifecycle arrives through the availability hook that L01 supplies).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U02b — Implement the conversation transport and remote exposure

- **Parent:** N10a / AII-520.
- **Status:** implemented; commits `1fe85f3`; CI runs 39676228455; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The conversation transport: authenticated HTTPS requests with cursor-based long-polling over the conversation service (a provisional choice recorded in the decision record). Local only by default; a remote listener needs an explicit opt-in, TLS and the host names clients use, and any other host name is refused; the credential is checked afresh on every request, so a revoked client is refused on its next one; bodies, request rates, long-polls and connections are bounded; a dropped client resumes from its cursor and loses nothing; the lifecycle gate applies to API calls. The controller start-up can open it and closes it first. Limits stated in the notes: rate windows are in memory, long-polls re-read every 250 ms, no certificate management. Reviewed and approved by an AI review session (Claude Opus); six-cell CI green after a rerun of one cancelled runner job.
- **Blockers:** U02.
- **Deliverable:** Chosen transport (authenticated HTTPS requests with cursor-based long-polling, server-sent events optional) and the opt-in remote listener.
- **Acceptance and verification:** Remote exposure is opt-in with local binding by default and TLS; client credentials are checked on every request and a revoked client is refused on its next request; request rate and size limits and backpressure at the transport; a dropped connection loses nothing and the client resumes from its cursor; the same permissions and results as in-process callers on macOS, Linux and Windows; a paused or stopped agent's lifecycle gate applies to API calls; the transport choice is recorded in the decision register.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U03 — Implement owner chat command interpretation

- **Parent:** N09 / AII-259.
- **Blockers:** U01, U02, R02, U03b, U03d.
- **Deliverable:** Intent-to-command mapping and audit links; a persistent coordinator agent (controller-managed, with its own grants, fallback list and lifecycle controls) answers from records and opens inquiries only when records are insufficient; proposal records; chat commands for agent, team and task-contract records.
- **Acceptance and verification:** Clear authorized project/task edits apply; material ambiguity asks; quoted/untrusted text cannot grant authority; a drafted project or assignment is saved as a proposal and nothing is admitted until an explicit request applies it; per-project conversation context is retained across switches and changing focus never retargets a running task; every dispatched task carries an explicit project and checkout; the controller keeps working when the coordinator is unavailable; the coordinator decomposes an outcome into tasks with dependencies and proposes or, if granted, makes assignments.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U03d — Let the owner reach the coordinator through the chat

- **Parent:** N09 / AII-259.
- **Blockers:** U01, U02, U03b.
- **Deliverable:** Split from U03 (audit 2026-10-26): the coordinator existed only as an in-process handle and in tests; the owner's chat now carries a coordinator intent (a question answered from the records with citations, a drafted plan as a proposal, handing out open tasks, and the coordinator's own set-up and start, pause and stop), checked as the owner's own words and applied once per turn.
- **Acceptance and verification:** Through the composed controller: a question is answered from a cited record, a plan is a proposal that exists only after the owner applies it, assignment shows the model the active agents, set-up and start in one message work, quoted text and text the owner did not say are refused, and a pending question holds the order.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U04 — Implement conversational policy editing

- **Parent:** N09 / AII-259.
- **Blockers:** U03, A02, A05, A07, U10.
- **Deliverable:** Original wording, proposed interpretation and applied revision.
- **Acceptance and verification:** Scoped exception preserves unrelated gates; unsupported condition explicitly unapplied; concurrent API edit detected; a direct API or UI edit appears in the next agent context build; forwarded messages record authenticated origin and forwarding agent separately; policy edits use the A07 action classes and the U10 configuration service.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U05 — Implement chat status and blocker explanations

- **Parent:** N09 / AII-259.
- **Blockers:** U03, S08, H01.
- **Deliverable:** Evidence-linked status and task/project inspection views.
- **Acceptance and verification:** Owner versus observed active attempt distinguished; exact pending dependency/retry shown; no fabricated completion; answers what changed since a given time, which tools were used (MCP server and capability included) and what was delivered, with links; the overview filters by project, agent and state and shows observation time, freshness and uncertainty; routine status comes from records without waking workers and stale reports are flagged; a blocker shows its kind (technical, enforced permission, policy conflict) and resolution route, and a supervisor or team preference cannot be a blocker on an owner-decided outcome; a permission-filtered noticeboard summarizes current assignments, latest stand-up reports and deliverables with links to owner desks; the failed-event queue can be listed and inspected.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U06 — Implement deterministic recovery chat controls

- **Parent:** N09 / AII-259.
- **Blockers:** U01, L02, A02.
- **Deliverable:** Model-independent status/pause/stop/revoke/recovery actions.
- **Acceptance and verification:** Provider loss still permits authenticated recovery through chat; unavailable host boundary reported; command audit retained; Force Stop and provider or route exclusion work without a model; replies distinguish received, accepted, activated and effected.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U03b — Back the owner chat interpreter and the coordinator with a routed model

- **Parent:** N09 / AII-259.
- **Status:** implemented; commits `17f3200`, `4a2043c`; CI runs 40411682946; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Routed model for the owner chat and the coordinator with failure guard and a daily token cap; start-up configuration of it, a chat.budget right and measured reading speed are not part of this card.
- **Blockers:** U01, U02, R01, R02.
- **Deliverable:** The chat interpreter (reads the owner's free-form message into intents) and the coordinator's model are implemented over the routed model client: routes come from the routing table (R01), failures are classified and fall back (R02), the coordinator's routes are resolved from the table instead of being plain names, and the model sees only what the scripted interpreter was shown (the owner's words, quoted text marked as quoted, the focus, the open proposals).
- **Acceptance and verification:** Against a recorded or simulated model: a clear order becomes the right intents; an ambiguous one asks; quoted text, and an instruction hidden in a record or a tool result, cannot become an intent that grants authority; a model that fails or answers with invalid intents leaves the chat answering that it is unavailable and nothing done; a route that fails falls back as R02 says and a cumulative budget is respected; the same message with the same command ID is one turn.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U03c — Run the coordinator as a hosted agent with its own lifecycle (optional, after the first release)

- **Parent:** N09 / AII-259.
- **Blockers:** U03, H11, L01.
- **Deliverable:** Optional: the coordinator becomes an agent record with a host, its own grants, fallback list and pause, stop and resume lifecycle through the same controls as other agents, instead of a controller-held credential.
- **Acceptance and verification:** The coordinator appears in the agent list with its lifecycle state; pausing or stopping it through the agent controls has the same effect as the coordinator state today; the controller works with it paused, stopped or failing; its grants are visible and revocable like any agent's.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U07 — Qualify responsive web chat over private networking

- **Parent:** N09 / AII-259.
- **Blockers:** U03, U06, A01, R05.
- **Deliverable:** Responsive browser UI, authenticated sessions and private HTTPS deployment guide using Tailscale or equivalent; blocker and cost views.
- **Acceptance and verification:** Phone browser supports chat/approval/status/recovery; suspended connection resumes without duplicate commands; revoked session denied; local/private binding explicit; no public exposure or mandatory VPN vendor dependency.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U09 — Implement read-only activity timeline and replay views

- **Parent:** N09 / AII-259.
- **Blockers:** C09, U05, A10, C06b.
- **Deliverable:** Summary-first timeline with step-through over C09 records in chat and the web UI: filters by agent, task, project and time, branch and related-agent navigation, and links to messages, diffs, comments, tool calls and artifacts (README 235-249, 608); model thinking that the provider returned is shown collapsed, labelled as model output and not as a decision explanation (C09), and the owner can expand any step to read it while it is stored (owner decision 2026-10-22).
- **Acceptance and verification:** Opening or advancing replay causes zero tool executions, messages, job submissions or model calls (asserted against the effect ledger, router and outbox); a rerun or simulation is a separate command in an isolated scope (P07); each step shows the versions used then, not current records; proposed, dispatched, confirmed and uncertain outcomes are distinct and concurrent branch events are not shown as sequential; redactions and incomplete or intentionally unavailable ranges are marked; contemporaneous explanations are visibly distinct from retrospective ones; superseded decisions are marked non-authoritative; replay links, search, summaries and exports apply the same permission checks and the owner inspection policy (A10) and expose no credentials or other projects' records; "what evidence and instruction led to this change?" is answered with links; validated with a task branch, provider switch, compressed history, failed tool and later owner correction; thinking is collapsed by default and expandable while stored, labelled as model output; after retention has deleted it the step shows that the thinking was removed by retention and nothing else changes; deleting it never breaks a timeline or an audit record.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U08 — Implement settings and administration views

- **Parent:** N09 / AII-259.
- **Blockers:** U07, U10, A07, F09, H11, R03, T03, A07b, A07c.
- **Deliverable:** Browser settings views over the same configuration service as chat and API for providers, routes, local inference endpoints, difficulty profiles, agents and teams, approval policy, API access, operations, P/PC, MCP connections and secrets; later cards add their own areas to these views (portability-and-configuration 43-63, 89-92; README 15, 74).
- **Acceptance and verification:** A fresh install is configured entirely through the UI with no source edits and no target-repository files; UI and chat edits yield the same durable revision; editable, inherited and locked values are shown with their source; secrets are entered write-only; invalid values are rejected with path-addressed errors; compatibility and migration status shows affected agents and operations; settings persist across restart on macOS, Linux and Windows; the views show the sandbox mechanism each host uses and flag a weaker boundary (macOS Seatbelt is process-level with weaker limits than Linux) wherever the owner chooses or reviews where work runs (G01 decision 2026-10-21); an approval-load view: owner decisions per day, how long asks wait, and the share decided by standing rule, agent review and owner, with every pending ask and its age; first-run setup explains the derived profile in plain words, recommends it for testing and development work, and asks whether to switch from the strict profile a new installation starts in; the same question is asked in chat setup for an installation with no browser UI, the answer is recorded and either profile can be chosen later; first run applies the configuration's approvals.preset when no approval policy exists yet (a private profile may say derived), before it asks the setup question.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U10 — Implement layered configuration, effective values and change history

- **Parent:** N09 / AII-259.
- **Status:** implemented; commits `cdc0071`; CI runs 39672565731; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Layered configuration (installation, team, agent, task): settings are defined in code, a default is overridden by the more specific layer, a restriction can only be narrowed (a denial only grows), and a layer can lock a setting. Changes are staged and applied as a whole after the combination is checked; a refused apply changes nothing in force and keeps the reasons. Every value reports its source layer, lock and when a change starts to count; history keeps who and what. A task is judged with the agent working it. The configuration document binds to the routing table, and a reorder from the screen or from the coordinator agent goes through one path and gives the same revision. Applying configuration touches only configuration (assignment and task untouched, tested); the clauses that it also leaves a pause and pending decisions in place are carried by L01 and C08. Limits stated in the notes: no screens or state-API operations yet. Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** F02, R01, U01, H11.
- **Deliverable:** Controller-backed configuration service: layered precedence (installation, team or agent, task override) constrained by authority, effective-value resolver with source and lock state, drafts versus applied revisions with actor history, configuration-document to routing-table binding, combination validation and stated take-effect timing (portability-and-configuration 63-73, 93-94; design-decisions 61; pitfalls-and-safeguards 35).
- **Acceptance and verification:** Every value reports its effective source layer and lock state; a task override cannot re-enable a globally disabled provider or widen authority; history shows actor and revision; a draft is distinct from the applied revision and a failed apply is never shown active; each change states when it takes effect (next request, after the current operation, after Suspend and restart); fallback cycles, missing routes, a PC target outside its floor and ceiling and impossible time, resource or permission settings are rejected; the configuration document loads into the R01 routing table and UI reorder and supervisor reorder produce the same routing revision; reload preserves Pause, ownership and pending decisions.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U11 — Implement owner notifications

- **Parent:** N09 / AII-259.
- **Status:** implemented; commits `20571ca`; CI runs 39705612613; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Owner notifications: a report points at a record and the controller builds the text, the project and the offered answers from it, so a producer cannot hijack another project's item or put its own words in front of the owner; only the controller (an internal call, not a grant) can interrupt or mark a review urgent. Only a safety stop and a blocked critical path interrupt at once; an urgent review waits out quiet hours; everything else is collected into digests at the owner's times and answered in one pass against the revision seen. The same event coalesces into one item with a count. Nothing leaves the installation unless an external channel is configured, and then only the controller-built label; failed deliveries are retried within a bound and stay visible. What is open is kept in one index. Limits stated: the scheduler and the producers are later cards, no channel adapters (webhook, email, chat) are built, nothing shows the inbox yet (U08), and one index serializes all reports. Reviewed and approved by an AI review session (Claude Opus) after four rounds; six-cell CI green.
- **Blockers:** U02, S08, U10.
- **Deliverable:** Configured notification channel for blockers, review requests, owner questions, maintenance outcomes and presence or disconnection, using the delivery method the owner selects (design-decisions 75; portability-and-configuration 57; maintenance-and-updates 28).
- **Acceptance and verification:** Each listed event produces one notification linking to its record; delivery failure is visible and retried within a bound; duplicates coalesce; channel and quiet-hour changes apply from the next notification; notifications carry no secrets or restricted payloads; nothing is sent to an external service unless configured; owner asks are collected into a digest at times the owner sets, answerable in one pass from the notification, with quiet hours; an immediate interruption only for a blocked critical path, a safety stop or the other Urgent triggers defined in U11b; reviews escalated to the owner (H05) arrive in the digest unless the policy marks them urgent.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U11b — Implement notification levels, the Needs you view and escalation to Urgent

- **Parent:** N09 / AII-259.
- **Blockers:** U11, A07b, H05, M03, H12, K01, H01, H09, A08.
- **Deliverable:** Three levels for everything that reaches the owner (owner decision 2026-10-22): Notice (informational, no action), Needs you (waiting on a decision, work elsewhere continues) and Urgent (needs the owner now); one 'Needs you' view with the count shown in every chat reply; extends U11's controller-raised interrupting kinds.
- **Acceptance and verification:** Only the controller raises Urgent (agents still cannot interrupt, as in U11); a notice goes to the inbox and the activity record only and is counted in the daily report, never pushed; every item awaiting an owner decision (approval requests, agent questions, escalated reviews, deferred meeting items from M03) appears in one view sorted by critical path first, then the number of tasks it blocks, then age, each answerable in place; Urgent triggers are exactly: a safety stop; a blocked critical path (a task that an open goal or another open task depends on through the task dependency records, or one the owner marked critical, computed by this card); failing backups (K01: no good backup within the limit, which is 48 hours until K01c lets the owner set it); a host down (H01 heartbeat loss, H09 reconciliation failure) or the controller down (a watchdog or host sends straight to the configured external channel, and the controller raises it again when it returns); a sandbox escape attempt, a credential used from the wrong task or host, a protected path (.git or the loader configuration) touched, a failed integrity check (A08), or repeated denials from one agent over an owner-set threshold; and any Needs-you item that has stopped work (a critical-path task is blocked, or the dispatcher's view of available work (H12) shows an agent or project with nothing else to do while it waits) or has waited past an owner-set time (default 24 hours); routine single policy denials are not Urgent; an item that only holds back an agent with other work stays Needs you; escalation to Urgent is recorded with its reason and the dispatcher returns it to Needs you on the next dispatch if the work has resumed; Urgent interrupts at once on every configured channel and also in quiet hours; the daily stand-up report (M03) opens with the Needs-you items and then a summary of notices and is the digest, with a plain 09:00 UTC digest only when no stand-up is scheduled; levels and the escalation time are changed by chatting with the supervisor, owner-only and recorded; the Needs you view also lists every review that is in owner-decision mode (created by the commit gate, a direct request, a deadline or a reviewer escalation as well as by the dispatcher), so no owner-mode review waits unseen (H12h follow-up); a task that needs a grant nobody has given (a grant_needed blocker raised by the dispatcher, H12) is listed as a Needs-you item.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U12 — Implement agent messages, delivery classes and interruption budget

- **Parent:** N10a / AII-520.
- **Blockers:** U02, S08, L05, M01.
- **Deliverable:** Per-agent message envelope (task, sender, purpose, urgency, optional deadline, correlation ID) with sending, accepted, delivered, handled and answered states; delivery classes; focus periods, interruption allowance and coalescing (README 61, 68, 153, 177, 185, 259, 482-491; agent-apis 19, 25, 29, 45; pitfalls-and-safeguards 65-67).
- **Acceptance and verification:** Informational messages batch to the next check-in or stand-up; advice is read at the next safe boundary; a blocking dependency wakes only an eligible waiting task, never through a pause; urgent control interrupts only under sender authority and parent rank does not imply urgency; repeated updates coalesce; per-sender and per-recipient rate and queue limits and reply-loop bounds are enforced; a message or inquiry to a paused or suspended agent stays queued, does not wake it and reports queued or unavailable; an agent's question to the owner appears in owner chat with its task context and the answer resolves the linked wait; a request without a reply reaches its escalation path at its deadline; states survive restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U13 — Expose lifecycle, decisions, deliverables and activity through the state API

- **Parent:** N07a / AII-519.
- **Blockers:** U01, L02, Q01, C08, C09.
- **Deliverable:** StateApi operations for lifecycle intent and observed execution state, checkpoints, decision records, deliverables, tool activity, message references, the project overview and event subscriptions (agent-apis 9-17; README 167-171).
- **Acceptance and verification:** Every listed object is readable, and writable where a command exists, with revision and provenance; the overview distinguishes paused assignee, unreachable worker, stale artifact and uncertain tool result with observation time and filters by project, task, agent, state and time under project and payload restrictions; long-running commands report accepted, queued, running, completed, blocked, failed or outcome-unknown; subscription cursors survive restart; the generated contract document stays current.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### V01 — Implement health and progress stall detection

- **Parent:** N11 / AII-261.
- **Blockers:** H01, S08, C04, H11.
- **Deliverable:** Deterministic alarms and bounded progress evidence.
- **Acceptance and verification:** Long legitimate job differs from loop and dead worker; stale timestamps not used as sole takeover permission; signals include request duration, last step, repeated equivalent actions and errors, job status, budget and acceptance evidence; concerns route to the agent's responsible supervisor (H11); thresholds depend on difficulty; suspected stalls are shown apart from confirmed failures.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### V01b — Scale stall thresholds to the prompt size and the measured speed of the model

- **Parent:** N11 / AII-261.
- **Blockers:** V01, H12, H12b, H12e.
- **Deliverable:** Split from V01 on the owner's direction (2026-10-26): V01 judges an open request against a fixed time per difficulty, so a local model that needs twenty minutes to read a 120,000-token prompt at 100 tokens a second is reported as a stuck request before it has begun. The prompt size is not known from the relay at the start of a request (usage arrives after the reply), so the start of a request records an estimate: the request body's characters divided by the route's calibrated characters per token, less the share the cache adapter expects to be cached (the request_started event gains an optional prompt-size field); the controller measures the reading and writing speed per route and host from finished requests (the relay is extended to report the input and output token counts of every call, not only the first call's input as today, and the time from the request's start to its first output and to its end), and a first-output event is added to the evidence and the allowed time of a request is the larger of the difficulty's time and a margin over the time the prompt should take at the measured speed.
- **Acceptance and verification:** A request for a large prompt on a slow local route is not reported as stuck while the expected reading time has not passed, and is reported when it passes by the margin; a hosted route with a fast reader keeps the difficulty's time; a route with no measurement yet uses a declared speed from the route settings, else a stated cautious default that is shown in the concern text; a cached prefix shortens the expected time by the cached share (without the cache adapter's expectation the whole estimate is used); the same reading allowance applies to the silence concern while a request is open and has produced no output, so a long read is neither a stuck request nor silence; the first-output event counts as progress and ends the reading allowance; while output continues the model relay (which sees the stream, and also reports the first output) reports output progress at a bounded interval (a count of tokens written so far), each report counting as progress, so a slow local model that writes for longer than the silence threshold is not reported as silent, and a stream that stops producing for the ordinary silence threshold is; the measured speed is a smoothed value that one slow request cannot collapse or one fast request inflate; a stuck-request concern states the prompt size, the speed used and the time expected so the supervisor can tell a slow model from a dead one; the thresholds and the margin are settings.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### V02 — Implement bounded supervisor recovery

- **Parent:** N11 / AII-261.
- **Blockers:** V01, V01b, L03, L04, R02, H05.
- **Deliverable:** Recovery action ladder and supervisor monitoring.
- **Acceptance and verification:** Loop recovery preserves history/effects; cumulative cost/retries enforced; supervisor stall escalates; owner holds remain; switching model or context never resets cumulative retry, time or cost limits; supervisors are subject to the same detection; an intervention and queued input are persisted before a stuck request is cancelled, and a resume on a backup route or rebuilt context records what context was carried.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M00 — Prototype the meeting protocol and run meeting experiments

- **Parent:** N12 / AII-262.
- **Blockers:** G01.
- **Deliverable:** A throwaway prototype of the meeting rules (owner decision 2026-10-22), built early and standalone (a small script that passes the baton, makes one tool-less model call per turn and keeps transcripts and ballots; it needs none of the controller, storage or sandbox) and run with real model calls on cloud providers during the testing period (owner decision 2026-10-22; runs against the local model wait until it has moved to its new engine and the Paperclip agents no longer use it, and a local run reads the server's slot state first so it never evicts someone else's cached conversation), to find where the ideas fall apart before M04-M06 are built: floor and baton, two comment rounds, direct questions, chair fact-finding questions, individual ballots revealed at the close, owner messages and inquiry period, absent members and a desk read.
- **Acceptance and verification:** At least five meetings are run on different subjects (for example a tool proposal put to a group of eight coders, a policy motion, a real disagreement, a meeting with an absent member, a meeting the owner interrupts and questions), with the owner's model-spend budget set beforehand and the spend recorded; every transcript, ballot record and chair question is kept; the experiments compare variants side by side (including the chair's notes written once after round 1 against rolling notes updated after each statement, which tests whether a long pile of full statements makes the chair lose track, with a 20-participant meeting in the set; role personalities and information habits, notes available from the first round, and tabling a motion for research): a blind or an open first round, one or two comment rounds, the whole transcript against a short summary of each turn written by the speaker at the end of its turn (the summary chain, with the full text kept and retrievable) against a digest, turn limits counted in output tokens, a meeting prompt built shared-first (common preamble, motion and transcript, then the agent-specific part) against the normal agent-first order with the cache hit rate measured on a hosted provider now and on the local server once local runs are allowed (the local measurement belongs to G10, so M00 can be accepted on cloud runs alone), and a question to a non-present subordinate answered from its checkpoint; a findings record states for each rule whether it worked, needed a change or should be dropped, with the evidence, plus problems the rules did not foresee (turn length, repetition, agents agreeing too readily, chair steering, cost, time); the proposed changes to M04-M06 and the provisional defaults are listed for the owner to accept or reject and nothing is changed without that; the prototype is not shipped and M05 and M06 are built after its findings are accepted.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M01 — Implement durable meeting scheduling and agendas

- **Parent:** N12 / AII-262.
- **Blockers:** H04, U03.
- **Deliverable:** Scheduled/urgent meetings and idempotent occurrences.
- **Acceptance and verification:** Restart/catch-up creates one occurrence; absent/paused participants handled without unauthorized wake; agenda retained.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M02 — Implement votes, decisions and meeting summaries

- **Parent:** N12 / AII-262.
- **Blockers:** M01, A02, C02, C08.
- **Deliverable:** Decision records, dissent, owner presence and task updates.
- **Acceptance and verification:** New decisions respect effective authority; owner arrival handled; summary matches applied changes; old grants not reopened; the summary lists attendance, key updates, decisions with reasons and links to the discussion, dissent, unresolved questions, actions and plan, and separates adopted from applied; a full-discussion view sits beside it and answers why a decision was taken from the record; transcript and summary stay durable and access-controlled when the meeting is interrupted or the summarizer fails; entries are typed (motion, amendment, ruling, vote, correction) and corrections are linked updates; decisions apply with expected revisions and a conflict shows as not applied; a conclusion published from private records is marked unverifiable when its source cannot be shared and asking for rationale grants no desk access (the one exception is the chair's meeting-scoped read of an absent member's desk, M05); stand-up plans persist.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M03 — Implement stand-up preparation, briefs and agenda items

- **Parent:** N12 / AII-262.
- **Blockers:** M01, C02, U03.
- **Deliverable:** Stand-up schedule configuration (time, IANA timezone, participant group, duration, daily window), advance notice, durable briefs, agenda ordering, supervisor-captured agenda items with request type and states, and improvement-backlog items with a timebox (README 69, 499-501, 531, 539-543; production-and-capacity 39-41).
- **Acceptance and verification:** Schedules follow real timezone and DST rules with one catch-up report after downtime; agents are notified to reach a safe boundary and each brief lists accomplishments over about 24 hours, unfinished work, blockers, advice needed and next priorities from records without waking paused agents; the agenda puts conflicts, questions and decisions first; a captured item is shown in chat and correctable; its request type (discussion, recommendation, delegated decision, instruction) sets its authority and a tentative idea is never executed; queued, scheduled, discussed, deferred and resolved states carry owner and outcome links; deferred items stay visible with reason and next step; outcomes return to the originating conversation; the planning agenda includes a P/PC balance review.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M04 — Implement meeting attendance and return to work

- **Parent:** N12 / AII-262.
- **Blockers:** M01, L01, L05, H04.
- **Deliverable:** Bounded meeting task under a task-scoped Pause, participant states (preparing, present, unavailable, blocked), immediate-meeting rooms, wake rules and the end-of-meeting return policy (README 501, 505, 509, 570-574, 580; operational-contracts 45, 103).
- **Acceptance and verification:** Near a scheduled meeting, admission avoids starting work that cannot yield before it while safe long-running operations continue; joining keeps ownership and background work and never uses Suspend, handoff or Force Stop; the meeting task does not advance the paused assignment; an immediate meeting starts with available participants scoped to the current project or named team, asking first if scope is unclear; a saved brief is never shown as a live answer; "everyone required" waits for missing participants under a visible timeout; a schedule never wakes a paused agent, while a direct owner invitation allows bounded attendance with other work still paused; suspended or stopped agents are woken only with owner authorization; the meeting proceeds without the owner and a late joiner sees the state so far; at the end only assignments paused solely for attendance resume, earlier or newly requested pauses, suspensions and stops are kept and nothing is transferred; return revalidates decisions and ownership and a new priority may defer it without transfer; absent affected agents are notified and revalidate their next actions before continuing; a participant who is not holding the floor receives no further messages from the meeting (the delivery rule is M05's).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M05 — Implement meeting facilitation and owner control

- **Parent:** N12 / AII-262.
- **Blockers:** M04, M02, U03, M00, A10, C01b.
- **Deliverable:** Facilitator floor control with bounded turns, time and spend limits, owner commands (ask one agent, address the team, change priorities, end the meeting), unresolved-question follow-ups and a waiting-on view (README 505-507, 558, 582).
- **Acceptance and verification:** Agents never answer all at once; an owner question preempts the active turn at a safe response boundary without undoing completed effects; the chair cannot silence the owner; targeted answers mark stale sources and separate proposed from completed actions; an unresolved question becomes an owned follow-up task; meeting duration and model-spend timeboxes are enforced and deep investigations become follow-up work; nonurgent items batch to the next meeting; chat and the console show whether the meeting waits on a person, agent or tool; floor and delivery (owner rule 2026-10-22): a participant receives the whole meeting transcript up to the moment it is given the floor (ballots are not part of that transcript while a vote is open; M06) and nothing while it does not hold the floor, so a meeting stays orderly (the floor is the baton: an owner message does not pass it unless the owner names an agent or the chair decides to, and an agent receives new transcript only with it; owner decision 2026-10-22); the objection check before a vote is a bounded call and not a floor turn: the member receives only the motion version and the round summary, may answer only yes or no with a reason if yes, cannot speak or ask or raise anything else, and an objection's reason enters the transcript for the chair's ruling and later speakers under the normal floor rule; addressing a particular agent (by the owner or the chair) gives it the floor and delivers everything said so far; the owner may open an inquiry period at any time (owner decision 2026-10-22): the meeting clock and the turn limits are paused, the owner asks any participants as many questions as they like, nothing else advances (no comment round, no vote opens, an open vote is held, its own time limit pauses with the meeting clock, and it keeps its roster, quorum and recorded ballots unchanged, and no ballot can be cast or revised until the inquiry ends), answers voters give to the owner during a held vote are kept out of other voters' deliveries until the vote closes (the owner sees them at once), when the inquiry ends each voter who has already cast gets the revision turn of M06, participants the owner has not addressed may return to work under M04's return-to-work rules and are recalled if addressed, attending agents' heartbeats and attempt timeouts keep running (only the meeting's own clock is paused), after an owner-set idle time the owner is reminded and an open inquiry shows as a Needs-you item (U11b), a held vote survives a long inquiry and a controller restart, and an owner command (for example 'done with questions') ends the period and the meeting resumes where it left off; the meeting's own time and spend timeboxes do not apply to the owner's questions, but model spend is still recorded and per-task and per-provider budgets still apply, and a budget that is reached is reported to the owner instead of cutting the inquiry off silently; after the first round the chair reads the full statements (never only summaries) and keeps its own private notes of follow-up questions, which are not delivered to other participants, can be read by the owner and are kept in the meeting record (owner idea 2026-10-22); before the vote opens the chair may put specific questions to one or more present participants to inform the group (for example asking the coders who have used a tool a participant proposed): each addressed agent is given the floor for a short bounded answer, answers go into the transcript for everyone who later gets the floor, chair questions count against the meeting's time and spend limits and an owner-set cap per motion, are structured (a factual topic and the experience or evidence sought, with no free-text position field, and a question that names the motion's outcome is refused), may be put only before or between comment rounds or, if put after the last round, are followed by a short reply turn for every present member before the vote; each is recorded with whom it went to and why, listed in the meeting summary for the owner, any member may ask the chair to put the same question to someone else (within the cap), and a question that seeks a position can be challenged as a procedural concern and ruled on; answers are delivered under the normal rule (the whole transcript up to the agent's turn, never ballots), change neither roster nor quorum, and chair questions are not allowed while a vote is open; a question to an absent participant is skipped and recorded, and the chair may read that absent member's shared working notes (C01b) through the ordinary read path, which needs no meetingRead, and may instead read that absent member's desk, private scratch and drafts included (owner decision 2026-10-22: only for roster members who cannot be present or were not invited, since a present agent reads its own desk itself, and only read-only; no agent outside the roster is ever brought in, and an agent in the middle of a long-running command is not interrupted): this needs new code and does not change A10: the card adds a third inspection path beside the owner's inspect and the recovery service's recoveryRead (for example meetingRead), decided from the meeting record and not from a grant on a desk, which checks that the caller is the meeting's current chair, that the record's owner is a roster member the controller (not the chair) has found absent, that the record's project is the meeting's project and its origin is this project or reachable through an open A10 path, and that the installation's inspection policy is not denied, then reads private scratch and drafts (drafts are readable only through this path), expires when the meeting ends or the chair changes, is revocable by the owner, is never carried by a task credential, and leaves an inspection record (via meeting-chair) that the record's owner sees through its inspections; absent means decided by the controller from roster and attendance state and never by the chair: cannot be present is an M04 participant state of unavailable or blocked (including an agent in a long-running command that is not interrupted) and not invited is a roster member left off this meeting's invitation list, and a present member is never readable this way; the read never writes, wakes or interrupts the agent; every read goes through the inspection service and leaves an inspection record per file read that the absent member can see; it returns excerpts that bear on the motion with secrets redacted and leaves out copies and citations whose origin is another project unless the owner has opened a path (A10); each excerpt carries a link to its record and revision and a short verbatim excerpt, not only the chair's paraphrase; reads are listed in the meeting summary for the owner and count against the chair-question cap and its timing rules; what the chair reports is marked as taken from the absent member's desk and unverified by that member, the returning member is shown what was read and can add a recorded correction, and a correction that contradicts what was relayed while the vote is open is reported to the owner; during its turn an agent may ask another present participant a direct question; the addressed agent is given the floor for a short bounded answer (it receives the whole transcript so far), then the floor returns to the asker, who receives the answer and may continue; questions count against the asker's turn, time and spend limits, each agent has a per-round question limit, an answer may not open a further question chain beyond an owner-set depth (default one), a question to an absent participant is skipped and recorded, the chair may refuse or cut short a direct question to keep the meeting brief but can never silence the owner; if the owner preempts during a direct-question exchange the floor returns to the answering agent and then to the asker; no direct questions are allowed while a vote is open so the ballot record stays separate (M06), and an owner question to a voter during an open vote is delivered as asked and its answer is not a ballot; ending the meeting during an open vote voids the vote and records it as not concluded; the question and answer are in the transcript for everyone who later gets the floor; meetings are brief by default (a short turn limit counted in output tokens, with a time limit kept only as a safety against a hung call, and a meeting time budget) and run longer only when the owner says so (tested: the chair's notes are made from the full text and are visible to the owner and not delivered to others, the chair gives the group a neutral summary of round 1 before round 2 (owner idea 2026-10-22): at most six of the most important points, those several speakers repeated, those the summaries left out and those in dispute, each attributed to the speakers who made it, balanced between sides, with no recommendation and nothing about how to vote, an omitted point carrying a verbatim quote that must occur in that speaker's full statement (a point that fails the check is refused), added to the transcript for everyone and visible to the owner, and the chair knows what the summaries left out and may restate up to an owner-set number of important omitted points before round 2 and before the ballots (owner idea 2026-10-22): each reminder carries a verbatim quote that must occur in that speaker's full statement, is attributed to the speaker, labeled as a chair reminder, appears in the transcript for everyone and is limited to facts, evidence and conditions and never how to vote, and a reminder whose quote is not in the statement is refused, a chair question to several agents reaches each of them and their answers appear in the transcript, an owner inquiry period pauses the clock and holds an open vote, a voter's answer during a held vote is not delivered to other voters until it closes, no ballot can be cast or revised during the inquiry, an idle inquiry produces a reminder and a Needs-you item, a held vote survives a restart, and a command ends it, the owner's questions are not cut off by the meeting timebox, a reached budget is reported, every present member receives the objection check before the vote opens and an absent member is skipped, a needs-time-to-research answer lets the chair table the motion with no vote and the research becomes owned follow-up tasks and a deferred agenda item, an objection holds the vote until the chair or owner rules, an upheld objection is addressed and the check runs again up to the rerun limit, a member that gives no answer is recorded as no response and does not block, a concern raised in a turn is ruled on by the chair, the owner can overrule any ruling, no challenge vote exists, the controller enforces the mechanical rules without any member raising them, an owner message during an open vote reaches no one until each receives the floor, a voter who cast before that message is offered exactly one revision turn before the vote closes and a revised ballot replaces the earlier one in the tally, an owner message never passes the floor by itself, the vote closes under the stated rule, a chair read of an absent member's desk is read-only, limited to absent roster members of the meeting's project, redacted, recorded and marked unverified in what it reports, a read of a present member's desk or any other desk is refused (including when the chair names a member absent while the controller's state says present), drafts are readable only through this path, access ends when the meeting ends or the chair changes, the absent member receives no message and no wake and its running attempt is not disturbed, an inspection record via meeting-chair appears that the absent member can see, each excerpt carries a source link and revision, access ends when the meeting ends or the chair changes, and a denied inspection policy blocks the read, a chair question with a position field or naming the outcome is refused, a challenged chair question is ruled on, a chair question after the last round triggers a reply turn for every present member, a direct question gives the addressed agent the floor and returns it, a question loop stops at the depth limit, an agent without the floor receives nothing new, an addressed agent receives the full transcript up to its turn, a long meeting needs the owner's setting).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M05b — Prove meeting desk reads are read-only and recorded per file

- **Parent:** N12 / AII-262.
- **Blockers:** M05, C01b.
- **Deliverable:** Adversarial tests of the chair's read of an absent member's desk (owner decision 2026-10-22: tests that the read cannot write and that every file read is logged).
- **Acceptance and verification:** Every file the chair reads leaves its own inspection record (record, revision, time, meeting) that the absent member can see, a missing or partial record fails the read; the read path has no write, rename, delete or lock operation and attempted writes through it are refused and recorded; reads through meetingRead of a present member's desk, another project's desk, or any desk after the meeting ends or the chair changes are refused (shared working notes are readable by the chair through the ordinary path, as C01b says); a chair read of shared working notes (C01b) needs no meetingRead and appears in the record as shared (this check lives here because no meeting chair exists when C01b is built); the absent member is not woken and its running attempt is not disturbed; repeated after a controller restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M06 — Implement meeting procedure, roster, quorum and ballots

- **Parent:** N12 / AII-262.
- **Blockers:** M02, A02, C08, T06, M00.
- **Deliverable:** Fixed eligible roster per meeting, quorum and threshold configuration (defaults: majority quorum, a tie is broken by the chair with no double vote (owner decision 2026-10-22): a chair on the roster who cast a ballot has one ballot and a tie goes to its side, and a chair who is not on the roster or abstained casts a single casting vote only if the vote is tied, recorded as a casting vote; if no chair can cast it the tie fails; exact thresholds and seconding per owner decision), motions with exact wording, scope, rationale, affected tasks and versions, amendments, procedural concerns (the controller enforces the mechanical rules itself; a speaker may raise a concern in its own turn, ruled on by the chair; every present member answers a short objection check (the motion version and a round summary; no, yes with a reason, or needs time to research with what it would look into) before the vote opens, and a motion may be tabled when members need time to research (owner idea 2026-10-22: the chair rules, no vote is held, the research becomes owned follow-up tasks, the motion returns as a deferred item on the next meeting's agenda with its reason and next step (M03), quorum and roster are unchanged, and the owner can overrule the tabling or ask for the vote anyway), an objection holds the vote until the chair or the owner rules on it, an upheld objection is addressed (clarify or amend) and the check runs again, at most an owner-set number of times (default two), after which the chair or owner rules whether to proceed and the remaining objections are recorded as dissent, and a member that fails to answer is recorded as no response and does not block; no challenge vote, dissent is recorded in the speaker's own turn and the owner can overrule any ruling), ballots with reasons cast through the bridge, and owner-present agreement rules (README 509-519, 527, 557-566; pitfalls-and-safeguards 155, 165-169; operational-contracts 99-101).
- **Acceptance and verification:** Duplicate sessions, newly created agents or late roster edits add no votes; without quorum only reports proceed and binding votes are deferred; the owner is not needed for quorum and absence is never approval; each ballot including an abstention carries a short reason and is bound to the motion version; a materially amended motion needs a fresh vote; the summary has an agent, vote and reason table; voting follows two comment rounds (the default; the owner can set the number) in which every present roster member has the floor once per round (an absent member is skipped and recorded; a member who joins before being asked gets its comment turn first), hears the whole transcript up to its turn, and in the second round may check its own desk and bring supporting or opposing information to the group before replying (within the turn, time and spend limits of M05), each ballot is asked of one agent individually and ballots go into a ballot record kept out of the delivered transcript, so no ballot is delivered to another participant while the vote is open (tested: the last voter's delivery contains no other ballot); the owner can read ballots as they arrive, an owner message during an open vote does not pass the floor by itself (owner decision 2026-10-22, the baton rule of M05): it goes into the transcript and each participant receives it only with the floor, so a voter who has not yet cast receives it with its ballot request, and before the vote closes each voter who cast a ballot before that message must be offered one short revision turn (keep or revise, with a reason; at most one revision per owner message, with an owner-set maximum) which gives it the floor and the message; the vote closes when every present member has cast a ballot and all revision turns are finished, or when the vote's time limit runs out; each member's last recorded ballot counts and the results show every original ballot and revision with its trigger; the interface warns the owner before a message sent during an open vote that quotes a ballot; an owner message that materially amends the motion restarts the vote with a fresh round instead of revising, revisions apply to one motion version only, and an owner alternative stays a separate owner decision, not a ballot; an amendment, or a procedural concern that changes the motion, after the comment rounds starts a fresh round and vote; and the tally and the table are revealed together when it closes (owner decision 2026-10-22; no sealed initial positions); quorum cannot change mid-vote; no motion widens permissions or budgets, bypasses cleanup or overrides a recorded owner decision; an adopted in-scope motion is actionable while the owner is absent and an out-of-scope one stays a recommendation; with the owner present the chair asks for agreement, silence leaves the decision pending while unrelated work continues, an owner alternative needs no re-vote, and the vote and the owner's decision are separate records; owner join and leave are durable events, departure authorizes nothing and an outcome already executed is reported accurately on join; tie tests (owner decision 2026-10-22): a chair on the roster who cast a ballot breaks a tie with that single ballot and is counted once; a chair not on the roster casts a single casting vote only on a tie and it is recorded as a casting vote; a chair on the roster who abstained may cast that vote; no casting vote is asked for when there is no tie; a tie fails when no chair can cast it, meaning the chair is absent, has changed during the vote or gives no answer within the vote's time limit; the casting vote shows in the revealed tally.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T01 — Implement immutable tool/skill catalog and attribution

- **Parent:** N13 / AII-263.
- **Status:** implemented; commits `aead5ec`, `084521f`; CI runs 39713762083; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** A durable catalog of skills and tools over the protected naming of the registry: personal (per-agent namespace), shared (toolbox) and system (nimblenewt) layers, every version immutable and identified by a digest over its manifest and the exact instructional and executable sources. A personal registration is accepted only from the registering agent's own accepted original work (another desk's content, copies, drafts and private scratch are refused); a shared or system release is the owner's own separate version, with the author recorded, so a personal edit cannot change it. Revocation falls back to the highest live version. A skill cannot run anything; a tool run needs a grant naming it in the task, and a host that cannot satisfy the manifest (OS, architecture, interpreter, dependencies, CPUs, memory) is told every reason before anything starts; each run is recorded per project (who, exact version, task) and visible only inside that project. Manifest fields are checked one by one and schemas may refer only to themselves. Limits stated: the catalog keeps digests and references, not copies; the host facts must come from the worker's own registration (H12); nothing starts or limits a tool (the worker). Reviewed and approved by an AI review session (Claude Opus) after two rounds; six-cell CI green.
- **Blockers:** F07, A03, C01.
- **Deliverable:** System/shared/personal artifacts and usage records; manifest schema (purpose, input and output schema, entry point, interpreter, OS and architecture, dependency versions, requested access, resource limits, cancellation and recovery behaviour).
- **Acceptance and verification:** Exact instructional and executable versions recorded; personal edits cannot mutate shared release; logs obey audience boundaries; a skill without an executable grant cannot run anything; a tool unavailable on a host reports why before run time; a skill or tool can be registered only from the registering agent's own accepted original work (DeskService.executableSource refuses another desk's content and copies of it).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T02 — Implement review/promotion/deprecation and retention

- **Parent:** N13 / AII-263.
- **Blockers:** T01, A05, L04.
- **Deliverable:** Artifact promotion and paused-task migration.
- **Acceptance and verification:** Revoked artifact cannot execute; stale referenced artifact retained for inspection; merge/deprecation does not break silent resume; revocation applies the configured policy to in-flight operations and a personal fork of a revoked tool gains no authority; non-maintainer publication is refused and rollback to a prior release works.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T03 — Implement approved MCP client connections

- **Parent:** N13 / AII-263.
- **Status:** implemented; commits `f3c3d51`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Approved MCP client connections: owner registration with a pinned protocol revision, launch plan with nothing inherited or a TLS address with a scoped credential reference, catalog snapshots with changed capabilities held until accepted, pinned and recorded calls. Limits stated: the form of a host name is checked, DNS rebinding is refused at connect time by the worker (clause on H12). Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** T01, A01, S05, F09.
- **Deliverable:** Local/remote MCP registration, credential refs and catalog snapshots; connection record (protocol and transport version, trusted administrator, audience, scope, allowed capabilities) covering tools, resources and prompts; supported MCP revision, transport and SDK pin list.
- **Acceptance and verification:** Unapproved server denied; catalog changes rechecked; effect uncertainty and prompt injection fixtures handled; local servers launch through the A03 launcher with only granted environment variables and no inherited secrets and remote servers need TLS and scoped credentials; each call is pinned to server identity, protocol version and catalogue revision or records observation time and uncertainty, checks the lifecycle gate first and appears in task-linked activity with server, capability, outcome and uncertainty for permitted readers; resource reads enter C03 manifests; protected tools work with no MCP server.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T04 — Implement controller-backed MCP state adapter

- **Parent:** N07a / AII-519.
- **Status:** implemented; commits `0df5bc6`; CI runs 39726115373; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The state API through MCP: JSON-RPC adapter with tools generated from the operation table, resources for projects and tasks, the same authentication, scoping and idempotency as every other client. No transport framing yet. Reviewed and approved by an AI review session (Claude Opus); full six-cell CI green.
- **Blockers:** U01, T03.
- **Deliverable:** Scoped resources and revisioned state operations.
- **Acceptance and verification:** Same admission and privacy as native API; reconnect cannot duplicate state mutation; unsupported protocol fails clearly.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T05 — Implement MCP durable conversation adapter

- **Parent:** N10a / AII-520.
- **Blockers:** U02, U02b, T04.
- **Deliverable:** Two-way conversation tools with stable IDs/cursors.
- **Acceptance and verification:** Both initiation directions survive reconnect; no duplicate turns or cross-scope leakage; protocol session not task owner; a protocol-version upgrade preserves thread IDs, cursors and audit history.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T06 — Implement the protected agent tool bridge and execution service

- **Parent:** N13 / AII-263.
- **Status:** implemented; commits `cd135e7`; CI runs 40390419891; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** The protected agent tool bridge and the controller-side execution service; starting it inside a composed worker is T06b.
- **Blockers:** H12, T01.
- **Deliverable:** Protected Pi Durable extension loaded at worker start exposing stable NimbleNewt tools (desk access, task updates, communication, tool discovery, description and invocation; meeting ballots, job control and environment-maintenance requests are added by M06, T07 and A09) through the reserved namespace and wire-name mapping, and a controller-side execution service that validates structured arguments against the manifest and checks permission, budget, platform compatibility and revocation (README 279-285, 309, 319-335).
- **Acceptance and verification:** A script tool is created, registered and used in one conversation without a worker reload; new declarations appear at the next model-request boundary and never in a request already in flight; descriptions are fetched on demand, not loaded into every prompt; an active call finishes on its version while the next call uses the new one; a revoked version is refused at invocation despite a stale tool list; excessive permissions denied; model-supplied text is never concatenated into a shell command; the extension holds only the worker's scoped credential and no admin methods, and a tampered in-process extension cannot exceed the worker's grants or call services directly; personal extensions cannot disable or shadow the bridge; the replay-safe or idempotent flag comes only from the controller-approved manifest; restart recovery verified.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T06b — Wire the protected bridge into the composed worker across a process boundary

- **Parent:** N13 / AII-263.
- **Blockers:** T06, H12b, H12c.
- **Deliverable:** The worker runtime factory starts every worker with the bridge extension over a bound transport to the tool execution service across a process boundary, backs the script runner with the sandbox launcher and its limits, and opens request-boundary declarations.
- **Acceptance and verification:** The worker process holds only its task credential and loads no controller module, and a tampered extension in the real worker process cannot reach controller services; a tool registered during a turn appears only at the next request boundary of a real Pi turn (declarations opened and closed per request, with the descriptions in the volatile context); the replay-safe answer is passed to the dispatcher; scripts run through the A03 launcher with arguments and model text as data on stdin, an empty environment, the manifest limits enforced (A08b) and output capped by the launcher; a script over its output or time limit fails and is recorded; an agent's own namespace grant exists from enrolment; call IDs are unique within an attempt (a provider ID that repeats cannot replay an earlier write); a remote (H02) attempt either reaches the bridge through a protocol endpoint or is refused bridge catalogue calls.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T07 — Implement durable job records and job control

- **Parent:** N13 / AII-263.
- **Status:** implemented; commits `d2ffdb6`, `4ad8d5e`; CI runs 40411682946; record [implementation-notes.md](implementation-notes.md).
- **Progress note:** Durable job records and job control with the restart, stop, Force Stop and outcome-unknown rules; running the restart decisions at controller start and relaunching from a checkpoint is T07b.
- **Blockers:** T06, S05.
- **Deliverable:** Job records for long-running local and remote operations with their own state machine (admitted through outcome-unknown) and resumability class, durable handles with status, cancellation and tool checkpoint where supported, bounded output, logs and artifacts (README 321, 333; operational-contracts 21, 39, 47, 75; portability-and-configuration 29).
- **Acceptance and verification:** A long-running job returns a durable handle that survives worker and controller restart; operation ID, exit status, bounded output, logs and artifacts are recorded; a job record does not imply resumability; cancelling a model request, stopping a tool and stopping a remote job are separate recorded operations; on restart a live job is completed, cancelled, restarted from a tool checkpoint or recorded as a tracked exception; Pause keeps permitted background jobs running and records their results without unpausing; Stop and Force Stop terminate the whole process tree (job objects on Windows, process groups on POSIX) and orphaned children are reported; long-running MCP operations use the same records and a revoked connection blocks new calls.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T07b — Give agents job control through the tool bridge and bind jobs to the sandbox, the MCP client and the API

- **Parent:** N13 / AII-263.
- **Blockers:** T07, T06b, H12g.
- **Deliverable:** Split from T07 (2026-10-26): the job records, their states, stop operations, restart decisions and unknown-outcome reconciliation are built as a service; what is not built is the agent's way to use them and the production bindings. The bridge gains job tools (start a job, status, bounded output, cancel) with the call ID as the idempotency key, the sandbox launcher's process-tree stop and orphan report are bound to the stop confirmation, the MCP client uses the job records and the connection check (`McpService.usable`), and the state API reads jobs.
- **Acceptance and verification:** An agent starts a long-running job through the bridge and gets a durable handle; status, bounded output and cancel work from the handle after a worker or controller restart; a Stop or Force Stop through the real launcher ends the whole process tree and the orphans it could not end appear on the job record; a long-running MCP operation is a job and a revoked server admits no new one; the owner can read jobs, live jobs and unresolved outcomes through the API; every restart decision of T07 is reachable by the owner and a supervisor; when the controller starts, the live jobs are listed and each gets a decision by a stated rule for its class (a tool with a checkpoint is relaunched from it through the dispatcher, a tracked remote job is followed or kept as an exception, anything else is recorded as outcome-unknown or stopped), so no live job is left without one; a Stop and a Force Stop through the real launcher are the two recorded steps of the job service.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T08 — Implement shared toolbox audiences, personal copies and patch proposals

- **Parent:** N13 / AII-263.
- **Blockers:** T02, T06, M02, U08.
- **Deliverable:** Scoped toolbox.manage permission tied to identity, audiences (role, team, project, all agents), /toolbox.* entries, read-only source inspection, personal copies with provenance, improvement proposals and maintainer decisions, platform compatibility in the catalogue, configured through the U08 views or chat (README 297-315, 627; pitfalls-and-safeguards 21-23; runtime-compatibility-and-namespaces 32-34).
- **Acceptance and verification:** The README 313-315 validation list passes (unauthorized publish or edit fails, eligible agents discover, excluded roles cannot invoke, edits to the original leave the shared release unchanged, survives author rename or retirement, update, revoke and rollback, escalation attempts fail, source inspection needs no manage permission, writes to a published artifact denied, a patch against an older base is rebased and rechecked, no private desk, history, credential or path exposure); a copy registers under the agent namespace with source tool ID, base version and digest, inherits no credentials or approvals and never shadows /toolbox.*; consumers stay on their pinned version until they opt in; deferred proposals are not listed as available; a meeting vote alone neither publishes nor grants toolbox.manage; toolbox.manage cannot touch protected commands; fork lineage is recorded so revocation notices reach forks; an accepted proposal (a suggestion, not an instruction) never authorizes a downstream push, merge or deploy.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T09 — Implement command namespaces and alias dispatch

- **Parent:** N13 / AII-263.
- **Blockers:** T06, H11, U03.
- **Deliverable:** Command dispatcher over the F07 registry: /nimblenewt.*, /toolbox.*, canonical /a_<id>.* agent prefixes and optional context-bound /agent.* and /custom.* aliases, resolved and bound before queuing, with UI actions and tool calls mapped to the same operation (runtime-compatibility-and-namespaces 13-28, 56-58; README 269).
- **Acceptance and verification:** The runtime-compatibility 56-58 cases pass; queued work stores the resolved canonical target; an ambiguous alias stays unresolved and asks; aliases resolve only in their bound context; renaming an agent changes no canonical command or record; operation ID, schema version, owner, revision and display name are kept separate; lowercase grammar with normalized or encoded collisions rejected and no last-installed-wins; agents cannot claim /nimblenewt.* or /toolbox.*; the provider wire-name mapping stays collision-free per provider.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P01 — Implement repository-independent projects and responsibilities

- **Parent:** N14 / AII-264.
- **Blockers:** U03, S01.
- **Deliverable:** Project/resource binding and ongoing responsibility records; optional workstreams, milestones and due dates and authorized participants on the project record.
- **Acceptance and verification:** Start project in chat then bind two repos and non-code output; internal state stays outside target repos; passing a due date changes no progress state; one repository bound to two projects with separate access scopes; a moved or same-named checkout does not redirect a task.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P02 — Implement isolated coding workspaces and integration

- **Parent:** N14 / AII-264.
- **Blockers:** P01, A04, L04, Y02, H12.
- **Deliverable:** Worktree/workspace adapter and integration contract.
- **Acceptance and verification:** Dirty/untracked work survives interruption; conflicting integration revalidates evidence; no metadata pollution of target checkout; the task workspace admits only repositories in the task's access scope and records the initial working state; an accepted proposal (a suggestion, not an instruction) never authorizes a downstream push, merge or deploy.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P02b — Implement optional work-in-progress branch backup (after the first release)

- **Parent:** N14 / AII-264.
- **Blockers:** P02, A06, A07, F09.
- **Deliverable:** Optional, off by default (owner decision 2026-10-22): regularly commit and push an agent's uncommitted workspace changes to a dedicated work-in-progress branch namespace on a remote the owner configured, so unfinished work does not live on one machine only.
- **Acceptance and verification:** Off unless the owner turns it on per project by chatting with the supervisor, which records one standing owner approval (A07) scoped to exactly that remote and that project's work-in-progress namespace, revocable, so scheduled pushes need no per-push approval and any push outside that scope takes the normal approval path; pushes never go to a protected or target branch; each commit is made from a temporary index in the controller's own git directory with the controller as committer and the A06 identity trailers (Developer, Executor, NimbleNewt-Task) plus NimbleNewt-WIP: unreviewed and never the Reviewed-by or Reviewed-via trailers, so the agent's index, branches and authorship are untouched; work-in-progress commits are never merged, integrated or treated as reviewed work (integration still goes through A06 and P02); before each push the files are scanned for credential patterns (redaction), the F09 secret values in use and known key formats, and a blocked file is left out and reported; a restore of the workspace from the branch matches the last successful push; a failed push is reported and never counted as a backup.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P03 — Implement non-code and sandbox operations adapters

- **Parent:** N14 / AII-264.
- **Blockers:** P01, T01, S05, Y02, H12.
- **Deliverable:** Research/documentation/design deliverables and simulated service operations.
- **Acceptance and verification:** Non-code task produces accepted artifact; operational effect records verified target; scoped repair cannot affect collateral service.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P04 — Implement ongoing responsibility checks, incidents and coverage

- **Parent:** N14 / AII-264.
- **Blockers:** P01, S08, H13, V01, L03.
- **Deliverable:** Responsibility records with managed resources, desired condition, availability need, check schedule and event sources, permitted actions, maintenance windows and escalation rules; deterministic check scheduler; observation and incident records; per-resource maintenance leases (README 110-118; organization-and-workers 19, 66-67; portability-and-configuration 9).
- **Acceptance and verification:** Each check produces a bounded task or a recorded observation, calling an agent only when interpretation or action is needed; checks are generated idempotently and survive host restart; intended state, observed state, last successful check and open incidents stay distinct and "no recent observation" is never shown healthy; repeated alerts group into one incident with bounded retries and escalation, preserved through restart; provider outages and NimbleNewt downtime show as coverage gaps with start, end and reason, and missed events are reconciled on return; a second agent's update to the same resource blocks visibly on the lease; failed validation triggers authorized rollback or escalation, both recorded; Suspend checkpoints the responsibility without stopping the managed service and Suspend and Release names the new monitor owner; pausing the maintenance agent keeps queued alerts and ownership; a remote host is managed through an approved tool with no worker enrolled on it.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P05 — Implement external contribution and pull-request workflow

- **Parent:** N14 / AII-264.
- **Blockers:** P02, A06, A07, T03, F09.
- **Deliverable:** Contribution adapter (push, open and revise PR or MR, read review and CI status) behind separate action scopes, repository-instruction discovery, pre-submission diff check and linked multi-repository change sets (README 229-233, 645, 668; organization-and-workers 27-29, 64; pitfalls-and-safeguards 149).
- **Acceptance and verification:** Existing contribution guides and instruction files are discovered and applied without adding NimbleNewt conventions; the checkout's starting state is recorded; an automated diff check blocks unrelated files, NimbleNewt state, ignore-rule edits and secrets before commit or PR; the requested PR contains only intended files and keeps unrelated local work; a local edit grant does not permit push, PR or merge, and owner approval does not bypass branch protection or CI; revision after review comments works; attribution is accurate; each push and PR is an effect-ledger operation; a multi-repository change set records review order, shows partial completion and is resumable, never treated as atomic.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P06 — Implement project and agent retirement and archival

- **Parent:** N14 / AII-264.
- **Blockers:** P01, H11, L03, K06.
- **Deliverable:** Retirement commands for projects, agents and responsibilities that release resources, revoke execution access and archive records (README 611; operational-contracts 91).
- **Acceptance and verification:** Archived records stay searchable under the same access rules; active resources, leases and worker slots are released; execution grants and credentials are revoked; retirement is refused while live assignments remain unless they are released or transferred first; a retired agent's ID is never reused and its records are retained per the retention policy; an archived project can be restored.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P07 — Implement simulation mode

- **Parent:** N14 / AII-264.
- **Blockers:** P03, R02, T03.
- **Deliverable:** Isolated simulation scope where a workflow runs against simulated tools, events and providers before real write access is granted (README 612, 245).
- **Acceptance and verification:** A workflow runs end to end against simulated tools and events including provider failure and competing edits; no real write, send or spend is possible in the scope (asserted against the effect ledger); results are labelled simulated; the owner grants real access separately; replay reruns use the same isolated scope.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q01 — Implement deliverable submission and acceptance

- **Parent:** N15 / AII-265.
- **Blockers:** S06, U01, P02, P03, S10.
- **Deliverable:** Versioned output records and review state.
- **Acceptance and verification:** Tool completion alone cannot accept task; missing/changed artifact invalidates review; rejected version history retained; draft, submitted, under-review, accepted, rejected and superseded are distinct versioned events; the deliverable records type, responsible agent, audience and access scope; an operational outcome can be a deliverable with verifiable reference, system version and observation time; source and exported artifacts can be grouped under one version; submission is checked against the task contract revision in force (S10).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q02 — Implement independent QA and dependency-bound evidence

- **Parent:** N15 / AII-265.
- **Blockers:** Q01, A06, C03, H05, C08.
- **Deliverable:** Self-check/QA records and stale-evidence propagation; review policy (scope, triggers including periodic and incident, required checks, whether independent review gates completion) and a project QA view.
- **Acceptance and verification:** Reviewer inspects actual version; changed dependency invalidates affected test/review; role title grants no access; a verdict cites the current acceptance-criteria and decision revisions and a rejection must cite an unmet owner requirement; a team vote cannot override an owner decision and work bound to a superseded decision fails review (C08); findings record environment, criteria revision and time; passed, failed, blocked and not-run are distinct and absent evidence fails the gate; invalidation schedules revalidation; independent evidence is counted by original source (DeskService.independence): a copy and the original are one source.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q03 — Implement documentation impact and release evidence links

- **Parent:** N15 / AII-265.
- **Blockers:** Q02, C02.
- **Deliverable:** User/developer documentation obligations and traceability.
- **Acceptance and verification:** Behavior change links required doc updates to tested artifact; no unsupported marketing capability claims; doc obligations record owner, applicable version, implementation references and validation status and stale or unverified docs are flagged; the impact check creates assigned update tasks; a release change flags linked docs, support guidance and promotional assets.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q04 — Implement defect tracking, review cycles and overrides

- **Parent:** N15 / AII-265.
- **Blockers:** Q02, C08.
- **Deliverable:** Defect records (severity, evidence, responsible agent, resolution), bounded repair and review cycles, escalation of unresolved disagreements and explicit owner override records (README 122-136).
- **Acceptance and verification:** A defect links to the version and finding; after the configured number of repair and review cycles it escalates to the owner; an owner override records the decision and the remaining findings and a failed check is never rewritten as passed; a QA agent that commits a fix becomes a contributor and cannot approve it; periodic and incident-triggered reviews run without interrupting contributors; chat answers what has been checked, what waits for QA and team-wide risks with evidence links.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B01 — Implement production/improvement budget admission

- **Parent:** N16 / AII-266.
- **Blockers:** H03, R02, Q01, Y03, R05.
- **Deliverable:** P/PC accounting, reservations and limits; category on the task contract; occupied worker-slot time as accounting basis (R05).
- **Acceptance and verification:** Reflection/experiments/monitoring charged; production review remains P; no quota busywork or catch-up debt; a continuous backlog of either kind cannot starve the other; approved PC work gets reserved capacity within its wait bound while P keeps its protected share under PC spend and concurrency ceilings; unused PC lends to P with a reason and is reclaimed at safe boundaries without ownership change; emergency borrowing needs explicit direction with reason, scope, expiry and review and repeated urgency cannot remove the floor; paused or suspended work is never woken to meet a quota; an unmet reservation is reported with its cause; relabeling or delegation cannot move spend; an expiring override survives restart; chat answers what was delivered and whether improvement was starved, and an allocation change by chat is a revision applied to pending dispatch only; external campaign spend limits are enforced.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B02 — Implement observations and provenance deduplication

- **Parent:** N16a / AII-615.
- **Blockers:** B01, H06, C01.
- **Deliverable:** Controller-generated correction/failure/recovery/friction observations; agent-submitted friction and improvement proposals with owner and disposition; approval stalls, redundant prompts and failed reviews as observation sources.
- **Acceptance and verification:** Duplicate retellings count once; cross-scope data remains restricted; rate limits prevent candidate storms.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B03 — Implement versioned lessons and triage

- **Parent:** N16a / AII-615.
- **Blockers:** B02, T01.
- **Deliverable:** Applicability, dependency, contradiction and supersession records; project improvement backlog linked to meeting agenda items.
- **Acceptance and verification:** Independent evidence distinguishable; stale premises trigger review; rejected/inconclusive candidate can finish; the evaluated outcome is reported to the proposer.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B04 — Implement bounded baseline experiments

- **Parent:** N16a / AII-615.
- **Blockers:** B03, Q02, A08.
- **Deliverable:** Pinned baseline/evaluator and separate evaluation cases.
- **Acceptance and verification:** Candidate cannot alter its own criteria/authority; negative result saved; budget exhaustion pauses/defer safely; candidates run in a disposable environment (A08) and are compared with the baseline; proposals record problem, affected work, change, effort, running cost, benefit, evaluation and stopping condition; metrics cover time to accepted result, rework, cost per success, adoption and maintenance without double-counting savings.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B05 — Implement scoped adoption and monitored withdrawal

- **Parent:** N16a / AII-615.
- **Blockers:** B04, T02, L04.
- **Deliverable:** Adoption grants, monitoring triggers and withdrawal reconciliation.
- **Acceptance and verification:** Regression stops future use; paused dependencies reconciled; completed external effects not falsely undone; restart every transition; adoption needs an existing grant and independent review; a finished PC task does not publish a shared tool.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B06 — Implement optional agent work on NimbleNewt itself (off by default, asked ahead, owner-approved launch)

- **Parent:** N16a / AII-615.
- **Blockers:** B05, A10b, A08, K02, C09, H05.
- **Deliverable:** An optional feature that is off by default (owner decision 2026-10-22; the documents already call this workflow optional): the owner enables a NimbleNewt development project in an installation. When it is enabled an agent must first ask to work on NimbleNewt's own code, with a short request (what, why, expected effort and cost), and the owner approves before any work starts, so no effort is spent on work the owner does not want; approved work happens in a separate project with its own checkout. An agent can never launch, install or switch the running installation to what it built: that needs the owner's approval of a launch proposal that carries a detailed plain-English explanation of what was done and why (the problem, what changed, the evidence and tests, the risks, how to go back, and what the owner must decide), reviewed first through the independent review path (H05). Agents building and changing their own tools stays as it is and is outside this card (T01, T02, T08).
- **Acceptance and verification:** With the feature off, a request to work on NimbleNewt's own code is refused with a message saying the owner can enable it; with it on, no work starts without an approved request and the approval can be withdrawn; a launch proposal cannot be submitted without the explanation and the explanation cannot be edited after submission (a change makes a new proposal); the approval names the exact revision and any change to the code invalidates it; an agent in the NimbleNewt project holds no authority over the installation, updater or its own launch (X02); candidates run only in a disposable environment (A08) until approved; the owner can ask questions about a proposal and see the decision-explanation and activity records (C09); a rejected proposal can be reopened with a changed explanation; the installation step is recorded and reversible by the previous revision (K02); an agent cannot satisfy the independent review of its own proposal or of a proposal by an agent it supervises, and only the owner approves; creating or changing an agent's own tools and skills works with the feature off.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K01 — Implement consistent backup and restore

- **Parent:** N17 / AII-267.
- **Blockers:** S06, F04, L02, S05.
- **Deliverable:** Both-backend manifested backup/export and restore runner including Pi state; nightly backups retaining 7 daily and 4 weekly copies plus pre-upgrade snapshot, and a 'back up now' command; first-release backup is this simple built-in one (owner decision 2026-10-22), the configurable system is K01c.
- **Acceptance and verification:** Portable recovery folder from consistent database snapshots and Pi/artifact manifest; coordinate maintenance barrier across stores; restore into empty install verifies artifacts/versions; separate secret recovery (secret values go into a backup only when encrypted backup K01b is on); uncertain later effects not replayed; interrupted backup never labeled complete; never sync live SQLite files as backup.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K01b — Implement encrypted backups with passcode and recovery-file unlock

- **Parent:** N17 / AII-267.
- **Blockers:** K01, F09.
- **Deliverable:** Public-key encrypted, authenticated backups (first release; owner decision 2026-10-22). Encrypted backup is off by default; when the owner turns it on the scope is 'secrets only' (the rest of the backup stays plaintext) unless they choose 'everything'. Each backup carries its key ID and, inside itself, the private key wrapped once per unlock method that existed when it was made: a passcode (Argon2id), a downloadable recovery file or printable recovery code, and any extra passcodes. The server keeps the public key and the wrapped copies, never the private key at rest.
- **Acceptance and verification:** Turning it on requires proving the recovery file unwraps a private key that matches the server's current public key; either a passcode or the file alone restores on a new machine from the backup alone; every backup uses authenticated encryption and is signed by a backup-signing key the server holds for unattended use (in the F09 secret store, not wrapped by a passcode), and a restore verifies the signature against a signing public key it already trusts (carried by the recovery file or the owner's records for each key generation, never taken from the backup being checked) and says plainly that authenticity is only as strong as the running server, because a compromised server can forge backups; the owner may also keep a manifest digest off the server as a stronger check for backups they export by hand; a stolen backup, or the server's backup-key material (public key and wrappers), cannot decrypt any backup without a passcode or the file; the server holds the unwrapped private key only in memory for one operation, never on disk, and says so (it sees the passcode at that moment); minimum passcode strength and Argon2id parameters (at least 64 MiB memory) are enforced and stored with each wrapper so they can be raised; a recovery code carries at least 128 bits; removing or replacing a passcode (for example after exposure) rotates the keypair, so later backups use a new key and the removed passcode opens only older backups, which the owner is told; each old key generation's wrapped key and recovery file are kept until the last backup under it has expired; a rotation issues a new recovery file or code and requires proving it as at setup; switching encryption off, narrowing the scope or replacing the public key is owner-only, recorded and announced (U11); every three months the system asks the owner to prove a passcode or the file still works; no passcode hints; losing every unlock method is stated plainly at setup (secrets only: secrets lost, the rest restores; everything: the backup is unreadable); a scheduled backup runs unattended.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K01c — Implement the full configurable backup system (before 1.0)

- **Parent:** N17 / AII-267.
- **Blockers:** K01b, K06, U11.
- **Deliverable:** Owner-configurable backups before 1.0, not needed for the first release: targets (local folder, other disk, off-machine), schedules, retention counts, verification restores and failure notifications, all settable by chatting with the supervisor (owner decision 2026-10-22).
- **Acceptance and verification:** a backup is deleted once it falls outside every count rule (7 daily, 4 weekly by default) or is older than an owner-set number of days (default about 35, which is what the counts give), except that the newest backup verified complete is never deleted by age and neither is a pre-upgrade snapshot while K03's rollback period needs it; if the newest good backup is older than the limit the owner is told (U11) because backups are failing, and a test shows that no new backup for longer than the limit leaves the last good one in place with a notice; changing a count or the age limit so that one overrides the other is said back to the owner; the owner can purge named backups sooner: a purge is owner-only and recorded, warns and asks for confirmation before it would delete the last good backup, covers every copy on every target (another disk, off-machine), reports each target's result, and keeps an unreachable target listed as not yet purged and retried; the delete confirmation says how long the item stays in backups, by target if targets keep backups for different times; once a key generation's last backup has expired or been purged its wrapped key and recovery file may be deleted and the owner is told the old recovery file no longer opens anything (K01b); deleting a project or record does not alter existing backups and the delete confirmation says how long it will remain in them; a backup target can be added, tested and removed by chat; a failed or missed backup notifies the owner; a periodic test restore proves a backup is usable; counts and schedule changes are owner-only and recorded; secrets and the encryption scope follow K01b.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K01d — Implement backup scope tiers (optional, after the first release)

- **Parent:** N17 / AII-267.
- **Blockers:** K01c, K06b.
- **Deliverable:** Optional: leave bulk records out of backups by age and kind (for example logs, scratch output and transcripts of tasks finished more than an owner-set time ago), set by chatting with the supervisor (owner decision 2026-10-22; backup scope is separate from live retention).
- **Acceptance and verification:** Off by default; audit and decisions are always included, as is anything a resumable task or replay still references; a restore reports what was left out by scope rather than looking complete; the live system's retention is unaffected; a scope change is owner-only and recorded.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K02 — Implement deterministic release staging and activation

- **Parent:** N17 / AII-267.
- **Blockers:** K01, F02, T02.
- **Deliverable:** Signed/verified exact artifact staging and maintenance policy; separate deterministic launcher and updater with current and candidate directories, a durable update journal and a last-known-good record; release-management permission distinct from toolbox.manage.
- **Acceptance and verification:** Model cannot replace updater authority; failed startup preserves compatible known-good path; maintenance scope enforced; authorization is bound to digest, migration plan and target installations; an interruption resolves to old or new, never mixed, on macOS, Linux and Windows; running executables are never overwritten and a routine release cannot replace the launcher; a supervisor role alone cannot change protected extensions; controller-worker protocol compatibility is checked before activation and rollback is tested against mixed versions; an agent-built candidate of NimbleNewt itself cannot stage or activate itself; Pi runtime changes follow G11.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K03 — Implement migration recovery and rollback limits

- **Parent:** N17 / AII-267.
- **Blockers:** K02, G03.
- **Deliverable:** Migration journal, compatibility checks and recovery guide.
- **Acceptance and verification:** Interrupted migration recovers; incompatible schema downgrade blocked; restore distinguishes external effects since snapshot; a defined rollback period with additive schema; code rollback only to a tested compatible pair; destructive migrations deferred; the watchdog distinguishes release defects from provider or host failures; health thresholds and probation are configurable and a rollout can be stopped.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K04 — Implement selected standby replication and recovery watermarks

- **Parent:** N17 / AII-267.
- **Blockers:** K01, K03, H09, Y03.
- **Deliverable:** SQLite recovery and native PostgreSQL replication/promotion integration plus artifact/workflow recovery manifest.
- **Acceptance and verification:** Distinguish database failover from controller promotion; test configured synchronous/asynchronous loss behavior, writable-primary reconnection and uncertain commits; no custom PostgreSQL replication protocol; measure lag and loss window; missing blobs or workflow state prevent unsafe promotion; backups remain independently restorable; replicated standby is an optional installation capability with controlled promotion.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K05 — Implement fenced primary promotion and recovery chat

- **Parent:** N17 / AII-267.
- **Blockers:** K04, U06.
- **Deliverable:** Authenticated external recovery endpoint and epoch transition.
- **Acceptance and verification:** Old primary demonstrably fenced before promotion; returning host cannot dispatch; workers stay stopped until reconciled; independent recovery login/authorization works with primary and model unavailable; owner consent cannot bypass fencing; no NimbleNewt-managed automatic controller failover in first release; qualified externally managed PostgreSQL database failover does not authorize another controller.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K06 — Implement retention, quotas, archive, export and deletion

- **Parent:** N17 / AII-267.
- **Blockers:** K01, S06, C02, C06b.
- **Deliverable:** Retention, export and deletion policy and runner covering derived data (summaries, indexes, caches) and backups, per-agent and per-project storage quotas, and reserved capacity for shutdown and recovery records (operational-contracts 129; pitfalls-and-safeguards 125; README 247, 641; design-decisions 73); stored model thinking (C06b) is deleted 14 days after the task is done, the same as the default cleanup deadline (owner decision 2026-10-22); for conversations that are not tasks (chat) only the words actually said are kept as the durable log, and thinking is held only as long as the live conversation needs it to resume (owner decision 2026-10-22; the last clause is provisional, an AI session's gap-filler to confirm).
- **Acceptance and verification:** Material referenced by a resumable task or by replay is never deleted and shows as retained; a user-requested deletion removes or marks derived summaries, indexes and cached replies and records how backups are handled; export excludes secrets; archived work restores; with the disk near full the next checkpoint and shutdown and recovery records still write and a disk-full checkpoint is never reported successful; quotas enforced with visible warnings; retention configurable, and the owner changes any retention value by chatting with the supervisor (owner-only, recorded, confirmed back with the old and new value; owner decision 2026-10-22); deleting or archiving a source carries to its derived copies, summaries, indexes and embeddings, which keep their source project and origin (A10); stored thinking is deleted at the cleanup deadline, a deletion is recorded, and a task cannot resume after its thinking is deleted without the provider-invalid handling of C06b; chat keeps the words said and drops thinking when the live conversation no longer needs it.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K06b — Implement tiered retention (optional, after the first release)

- **Parent:** N17 / AII-267.
- **Blockers:** K06, C02.
- **Deliverable:** Optional tiered retention: per-kind tiers (for example keep audit and decisions forever, expire bulk logs, scratch output and old transcripts after owner-set ages, optionally archive before expiry), set by chatting with the supervisor (owner decision 2026-10-22; provisional-defaults Retention).
- **Acceptance and verification:** Off by default so nothing is deleted unless the owner enables a tier; audit and anything a resumable task or replay references is never expired; an expiry shows what it will remove before it runs and records what it removed; a tier change is owner-only and recorded; archive then restore returns the original; derived copies follow their source (K06).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K07 — Implement maintenance windows and update orchestration

- **Parent:** N17 / AII-267.
- **Blockers:** K02, K01, L06, U11, G05.
- **Deliverable:** Maintenance windows (timezone, duration, scope, channel, exact version, authorization, preparation limits, health deadlines, rollout status, rollback eligibility, failure history) set via chat and UI, and the Prepare, Quiesce, Checkpoint, quarantined Activate, Verify and Commit-or-revert sequence (maintenance-and-updates 3-44).
- **Acceptance and verification:** A delayed window never deploys at an unrelated time; Prepare verifies the artifact, tests migration on an isolated copy with fake services and checks space; Quiesce uses Suspend without release and defers and reports rather than silently Force Stopping; input acknowledged during downtime is kept in an independent compatible inbox or unavailability is reported; activation is quarantined with dispatch and effects disabled and a single writer; verification runs startup, registration, a local admin request and a fake task, checkpoint and restore cycle; revert terminates the candidate process tree, restores state and verifies the old release; an updater crash or reboot recovers from the journal; a failed artifact is quarantined with no update/rollback loop and the owner is notified; both releases failing enters bounded recovery mode; cancelled maintenance clears only its own gates; the maintenance-and-updates 44 fault matrix passes on macOS, Linux and Windows; a new macOS release triggers a re-run of the G05 macOS cases before the macOS launcher keeps advertising capacity (G01 decision 2026-10-21).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X09 — Implement external release-test job protocol

- **Parent:** N18 / AII-268.
- **Blockers:** H07, H09, F03, S06.
- **Deliverable:** Immutable release candidate matrix, deterministic job payload and result schema.
- **Acceptance and verification:** Hash/source/suite mismatch rejected; interrupted attempt not pass; no model needed for test execution; restricted test workers cannot approve release.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X10 — Run partition and remote-worker safety campaign

- **Parent:** N18 / AII-268.
- **Blockers:** X09, H10, K05, G08.
- **Deliverable:** External-observer disconnect, watchdog and failover evidence.
- **Acceptance and verification:** Cover idle/stream/tool/external-effect loss, delayed renewal, host sleep, supervisor crash, replica lag and old-primary return; measure hard stop; no dual authority; test lagged revocation/receipt and rolled-back epoch, database-only failover with live controller, historical restore and missing Pi artifacts; quarantine ambiguous recovery.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X01 — Run integrated crash and handoff campaign

- **Parent:** N18 / AII-268.
- **Blockers:** S09, V02, H02, Q02, K03, G04, H12, T07, K06, L06.
- **Deliverable:** Fault matrix with trace IDs and reproducible results.
- **Acceptance and verification:** Every persistence boundary tested; duplicate/delayed delivery, disk errors, stale worker and lost wakeup accounted for; no silent stuck state.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X02 — Run policy, isolation and adversarial campaign

- **Parent:** N18 / AII-268.
- **Blockers:** A06, U04, T05, Q02, G05, A07, A09, A10, T08, T09, P05, H05b, A10b, M05b, B06, H12i.
- **Deliverable:** Scope/revocation/escape/injection and review-race evidence.
- **Acceptance and verification:** Alternate shell/tool/MCP/API paths cannot bypass grants or human gate; reviewer outage cannot authorize work; a project named NimbleNewt gains no authority over the installation or updater; no outbound telemetry, issue, PR or report leaves without explicit scoped authorization (network capture); agent B cannot reach suspended agent A's scratch through file paths, search or artifact links, repeated after restart and harness change; an agent in the NimbleNewt project cannot launch, install or activate a candidate by any path (shell, MCP, API, updater) without an owner-approved proposal for that exact revision.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X03 — Run chat-only complete product workflow

- **Parent:** N18 / AII-268.
- **Blockers:** U05, U06, U07, M02, P03, Q03, B05, K03, C06, L05, G09, C07, U09, U11, U12, U13, M03, M05, M06, R03, R04, P04, P06, P07, Q04, U08, H13, L06.
- **Deliverable:** Recorded scenario from project creation to accepted delivery and recovery.
- **Acceptance and verification:** All administration accomplished through chat; direct API edit coexists; interruption and restart retain progress; meetings/learning/operations exercised; at each step from assignment through tool use, pause or worker loss, handoff, submission, review and completion, chat, project view and API report the same owner, activity, blocker and delivery state and stale or uncertain is never shown complete; the README 651 meeting scenario set passes; routing by difficulty, a queued advice exchange and an event-triggered task are exercised.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X04 — Qualify fresh macOS release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported macOS.
- **Acceptance and verification:** Full accepted scenario passes on exact build; containment limits explicit; no development-directory dependency; with each optional integration (local inference, MCP server, remote worker, cache backend) absent or failing, core lifecycle, chat and recovery still work and report it unavailable; core runs with optional adapter packages not installed; the controller runs as the chosen background service and planned OS shutdown is distinguished from a crash; UI settings persist across restart; clean uninstall leaves no service registration or data outside chosen folders and common setup needs no single-platform tooling.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X05 — Qualify fresh Linux release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported Linux.
- **Acceptance and verification:** Full accepted scenario passes on exact build; remote topology if selected verified; no developer credentials required; same optional-integration, service, settings and uninstall checks as X04; two distinct deployments configured from a release extract with no source edits.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X06 — Qualify fresh Windows release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03, G06.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported Windows.
- **Acceptance and verification:** Full accepted scenario passes on exact build; path/locking/process semantics exercised; no platform skips; same optional-integration, service, settings and uninstall checks as X04.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X07 — Measure load, inquiry latency and budget behavior

- **Parent:** N18 / AII-268.
- **Blockers:** X04, X05, X06.
- **Deliverable:** Benchmarks separating controller, model and tool latency.
- **Acceptance and verification:** Approved workload and resource envelope met; bounded review capacity under saturation; compare side inquiry with queued handoff using equivalent cases; report reconstruction count, retention and resume-correctness checks, accepted-result rate, time and cost for equivalent cases.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X08 — Run representative soak and independent release audit

- **Parent:** N18 / AII-268.
- **Blockers:** X07, X10, F04e, G10, K07, G11.
- **Deliverable:** At least 72-hour soak, incident log and requirement evidence matrix.
- **Acceptance and verification:** Injected faults during mixed work settle; no unresolved severe correctness/security defects; independent reviewer verifies all accepted requirements.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D01 — Finish installation and chat-first user guidance

- **Parent:** N19 / AII-269.
- **Blockers:** X03, Q03, U11b.
- **Deliverable:** Public docs, examples and model-independent recovery guide.
- **Acceptance and verification:** Fresh user completes representative chat flow from guide; policy scope and trusted-host limitations understandable.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D02 — Finish developer/API/security and license guidance

- **Parent:** N19 / AII-269.
- **Blockers:** T05, K03, F03.
- **Deliverable:** Architecture, contribution, protocol, troubleshooting and notices.
- **Acceptance and verification:** Examples match current API; dependencies/licenses inventoried; security reporting and compatibility support documented; documents flush guarantees for process crash, orderly shutdown and power loss, and the rule that a non-TypeScript component needs a recorded justification, bounded interface and maintenance plan.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D03 — Approve release readiness and publication decision

- **Parent:** N19 / AII-269.
- **Blockers:** X08, D01, D02, F04h, T06b, U03b, C07d, L01b, V01b, F04k, T07b, H06c, R05b, R05c, R05d, H12a, H12b, H12c, H12d, H12e, H12f, H12g, H12h, H12i, H12j, H12k, X11.
- **Deliverable:** Exact release manifest, known limitations and owner signoff.
- **Acceptance and verification:** All gates mapped to current evidence; no unapproved scope deletion; publication/deployment remains explicit owner decision; the release manifest contains no preset team, backlog, credentials or self-development automation and states the support matrix (OS versions, Linux distributions, architectures, filesystems); the owner inspection policy and the other pre-release owner decisions are recorded.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D04 — Run detailed real-world QA on macOS, Linux and Windows

- **Parent:** N19 / AII-269.
- **Blockers:** D03.
- **Deliverable:** Automated and manual QA run on the completed product on the owner's real macOS and Windows machines and on Linux, with a written plan and evidence for each platform.
- **Acceptance and verification:** Detailed plan agreed with the owner before the run: install from a clean checkout and from the release artifact, full automated suite repeated, real-agent trial with a real model provider approved by the owner, long-running and restart scenarios, crash and power-loss style kills, unattended operation, antivirus and filesystem behaviour on Windows, sleep and network change on laptops, every supported PostgreSQL major released in the last three years re-verified, supported OS release floors confirmed; results recorded per platform; failures raised as typed blockers; this is the last item before the plan is closed (D05) and the owner accepts it; accepted only if the real-agent trial meets the approval-load targets (no more than three owner decisions per working day after the first week, no stall that reaches unrelated work).
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D04b — Measure code-navigation aids on real coding tasks (optional, after the first release)

- **Parent:** N19 / AII-269.
- **Blockers:** D04.
- **Deliverable:** Optional, after the first release (owner decision 2026-10-26): run real coding tasks on real projects with each candidate aid and keep the ones that measurably help. Candidates: better ripgrep with paged output under the tool-output caps; an on-demand code map and references tool built inside the sandbox from a language-neutral parse (Tree-sitter or ctags; stamped with the tree hash, capped by a token and time budget, its reads recorded as dependencies, nothing stored by the controller); neighbour-file suggestions; a "what calls the changed exports" view for reviewers. Not candidates: graphify itself, model-extracted relationships, visualisation, a startup architecture summary (it breaks prompt-cache reuse), controller-side shared indexes. The languages measured follow the owner's real projects. No aid is specific to one language (owner decision 2026-10-26): a precision layer for a language is built only if the same is done for the ten most used languages, and an aid for JavaScript or TypeScript must handle the frameworks projects use (Angular templates and decorators, Vue and Svelte single-file components, React JSX) or say plainly that it does not.
- **Acceptance and verification:** Each candidate is tried against the same task set with and without it and the results recorded: tokens and tool calls spent finding code, task success, review findings, and time; an aid is built into the product only if it measurably helps and its card names the evidence; the languages and frameworks tried are named, and a language or framework an aid does not support is reported as unsupported, never as an empty or silently partial result; a candidate that does not help is recorded as dropped with the numbers.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D05 — Close the plan: every optional item built or deferred by the owner

- **Parent:** N19 / AII-269.
- **Blockers:** D04, D04b, U03c, K06b, K01d, P02b, A08c.
- **Deliverable:** Final bookkeeping after real-world QA: each optional, after-the-first-release card (D04b, U03c, K06b, K01d, P02b, A08c) is either built or recorded as deferred by the owner, and the plan is marked complete.
- **Acceptance and verification:** D05 is the one card for which an owner-recorded deferral counts as satisfying a dependency, so D04b, U03c, K06b, K01d, P02b and A08c may be built or deferred; each shows built, or deferred with the owner's decision recorded; D03 and D04 are for the first release and do not wait for optional cards.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Y01 — QA checkpoint 1: durable core

- **Parent:** N18 / AII-268.
- **Status:** implemented; commits `eab38e6`; CI runs 39506052276; record [y01-qa-checkpoint.md](y01-qa-checkpoint.md).
- **Progress note:** Automated part passing: the hand-started QA workflow (fresh checkout in a path with a space, root npm test repeated five times) passed every repeat on all six cells (Ubuntu, macOS, Windows x Node 22.19.0 and 24.21.0, 1463 tests per run, run 39506057525) on a commit that includes the fix for the one failure its first run found (a smoke-test stopping rule that counted warm-up work, run 39499788238, fixed in a674bf5). The owner's Mac mini run (Darwin 25.5.0, Node 22.23.2) first failed four worker-thread crash tests, most likely because the test hook let the worker run past its crash point on a fast machine, and passed 5 of 5 after the fix in e318c62 (regular CI on e318c62 then failed one Windows cell with a per-file time limit, fixed in 632cb6f, CI run 39523877412 green). The owner's Windows machine passed 1 repeat (Windows 11, Node 22.20.0, d0c4823; an unrelated test-server cleanup failure seen in an older log there is fixed in the test harness; the owner's five Windows repeats at 7d7078a, which includes that fix, then passed). The development server (Ubuntu 26.04, kernel 7.0, ext4) passed 5 of 5 repeats at 7d7078a. On 2026-10-21 the owner instructed that the Windows run be considered passed (their one-repeat runs passed) and that work continue, with their five-repeat run to follow. The macOS (the owner's run, 5 of 5) and Linux (the implementing session's run at the owner's request, 5 of 5) boxes were ticked at the owner's direction on 2026-10-21. The Linux run was the implementing session's, with an install that skipped package scripts and used the offline cache. On 2026-10-21 the owner allowed work to continue before that acceptance (A01 and the cards after it were built); the owner's five Windows repeats then passed (5 of 5 at 7d7078a), and the owner accepted the checkpoint on 2026-10-21.
- **Blockers:** S09, F04h.
- **Deliverable:** Cross-platform QA of the completed durable core (storage on both backends, assignment, delivery, inbox, effect ledger, reconciliation, waits, artifacts, environment check) before security and agent layers are built on it.
- **Acceptance and verification:** Scenario set run on Linux, macOS and Windows: repeated kill and restart at every durable boundary, no lost acknowledged work or duplicated effect, artifact integrity after kills, unsupported environment refused and overridden as designed, suite repeated five times per platform with no flaky failure left unexplained; evidence recorded per platform. Each checkpoint has two parts: an automated part (an integration scenario set run by the QA workflow on Linux, macOS and Windows with crash and restart kills, extended from scripts/qa.mjs) that must pass, and a real-hardware run on the owner's Mac, Windows and Linux machines that the owner runs and signs off. Failures are raised as typed blockers and fixed before the layers above are built; the owner may waive the real-hardware part for a checkpoint explicitly, and the waiver is recorded. Not a substitute for the final D04..
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Y02 — QA checkpoint 2: isolation, stop and recovery

- **Parent:** N18 / AII-268.
- **Blockers:** G05, G06, A06, L04, H09, A03b, A08b, F04i, F04j, H06b.
- **Deliverable:** Cross-platform QA of the sandbox and protected filesystem, human pre-commit gate, pause, stop, release and checked resume, and remote reconnect with primary epochs, before the cards that run agent work on them (P02, P03) are built.
- **Acceptance and verification:** Scenario set run on Linux, macOS and Windows with real sandbox launchers: escape and path-trick attempts refused, pause and stop settle with no unfinished tool action, resume invalidates stale evidence, a worker lost mid-task is fenced and reconciled with no duplicate protected effect, Windows implementation qualified on real Windows; evidence recorded per platform. Each checkpoint has two parts: an automated part (an integration scenario set run by the QA workflow on Linux, macOS and Windows with crash and restart kills, extended from scripts/qa.mjs) that must pass, and a real-hardware run on the owner's Mac, Windows and Linux machines that the owner runs and signs off. Failures are raised as typed blockers and fixed before the layers above are built; the owner may waive the real-hardware part for a checkpoint explicitly, and the waiver is recorded. Not a substitute for the final D04.; the checkpoint reports owner decisions per day, counted from the audit log (commands whose actor is the owner, per day), and any stall that reached unrelated work.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Y03 — QA checkpoint 3: first complete chat-driven workflow

- **Parent:** N18 / AII-268.
- **Blockers:** U07, M02, P02, P03, Q02, K03, A07d.
- **Deliverable:** Cross-platform QA of the first end-to-end workflow driven from chat (project, tasks, meeting decision, coding and non-code work, independent QA, backup and migration) before budgets, improvement, standby failover and the release campaigns are built on it.
- **Acceptance and verification:** Scenario set run on Linux, macOS and Windows from a fresh install using the web chat over a private network: a project is created and finished from chat, restarts and a worker loss mid-way lose nothing, backup restores and a migration rolls back as documented, responsive chat under load; evidence recorded per platform. Each checkpoint has two parts: an automated part (an integration scenario set run by the QA workflow on Linux, macOS and Windows with crash and restart kills, extended from scripts/qa.mjs) that must pass, and a real-hardware run on the owner's Mac, Windows and Linux machines that the owner runs and signs off. Failures are raised as typed blockers and fixed before the layers above are built; the owner may waive the real-hardware part for a checkpoint explicitly, and the waiver is recorded. Not a substitute for the final D04..
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.
