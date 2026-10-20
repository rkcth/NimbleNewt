# G01: accepted scope and experiment prerequisites

Status: **recorded; reviewed by a separate AI session (not a human review).** This consolidates decisions the owner has already made and states what is still open. It adds no new decisions: where the owner has not decided something, it says so and does not fill the gap. N00 (the implementation scope and budget gate) is **not** opened or closed by this record.

Sources: [design-proposal.md](design-proposal.md) section 3 (D1-D7), [design-decisions.md](../design-decisions.md), [approval.md](approval.md), [windows-unattended-findings.md](windows-unattended-findings.md).

## D1-D7

| ID | Decision | Owner acceptance |
| --- | --- | --- |
| D1 | One authoritative primary controller with subordinate external workers. Workers keep primary communication and stop work on loss; they are not peers and cannot promote themselves. Remote workers are required for cross-OS release tests and distributed agent capacity. | Accepted by Rob, October 16, 2026 |
| D2 | Durable scheduling: an embedded TypeScript scheduler over interchangeable SQLite and PostgreSQL controller stores. Pi owns conversation execution; the controller owns tasks, policy, leases and effect admission. Temporal is a reference, not a dependency. Tests may falsify the choice but do not postpone it. | Current implementation-plan selection; dual SQLite/PostgreSQL support requested by Rob |
| D3 | Browser-based chat over a private network (Tailscale or equivalent) from a phone or other browser. No dedicated mobile app and no public Internet exposure. | Accepted by Rob, October 16, 2026 |
| D4 | Strong execution isolation by default, with an explicitly authorized trusted-host mode. The actual container/VM/native boundary is chosen per supported OS and its limitations published. A prompt or tool-name allowlist is not a shell sandbox. | Accepted by Rob, October 16, 2026 |
| D5 | Windows qualification: a Windows 11 Pro 10.0.26200 host is available and research tests ran. Unattended operation uses an installation-specific auto-login plus immediate-lock fallback; the measured sign-in-to-lock delay of about 19 seconds is accepted for the owner's private test laptop. This is not a zero-exposure guarantee. Full release qualification remains required. | Accepted by Rob, October 16, 2026 (the delay explicitly) |
| D6 | Initial operating and research limits: qualify exact OS versions on the three available machines; 4 productive attempts installation-wide, 2 per worker host, plus capacity for 2 inquiries/reviews; test 100 simulated idle hosts and 20 concurrent synthetic tasks; research paid-model cap **$25 total** with no automatic overage, local/scripted work first; cache budgets follow measurement. | Accepted by Rob, October 16, 2026 |
| D7 | Primary recovery: optional replicated standby with owner-controlled promotion through a separately reachable authenticated recovery interface; fence the old primary before promotion; keep independent versioned backups. Automatic failover is not first-release scope. | Accepted by Rob, October 16, 2026 |

## Dual database support

Both SQLite (default for a simple local installation) and PostgreSQL are first-release controller backends behind one typed transactional storage interface (cards F04a-F04d). There is one scheduler with two storage implementations, not two engines, and no promise of compatibility with arbitrary databases. Pi's own conversation storage is a separate boundary and does not move with the controller database.

## Remote topology

One authoritative controller; subordinate workers on other hosts (D1); private-network browser access (D3); optional replicated standby with owner-controlled promotion (D7). Workers cannot promote themselves, and loss of primary communication stops their work.

## Operating limits and workload envelope

As D6: 4 productive attempts installation-wide, 2 per worker host, 2 inquiry/review slots; qualification workloads of 100 simulated idle hosts and 20 concurrent synthetic tasks. These are qualification targets, not capacity claims for real agents.

## Supported versions: what is decided, what has been qualified, what is open

