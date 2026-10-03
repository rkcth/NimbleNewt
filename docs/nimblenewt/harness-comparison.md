# NimbleNewt harness comparison

Initial documentation review recorded October 3, 2026. Candidates are pi, Pi Durable, Hermes Agent, LangChain Deep Agents, DeepSeek Harness, and OpenCode. The user confirmed that DeepSeek Harness and OpenCode are separate candidates. Subsequent [isolated runtime experiments](harness-test-results.md) tested pinned Deep Agents and Pi Durable releases with scripted models, process crashes, and SQLite recovery. Other candidates remain documentation-only assessments. The user has now selected Pi Durable as the reference worker runtime, accepting its experimental API risk. Neither documentation nor the narrow experiments prove NimbleNewt's end-to-end guarantees.

## Selection principle

NimbleNewt owns agent identity, project and task state, user decisions, task assignments, meetings, tool authorization, model fallback policy, and recovery rules. A harness adapter supplies model execution, tool exposure, context handling, and lifecycle observations. Protected Pi Durable extensions are the selected worker-facing packaging direction; NimbleNewt's service contracts remain independent of harness APIs. Other harnesses must expose the same service contracts through their supported integration points.

Evaluate the frameworks at the appropriate level: Deep Agents is an embeddable library, whereas Hermes and OpenCode also supply application and service surfaces. Pi Durable is a separate runtime candidate from regular pi. Similar labels such as pause, interrupt, checkpoint, or resume do not guarantee equivalent semantics.

## Initial comparison

| Candidate | Documented integration opportunity | NimbleNewt-specific uncertainty to test | Preliminary assessment |
| --- | --- | --- | --- |
| pi | SDK/RPC control, persistent sessions, extension tools and lifecycle hooks. See the [pi assessment](pi-integration-research.md). | Prevent queued work from continuing after Pause; preserve context sidecars; reconcile tools and jobs across restart. | Strong candidate for a customizable worker with existing extension reuse. |
| Pi Durable | Official overview describes checkpointed tasks and concurrent persistent conversations. | Match NimbleNewt ownership and suspension semantics; prove context strategy and tool replay safety; assess extension portability. | Strong candidate for reducing recovery infrastructure inside a worker. |
| Hermes Agent | Persistent conversation storage and search; API-controlled session and run operations. | Verify precise interruption boundaries, pending tool recovery, profile isolation, and how external scheduling overrides built-in autonomy. | Worth evaluating for the conversational supervisor and general-purpose workers; existing local experience is useful. |
| Deep Agents with LangGraph | Embeddable agent construction with tools, backends, checkpoint-backed interrupts, and streaming. | Use durable storage rather than in-memory examples; define behavior of arbitrary running tools, background jobs, graph upgrades, and model swaps. | Strong candidate if we want to own more of the worker's execution design directly. |
| DeepSeek Harness | Official project describes a Cordis-based plugin architecture. | Verify an external adapter API, persistence and interruption guarantees, protected plugin boundaries, provider breadth, and upgrade compatibility. | Interesting customization candidate; lifecycle qualification is still open. |
| OpenCode | Server session APIs, including fork and abort, with custom tools and plugins. | Verify restart recovery of in-flight work, queued requests, tool updates, and global per-agent configuration isolation. | Strong candidate for an externally controlled coding worker. |

Initial assessments are design judgments based on the sources below, not measured rankings. Consult the [experiment results](harness-test-results.md) for the narrower behaviors subsequently tested. A missing verified capability means unknown, not unsupported.

## Current selection

**Pi Durable is selected.** With stability and long-term upkeep held equal, the architectural fit assessment rated Pi Durable **9.1/10** and LangGraph/Deep Agents **8.6/10**. These are subjective fit scores, not benchmarks or cross-platform qualification. The user accepted the experimental-runtime risk and chose Pi Durable for its persistent conversation/task model and customization fit. LangGraph/Deep Agents remains the principal alternative.

Follow the [runtime compatibility and namespace plan](runtime-compatibility-and-namespaces.md): pin versions, isolate upstream APIs behind the NimbleNewt adapter, reserve command namespaces, and qualify migrations and rollback before activation.

## Earlier risk-weighted assessment (superseded selection)

Recommendation recorded October 3, 2026: **first choice Deep Agents with LangGraph; second choice Pi Durable** as the foundation for the first reference worker. This was the recommendation immediately after the isolated experiments; the current user selection above supersedes it. Those experiments strengthened Pi Durable's candidacy and demonstrated duplicate-effect hazards in both frameworks. It is not full runtime qualification or a commitment to adopt either. Recovery correctness and externally controlled execution carry more weight than an existing chat UI or coding benchmark.

