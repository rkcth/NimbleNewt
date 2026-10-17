# Experiments and findings

> Historical feasibility research, October 16, 2026. Statements about future research gates are superseded by the current implementation plan. These reports do not qualify NimbleNewt production code. Raw machine-local fixtures remain in the research workspace; paths below identify historical evidence, not shipped dependencies.

**Executed October 16, 2026; isolated research, not product qualification.**

No live model/provider calls were used in these probes. Pi used scripted providers; external effects were synthetic files or SQLite rows. Mac experiments were in this review directory. Linux experiments were in `/tmp/nimblenewt-review-20261016` on the existing server. The Temporal service was a temporary local development service. Production services were not intentionally interrupted. A real host reboot or power-loss test was not performed.

## Environment and reproducibility

- Mac: macOS 26.5.2, ARM64, Node 22.23.2. Executable used: `[local research path]`.
- Linux: Linux 7.0.0-38-generic, x86_64, glibc 2.43, Node 24.21.0. Executable used: `/home/rob/.local/opt/node-v24.21.0-linux-x64/bin/node`.
- Pi package locks: `experiments/pi-1.0.1/package-lock.json` and `experiments/pi-1.3.0/package-lock.json`; packages installed in scratch directories with lifecycle scripts disabled.
- Temporal SDK: 1.24.0; package lock in `experiments/temporal/package-lock.json`. The downloaded local test server reported CLI 1.9.1 / Server 1.32.0. Its persisted SQLite service is not a production Temporal deployment.
- Protocol spike: Python standard-library SQLite, version 3.51.0 on Mac and 3.46.1 on Linux. This is a mechanism experiment; the production controller remains TypeScript.
- Baseline source: approved commit `ecd24cb26ebb6be47c26518237b30c2d0aa6bd56`, `benchmarks/nimblenewt-harness/pi_probe.mjs` and `pi_controls.mjs`. The candidate 1.3.0 copies were adapted to its `output` tool-result contract after the compatibility finding.

Use clean output directories for reruns. These scripts intentionally terminate their own test worker subprocesses; run only against disposable paths. Keep dependency locks. Cached dependencies, test-server binaries, and SQLite artifacts can be recreated; source and JSON reports are the durable review evidence.

## Subsequent Windows and context experiments

The [October 16 follow-up results](context-and-windows-results.md) add native Windows recovery/migration tests, exact retained-context forks on all three platforms, interrupted-stream crash recovery, and actual llama.cpp inference-cache measurements. The tables below retain the original experiment scope; their earlier Windows-pending entries are superseded for the specific research probes, not for full isolation/release qualification.

## Results

| Experiment | Observed result | Meaning and limit |
| --- | --- | --- |
| Pi 1.0.1, Mac and Linux, three repeats each of three crash scenarios | 18 expected-result cases passed | Completed prerequisite not repeated; unsafe interrupted call not blindly replayed; declared-safe unprotected call duplicated; idempotent protected effect occurred once. |
| Pi 1.3.0 with corrected result contract, same platforms/repeats | 18 expected-result cases passed | Same narrow recovery properties with current output contract. Not proof of every tool/compaction path. |
| Pi 1.3.0 with unchanged legacy probes | 18 count-based cases passed, but semantic sentinel failed | Superseded as semantic compatibility evidence. Demonstrates why old probe success was misleading. |
| Tool-output contract sentinel | 1.0.1 `content`: visible; 1.3.0 `content`: absent; 1.3.0 `output`: visible | A breaking API change could silently remove model-visible results in untyped probes. The expected absence is a compatibility defect, not a successful product behavior. |
| Runtime controls, both versions/platforms | Expected observations reproduced | SQLite default synchronous NORMAL (1), explicit FULL (2); hot replacement; protected-name override hazard; context-preserving next-request model switch; separate contexts; abort leaves active/queued input unanswered; new submission wakes conversation. Controller protections remain necessary. |
| Forward migration, Mac, 1.0.1 → 1.3.0 | Three synthetic crash/recovery cases passed | Identity and prerequisite preserved; expected effect counts. No downgrade, full extension, compaction, or Windows proof. |
| Pi live inquiry, Mac 1.3.0 | Side conversation completed while main tool remained blocked; contexts separate | Supports separate inquiry architecture. Scripted model timing (~2 ms) is not representative review latency or proof of policy/fairness. |
| SQLite durable protocol spike, Mac and Linux | 12 cases per platform passed | Atomic update/intent, duplicate receipt/admission, 8-way admission race, pause/revocation gate checks, stale generation rejection, artifact-before-manifest publication and corruption detection. Not a production orchestrator. |
| Actual Temporal SDK/local service, Mac | Killed worker recovered, heartbeat details carried, prerequisite ran once, effect attempted twice with one synthetic effect | Durable activity retry works in the fixture. Exactly-once synthetic effect came from the fixture's idempotency, not a general Temporal guarantee. |
| Temporal persisted service restart and queued signal | Orderly dev-server stop/reopen retained workflow; signal accepted without worker and later processed | This was a persisted service restart, not abrupt service power loss, production Postgres, clustering, or a Pi integration. |

The primary Pi crash matrix is 36 cases across versions/platforms; the additional 18 legacy candidate runs are retained to document the test blind spot. Do not count a deliberately duplicated “safe” effect as a safety success. It is an expected demonstration of unsafe classification.

