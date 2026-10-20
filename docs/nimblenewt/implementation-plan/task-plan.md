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
| N02 / AII-252 | F01, F02, F03, F04a, F04b, F04c, F04d, F04, F04e |
| N03 / AII-253 | G02, G03, G09, G10, F05, F06, F07, C06 |
| N04 / AII-254 | S01, S02, S03, S04, S05, S06, S07, S08, S09, C03 |
| N05 / AII-255 | L05, L01, L02, L03, L04, H08 |
| N06 / AII-256 | G05, A01, A02, A03, A04, A05, A06 |
| N07 / AII-257 | C01, C02, C04, C05 |
| N08 / AII-258 | R01, R02 |
| N09 / AII-259 | U03, U04, U05, U06, U07 |
| N10 / AII-260 | H01, H02, H03, H04, H05, H06, H07, H09, H10 |
| N11 / AII-261 | V01, V02 |
| N12 / AII-262 | M01, M02 |
| N13 / AII-263 | T01, T02, T03 |
| N14 / AII-264 | P01, P02, P03 |
| N15 / AII-265 | Q01, Q02, Q03 |
| N16 / AII-266 | B01 |
| N17 / AII-267 | K01, K02, K03, K04, K05 |
| N18 / AII-268 | G06, X09, X10, X01, X02, X03, X04, X05, X06, X07, X08 |
| N19 / AII-269 | D01, D02, D03 |
| N07a / AII-519 | U01, T04 |
| N10a / AII-520 | U02, T05 |
| N16a / AII-615 | B02, B03, B04, B05 |

## Cards

### G01 — Record accepted scope and experiment prerequisites

- **Parent:** N01 / AII-251.
- **Status:** implemented-awaiting-signoff; commits `5e2953f`; CI runs 39358055788; record [g01-decision-record.md](g01-decision-record.md).
- **Progress note:** Consolidates the owner-accepted D1-D7 and the limits; the production/N00 budget, supported PostgreSQL versions and minimum OS versions are open owner decisions listed in the record.
- **Blockers:** Owner scope/decision input; no implementation activation.
- **Deliverable:** Decision records for D1-D7, supported versions, workload envelope and budget.
- **Acceptance and verification:** Record current decisions, dual database support, remote topology, operating limits and owner planning-sync authorization; preserve N00 execution hold.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G02 — Accept the Pi adapter first milestone

- **Parent:** N03 / AII-253.
- **Status:** implemented-awaiting-signoff; commits `fe494f9`; CI runs 39356097952; record [g02-acceptance.md](g02-acceptance.md).
- **Progress note:** Acceptance suite and record written and CI green on all six cells; needs real macOS/Windows QA and owner acceptance.
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
- **Blockers:** S09, F04d, G09.
- **Deliverable:** Actual embedded controller and Pi integration on SQLite and PostgreSQL.
- **Acceptance and verification:** Kill worker and controller around admission and result; no lost acknowledged request or duplicate protected effect; wait survives service restart; exercise both real controller databases, connection loss and ambiguous commits; validate the mechanism decisions in design proposal section 3; classify any failure as an implementation defect or evidence against the selected architecture; do not defer backend selection to this task; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G05 — Prove selected isolation boundary per OS

- **Parent:** N06 / AII-256.
- **Blockers:** A03, A04.
- **Deliverable:** Actual NimbleNewt component/integration tests: Disposable containment fixtures and capability matrix.
- **Acceptance and verification:** Deny outside-workspace writes, symlink escape, credential reads and uncontrolled network routes; record trusted-host exceptions; run on available platforms and require Windows before release; prove launch/exec/results/teardown under actual unattended service identity after logout and reboot; feature-enabled or interactive-session smoke success alone is insufficient; include mapped-output ACL positive/negative controls and packaged controller working-directory checks; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G06 — Qualify actual Windows implementation

- **Parent:** N18 / AII-268.
- **Blockers:** G02, G03, G05, F03.
- **Deliverable:** Actual NimbleNewt component/integration tests: Windows host evidence and reproducible commands.
- **Acceptance and verification:** Repeat crash, output, migration and containment cases on supplied host; document OS/runtime/filesystem; no Mac/Linux substitute; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
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
- **Blockers:** C05, L05.
- **Deliverable:** Actual NimbleNewt component/integration tests: Typed pause/branch/resume/suspend fixture with exact context manifests.
- **Acceptance and verification:** Inquiry sees original current context without polluting parent; unchanged and updated resumes correct; stream interruption and partial tool calls cannot admit stale actions; context survives restart without summary reconstruction; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### G10 — Benchmark native backend caching and branch markers