| Item | Decided by the owner | Qualified or chosen so far | Open |
| --- | --- | --- | --- |
| Operating systems | macOS, Linux and Windows are all required; exact versions to be qualified on the three available machines | CI (hosted runners `ubuntu-latest`, `macos-latest`, `windows-latest`) passes the full suite; the development server runs Ubuntu 26.04.1 LTS (Linux 7.0.0) on x86_64 | **Decided 2026-10-20:** claim only what CI covers (Linux x64, macOS arm64, Windows x64; Node 22.19.0 or newer). Linux arm64 is the next platform to add to CI; Intel Macs and Windows arm64 are not claimed. Mac and Windows claims stay provisional until real-hardware runs (G02 checklist; the owner's Mac and Windows 11 Pro 10.0.26200) and the owner's acceptance. Still open: exact OS release floors, filesystems |
| Node.js | TypeScript is the implementation language | Node 22.19.0 (minimum) and 24.21.0 (current) pass CI on all three platforms; `engines` is `>=22.19.0` | Which Node lines are supported long-term |
| Pi Durable | Selected as the initial runtime | Exactly 1.3.0, pinned; any other version is refused (see [g03-compatibility.md](g03-compatibility.md)) | Upgrade procedure and qualification of later releases |
| SQLite | First-release controller backend | Pi's optional SQLite storage backend uses `node:sqlite`; the Pi adapter has been qualified only on JSONL and memory storage; the controller SQLite adapter is implemented (F04b: WAL, `synchronous=FULL`) and green in CI on Linux x64, macOS arm64 and Windows x64 | **Decided 2026-10-20:** keep `synchronous=FULL` and move the adapter to a worker thread (card F04f). Still open: minimum SQLite version |
| PostgreSQL | First-release controller backend | 17.10 on all three platforms in CI with an embedded server started by the test helper (F04c, F04d, F04); 14.23, 15.18, 16.14, 17.10 and 18.4 verified on Linux (F04g) | **Decided 2026-10-20:** support 17 and above. Card F04g verified the latest minor of each major from 14 to 18 (all pass on Linux; see [f04g-postgres-versions.md](f04g-postgres-versions.md)) and the code floor is now 17, matching the claim; the owner may later narrow support to the two most recent majors |

## Decisions recorded 2026-10-20

Given by the owner in conversation with the implementing AI session; recorded here, not yet signed off as part of G01.

1. **SQLite and the event loop:** worker thread, `synchronous=FULL` kept (card F04f). `synchronous=NORMAL` is rejected because it can lose acknowledged commits on power loss.
2. **PostgreSQL:** support 17 and above; verify against 14 and later majors (card F04g); narrowing to the two most recent majors is a later decision.
3. **Platforms:** claim what CI covers (see the table); Linux arm64 next.
4. **Numeric defaults and budgets:** the current defaults (PostgreSQL pool of 10, lock and statement timeouts, lease durations, retry bounds, SQLite busy-wait bound) stay as provisional, configurable values labelled **unvalidated**; they are revisited after a trial with real agents. No production target is set.
5. **QA:** G02 QA runs outside Paperclip for now, as the hand-started `QA` workflow (see [g02-acceptance.md](g02-acceptance.md)).

### Second round, 2026-10-20 (answers to five questions, asked one at a time)

6. **N00 scope and budget:** the owner asked what would cost money. Answer given: the plan's "budget" is the spending limit for AI agent runs; nothing done so far costs money (CI is free on a public repository, tests are offline). Decision: **scope only, no money cap yet.** The Pi-first path is in scope; anything that uses a paid model provider or dispatches Paperclip workers needs the owner's explicit go-ahead first; revisit when the real-agent trial comes up. The N00 gate itself is still the owner's to open and is not opened by this record.
7. **OS release floors:** claim what CI runs today (the hosted runner releases; the owner's Mac overlaps with them); older releases are untested and not claimed. **Unsupported environments refuse to start unless explicitly overridden** (not silently blocked, and not merely warned): the controller **refuses to start** on an unsupported OS, architecture, Node version or PostgreSQL major, with a message that says what was found, what is supported, how to test that version with the project's own verification, and the exact startup switch that overrides the refusal. A warning alone is rejected because it would be missed. Card F04h. The exact runner versions are to be confirmed and written into the platform table before the check is built.
8. **Other numbers and defaults** (meeting cadence, voting rules, P/PC allocation, lifecycle limits, update windows, budgets): provisional and configurable, labelled unvalidated, revisited after the real-agent trial.
9. **PostgreSQL support window:** 17 and above is supported. An older server makes the controller refuse to start, tells the user how to test their version and how to override (card F04h; today the adapter refuses with no override). Before launch, validate every major released in the last three years (possibly just 17 and 18, possibly more); whether to narrow to the two most recent majors is still decided later.
10. **G02 real-hardware QA:** not done now. The periodic hosted-runner QA continues. Detailed real-world QA on macOS, Linux and Windows (the owner has all three) is planned as the **last item of the plan** (card D04), with automated testing of the completed product. The G02 real-hardware and Linux boxes therefore stay unticked until then; the owner ticks the acceptance box.
11. **Three planned QA checkpoints during development** (the owner's idea, 2026-10-20; the implementing AI session picked the points, the owner has not yet confirmed them): **Y01** after the durable core (S09, F04h), gating A01 so no security or agent layer is built on an untested core; **Y02** after isolation, stop and recovery (G05, G06, A06, L04, H09), gating the isolated coding workspaces (P02) and non-code and sandbox operations (P03), the first cards that run agent work on those foundations; **Y03** after the first complete chat-driven workflow (U07, M02, P02, P03, Q02, K03), gating budgets (B01) and standby failover (K04). Each has an automated cross-platform part and a real-hardware part run and signed off by the owner (who may waive it, recorded). D04 remains the detailed final run.

## Budget

- **Decided:** research paid-model spend is capped at $25 total with no automatic overage (D6).
- **Not decided:** the production and improvement budget, the N00 implementation budget and the per-task budgets. The plan treats N00 scope and budget as the owner's separate gate; this record does not set them.

## Authorizations on record

- **Planning synchronization and plan approval:** October 17, 2026, "Approved implementation plan", for repository revision `aaa9f0ddd11d92bfdedbb93fa926f7b9312870de` ([approval.md](approval.md)). Document/task reconciliation and Mac/server/GitHub synchronization are authorized.
- **Start of implementation:** the owner's instruction of October 19, 2026 to begin working on the project; work has proceeded on the Pi-first path since (F01, F03, F05, F06, G02, G03; see the roadmap in the README).
- **N00:** its formal scope and budget record has **not** been written. That remains an open owner item, and the plan keeps N00 as the activation gate in its generated files. Nothing here dispatches Paperclip workers or authorizes deployment.

## Open owner decisions this record surfaces

1. ~~N00 formal scope and budget~~ Scope-only record decided 2026-10-20 (no money cap yet; paid model use needs the owner's go-ahead); the N00 gate is still the owner's to open.
2. ~~Supported PostgreSQL versions~~ Decided 2026-10-20 (17 and above; verification in F04g). Embedded/ephemeral servers in CI are in use.
3. ~~Minimum OS versions and architectures~~ Decided 2026-10-20 as what CI covers; exact OS release floors decided as the CI runner releases (to be confirmed), with refuse-unless-overridden behaviour (F04h); real-hardware qualification moved to the last plan item (D04).
4. Production and improvement budgets (provisional, configurable storage defaults decided 2026-10-20) and the proposed defaults in the design register that the owner has not set (P/PC allocation, meeting cadence, voting rules, lifecycle limits, update windows).
5. Acceptance of the G02 milestone and its default decisions (aborted-input framing, update behaviour, branch and task limits, the interrupted-work hold).