Temporal's single observed worker recovery took 4.416 seconds; the complete fixture took 9.665 seconds. These are single local samples with scripted work and short configured timeouts. They do not establish production percentiles or an advantage over a fully implemented embedded dispatcher.

## Evidence links

- Mac Pi 1.0.1 (`research-workspace/evidence/mac-pi-1.0.1/report.json`, historical local evidence), Linux Pi 1.0.1 (`research-workspace/evidence/linux-pi-1.0.1/report.json`, historical local evidence).
- Mac Pi 1.3.0 adapted (`research-workspace/evidence/mac-pi-1.3.0-adapted/report.json`, historical local evidence), Linux Pi 1.3.0 adapted (`research-workspace/evidence/linux-pi-1.3.0-adapted/report.json`, historical local evidence).
- Superseded legacy result runs: Mac (`research-workspace/evidence/mac-pi-1.3.0/report.json`, historical local evidence), Linux (`research-workspace/evidence/linux-pi-1.3.0/report.json`, historical local evidence).
- Output sentinel: 1.0.1/content (`research-workspace/evidence/output-1.0.1-content/result.json`, historical local evidence), 1.3.0/content (`research-workspace/evidence/output-1.3.0-content/result.json`, historical local evidence), 1.3.0/output (`research-workspace/evidence/output-1.3.0-output/result.json`, historical local evidence).
- Forward migration (`research-workspace/evidence/pi-migration-mac/report.json`, historical local evidence), live side inquiry (`research-workspace/evidence/pi-live-inquiry-mac/report.json`, historical local evidence).
- Protocol Mac (`research-workspace/evidence/protocol-mac/report.json`, historical local evidence), protocol Linux (`research-workspace/evidence/protocol-linux/report.json`, historical local evidence).
- Temporal (`research-workspace/evidence/temporal-mac/report.json`, historical local evidence), Temporal run log (`research-workspace/evidence/temporal-run.log`, historical local evidence).

## Reproduction entry points

From the review root, with the matching locked package dependencies installed:

```sh
python3 experiments/run_pi.py --node /absolute/path/to/node --package experiments/pi-1.0.1 --output evidence/new-pi-101 --repeats 3
python3 experiments/run_pi.py --node /absolute/path/to/node --package experiments/pi-1.3.0 --output evidence/new-pi-130 --repeats 3
python3 experiments/protocol_probe.py evidence/new-protocol
```

`experiments/migration_probe.py` currently records the exact Mac Node path and output directory used; adjust those two fixture parameters for a different host or clean rerun. `experiments/pi-1.3.0/live_inquiry.mjs` takes a fresh output directory. `experiments/output_contract.mjs` and its package-local copies take the fixture arguments documented in their source. The Temporal runner is `experiments/temporal/run.js`; inspect its disposable output/service configuration before rerunning. These are research scripts, not a supported product CLI.

## Research findings affecting decisions

Pi Durable's installed current release was 1.3.0 at review time. Its changelog documents a breaking tool-result change in 1.2.0 and further fixes in 1.3.0. Do not infer compatibility from semantic version intuition or from process completion. Pin, compile, test model-visible semantics, migrate a copy, and only then propose an upgrade. [Changelog](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md).

The upstream Pi durability description discusses resumed steps, interrupted tools, and stable request IDs. The probes support a narrow subset. NimbleNewt still needs a durable inbox above abort behavior, enforced namespaces, immutable versions and its own effect reconciliation. [Pi Durable](https://earendil.com/posts/pi-durable/).

Temporal is an alternative durable scheduling foundation, not a substitute for policy or an external-effect transaction. Its production deployment and worker lifecycle require operational design. The local development service used for this experiment is explicitly a development facility. [Production deployment](https://docs.temporal.io/production-deployment), [worker practices](https://docs.temporal.io/best-practices/worker).

## Experiments still required before architecture freeze

| Gate | Why still needed | Safe execution plan and pass condition |
| --- | --- | --- |
| Selected engine + Pi integrated spike (G04) | Today's protocol and Temporal tests are separate mechanisms. | Build a small disposable TypeScript slice using the selected persistence; kill controller/worker around each boundary, reconnect, and compare durable command/effect/assignment truth. |
| Compaction and richer runtime migration (G02/G03) | Current probes disable compaction and use simple tools. | Use long scripted histories, changed extension versions, nested tools where supported, interrupted compaction and incompatible manifests; preserve semantic results or reject safely. |
| Strong isolation per OS (G05) | No sandbox is established by conversation or replay tests. | Disposable workspace and fake secrets; attempt symlink/path/process/network escape under chosen boundary. Record unsupported routes and do not expose real credentials. |
| Windows (G06) | Existing required platform, not exercised here. | Rob has offered a host; await details, install isolated pinned fixtures, run crash/output/migration/containment matrix, preserve exact environment logs. |
| Production workflow-service operations if selected | Dev-server persistence does not prove production recovery. | Disposable service/persistence stack, restart/failure/backup/restore and version tests. Never use the active application service as a fault target. |

Later integration/release gates additionally require real host reboot, controlled storage failure, network partitions, full chat authorization, realistic model latency/cost, all-platform install/update/restore and soak. Those depend on implemented components and cannot honestly be completed in advance. Their scripts/fixtures and acceptance criteria must be developed alongside those components, rather than invented at release time.