- **Parent:** N03 / AII-253.
- **Blockers:** C06.
- **Deliverable:** Actual NimbleNewt component/integration tests: Pinned Strata/vLLM/llama.cpp capability matrix and available-hardware measurements.
- **Acceptance and verification:** Audit exact backend APIs: llama slot save waits for idle, vLLM keep pauses whole engine; qualify cache-preserving options and avoid development-route exposure. Separate cold/native/retained-marker runs; verify tokens reused and context fidelity; report memory, TTFT, switch latency and cache-miss fallback; unavailable backends marked unqualified; no production changes; invoke production implementation, not a parallel test-only state machine; attach implementation commit and reproducible evidence.
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
- **Blockers:** F01, G02, G03.
- **Deliverable:** Typed domain operations and shared semantic fixtures.
- **Acceptance and verification:** Atomic transition plus audit/outbox; unique IDs and payload mismatch; revision/epoch checks; consistent data types, transaction boundaries and ambiguous-commit resolution; no raw SQL in domain services.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04b — Implement SQLite controller storage adapter

- **Parent:** N02 / AII-252.
- **Blockers:** F04a.
- **Deliverable:** Local SQLite adapter and schema with explicit durability settings.
- **Acceptance and verification:** Shared semantic fixtures pass; bounded busy handling and rollback; no network filesystem; short transactions and process-crash recovery verified.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04c — Implement PostgreSQL controller storage adapter

- **Parent:** N02 / AII-252.
- **Blockers:** F04a.
- **Deliverable:** PostgreSQL adapter and schema with bounded pool and retry policy.
- **Acceptance and verification:** Shared fixtures pass on real PostgreSQL; competing claims preserve ownership and ordering; deadlock/serialization retries and ambiguous commit handled without duplicated admission.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04d — Qualify storage adapter parity and contention

- **Parent:** N02 / AII-252.
- **Blockers:** F04b, F04c.
- **Deliverable:** Identical fault suite and workload reports for both backends.
- **Acceptance and verification:** Crash at every atomic boundary; interrupted connection and uncertain commit; duplicate messages, stale epochs and per-task ordering; baseline four active and 32-active-equivalent stress plus100 idle; record latency/contention without claiming real-agent capacity.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### F04 — Define storage schema migration runners

- **Parent:** N02 / AII-252.
- **Blockers:** F04d.
- **Deliverable:** Backend-specific versioned schema migration journals.
- **Acceptance and verification:** Interrupted schema migration recoverable on both databases; incompatible downgrade rejected; constraints enforce unique operation and delivery IDs; upgrades preserve fixture state.
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
- **Blockers:** F05, F02.
- **Deliverable:** Protected registry facade and artifact version selection.
- **Acceptance and verification:** Personal extension cannot replace reserved system tool; paused attempt restores pinned version or blocks on revocation.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S01 — Implement project/task records and revisioned commands

- **Parent:** N04 / AII-254.
- **Blockers:** F04.
- **Deliverable:** Domain commands, stable identities and optimistic revisions.
- **Acceptance and verification:** Duplicate identical command applies once; conflicting key payload and stale revision rejected; task may exist without repository.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S02 — Implement assignment generations and attempt admission

- **Parent:** N04 / AII-254.
- **Blockers:** S01, F05.
- **Deliverable:** Assignment history, attempt records and fencing checks.
- **Acceptance and verification:** Two competing admissions yield one valid writer; old generation cannot mutate task after transfer; observed activity separate from owner.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S03 — Implement durable transition delivery

- **Parent:** N04 / AII-254.
- **Blockers:** S01.
- **Deliverable:** Selected engine delivery mechanism and domain outbox bridge where needed.
- **Acceptance and verification:** Kill before/after commit and receipt; committed intent is eventually found; no event for rolled-back transition; cross-store gap reconciled.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S04 — Implement durable inbox and duplicate handling

- **Parent:** N04 / AII-254.
- **Blockers:** S03, S02.
- **Deliverable:** Receipt, admission and settlement records.
- **Acceptance and verification:** Duplicate/out-of-order delivery cannot create second attempt; acceptance acknowledges only durable receipt; changed payload rejected.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S05 — Implement effect ledger and idempotent bridge