| Order | Candidate | Why it lands here | Main cost or reservation |
| --- | --- | --- | --- |
| 1 | Deep Agents with LangGraph | Programmable execution and persistent checkpoints give us an explicit place to implement NimbleNewt's lifecycle, approval, and recovery contracts. | More framework integration; we must design safe tool boundaries, state migrations, and background-job recovery ourselves. |
| 2 | Pi Durable | Its durable conversation/task model closely matches agents switching between work and discussion. | Newly experimental; API stability and compatibility with regular pi extensions need evidence. |
| 3 | Regular pi | Attractive coding worker with SDK/RPC control and the extension path already researched. | NimbleNewt must supply more of the execution recovery machinery around saved sessions. |
| 4 | Hermes Agent | Useful general-purpose conversational worker, with existing project experience and persistent recall. | Need to reconcile its application-level behavior with NimbleNewt's authority and independently qualify interruption/recovery. |
| 5 | OpenCode | Useful coding worker with an external server interface and customizable tools. | Less verified evidence in this review for NimbleNewt's broader lifecycle and durable background work. |
| 6 | DeepSeek Harness | Interesting plugin-oriented design for agent customization. | Developer-preview compatibility and unverified external-control/recovery contracts create the most evaluation uncertainty. |

Ranks 3–6 describe fit for our initial reference worker, not overall product quality. A missing verified capability is not proof of absence. Hermes could be preferable for a conversational role and OpenCode for a particular coding workload.

### Rationale for the earlier Deep Agents preference

LangGraph distinguishes thread checkpoints from cross-thread stores, which fits separate task/conversation state and agent desks. Its [persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) explicitly distinguishes RAM-only examples from persistent PostgreSQL and SQLite checkpointers. NimbleNewt should use durable storage and choose checkpoint durability deliberately; the [synchronous durability mode](https://reference.langchain.com/python/langgraph/types/Durability) persists changes before the next step begins.

The key advantage is control over execution boundaries. That gives us a useful foundation for implementing our exact semantics instead of interpreting a terminal application's stop command as Suspend. However, [LangGraph's replay guidance](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/functional-api.mdx) says unfinished tasks can run again: side effects still require idempotency keys or reconciliation. Checkpointing does not freeze an OS process or preserve its files automatically.

If Deep Agents is adopted as an alternative, use it as a worker library, with NimbleNewt retaining team hierarchy, assignments, meetings, model routing, and user authority. Built-in ephemeral subagents do not constitute NimbleNewt's durable team. Its backend and memory configuration should place agent data outside contribution repositories. Filesystem tool policies also do not replace OS isolation for shell commands. Built-in context summarization is not evidence of billion-context-style expandable history; that remains an integration requirement.

### Earlier Pi Durable reservations

