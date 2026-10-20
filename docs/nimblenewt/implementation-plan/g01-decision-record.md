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
| Operating systems | macOS, Linux and Windows are all required; exact versions to be qualified on the three available machines | CI (hosted runners `ubuntu-latest`, `macos-latest`, `windows-latest`) passes the full suite; the development server runs Ubuntu 26.04.1 LTS (Linux 7.0.0) on x86_64 | Exact minimum OS versions, architectures (Apple Silicon vs Intel, Windows/Linux ARM) and filesystems; real-hardware runs on the owner's Mac and Windows 11 Pro 10.0.26200 (see the G02 checklist) |
| Node.js | TypeScript is the implementation language | Node 22.19.0 (minimum) and 24.21.0 (current) pass CI on all three platforms; `engines` is `>=22.19.0` | Which Node lines are supported long-term |
| Pi Durable | Selected as the initial runtime | Exactly 1.3.0, pinned; any other version is refused (see [g03-compatibility.md](g03-compatibility.md)) | Upgrade procedure and qualification of later releases |
| SQLite | First-release controller backend | Pi's optional SQLite storage backend uses `node:sqlite`; the adapter has been qualified only on JSONL and memory storage, and the controller SQLite adapter does not exist yet (F04b) | Minimum SQLite version and durability settings |
| PostgreSQL | First-release controller backend | None | **Which PostgreSQL major versions to support, and how tests obtain a server on all three platforms** |

## Budget

- **Decided:** research paid-model spend is capped at $25 total with no automatic overage (D6).
- **Not decided:** the production and improvement budget, the N00 implementation budget and the per-task budgets. The plan treats N00 scope and budget as the owner's separate gate; this record does not set them.

## Authorizations on record

- **Planning synchronization and plan approval:** October 17, 2026, "Approved implementation plan", for repository revision `aaa9f0ddd11d92bfdedbb93fa926f7b9312870de` ([approval.md](approval.md)). Document/task reconciliation and Mac/server/GitHub synchronization are authorized.
- **Start of implementation:** the owner's instruction of October 19, 2026 to begin working on the project; work has proceeded on the Pi-first path since (F01, F03, F05, F06, G02, G03; see the roadmap in the README).
- **N00:** its formal scope and budget record has **not** been written. That remains an open owner item, and the plan keeps N00 as the activation gate in its generated files. Nothing here dispatches Paperclip workers or authorizes deployment.

## Open owner decisions this record surfaces

1. N00 formal scope and budget (the implementation budget in particular).
2. Supported PostgreSQL versions, and whether PostgreSQL test runs may use an embedded/ephemeral server in CI.
3. Minimum OS versions and architectures (and which of the owner's machines count as the qualifying hardware).
4. Production and improvement budgets and the proposed defaults in the design register that the owner has not set (P/PC allocation, meeting cadence, voting rules, lifecycle limits, update windows).
5. Acceptance of the G02 milestone and its default decisions (aborted-input framing, update behaviour, branch and task limits, the interrupted-work hold).