- **Parent:** N04 / AII-254.
- **Blockers:** S02, S04.
- **Deliverable:** Effect intents, external keys and reconciliation interface.
- **Acceptance and verification:** Kill after external success before result save; protected effect occurs once; unsupported target becomes uncertain and blocks blind retry.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S06 — Implement artifact publication and integrity

- **Parent:** N04 / AII-254.
- **Blockers:** F04.
- **Deliverable:** Immutable blob/manifest storage and hash verification.
- **Acceptance and verification:** Crash between blob and manifest leaves no accepted dangling reference; corrupt/missing blob blocks resume; orphan cleanup safe.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S07 — Implement startup and periodic reconciliation

- **Parent:** N04 / AII-254.
- **Blockers:** S03, S04, S05.
- **Deliverable:** Deterministic repair scan, cursors and bounded retry.
- **Acceptance and verification:** Drop wakeups and restart dispatcher; pending work found without LLM; manual hold preserved; exhausted retries create visible blocker.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S08 — Implement typed waits and deadline settlement

- **Parent:** N04 / AII-254.
- **Blockers:** S04, S07.
- **Deliverable:** Wait reasons, resolver IDs, deadlines and terminal outcomes.
- **Acceptance and verification:** No waiting task lacks next action or explicit indefinite owner hold; late answer cannot revive cancelled operation.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### S09 — Verify the durable vertical slice

- **Parent:** N04 / AII-254.
- **Blockers:** S05, S06, S07, S08, F06, G02, G03.
- **Deliverable:** Integrated fault harness and first acceptance report.
- **Acceptance and verification:** Chat-command stub through worker result survives every enumerated crash boundary; exact effects and owner generation agree after restart.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A01 — Implement authenticated principals and capabilities

- **Parent:** N06 / AII-256.
- **Blockers:** S01, F02, S09.
- **Deliverable:** Owner/agent/host identities and scoped capability checks.
- **Acceptance and verification:** Spoofed actor and cross-project access rejected; permission checks cover API and tool paths; secrets redacted.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A02 — Implement revisioned grants and restrictions

- **Parent:** N06 / AII-256.
- **Blockers:** A01.
- **Deliverable:** Direct, derived and standing grants with expiry/revocation.
- **Acceptance and verification:** Necessary scoped actions covered without redundant approval; unrelated resource and expired scope denied; conflicting restriction wins.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A03 — Implement selected sandbox launcher

- **Parent:** N06 / AII-256.
- **Blockers:** A01, F03.
- **Deliverable:** OS-specific constrained worker launch and trusted-host mode.
- **Acceptance and verification:** Escape fixture denied on each OS; mode visible in audit; trusted-host option requires explicit configured authority; fail closed when the Windows session/client is unavailable; advertise capacity only after launcher health checks; keep supervisor code outside guest-writable staging; provision narrow per-job share ACLs; verify package publisher/version and working directory; qualify VM fallback only if Sandbox cannot meet service lifecycle needs; support explicit owner-opt-in auto-login/lock mode with local credential entry, verified lock gating and clear session-dependent capability; never enable it by default.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A04 — Implement protected filesystem and Git bridge

- **Parent:** N06 / AII-256.
- **Blockers:** A03, S05.
- **Deliverable:** Workspace access, expected-version writes and protected Git operations.
- **Acceptance and verification:** Symlink/path replacement and indirect .git writes denied; dirty work preserved; target change rejects conditional write.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A05 — Implement exact-operation review admission

- **Parent:** N06 / AII-256.
- **Blockers:** A02, S05, F07.
- **Deliverable:** Review binding to command, script, target and policy versions.
- **Acceptance and verification:** Changed arguments/script/resource/revocation invalidates verdict before execution; reviewer cannot expand capability.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### A06 — Implement human pre-commit gate and attribution

- **Parent:** N06 / AII-256.
- **Blockers:** A04, A05.
- **Deliverable:** Staged-tree/base review and actor provenance.
- **Acceptance and verification:** Reviewed tree commits; changed staged content/base requires new review; developer, agent, executor and reviewer identities retained.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C01 — Implement separated task/chat/meeting histories

- **Parent:** N07 / AII-257.
- **Blockers:** S01, S06, A01, F06.
- **Deliverable:** Scoped durable histories and desk ownership.
- **Acceptance and verification:** Peer can read allowed desk but cannot write it or read private scratch; side chat does not pollute task history.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C02 — Implement bounded source-backed retrieval

