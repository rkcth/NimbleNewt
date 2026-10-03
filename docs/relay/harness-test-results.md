# Relay harness experiments — October 3, 2026

**Historical result:** these tests initially supported a risk-weighted preference for Deep Agents, with Pi Durable second. The user subsequently selected **Pi Durable**, accepting its experimental API risk; see the [current decision and upgrade safeguards](runtime-compatibility-and-namespaces.md). Both now have limited runtime evidence for recovery. Pi Durable's live controls are promising, but neither is qualified for Relay's complete lifecycle or safety contracts. Other candidates remain documentation-only assessments.

Relay now explicitly requires macOS, Linux, and Windows support. These experiments were run on macOS only. Their POSIX termination and exit-code assumptions must be adapted and tested on Windows, and Linux needs its own execution evidence. Pi Durable is selected, but production qualification still requires satisfying that three-platform requirement.

## Method and scope

Installed Deep Agents 0.7.21, LangGraph 1.2.12, langgraph-checkpoint-sqlite 3.1.1, and Pi Durable 1.0.1 in temporary environments outside the project. Used Python 3.12.14 and Node 22.23.2 on macOS arm64. System Python 3.9 could not install Deep Agents; using an isolated Python 3.12 environment resolved that setup issue.

The [reproducible probes and dependency locks](../../benchmarks/relay-harness/README.md) use real harness execution and storage with scripted models. No paid model calls, user credentials, production services, real PRs, or external mutations were used. Fake effects are confined to scratch files/databases. [Recorded recovery counts](../../benchmarks/relay-harness/recorded-2026-10-03/recovery.json) and [Pi control results](../../benchmarks/relay-harness/recorded-2026-10-03/pi-controls.json) are checked in.

A completed prerequisite precedes each effect. In the crash cases, the worker performs and persists an effect, then receives SIGKILL before the tool can return a result. A new process reopens the checkpoint and continues. This tests an ambiguous-outcome window rather than just saving and loading a completed conversation. The approval case instead exits normally while awaiting a decision and receives approval after reopening. LangGraph invocations explicitly use synchronous checkpoint durability.

## Recovery observations

| Scenario | Tool attempts across both processes | Actual fake effects | Observation |
| --- | ---: | ---: | --- |
| Deep Agents: approval interrupt | 1 | 1 | Pending approval survived process replacement; no effect occurred before approval. |
| Deep Agents: unprotected action, crash | 2 | 2 | Recovery repeated the action. Checkpointing alone did not prevent duplication. |
| Deep Agents: operation-ID-protected action, crash | 2 | 1 | Tool retried, but the fake service deduplicated the effect. |
| Pi Durable: default unsafe action, crash | 1 | 1 | Tool was not rerun; its interrupted result was recorded. The scripted model then finished. This is not proof that a real model would reconcile correctly. |
| Pi Durable: action incorrectly declared replay-safe, crash | 2 | 2 | The runtime trusted the declaration and repeated the action. |
| Pi Durable: replay-safe action with operation-ID protection, crash | 2 | 1 | Retry recovered without duplicating the effect. |

All six assertions passed. The completed prerequisite ran exactly once in every scenario. Deep Agents retained the task marker and separate thread state after reopening; Pi Durable retained the conversation and submission identities and deduplicated a repeated submission request ID. Submission deduplication did not prevent the replay-safe tool from duplicating an unprotected effect.

These outcomes confirm the need for intent records, operation IDs, and reconciliation. They do not establish exactly-once execution. Marking an operation replay-safe is a reviewed contract, not permission for the model to opt an arbitrary action into automatic retry.

## Pi Durable runtime-control observations

The separate control suite verified:

- Replacing an installed extension between completed turns changed the next tool call from version 1 to version 2 without restarting the harness. This tested direct host registry updates, not pi CLI extension compatibility or agent self-installation.
- Installing a different extension with the same tool name overrode the earlier tool. A protected name is not inherently protected by the registry.
- Reconfiguring the next request to a second fake provider retained prior conversation context; the first provider received no additional calls in that test. It did not test automatic fallback, an in-flight cutover, compaction, retries, or provider-native protocol compatibility.
- A separate meeting conversation received an answer without mixing its context with the task conversation. This verifies separate contexts, not private-data access control or meeting governance.
- Aborting a cooperatively cancellable tool withdrew both the active input and a queued input. A subsequent new submission ran immediately. Abort is not a durable Pause gate, and withdrawn inbox items need Relay-owned preservation.
- The live SQLite connection used `synchronous=1` (NORMAL) by default. Constructing storage through the exported database adapter allowed setting and reading back `synchronous=2` (FULL) before opening the harness. This is configuration evidence, not a physical power-loss test.

The installed Pi Durable README and `dist/storage/sqlite/node.js` distinguish process-crash recovery from power/host-failure durability. Its storage documentation also requires one owning process and states that it does not provide cross-process locking. Relay must enforce ownership outside this storage layer.

## Required design consequences

1. Keep durable ingress gates and inboxes outside the harness. Persist Pause/Suspend status before acknowledging it, and prevent new submissions or background follow-ups from waking ordinary execution. Preserve withdrawn messages for later authorized delivery.
2. Keep effect identity separate from model attempts and submission identity. An interrupted action must be reconciled or explicitly retried under its effect policy. Guard against a model issuing a new tool-call ID for the same uncertain action.
3. Make replay-safety declarations and protected tool registration host-controlled. Reject unauthorized name collisions, pin permitted code revisions, and enforce consequential service permissions outside the worker. Hot replacement is not isolation.
4. Explicitly configure and validate storage durability for shutdown and unexpected host failure. Do not treat a successful process-kill test as a power-loss guarantee. Record data-store and artifact-flush readiness in the Suspend checkpoint.
5. Enforce one active owner, with locking/fencing and stale-owner write rejection, rather than relying on the database accepting concurrent connections safely.
6. Preserve harness-neutral records of user decisions, task ownership, routing revisions, and meeting outcomes. Logical conversation separation does not provide those policies by itself.

## Effect on selection and remaining evidence

At the time of the experiments, Deep Agents was the first recommendation because it gives us explicit execution boundaries with persistent approval state and demonstrated recovery. That is an architectural preference, not proof of superior safety: the unprotected-effect test exposed an actual integration hazard.

Those tests strengthened Pi Durable's candidacy through recovery, submission deduplication, tool replacement, and separate-context evidence. The subsequent user decision selected Pi Durable; the earlier second-place ranking is historical. Its default refusal to replay an unsafe tool is useful. Its experimental API, context-extension portability, and operational ownership requirements remain material considerations. The tests are intentionally asymmetric in coverage; this is not a performance or reliability ranking.

Still untested: real local/cloud provider failures and exclusions across all helper calls; background OS/remote job recovery; bounded agent-led cleanup; Suspend versus Suspend and Release; graceful/forced Stop; stale-owner races; power loss; rollback of extension upgrades; billion-context compression and retrieval; real-model continuation quality; permissions and shared-repository isolation; history replay across software upgrades. Test these before qualifying the selected Pi Durable runtime for production use. Phases and MVP scope remain undecided.