The [official announcement](https://earendil.com/posts/pi-durable/) describes checkpointed model/tool tasks and concurrent persistent conversations. This is a close conceptual match for NimbleNewt. But the package was announced on October 1, 2026 as experimental, with APIs subject to change—only two days before this assessment. We must not transfer regular pi's stability or extension compatibility to it by association.

The earlier ranking favored Deep Agents because of this uncertainty. The user subsequently chose Pi Durable for architectural fit and accepted the risk; the unresolved tests still apply. In particular, verify billion-context portability rather than assuming compatibility.

For any production-qualified runtime, require recovery from a crash during an external action without blindly repeating it, Suspend/reboot with assignment retained, a meeting followed by return to the original task, and provider exclusion covering every helper call. These are qualification gates, not a new phase or MVP plan.

## Detailed source findings

### Hermes Agent

Hermes documents SQLite-backed session history and cross-session recall in its [session guide](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/sessions.md). Its [API server guide](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/api-server.md) describes session operations, streaming turns, and a run-stop endpoint that reports stopping until execution exits. NimbleNewt can investigate those as adapter primitives; a stopped Hermes run is not automatically a NimbleNewt Suspend checkpoint.

Prior local experience with Hermes profiles and persistent task sessions informed its candidacy, but is not portable verification of live services or hard isolation. NimbleNewt must work without that installation or its private setup notes. Evaluate profile/session integration against the public contracts while keeping NimbleNewt's permissions, scheduling, and event delivery authoritative.

### Deep Agents

The official [overview](https://docs.langchain.com/oss/python/deepagents/overview) describes a library built on LangChain and LangGraph with custom tools, configurable filesystem backends, context handling, and subagents. Its [human-in-the-loop guide](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop) requires a checkpointer and a consistent thread identifier to resume interrupts.

NimbleNewt would need a persistent checkpoint backend, an externally enforced execution boundary, and explicit handling of side effects. An in-memory saver in an example cannot satisfy reboot recovery. An approval interrupt before a tool is different from pausing a tool already running. Test reconstructed graph versions and saved state together; a live Python object or coroutine is not a portable checkpoint. Keep NimbleNewt task ownership separate from graph and subagent ownership.

### DeepSeek Harness

The [official repository](https://github.com/deepseek-ai/deepseek-harness) identifies `dsh` as DeepSeek Harness and describes a plugin-based architecture with an explicit developer-preview compatibility warning. The [official product page](https://deepseek.com/en/harness/) also describes background work and scheduled-task plugins. Those features make it relevant but do not establish the required recovery guarantees.

Investigate how NimbleNewt can load protected tools, observe and gate execution, persist state externally, disable internal schedulers where necessary, and prevent personal plugins from replacing protected functionality. Pin a revision before exploring plugin contracts. Do not infer provider neutrality, seamless restart, or a supported control endpoint from the general extensibility claim. Community OpenCode bridges are not the same candidate as either native DSH or native OpenCode.

### OpenCode

The official [server API](https://opencode.ai/docs/server/) exposes session operations including fork and abort. Its [custom-tool guide](https://opencode.ai/docs/custom-tools/) supports JavaScript or TypeScript definitions that can invoke other languages, and a global tool location outside the repository. It also allows name collisions to override built-ins, which requires explicit protection for NimbleNewt tool names. [Plugins](https://opencode.ai/docs/plugins/) provide another integration surface.

Use externally managed configuration for each worker and avoid optional repository initialization that generates instruction files. Determine how a tool catalog or plugin revision becomes active without assuming hot reload. Validate tool registration and global configuration discovery against the chosen release. A successful abort response must be followed by verification of actual operation and job state before reporting readiness.

### Pi and Pi Durable

Retain the [detailed pi assessment](pi-integration-research.md). The [Pi Durable overview](https://earendil.com/posts/pi-durable/) describes the selected runtime's execution model, distinct from regular pi. Do not mix a CLI plugin compatibility claim with a Pi Durable capability claim. Both must pass NimbleNewt's common tests, including preserved user authority and external-effect reconciliation.

## Common adapter contract

Propose capability declarations for each pinned adapter, with explicit supported, unsupported, and unverified states:

- Start or reopen an exact agent/context identity in an isolated environment without repository setup files.
- Accept a turn, stream attributed events, and distinguish accepted, active, settled, and failed work.
- Gate new ordinary execution; park structured inputs; cooperate with cleanup; force termination externally if necessary.
- Export or reference durable native history, branch identity, context state, and pending operations, without pretending every harness shares one session format.
- Expose protected NimbleNewt tools and a dynamic script catalog; stage and restart personal extension changes with rollback.
- Respect provider exclusions and selected fallbacks, including model calls made by compaction, plugins, and delegated agents.
- Preserve shared/private record boundaries and make all consequential effects observable through enforced service contracts.

Prefer keeping a task on its current qualified harness while changing its model when possible. Cross-harness handoff is an explicit reconstruction from portable task evidence and artifacts, not guaranteed native-session migration. Record the fidelity and limitations of that handoff.

## Qualification criteria

Run the same behavioral scenarios for every serious candidate, using pinned artifacts and a representative local model plus a configured cloud backup. Do not rank only by a coding benchmark or UI polish.

| Criterion | Required evidence |
| --- | --- |
| Standalone configuration | Install without the original project's services; configure model routes, fallback order, and environment bindings through the common settings service and UI without source edits. |
| Required platforms | Qualify at least one complete execution path on each of macOS, Linux, and Windows, including setup, tools, cancellation, isolation, and recovery. Pi Durable is not yet qualified across all three; reevaluate selection if a candidate cannot meet this requirement. |
| Pause correctness | Ownership retained; foreground work stays paused despite retries and job completion; selected background work continues. |
| Suspend and reboot | Durable context and artifacts restore with the same owner; no required process memory survives as an assumption. |
| Release and Stop | Cleanup precedes ordinary release; graceful Stop and forced termination are distinguishable; stale owners cannot write. |
| Crash recovery | Tool outcomes are recovered or marked uncertain; external effects are not duplicated blindly. |
| Provider switch | Disabled routes receive no new requests, including hidden helper calls; eligible fallback retains necessary context. |
| Tools and extensions | Protected tools remain protected, catalog scripts work without a harness reload, and failed environment upgrades roll back. |
| Conversation and meetings | Task to meeting to task transitions preserve private boundaries and apply updated user decisions. |
| Clean repositories | No mandatory NimbleNewt files or hidden configuration changes appear in contribution diffs. |
| Operational cost | Measure adapter complexity, context quality, latency, resource use, and upgrade burden alongside task success. |

Keep the alternative assessments as reference material. Pi Durable is the selected reference runtime; qualify it against the required contracts before production use, while preserving a common contract for additional harnesses. Multiple qualified harnesses may serve different agent roles, but adding one should justify its ongoing maintenance cost. This document is research and selection criteria, not a phase plan or commitment to implement all adapters immediately.