- **Parent:** N07 / AII-257.
- **Blockers:** C01.
- **Deliverable:** Cursor retrieval, summaries and full-source links.
- **Acceptance and verification:** Summary resolves original evidence; permissions enforced on search/snippets/links; context budget bounded without hiding missing sources.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C03 — Capture read/write/search dependency manifests

- **Parent:** N04 / AII-254.
- **Blockers:** S06, A04, C01.
- **Deliverable:** Resource identities, hashes, query scopes and event cursors.
- **Acceptance and verification:** Detect changed/deleted/non-Git inputs and new directory members; unknown coverage and expired cursor remain explicit.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C04 — Implement safe-boundary continuation capture

- **Parent:** N07 / AII-257.
- **Blockers:** C02, C03, F06.
- **Deliverable:** Checkpoint manifest and structured continuation builder.
- **Acceptance and verification:** Timeout preserves artifacts, decisions, pending effects, budget and next step; non-checkpointable tool exposure explicitly recorded.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C05 — Implement retained context branches and selective updates

- **Parent:** N07 / AII-257.
- **Blockers:** C04, H04.
- **Deliverable:** Immutable parent context, inquiry branch and revisioned update application.
- **Acceptance and verification:** Inquiry has permitted current context; parent unchanged after status question; selected updates applied once; suspend/switch/restore preserves exact available history.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### C06 — Implement optional inference-cache capability adapters

- **Parent:** N03 / AII-253.
- **Blockers:** C05.
- **Deliverable:** Backend capability negotiation, opaque markers and bounded retention policy.
- **Acceptance and verification:** Cache eviction/incompatibility falls back without context loss; quota/privacy enforced; pin/fork/decoder-resume advertised separately; engine changes require measured gap and separate scoped patch.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L05 — Implement generation interruption and late-result handling

- **Parent:** N05 / AII-255.
- **Blockers:** C05, F06, A02.
- **Deliverable:** Finish-and-hold/cancel controls and revision-bound partial streams.
- **Acceptance and verification:** Pause blocks new effects immediately; partial tool calls never execute; late response cannot override correction; optional decoder resume qualified separately.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L01 — Implement Pause and background settlement

- **Parent:** N05 / AII-255.
- **Blockers:** C04, A02, S08, L05.
- **Deliverable:** Durable pause gates and permitted background result collection.
- **Acceptance and verification:** Pause retains owner and blocks new foreground work across restart; background result recorded without unpausing.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L02 — Implement Suspend and graceful Stop

- **Parent:** N05 / AII-255.
- **Blockers:** L01.
- **Deliverable:** Bounded preparation, checkpoint and process shutdown.
- **Acceptance and verification:** Kill during preparation resumes shutdown intent; uncooperative tool classified; force stop explicit and auditable.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L03 — Implement prepared release and reassignment

- **Parent:** N05 / AII-255.
- **Blockers:** L02, S02, S05.
- **Deliverable:** Transfer protocol and retained continuation.
- **Acceptance and verification:** Crash before/after transfer yields one owner; no recipient leaves durable unassigned work; returning worker fenced.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### L04 — Implement checked resume and evidence invalidation

- **Parent:** N05 / AII-255.
- **Blockers:** C03, L02, A02.
- **Deliverable:** Collect/verify/review/commit resume pipeline.
- **Acceptance and verification:** Input change between review and commit blocks stale continuation; revoked content not leaked; uncertain effects resolved first.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H01 — Implement worker enrollment and observation

- **Parent:** N10 / AII-260.
- **Blockers:** A01, S02.
- **Deliverable:** Host identity, heartbeat/progress reports and freshness.
- **Acceptance and verification:** Disconnected host shown stale; identity rotation and revoked host denied; ownership not silently released.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H02 — Implement subordinate remote work/artifact transport

- **Parent:** N10 / AII-260.
- **Blockers:** H01, S06, A03.
- **Deliverable:** Authenticated remote admission and artifact fetch.
- **Acceptance and verification:** Network partition and delayed packets preserve fencing; no shared database mount; unsupported host fails visibly; remote workers cannot self-promote or admit independent work.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H03 — Implement priority admission and reserved control capacity

- **Parent:** N10 / AII-260.
- **Blockers:** S08, H01.
- **Deliverable:** Fair bounded queue with accepted initial 4 productive attempts total, 2 per host and 2 inquiry/review capacity.
- **Acceptance and verification:** Workload saturation cannot starve stop/revoke or review; limits apply to CPU/memory/concurrency; no unbounded recursive spawning.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H04 — Implement durable inquiries and correlation

- **Parent:** N10 / AII-260.
- **Blockers:** S04, C01, H03.
- **Deliverable:** Side-conversation requests, replies and completion.
- **Acceptance and verification:** Ask/answer while main attempt waits without ownership transfer; restart preserves correlation; unauthorized context absent.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H05 — Implement review routing and wait-cycle prevention

- **Parent:** N10 / AII-260.
- **Blockers:** H04, A05.
- **Deliverable:** Independent reviewer selection, fallback and wait graph.
- **Acceptance and verification:** Self-review rejected when independence required; cyclic reviewers detected; outage waits or uses authorized fallback; no implicit approval.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H06 — Implement event subscriptions and gap recovery

- **Parent:** N10 / AII-260.
- **Blockers:** S07, C03.
- **Deliverable:** Scoped subscription cursors, dedup and batching.
- **Acceptance and verification:** Missing/duplicate/out-of-order events and retention expiry trigger reconciliation; incoming event never lifts manual hold.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### H07 — Implement idle host polling and capability placement

- **Parent:** N10 / AII-260.
- **Blockers:** H02, H03.
- **Deliverable:** One bounded poll per host, jitter/backoff and capability-indexed queue.
- **Acceptance and verification:** 100 simulated idle hosts and reconnect burst stay within measured resource limits; unavailable platforms wait visibly; no per-agent idle polling storm.
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
- **Blockers:** H07, H09, H03.
- **Deliverable:** Host/global quotas, spawn admission and bounded coordination.
- **Acceptance and verification:** Swarm cancellation settles children; exhausted slots/budgets block expansion; stop/review control traffic remains responsive.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R01 — Implement model routing and capability policy

- **Parent:** N08 / AII-258.
- **Blockers:** F05, A02, F02.
- **Deliverable:** Role-aware ordered routes and exclusion rules.
- **Acceptance and verification:** Disabled provider excluded immediately for new dispatch; incompatible context/tool capability skipped; data-sharing restrictions honored.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### R02 — Implement fallback and cumulative budget accounting

- **Parent:** N08 / AII-258.
- **Blockers:** R01, S05, C04.
- **Deliverable:** Provider failure classification and bounded fallback.
- **Acceptance and verification:** Credit/rate/outage failures choose eligible route; exhausted routes become visible wait; no repeated external effect on fallback.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U01 — Implement versioned state query/write API

- **Parent:** N07a / AII-519.
- **Blockers:** S01, A01, C02.
- **Deliverable:** Documented contracts, pagination and command results.
- **Acceptance and verification:** Chat/API clients see same scoped facts; stale revisions and duplicate command semantics verified; accepted differs from completed.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U02 — Implement durable conversation API and transport

- **Parent:** N10a / AII-520.
- **Blockers:** U01, H04.
- **Deliverable:** Thread/message/cursor API and chosen streaming/polling transport.
- **Acceptance and verification:** Either side initiates; disconnect/restart resumes without duplicate turns; live connection never owns history.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U03 — Implement owner chat command interpretation

- **Parent:** N09 / AII-259.
- **Blockers:** U01, U02, R02.
- **Deliverable:** Intent-to-command mapping and audit links.
- **Acceptance and verification:** Clear authorized project/task edits apply; material ambiguity asks; quoted/untrusted text cannot grant authority.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U04 — Implement conversational policy editing

- **Parent:** N09 / AII-259.
- **Blockers:** U03, A02, A05.
- **Deliverable:** Original wording, proposed interpretation and applied revision.
- **Acceptance and verification:** Scoped exception preserves unrelated gates; unsupported condition explicitly unapplied; concurrent API edit detected.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U05 — Implement chat status and blocker explanations

- **Parent:** N09 / AII-259.
- **Blockers:** U03, S08, H01.
- **Deliverable:** Evidence-linked status and task/project inspection views.
- **Acceptance and verification:** Owner versus observed active attempt distinguished; exact pending dependency/retry shown; no fabricated completion.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U06 — Implement deterministic recovery chat controls

- **Parent:** N09 / AII-259.
- **Blockers:** U01, L02, A02.
- **Deliverable:** Model-independent status/pause/stop/revoke/recovery actions.
- **Acceptance and verification:** Provider loss still permits authenticated recovery through chat; unavailable host boundary reported; command audit retained.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### U07 — Qualify responsive web chat over private networking

- **Parent:** N09 / AII-259.
- **Blockers:** U03, U06, A01.
- **Deliverable:** Responsive browser UI, authenticated sessions and private HTTPS deployment guide using Tailscale or equivalent.
- **Acceptance and verification:** Phone browser supports chat/approval/status/recovery; suspended connection resumes without duplicate commands; revoked session denied; local/private binding explicit; no public exposure or mandatory VPN vendor dependency.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### V01 — Implement health and progress stall detection

- **Parent:** N11 / AII-261.
- **Blockers:** H01, S08, C04.
- **Deliverable:** Deterministic alarms and bounded progress evidence.
- **Acceptance and verification:** Long legitimate job differs from loop and dead worker; stale timestamps not used as sole takeover permission.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### V02 — Implement bounded supervisor recovery

- **Parent:** N11 / AII-261.
- **Blockers:** V01, L03, L04, R02, H05.
- **Deliverable:** Recovery action ladder and supervisor monitoring.
- **Acceptance and verification:** Loop recovery preserves history/effects; cumulative cost/retries enforced; supervisor stall escalates; owner holds remain.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M01 — Implement durable meeting scheduling and agendas

- **Parent:** N12 / AII-262.
- **Blockers:** H04, U03.
- **Deliverable:** Scheduled/urgent meetings and idempotent occurrences.
- **Acceptance and verification:** Restart/catch-up creates one occurrence; absent/paused participants handled without unauthorized wake; agenda retained.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### M02 — Implement votes, decisions and meeting summaries

- **Parent:** N12 / AII-262.
- **Blockers:** M01, A02, C02.
- **Deliverable:** Decision records, dissent, owner presence and task updates.
- **Acceptance and verification:** New decisions respect effective authority; owner arrival handled; summary matches applied changes; old grants not reopened.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T01 — Implement immutable tool/skill catalog and attribution

- **Parent:** N13 / AII-263.
- **Blockers:** F07, A03, C01.
- **Deliverable:** System/shared/personal artifacts and usage records.
- **Acceptance and verification:** Exact instructional and executable versions recorded; personal edits cannot mutate shared release; logs obey audience boundaries.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T02 — Implement review/promotion/deprecation and retention

- **Parent:** N13 / AII-263.
- **Blockers:** T01, A05, L04.
- **Deliverable:** Artifact promotion and paused-task migration.
- **Acceptance and verification:** Revoked artifact cannot execute; stale referenced artifact retained for inspection; merge/deprecation does not break silent resume.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T03 — Implement approved MCP client connections

- **Parent:** N13 / AII-263.
- **Blockers:** T01, A01, S05.
- **Deliverable:** Local/remote MCP registration, credential refs and catalog snapshots.
- **Acceptance and verification:** Unapproved server denied; catalog changes rechecked; effect uncertainty and prompt injection fixtures handled.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T04 — Implement controller-backed MCP state adapter

- **Parent:** N07a / AII-519.
- **Blockers:** U01, T03.
- **Deliverable:** Scoped resources and revisioned state operations.
- **Acceptance and verification:** Same admission and privacy as native API; reconnect cannot duplicate state mutation; unsupported protocol fails clearly.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### T05 — Implement MCP durable conversation adapter

- **Parent:** N10a / AII-520.
- **Blockers:** U02, T04.
- **Deliverable:** Two-way conversation tools with stable IDs/cursors.
- **Acceptance and verification:** Both initiation directions survive reconnect; no duplicate turns or cross-scope leakage; protocol session not task owner.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P01 — Implement repository-independent projects and responsibilities

- **Parent:** N14 / AII-264.
- **Blockers:** U03, S01.
- **Deliverable:** Project/resource binding and ongoing responsibility records.
- **Acceptance and verification:** Start project in chat then bind two repos and non-code output; internal state stays outside target repos.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P02 — Implement isolated coding workspaces and integration

- **Parent:** N14 / AII-264.
- **Blockers:** P01, A04, L04.
- **Deliverable:** Worktree/workspace adapter and integration contract.
- **Acceptance and verification:** Dirty/untracked work survives interruption; conflicting integration revalidates evidence; no metadata pollution of target checkout.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### P03 — Implement non-code and sandbox operations adapters

- **Parent:** N14 / AII-264.
- **Blockers:** P01, T01, S05.
- **Deliverable:** Research/documentation/design deliverables and simulated service operations.
- **Acceptance and verification:** Non-code task produces accepted artifact; operational effect records verified target; scoped repair cannot affect collateral service.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q01 — Implement deliverable submission and acceptance

- **Parent:** N15 / AII-265.
- **Blockers:** S06, U01, P02, P03.
- **Deliverable:** Versioned output records and review state.
- **Acceptance and verification:** Tool completion alone cannot accept task; missing/changed artifact invalidates review; rejected version history retained.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q02 — Implement independent QA and dependency-bound evidence

- **Parent:** N15 / AII-265.
- **Blockers:** Q01, A06, C03, H05.
- **Deliverable:** Self-check/QA records and stale-evidence propagation.
- **Acceptance and verification:** Reviewer inspects actual version; changed dependency invalidates affected test/review; role title grants no access.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### Q03 — Implement documentation impact and release evidence links

- **Parent:** N15 / AII-265.
- **Blockers:** Q02, C02.
- **Deliverable:** User/developer documentation obligations and traceability.
- **Acceptance and verification:** Behavior change links required doc updates to tested artifact; no unsupported marketing capability claims.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B01 — Implement production/improvement budget admission

- **Parent:** N16 / AII-266.
- **Blockers:** H03, R02, Q01.
- **Deliverable:** P/PC accounting, reservations and limits.
- **Acceptance and verification:** Reflection/experiments/monitoring charged; production review remains P; no quota busywork or catch-up debt.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B02 — Implement observations and provenance deduplication

- **Parent:** N16a / AII-615.
- **Blockers:** B01, H06, C01.
- **Deliverable:** Controller-generated correction/failure/recovery/friction observations.
- **Acceptance and verification:** Duplicate retellings count once; cross-scope data remains restricted; rate limits prevent candidate storms.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B03 — Implement versioned lessons and triage

- **Parent:** N16a / AII-615.
- **Blockers:** B02, T01.
- **Deliverable:** Applicability, dependency, contradiction and supersession records.
- **Acceptance and verification:** Independent evidence distinguishable; stale premises trigger review; rejected/inconclusive candidate can finish.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B04 — Implement bounded baseline experiments

- **Parent:** N16a / AII-615.
- **Blockers:** B03, Q02.
- **Deliverable:** Pinned baseline/evaluator and separate evaluation cases.
- **Acceptance and verification:** Candidate cannot alter its own criteria/authority; negative result saved; budget exhaustion pauses/defer safely.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### B05 — Implement scoped adoption and monitored withdrawal

- **Parent:** N16a / AII-615.
- **Blockers:** B04, T02, L04.
- **Deliverable:** Adoption grants, monitoring triggers and withdrawal reconciliation.
- **Acceptance and verification:** Regression stops future use; paused dependencies reconciled; completed external effects not falsely undone; restart every transition.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K01 — Implement consistent backup and restore

- **Parent:** N17 / AII-267.
- **Blockers:** S06, F04, L02, S05.
- **Deliverable:** Both-backend manifested backup/export and restore runner including Pi state; nightly backups retaining 7 daily and 4 weekly copies plus pre-upgrade snapshot.
- **Acceptance and verification:** Portable recovery folder from consistent database snapshots and Pi/artifact manifest; coordinate maintenance barrier across stores; restore into empty install verifies artifacts/versions; separate secret recovery; uncertain later effects not replayed; interrupted backup never labeled complete; never sync live SQLite files as backup.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K02 — Implement deterministic release staging and activation

- **Parent:** N17 / AII-267.
- **Blockers:** K01, F02, T02.
- **Deliverable:** Signed/verified exact artifact staging and maintenance policy.
- **Acceptance and verification:** Model cannot replace updater authority; failed startup preserves compatible known-good path; maintenance scope enforced.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K03 — Implement migration recovery and rollback limits

- **Parent:** N17 / AII-267.
- **Blockers:** K02, G03.
- **Deliverable:** Migration journal, compatibility checks and recovery guide.
- **Acceptance and verification:** Interrupted migration recovers; incompatible schema downgrade blocked; restore distinguishes external effects since snapshot.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K04 — Implement selected standby replication and recovery watermarks

- **Parent:** N17 / AII-267.
- **Blockers:** K01, K03, H09.
- **Deliverable:** SQLite recovery and native PostgreSQL replication/promotion integration plus artifact/workflow recovery manifest.
- **Acceptance and verification:** Distinguish database failover from controller promotion; test configured synchronous/asynchronous loss behavior, writable-primary reconnection and uncertain commits; no custom PostgreSQL replication protocol; measure lag and loss window; missing blobs or workflow state prevent unsafe promotion; backups remain independently restorable; replicated standby is an optional installation capability with controlled promotion.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### K05 — Implement fenced primary promotion and recovery chat

- **Parent:** N17 / AII-267.
- **Blockers:** K04, U06.
- **Deliverable:** Authenticated external recovery endpoint and epoch transition.
- **Acceptance and verification:** Old primary demonstrably fenced before promotion; returning host cannot dispatch; workers stay stopped until reconciled; independent recovery login/authorization works with primary and model unavailable; owner consent cannot bypass fencing; no NimbleNewt-managed automatic controller failover in first release; qualified externally managed PostgreSQL database failover does not authorize another controller.
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
- **Blockers:** S09, V02, H02, Q02, K03, G04.
- **Deliverable:** Fault matrix with trace IDs and reproducible results.
- **Acceptance and verification:** Every persistence boundary tested; duplicate/delayed delivery, disk errors, stale worker and lost wakeup accounted for; no silent stuck state.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X02 — Run policy, isolation and adversarial campaign

- **Parent:** N18 / AII-268.
- **Blockers:** A06, U04, T05, Q02, G05.
- **Deliverable:** Scope/revocation/escape/injection and review-race evidence.
- **Acceptance and verification:** Alternate shell/tool/MCP/API paths cannot bypass grants or human gate; reviewer outage cannot authorize work.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X03 — Run chat-only complete product workflow

- **Parent:** N18 / AII-268.
- **Blockers:** U05, U06, U07, M02, P03, Q03, B05, K03, C06, L05, G09.
- **Deliverable:** Recorded scenario from project creation to accepted delivery and recovery.
- **Acceptance and verification:** All administration accomplished through chat; direct API edit coexists; interruption and restart retain progress; meetings/learning/operations exercised.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X04 — Qualify fresh macOS release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported macOS.
- **Acceptance and verification:** Full accepted scenario passes on exact build; containment limits explicit; no development-directory dependency.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X05 — Qualify fresh Linux release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported Linux.
- **Acceptance and verification:** Full accepted scenario passes on exact build; remote topology if selected verified; no developer credentials required.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X06 — Qualify fresh Windows release candidate

- **Parent:** N18 / AII-268.
- **Blockers:** X01, X02, X03, X09, F03, G06.
- **Deliverable:** Fresh-install and reboot/update/restore evidence on supported Windows.
- **Acceptance and verification:** Full accepted scenario passes on exact build; path/locking/process semantics exercised; no platform skips.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X07 — Measure load, inquiry latency and budget behavior

- **Parent:** N18 / AII-268.
- **Blockers:** X04, X05, X06.
- **Deliverable:** Benchmarks separating controller, model and tool latency.
- **Acceptance and verification:** Approved workload and resource envelope met; bounded review capacity under saturation; compare side inquiry with queued handoff using equivalent cases.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### X08 — Run representative soak and independent release audit

- **Parent:** N18 / AII-268.
- **Blockers:** X07, X10, F04e, G10.
- **Deliverable:** At least 72-hour soak, incident log and requirement evidence matrix.
- **Acceptance and verification:** Injected faults during mixed work settle; no unresolved severe correctness/security defects; independent reviewer verifies all accepted requirements.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D01 — Finish installation and chat-first user guidance

- **Parent:** N19 / AII-269.
- **Blockers:** X03, Q03.
- **Deliverable:** Public docs, examples and model-independent recovery guide.
- **Acceptance and verification:** Fresh user completes representative chat flow from guide; policy scope and trusted-host limitations understandable.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D02 — Finish developer/API/security and license guidance

- **Parent:** N19 / AII-269.
- **Blockers:** T05, K03, F03.
- **Deliverable:** Architecture, contribution, protocol, troubleshooting and notices.
- **Acceptance and verification:** Examples match current API; dependencies/licenses inventoried; security reporting and compatibility support documented.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.

### D03 — Approve release readiness and publication decision

- **Parent:** N19 / AII-269.
- **Blockers:** X08, D01, D02.
- **Deliverable:** Exact release manifest, known limitations and owner signoff.
- **Acceptance and verification:** All gates mapped to current evidence; no unapproved scope deletion; publication/deployment remains explicit owner decision.
- **On interruption:** apply the continuation contract above; preserve this card's partial deliverable and remaining checks.
