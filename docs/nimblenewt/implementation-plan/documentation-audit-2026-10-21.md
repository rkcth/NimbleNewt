<!-- Written by an AI session (Claude Opus) from five read-only audit reports; reviewed by a separate AI session (Claude Opus) on 2026-10-21; not a human review. -->
# Consolidated plan change proposal: docs vs task plan

Sources: the five audit reports in this folder (readme-1, readme-2, readme-3, contracts, operations), `scripts/generate_task_plan.py` and `scripts/plan.test.mjs` at the current checkout. No repo file was edited.

## Summary

- Today: 113 cards, 22 parents in use (N00 has none), 46 phases, longest chain 46, single root G01, single leaf D04, 38 cards implemented or awaiting sign-off.
- Proposed: **38 new cards, giving 151 cards**. Parents in use stay 22 (all new cards sit under existing workstreams, so the `parents` map needs no new AII issue). Phases stay **46** and the longest chain stays 46 cards. Root still G01, leaf still D04.
- **50 existing cards get clause additions** (all `planned`). **18 planned cards get new dependencies** (section 1b). No implemented card is changed.
- Every GAP row in the five reports is mapped to a new card or clause (section 4). No GAP is left unresolved. Some items are flagged as OWNER DECISIONS (section 3) where the docs themselves say a policy is still open.
- Validated mechanically: a patched copy of the generator with every change in this file applied is at a scratch copy kept outside the repository. It runs cleanly (151 tasks, acyclic) and writes only to a scratch copy kept outside the repository. A Python re-check of plan.test.mjs's rules passes: unique well-formed IDs, every dependency exists, no cycle, one root and one leaf, no implemented card with an unimplemented blocker, 46 phases. The plan test itself was not run because node is not installed on this host.
- The ID clashes between reports are resolved as follows (report suggestion → final ID): A07 (env, readme-2/readme-3/operations) → A08 + A09; A07 (action classes, contracts) → A07; A08 (inspection, contracts) → A10; U08 (messages, readme-2) → U12; U08 (settings, readme-1/operations) → U08; U08 (decision precedence, readme-3) → C08; U08 (state API, contracts) → U13; U09 (replay) → C09 + U09; U10 (notifications) → U11; P04 (responsibilities, readme-1) → P04; P04 (retirement, readme-3) → P06; P04 (contribution, contracts) → P05; P05 (contribution, readme-1) → P05; P05 (simulation, readme-3) → P07; F08 (harness, readme-1) → F08; F08 (aliases, readme-2) → T09; F08 (secret stores, operations) → F09; T06 (bridge, readme-2) → T06; T06 (aliases, operations) → T09; T07 (toolbox, readme-2) → T08; C08 (all) → C08; S10 / O01 (agent records) → H11; S10 (wait graph, readme-3) → S10 (task contracts); H11 (worker, contracts) → H12; R03 (difficulty, readme-2) → R03; R03 (cost, readme-3) → R05; R04 → R04; K06 → K06; K06 (dev workflow, readme-3) → K02 clause plus an owner decision; K07 → K07; G11 → G11; M03, M04, M05 (readme-3) keep their IDs; readme-3 M06 (meeting record and views) is folded into M02 clauses; readme-3 M07 (procedure, roster, quorum, ballots) becomes M06; L06 → L06; Q04 → Q04.

### Redirects of suggestions aimed at implemented cards

| Report suggestion (implemented card) | Now carried by |
| --- | --- |
| S01: difficulty, priority, budget, acceptance criteria, dependency edges (readme-1 #4/#27, contracts #12, readme-3 #48) | S10 |
| S02: attempt records harness/model/policy/environment versions; failed attempt leaves task unchanged (readme-1 #33, contracts #5/#51) | H12 |
| S04: urgency and task association on messages (readme-1 #8) | U12 |
| S08: general wait-for graph (operations #19) | S10 |
| R01: difficulty-to-profile mapping; config document into routing table (readme-1 #4/#5, operations #4/#6) | R03, U10 |
| A02: grant fields (spend, environment, delegation, conditions), publish/send/spend scopes (contracts #21, readme-1 #37) | A07 |
| A05: redundant-approval reconciliation (contracts #25) | H05 clause |
| C01/C02: desk survives model change, recovery-service principal, source-project labels, derived data inherits restrictions, shared reading grants no execution, source identity (readme-1 #73-77, contracts #19, operations #32) | H11, A10 |
| H03: priority change applies at next admission (readme-1 #11) | S10 |
| H04: owner as addressee; inquiry to a paused agent stays queued (readme-1 #12/#76) | U12 |
| F02/U04 note: config history and drafts (operations #3) | U10 |
| F03: core runs without optional adapters (operations #15) | X04-X06 clauses |
| F07: RC:58 collision tests (operations #24) | T09 |
| G01: supported filesystems and distributions; MCP pin list (operations #12/#72) | D03 clause, T03 clause |
| U01: expose later state through the API (contracts #38) | U13 |

## 1. New cards (38)

Each block is the exact generator line, ready to paste into `raw` in scripts/generate_task_plan.py (suggested position: after the last existing card with the same letter). `Phase` is the card's dependency level in the resulting DAG; `Unblocks` lists the cards that will depend on it (including the dependency edits in section 1b).

| ID | Parent | Title | Phase | Unblocks | Merged from (report suggestion) |
| --- | --- | --- | --- | --- | --- |
| F08 | N03 | Declare harness capabilities and enforce per-task recovery requirements | 14 | H12 | readme-1 F08 |
| F09 | N02 | Implement per-OS secret store backends | 21 | T03, U08, P05 | operations F08 |
| S10 | N04 | Implement task contracts and the task dependency graph | 22 | Q01, R03, R05 | readme-1 #4/#27 (S01 clauses), contracts #12, readme-3 #48/#51, operations #19 (S08 part) |
| C08 | N07 | Implement owner decision records and correction propagation | 27 | M02, Q02, C09, U13, M06, Q04 | readme-1 C08, readme-3 U08+C08, operations C08, contracts #15/#16 |
| C09 | N07 | Capture activity records and decision explanations | 28 | U09, U13 | readme-1 C09, readme-3 U09 (capture part), operations U09 (capture part) |
| U09 | N09 | Implement read-only activity timeline and replay views | 29 | X03 | readme-1 C09/U09, readme-3 U09, operations U09 |
| A07 | N06 | Implement action classes, default policy and effective-policy view | 23 | U04, X02, U08, P05 | contracts A07 (#17/#20/#21), readme-1 #37 |
| A08 | N06 | Implement per-agent environments | 25 | B04, A09 | readme-2 A07 (env part), readme-3 A07, operations A07, readme-1 #3 |
| A09 | N06 | Implement reviewed environment changes and maintenance requests | 29 | X02 | readme-2 A07 (maintenance part), operations A07 (review part) |
| A10 | N06 | Implement private-record inspection and cross-project information boundaries | 25 | X02, U09 | contracts A08/#19, readme-1 #74/#75/#77 (C01 clauses) |
| L06 | N05 | Implement team and system shutdown, reboot and resume policy | 30 | X01, X03, K07 | readme-2 L06, readme-1 #7, readme-3 #54, contracts #7, operations #34 |
| H11 | N10 | Implement agent, team and role records | 24 | V01, A08, A10, L06, R03, U08, U10, T09, P06 | readme-1 S10, contracts O01, operations S10/#22, readme-3 #21/#61 |
| H12 | N10 | Implement the local worker runtime and attempt dispatcher | 25 | H02, P02, P03, X01, T06 | contracts H11/#14/#51, readme-1 #29/#33 |
| H13 | N10 | Implement event source adapters and watchers | 26 | X03, P04 | readme-3 #43-46, readme-1 #11, contracts #46 |
| R03 | N08 | Implement difficulty profiles and escalation | 26 | X03, U08 | readme-2 R03, readme-1 #4, operations #6 |
| R04 | N08 | Implement provider drain, cutover and failback policy | 27 | X03 | readme-2 R04, operations #16/#35, readme-3 #78 |
| R05 | N08 | Implement cost and resource attribution and delegated budgets | 26 | H10, U07, B01 | readme-3 R03, operations #33/#44/#45 |
| U08 | N09 | Implement settings and administration views | 31 | X03, T08 | operations U08, readme-1 U08 |
| U10 | N09 | Implement layered configuration, effective values and change history | 25 | U04, U08, U11 | operations #2/#3/#4/#53, readme-1 #5 |
| U11 | N09 | Implement owner notifications | 26 | X03, K07 | operations U10 |
| U12 | N10a | Implement agent messages, delivery classes and interruption budget | 28 | X03 | readme-2 U08, readme-1 #8/#12/#76, contracts #42, operations #18 |
| U13 | N07a | Expose lifecycle, decisions, deliverables and activity through the state API | 34 | X03 | contracts U08 (#38) |
| M03 | N12 | Implement stand-up preparation, briefs and agenda items | 28 | X03 | readme-3 M03, readme-1 #9 |
| M04 | N12 | Implement meeting attendance and return to work | 28 | M05 | readme-3 M04, contracts #8/#9 |
| M05 | N12 | Implement meeting facilitation and owner control | 29 | X03 | readme-3 M05 |
| M06 | N12 | Implement meeting procedure, roster, quorum and ballots | 29 | X03 | readme-3 M07, readme-3 #11/#15-17, contracts #32, operations #39 |
| T06 | N13 | Implement the protected agent tool bridge and execution service | 26 | C09, A09, M06, T07, T08, T09 | readme-2 T06, operations #26/#27 |
| T07 | N13 | Implement durable job records and job control | 27 | L02, X01 | readme-2 T06 (jobs), contracts #3, operations #9/#71 |
| T08 | N13 | Implement shared toolbox audiences, personal copies and patch proposals | 32 | X02 | readme-2 T07, operations #25, readme-2 #10 |
| T09 | N13 | Implement command namespaces and alias dispatch | 27 | X02 | operations T06/#24, readme-2 F08 |
| P04 | N14 | Implement ongoing responsibility checks, incidents and coverage | 30 | X03 | readme-1 P04 (#39-47), contracts #28, operations #14 |
| P05 | N14 | Implement external contribution and pull-request workflow | 33 | X02 | readme-1 P05, contracts P04, operations #38, readme-3 #70 |
| P06 | N14 | Implement project and agent retirement and archival | 31 | X03 | readme-3 P04 |
| P07 | N14 | Implement simulation mode | 33 | X03 | readme-3 P05 |
| Q04 | N15 | Implement defect tracking, review cycles and overrides | 35 | X03 | readme-1 Q04 (#50/#51/#53) |
| K06 | N17 | Implement retention, quotas, archive, export and deletion | 30 | X01, P06 | contracts K06, operations K06, readme-1 #71 |
| K07 | N17 | Implement maintenance windows and update orchestration | 32 | X08, G11 | operations K07 (#56-63) |
| G11 | N03 | Qualify the Pi Durable runtime upgrade path | 33 | X08 | operations G11 (#64/#65), readme-2 #27 |

### F08 — Declare harness capabilities and enforce per-task recovery requirements

- Parent N03; blockers F06, S02; phase 14; unblocks H12.
- Implements: README:59,85-87,193.
- Replaces report suggestions: readme-1 F08.

```
F08|N03|Declare harness capabilities and enforce per-task recovery requirements|F06,S02|Harness adapter capability declaration (native continuation, portable reconstruction, checkpoint export, abort semantics) with the Pi declaration taken from the G02 record, and a per-task recovery requirement checked at admission (README 59, 85-87, 193)|A fake second harness passes the same contract suite through its declaration; admission refuses a durable task whose recovery requirement the selected harness lacks, with a visible reason; a harness without state export is marked unsupported for durable tasks; the Pi declaration matches the G02 record including its unsupported capabilities; only the Pi adapter is a shipped harness unless the owner widens scope
```

### F09 — Implement per-OS secret store backends

- Parent N02; blockers F02, A01; phase 21; unblocks T03, U08, P05.
- Implements: PO:31,75.
- Replaces report suggestions: operations F08.

```
F09|N02|Implement per-OS secret store backends|F02,A01|Secret backends behind the F02 secret-reference resolver: macOS Keychain, Windows Credential Manager/DPAPI, Linux Secret Service with a documented, permission-checked file fallback (portability-and-configuration 31, 75)|A secret is written through the API, chat or UI and never returned, echoed or logged; references resolve under the unattended service identity on macOS, Linux and Windows after logout and reboot; a missing or locked store fails with a clear error naming the reference; export and backup carry references only; a rotated secret is used from the next resolution without restart
```

### S10 — Implement task contracts and the task dependency graph

- Parent N04; blockers S01, S08, A02; phase 22; unblocks Q01, R03, R05.
- Implements: README:148,159,601; OC:17; PC:9; PS:65.
- Replaces report suggestions: readme-1 #4/#27 (S01 clauses), contracts #12, readme-3 #48/#51, operations #19 (S08 part).

```
S10|N04|Implement task contracts and the task dependency graph|S01,S08,A02|Versioned task contract fields (expected result, acceptance criteria, priority, difficulty, budget, P/PC class, required evidence, permissions) and task dependency edges with responsible agents, changed only by revisioned commands (README 148, 159; operational-contracts 17; production-and-capacity 9; pitfalls-and-safeguards 65)|A contract change creates a new revision with history; dependency cycles rejected; an agent without a grant cannot edit another team's dependencies or a task's difficulty; a wait-for graph across task dependencies, inquiries and reviews detects circular waits beyond reviewer cycles and opens a blocker naming who can unblock; a priority change takes effect at the next admission decision without rewriting history; a P/PC class change is an audited command needing planning authority; tasks created before the new fields keep working
```

### C08 — Implement owner decision records and correction propagation

- Parent N07; blockers C03, C07, U03, H06; phase 27; unblocks M02, Q02, C09, U13, M06, Q04.
- Implements: README:72,204,213-221,607,636,657,670; PS:81; OC:85-87; ORG:13,61; AUTH:67-71.
- Replaces report suggestions: readme-1 C08, readme-3 U08+C08, operations C08, contracts #15/#16.

```
C08|N07|Implement owner decision records and correction propagation|C03,C07,U03,H06|Owner decision records (source utterance, scope, version, supersedes, authenticated origin) kept apart from agent conclusions; links from plans, task contracts, reviews and pending actions to the decisions they rely on; a versioned context record of current decisions, permissions, pending questions and goals supplied by the C07 startup builder (README 72, 204, 213-221, 607, 636; pitfalls-and-safeguards 81; operational-contracts 85-87)|A correction supersedes only the conflicting decisions in its scope and is authoritative at once; dependent plans, reviews and queued actions are marked superseded, owning agents notified and each affected task's next action blocked until revalidated, including busy, paused and suspended agents on resume and after restart; completed external effects are recorded with corrective follow-up and never claimed undone; brainstorming, hypotheticals, quoted text and an agent's paraphrase create no decision and a decided choice is not re-asked; conflicting instructions on one decision from concurrent owner sessions or devices are surfaced and block the disputed action, never settled by arrival order or agent vote; a planning-only instruction or implementation hold is a binding gate that admits no work; agent agreement or a team vote cannot restore superseded guidance; superseded decisions stay visible marked non-authoritative; the context record and links to original wording survive repeated compaction
```

### C09 — Capture activity records and decision explanations

- Parent N07; blockers C04, C08, T06, S05; phase 28; unblocks U09, U13.
- Implements: README:237-247,608.
- Replaces report suggestions: readme-1 C09, readme-3 U09 (capture part), operations U09 (capture part).

```
C09|N07|Capture activity records and decision explanations|C04,C08,T06,S05|Unified per-step activity record (owner and agent messages, delivered instructions, retrieved source references, model and harness selections, tool inputs and results, approvals, artifact versions and diffs, compression events, branches, meeting decisions, lifecycle and ownership changes) holding the exact context manifest used at each step, plus decision-explanation records written at material choices (README 237-247, 608)|Each step stores the context references and versions actually supplied, including which summary; sensitive payloads are stored under access control and redactions and missing data are marked; decision explanations record alternatives, key evidence and uncertainty as user-facing statements, never chain-of-thought, and provider thinking or hidden reasoning is not captured as an explanation; an explanation requested later is a separate explicit operation, labelled retrospective, grounded only in records, and says so when the records cannot explain; corrections append provenance and never rewrite history; archived, deleted or unavailable ranges stay referenced and are marked unavailable
```

### U09 — Implement read-only activity timeline and replay views

- Parent N09; blockers C09, U05, A10; phase 29; unblocks X03.
- Implements: README:235-249,608; DD:37; PS:161.
- Replaces report suggestions: readme-1 C09/U09, readme-3 U09, operations U09.

```
U09|N09|Implement read-only activity timeline and replay views|C09,U05,A10|Summary-first timeline with step-through over C09 records in chat and the web UI: filters by agent, task, project and time, branch and related-agent navigation, and links to messages, diffs, comments, tool calls and artifacts (README 235-249, 608)|Opening or advancing replay causes zero tool executions, messages, job submissions or model calls (asserted against the effect ledger, router and outbox); a rerun or simulation is a separate command in an isolated scope (P07); each step shows the versions used then, not current records; proposed, dispatched, confirmed and uncertain outcomes are distinct and concurrent branch events are not shown as sequential; redactions and incomplete or intentionally unavailable ranges are marked; contemporaneous explanations are visibly distinct from retrospective ones; superseded decisions are marked non-authoritative; replay links, search, summaries and exports apply the same permission checks and the owner inspection policy (A10) and expose no credentials or other projects' records; "what evidence and instruction led to this change?" is answered with links; validated with a task branch, provider switch, compressed history, failed tool and later owner correction
```

### A07 — Implement action classes, default policy and effective-policy view

- Parent N06; blockers A02, A05, F02; phase 23; unblocks U04, X02, U08, P05.
- Implements: AUTH:3-19,37,48-51; OC:87; README:106.
- Replaces report suggestions: contracts A07 (#17/#20/#21), readme-1 #37.

```
A07|N06|Implement action classes, default policy and effective-policy view|A02,A05,F02|Action-class catalogue (inspect, mutate, external send, publish, spend, install executable, access change, commit, push, merge, deploy), the public tight default policy, presets (direct approval, delegated agent review, automatic) and strict, derived and autonomous profiles, an optional all-command human gate, grant fields for spend limit, environment, maintenance window, delegation allowance and conditions, and an effective-policy and preview query (authorization-and-delegation 3-19, 37; operational-contracts 87; README 106)|A fresh install requires direct approval for every consequential class; an unknown action goes to review, never auto-allowed; enabling the all-command gate gates every execution; drafting never publishes, and publish, external send and spend are granted separately per account and audience; an accepted proposal does not authorize downstream push, merge or deploy; relaxation scoped by environment, window or budget changes only that scope; a preset change keeps narrower human-review rules; a permissive project cannot weaken a locked installation restriction; effective policy shows source grants, inherited restrictions and effect time, and preview reports the practical effect before apply; a materially broader action, likely danger or unexpected spend needs a new decision while a standing grant survives handoff and restart without a prompt
```

### A08 — Implement per-agent environments

- Parent N06; blockers A03, T01, H11; phase 25; unblocks B04, A09.
- Implements: README:7,62,146,271,283-285,339-349,637,664,666; PS:87,93-95; DD:56.
- Replaces report suggestions: readme-2 A07 (env part), readme-3 A07, operations A07, readme-1 #3.

```
A08|N06|Implement per-agent environments|A03,T01,H11|Common maintained base plus per-agent persistent home, configuration, package area and skill library; environment manifest (installed versions, approved capabilities, configuration revisions) whose revisions are referenced by attempts and checkpoints, with package artifacts or reproducible inputs retained; per-agent CPU, memory, disk and process limits (README 62, 146, 339-349, 637; pitfalls-and-safeguards 87)|Changing agent A's environment leaves B's tools, configuration and files unchanged; each attempt and checkpoint records the environment revision it ran with and resumes on it after restart; rollback to a prior revision works; CPU, memory, disk and process-count limit fixtures enforced with headroom reserved for the controller; another agent's home is denied; protected extensions load only from controller-owned read-only artifacts and the loader configuration is not agent-writable; reserved-tool integrity is verified before an environment is accepted and activation stops on failure
```

### A09 — Implement reviewed environment changes and maintenance requests

- Parent N06; blockers A08, A05, H05, L02, T06; phase 29; unblocks X02.
- Implements: README:283,327,343-345,367-374; PS:87.
- Replaces report suggestions: readme-2 A07 (maintenance part), operations A07 (review part).

```
A09|N06|Implement reviewed environment changes and maintenance requests|A08,A05,H05,L02,T06|Durable environment-maintenance requests issued through the bridge, change-class policy (skill draft allowed and recorded; extension or executable dependency via preapproved catalogue or supervisor review; broader access via scoped review; host policy, protected rules and shared base via owner or administrator), disposable trial and staged activation (README 327, 343-345, 367-374)|The request returns a maintenance ID before the requesting worker is replaced; stage, trial in a disposable environment, Suspend without release, checkpoint, reload or restart, validate and restore, keeping session and compaction state and prior Pause or Suspend intent; failed activation rolls back; unsupported safe restoration leaves the change pending; install scripts never run before exact-artifact approval and run inside the boundary; the reviewer sees exact package version, source, access, install behaviour and rollback plan; standing permission causes no redundant approval; skills and extensions cannot self-grant; a supervisor role alone cannot change the protected base; a review outage leaves the change pending while the approved environment keeps working
```

### A10 — Implement private-record inspection and cross-project information boundaries

- Parent N06; blockers C02, A02, H11; phase 25; unblocks X02, U09.
- Implements: OC:91-95; README:247,253-257,261; ORG:15,59.
- Replaces report suggestions: contracts A08/#19, readme-1 #74/#75/#77 (C01 clauses).

```
A10|N06|Implement private-record inspection and cross-project information boundaries|C02,A02,H11|Owner inspection policy for agents' private desks and scratch (as decided by the owner before release), a trusted recovery-service principal, source-project labels on desk records and derived data, and per-task credentials for agents serving several projects (operational-contracts 91-95; README 247, 253-257, 261; organization-and-workers 15)|Owner inspection follows the recorded policy and is audited; the recovery service reads scratch and recovery records under a service principal no peer or conversation can use; a desk record carrying restricted-source references cannot be published into another project's scope; copies, embeddings, summaries and indexes inherit source restrictions; a record cites its original source identity and copied claims do not count as independent evidence; content read from another desk cannot be registered or executed as a skill or tool; credentials are issued per task, not per agent
```

### L06 — Implement team and system shutdown, reboot and resume policy

- Parent N05; blockers L02, L03, H08, U06, H11; phase 30; unblocks X01, X03, K07.
- Implements: README:65,116,191,382,398,404,420-429,605; PS:111; OC:43.
- Replaces report suggestions: readme-2 L06, readme-1 #7, readme-3 #54, contracts #7, operations #34.

```
L06|N05|Implement team and system shutdown, reboot and resume policy|L02,L03,H08,U06,H11|Lifecycle commands at agent, team and installation scope with explicit descendants and jobs, an aggregated shutdown readiness report, a reboot procedure, a resume-condition policy and an authenticated non-chat Stop and Force Stop command (README 65, 191, 382, 398, 404, 420-429, 605; pitfalls-and-safeguards 111)|Installation shutdown reports ready only when every affected agent and job is, listing unsettled and permitted remote jobs as tracked exceptions; bookkeeping after preparation completes with no model available, and the last model failing mid-preparation leaves a mechanically recoverable checkpoint and reports the missing briefing; reboot preserves assignments and pause intent and schedules no paused work; resume happens only on explicit owner action or a recorded authorized condition; gates at task, agent, team and installation scope stack and resuming one never lifts another; Stop and Force Stop work through the non-chat command with every model route down
```

### H11 — Implement agent, team and role records

- Parent N10; blockers A02, C01, R01, U01; phase 24; unblocks V01, A08, A10, L06, R03, U08, U10, T09, P06.
- Implements: README:7,59,86,91,142,155,255-257,523,626; OC:12,23,89; ORG:9,37; AUTH:17; RC:24,56-57; PS:29; PO:51; DD:28.
- Replaces report suggestions: readme-1 S10, contracts O01, operations S10/#22, readme-3 #21/#61.

```
H11|N10|Implement agent, team and role records|A02,C01,R01,U01|Agent records (durable computer-assigned ID, editable friendly name, roles, team, supervisor link, default execution profile, permitted overrides, environment selection, desk and inbox), team hierarchy, role templates mapped to capability bundles and explicit role-combination rules, created, edited and retired through revisioned state API commands (README 7, 59, 91, 142, 155, 257, 523; operational-contracts 12, 23, 89; organization-and-workers 9, 37; runtime-compatibility-and-namespaces 24, 56-57; portability-and-configuration 51)|A role name grants nothing beyond its capability bundle; parentage gives no write to a child's desk, no read of its scratch and no toolbox or release authority; conflicting combinations such as author and independent reviewer of the same work are rejected; parent cycles rejected; re-parenting or cross-team advice changes no task dependency or assignment; renaming keeps commands, queued targets, ownership and history; two agents with the same friendly name stay distinct; retired IDs are never reused; a clone or import gets a new ID and collisions are rejected; an agent keeps the same identity and desk when its model or harness changes; persona fields have no authorization effect; hierarchy changes are revisioned and audited
```

### H12 — Implement the local worker runtime and attempt dispatcher

- Parent N10; blockers A03, A05, R01, S05, C04, F08; phase 25; unblocks H02, P02, P03, X01, T06.
- Implements: OC:13,20,41,61,66-68; ORG:53; README:151,167.
- Replaces report suggestions: contracts H11/#14/#51, readme-1 #29/#33.

```
H12|N10|Implement the local worker runtime and attempt dispatcher|A03,A05,R01,S05,C04,F08|Local worker loop that takes an admitted attempt, launches the sandboxed worker (A03), selects a route (R01), runs the Pi adapter and sends every tool call through the A01 tool gate, A05 admission and the S05 effect ledger, with checkpoint capture (C04) (operational-contracts 13, 20, 61, 66-68; organization-and-workers 53)|An admitted attempt runs a real Pi turn with the scripted offline model; the attempt records harness, model route, policy, decision and environment revisions, worker version and expiry; every tool call, read-only and MCP included, gets a durable operation ID linked to project, task, agent and attempt with exact tool or server version, invocation, in-progress, confirmed, failed, cancelled or uncertain state, start and end, diagnostics and resource use, and restricted payloads are redacted in summaries; a tool call alone never marks progress; a call is refused when a gate, decision revision, budget, provider eligibility or grant changed; a stale generation cannot dispatch; a kill mid-tool resumes through the ledger with no duplicate effect; a failed attempt leaves the task outcome unchanged; H02 remote workers use the same dispatch contract
```

### H13 — Implement event source adapters and watchers

- Parent N10; blockers H06, H01, R02; phase 26; unblocks X03, P04.
- Implements: README:70,586-588,662; RR:11,39.
- Replaces report suggestions: readme-3 #43-46, readme-1 #11, contracts #46.

```
H13|N10|Implement event source adapters and watchers|H06,H01,R02|Event source adapters for timers, task completion, file and repository changes (watchers as hints), service failures and model availability feeding H06 subscriptions, and event-to-inbox scheduling of the owning agent (README 70, 586-588; resume-reconciliation 11, 39)|Each source produces deduplicated events with causation links; a subscribed event creates an inbox item that schedules the owning agent, subject to holds, to revise its plan; dropped or duplicated watcher events are still caught by the direct version check at resume; event payload text cannot invoke tools or grant authority; a self-triggering loop is detected and held; an event storm leaves unrelated work responsive; failed handling attempts can be listed and inspected from chat and API
```

### R03 — Implement difficulty profiles and escalation

- Parent N08; blockers R02, S10, H11; phase 26; unblocks X03, U08.
- Implements: README:9,67,74,148,441-453,662; PO:15,49.
- Replaces report suggestions: readme-2 R03, readme-1 #4, operations #6.

```
R03|N08|Implement difficulty profiles and escalation|R02,S10,H11|Difficulty-to-profile mapping separate from priority with no built-in provider defaults; profile fields for harness, provider, model, reasoning settings, context needs, tool permissions and spending limit; child escalation requests (README 9, 67, 74, 148, 441-453; portability-and-configuration 15, 49)|The parent-set difficulty selects the configured profile at dispatch and a changed mapping affects only the next dispatch; changing priority does not change the profile or the reverse; no tier implies locality, provider or model; a non-parent without a grant cannot set difficulty; a blocked or repeatedly failing child escalates within its delegated ceiling or to its parent; retry and total budgets stop an escalation loop; routing decisions and reasons are persisted and queryable
```

### R04 — Implement provider drain, cutover and failback policy

- Parent N08; blockers R02, L05; phase 27; unblocks X03.
- Implements: README:459-476,680; PS:119; DD:55; PO:93-94.
- Replaces report suggestions: readme-2 R04, operations #16/#35, readme-3 #78.

```
R04|N08|Implement provider drain, cutover and failback policy|R02,L05|Fallback-list validation for every model-using role including the coordinator and safety supervisor; exclusions at model, endpoint, account, provider and local-service level with alias resolution; persisted list position and attempt history; planned-drain and immediate-cutover modes; cooldowns and a separate failback policy (README 459-476; pitfalls-and-safeguards 119; design-decisions 55)|A role without a valid list is rejected at configuration; an alias to a disabled service is excluded; no recursion into a fallback's own list and no cycles; list position survives restart; drain reports routing applied, in-flight requests remaining and service safe to stop as separate facts, including when no local route is in use; cutover cancels in-flight attempts, rejects late responses and records possible outstanding charges; an account-wide block is distinguished from an endpoint failure; a tool error or bad answer does not trigger failover; an explicitly disabled route stays disabled despite probes; failback follows its own policy without flapping; local-only, cloud-only and mixed configurations exercised across restart
```

### R05 — Implement cost and resource attribution and delegated budgets

- Parent N08; blockers R02, H03, S10; phase 26; unblocks H10, U07, B01.
- Implements: README:604,638; PS:101; PC:19-21.
- Replaces report suggestions: readme-3 R03, operations #33/#44/#45.

```
R05|N08|Implement cost and resource attribution and delegated budgets|R02,H03,S10|Usage ledger attributing provider spend (currency) and local compute (occupied worker-slot time) to task, agent and project, atomic budget reservation across the task tree, delegated sub-budgets and a request-more-budget flow (README 604, 638; pitfalls-and-safeguards 101; production-and-capacity 19-21)|Spend is reserved before dispatch and reconciled to actual usage; concurrent children cannot spend the same allocation; uncertain in-flight and outstanding charges are shown; currency and compute are tracked separately; background jobs, meetings and supervision are attributed to their work or an explicit shared-overhead category; a request for more budget goes to the owner or delegated authority; provider ceiling enforceability is stated honestly
```

### U08 — Implement settings and administration views

- Parent N09; blockers U07, U10, A07, F09, H11, R03, T03; phase 31; unblocks X03, T08.
- Implements: PO:43-63,89-92; README:15,74; RC:52.
- Replaces report suggestions: operations U08, readme-1 U08.

```
U08|N09|Implement settings and administration views|U07,U10,A07,F09,H11,R03,T03|Browser settings views over the same configuration service as chat and API for providers, routes, local inference endpoints, difficulty profiles, agents and teams, approval policy, API access, operations, P/PC, MCP connections and secrets; later cards add their own areas to these views (portability-and-configuration 43-63, 89-92; README 15, 74)|A fresh install is configured entirely through the UI with no source edits and no target-repository files; UI and chat edits yield the same durable revision; editable, inherited and locked values are shown with their source; secrets are entered write-only; invalid values are rejected with path-addressed errors; compatibility and migration status shows affected agents and operations; settings persist across restart on macOS, Linux and Windows
```

### U10 — Implement layered configuration, effective values and change history

- Parent N09; blockers F02, R01, U01, H11; phase 25; unblocks U04, U08, U11.
- Implements: PO:63-73,93-94; DD:61; PS:35.
- Replaces report suggestions: operations #2/#3/#4/#53, readme-1 #5.

```
U10|N09|Implement layered configuration, effective values and change history|F02,R01,U01,H11|Controller-backed configuration service: layered precedence (installation, team or agent, task override) constrained by authority, effective-value resolver with source and lock state, drafts versus applied revisions with actor history, configuration-document to routing-table binding, combination validation and stated take-effect timing (portability-and-configuration 63-73, 93-94; design-decisions 61; pitfalls-and-safeguards 35)|Every value reports its effective source layer and lock state; a task override cannot re-enable a globally disabled provider or widen authority; history shows actor and revision; a draft is distinct from the applied revision and a failed apply is never shown active; each change states when it takes effect (next request, after the current operation, after Suspend and restart); fallback cycles, missing routes, a PC target outside its floor and ceiling and impossible time, resource or permission settings are rejected; the configuration document loads into the R01 routing table and UI reorder and supervisor reorder produce the same routing revision; reload preserves Pause, ownership and pending decisions
```

### U11 — Implement owner notifications

- Parent N09; blockers U02, S08, U10; phase 26; unblocks X03, K07.
- Implements: DD:75; PO:57; MU:28.
- Replaces report suggestions: operations U10.

```
U11|N09|Implement owner notifications|U02,S08,U10|Configured notification channel for blockers, review requests, owner questions, maintenance outcomes and presence or disconnection, using the delivery method the owner selects (design-decisions 75; portability-and-configuration 57; maintenance-and-updates 28)|Each listed event produces one notification linking to its record; delivery failure is visible and retried within a bound; duplicates coalesce; channel and quiet-hour changes apply from the next notification; notifications carry no secrets or restricted payloads; nothing is sent to an external service unless configured
```

### U12 — Implement agent messages, delivery classes and interruption budget

- Parent N10a; blockers U02, S08, L05, M01; phase 28; unblocks X03.
- Implements: README:61,68,153,177,185,259,482-491; API:19,25,29,45; PS:65-67.
- Replaces report suggestions: readme-2 U08, readme-1 #8/#12/#76, contracts #42, operations #18.

```
U12|N10a|Implement agent messages, delivery classes and interruption budget|U02,S08,L05,M01|Per-agent message envelope (task, sender, purpose, urgency, optional deadline, correlation ID) with sending, accepted, delivered, handled and answered states; delivery classes; focus periods, interruption allowance and coalescing (README 61, 68, 153, 177, 185, 259, 482-491; agent-apis 19, 25, 29, 45; pitfalls-and-safeguards 65-67)|Informational messages batch to the next check-in or stand-up; advice is read at the next safe boundary; a blocking dependency wakes only an eligible waiting task, never through a pause; urgent control interrupts only under sender authority and parent rank does not imply urgency; repeated updates coalesce; per-sender and per-recipient rate and queue limits and reply-loop bounds are enforced; a message or inquiry to a paused or suspended agent stays queued, does not wake it and reports queued or unavailable; an agent's question to the owner appears in owner chat with its task context and the answer resolves the linked wait; a request without a reply reaches its escalation path at its deadline; states survive restart
```

### U13 — Expose lifecycle, decisions, deliverables and activity through the state API

- Parent N07a; blockers U01, L02, Q01, C08, C09; phase 34; unblocks X03.
- Implements: API:9-17; README:167-171.
- Replaces report suggestions: contracts U08 (#38).

```
U13|N07a|Expose lifecycle, decisions, deliverables and activity through the state API|U01,L02,Q01,C08,C09|StateApi operations for lifecycle intent and observed execution state, checkpoints, decision records, deliverables, tool activity, message references, the project overview and event subscriptions (agent-apis 9-17; README 167-171)|Every listed object is readable, and writable where a command exists, with revision and provenance; the overview distinguishes paused assignee, unreachable worker, stale artifact and uncertain tool result with observation time and filters by project, task, agent, state and time under project and payload restrictions; long-running commands report accepted, queued, running, completed, blocked, failed or outcome-unknown; subscription cursors survive restart; the generated contract document stays current
```

### M03 — Implement stand-up preparation, briefs and agenda items

- Parent N12; blockers M01, C02, U03; phase 28; unblocks X03.
- Implements: README:69,499-501,531,539-543; PC:39-41,54; DW:13-19.
- Replaces report suggestions: readme-3 M03, readme-1 #9.

```
M03|N12|Implement stand-up preparation, briefs and agenda items|M01,C02,U03|Stand-up schedule configuration (time, IANA timezone, participant group, duration, daily window), advance notice, durable briefs, agenda ordering, supervisor-captured agenda items with request type and states, and improvement-backlog items with a timebox (README 69, 499-501, 531, 539-543; production-and-capacity 39-41)|Schedules follow real timezone and DST rules with one catch-up report after downtime; agents are notified to reach a safe boundary and each brief lists accomplishments over about 24 hours, unfinished work, blockers, advice needed and next priorities from records without waking paused agents; the agenda puts conflicts, questions and decisions first; a captured item is shown in chat and correctable; its request type (discussion, recommendation, delegated decision, instruction) sets its authority and a tentative idea is never executed; queued, scheduled, discussed, deferred and resolved states carry owner and outcome links; deferred items stay visible with reason and next step; outcomes return to the originating conversation; the planning agenda includes a P/PC balance review
```

### M04 — Implement meeting attendance and return to work

- Parent N12; blockers M01, L01, L05, H04; phase 28; unblocks M05.
- Implements: README:501,505,509,570-574,580; OC:45,103; PS:155.
- Replaces report suggestions: readme-3 M04, contracts #8/#9.

```
M04|N12|Implement meeting attendance and return to work|M01,L01,L05,H04|Bounded meeting task under a task-scoped Pause, participant states (preparing, present, unavailable, blocked), immediate-meeting rooms, wake rules and the end-of-meeting return policy (README 501, 505, 509, 570-574, 580; operational-contracts 45, 103)|Near a scheduled meeting, admission avoids starting work that cannot yield before it while safe long-running operations continue; joining keeps ownership and background work and never uses Suspend, handoff or Force Stop; the meeting task does not advance the paused assignment; an immediate meeting starts with available participants scoped to the current project or named team, asking first if scope is unclear; a saved brief is never shown as a live answer; "everyone required" waits for missing participants under a visible timeout; a schedule never wakes a paused agent, while a direct owner invitation allows bounded attendance with other work still paused; suspended or stopped agents are woken only with owner authorization; the meeting proceeds without the owner and a late joiner sees the state so far; at the end only assignments paused solely for attendance resume, earlier or newly requested pauses, suspensions and stops are kept and nothing is transferred; return revalidates decisions and ownership and a new priority may defer it without transfer; absent affected agents are notified and revalidate their next actions before continuing
```

### M05 — Implement meeting facilitation and owner control

- Parent N12; blockers M04, M02, U03; phase 29; unblocks X03.
- Implements: README:505-507,558,582; PS:155.
- Replaces report suggestions: readme-3 M05.

```
M05|N12|Implement meeting facilitation and owner control|M04,M02,U03|Facilitator floor control with bounded turns, time and spend limits, owner commands (ask one agent, address the team, change priorities, end the meeting), unresolved-question follow-ups and a waiting-on view (README 505-507, 558, 582)|Agents never answer all at once; an owner question preempts the active turn at a safe response boundary without undoing completed effects; the chair cannot silence the owner; targeted answers mark stale sources and separate proposed from completed actions; an unresolved question becomes an owned follow-up task; meeting duration and model-spend timeboxes are enforced and deep investigations become follow-up work; nonurgent items batch to the next meeting; chat and the console show whether the meeting waits on a person, agent or tool
```

### M06 — Implement meeting procedure, roster, quorum and ballots

- Parent N12; blockers M02, A02, C08, T06; phase 29; unblocks X03.
- Implements: README:507-519,527,553,557-566; PS:155,165-169; OC:99-101; ORG:11; DD:52-53.
- Replaces report suggestions: readme-3 M07, readme-3 #11/#15-17, contracts #32, operations #39.

```
M06|N12|Implement meeting procedure, roster, quorum and ballots|M02,A02,C08,T06|Fixed eligible roster per meeting, quorum and threshold configuration (defaults: majority quorum, ties fail; exact thresholds and seconding per owner decision), motions with exact wording, scope, rationale, affected tasks and versions, amendments, points of order with ruling and challenge, sealed initial positions, ballots with reasons cast through the bridge, and owner-present agreement rules (README 509-519, 527, 557-566; pitfalls-and-safeguards 155, 165-169; operational-contracts 99-101)|Duplicate sessions, newly created agents or late roster edits add no votes; without quorum only reports proceed and binding votes are deferred; the owner is not needed for quorum and absence is never approval; each ballot including an abstention carries a short reason and is bound to the motion version; a materially amended motion needs a fresh vote; the summary has an agent, vote and reason table; quorum cannot change mid-vote; no motion widens permissions or budgets, bypasses cleanup or overrides a recorded owner decision; an adopted in-scope motion is actionable while the owner is absent and an out-of-scope one stays a recommendation; with the owner present the chair asks for agreement, silence leaves the decision pending while unrelated work continues, an owner alternative needs no re-vote, and the vote and the owner's decision are separate records; owner join and leave are durable events, departure authorizes nothing and an outcome already executed is reported accurately on join
```

### T06 — Implement the protected agent tool bridge and execution service

- Parent N13; blockers H12, T01; phase 26; unblocks C09, A09, M06, T07, T08, T09.
- Implements: README:279-287,309,319-335; PS:7,93-95.
- Replaces report suggestions: readme-2 T06, operations #26/#27.

```
T06|N13|Implement the protected agent tool bridge and execution service|H12,T01|Protected Pi Durable extension loaded at worker start exposing stable NimbleNewt tools (desk access, task updates, communication, tool discovery, description and invocation; meeting ballots, job control and environment-maintenance requests are added by M06, T07 and A09) through the reserved namespace and wire-name mapping, and a controller-side execution service that validates structured arguments against the manifest and checks permission, budget, platform compatibility and revocation (README 279-285, 309, 319-335)|A script tool is created, registered and used in one conversation without a worker reload; new declarations appear at the next model-request boundary and never in a request already in flight; descriptions are fetched on demand, not loaded into every prompt; an active call finishes on its version while the next call uses the new one; a revoked version is refused at invocation despite a stale tool list; excessive permissions denied; model-supplied text is never concatenated into a shell command; the extension holds only the worker's scoped credential and no admin methods, and a tampered in-process extension cannot exceed the worker's grants or call services directly; personal extensions cannot disable or shadow the bridge; the replay-safe or idempotent flag comes only from the controller-approved manifest; restart recovery verified
```

### T07 — Implement durable job records and job control

- Parent N13; blockers T06, S05; phase 27; unblocks L02, X01.
- Implements: README:321,333; OC:21,39,47,75; PO:29,90; MCP:15.
- Replaces report suggestions: readme-2 T06 (jobs), contracts #3, operations #9/#71.

```
T07|N13|Implement durable job records and job control|T06,S05|Job records for long-running local and remote operations with their own state machine (admitted through outcome-unknown) and resumability class, durable handles with status, cancellation and tool checkpoint where supported, bounded output, logs and artifacts (README 321, 333; operational-contracts 21, 39, 47, 75; portability-and-configuration 29)|A long-running job returns a durable handle that survives worker and controller restart; operation ID, exit status, bounded output, logs and artifacts are recorded; a job record does not imply resumability; cancelling a model request, stopping a tool and stopping a remote job are separate recorded operations; on restart a live job is completed, cancelled, restarted from a tool checkpoint or recorded as a tracked exception; Pause keeps permitted background jobs running and records their results without unpausing; Stop and Force Stop terminate the whole process tree (job objects on Windows, process groups on POSIX) and orphaned children are reported; long-running MCP operations use the same records and a revoked connection blocks new calls
```

### T08 — Implement shared toolbox audiences, personal copies and patch proposals

- Parent N13; blockers T02, T06, M02, U08; phase 32; unblocks X02.
- Implements: README:297-315,343,627; PS:21-23; RC:32-34; OC:95.
- Replaces report suggestions: readme-2 T07, operations #25, readme-2 #10.

```
T08|N13|Implement shared toolbox audiences, personal copies and patch proposals|T02,T06,M02,U08|Scoped toolbox.manage permission tied to identity, audiences (role, team, project, all agents), /toolbox.* entries, read-only source inspection, personal copies with provenance, improvement proposals and maintainer decisions, platform compatibility in the catalogue, configured through the U08 views or chat (README 297-315, 627; pitfalls-and-safeguards 21-23; runtime-compatibility-and-namespaces 32-34)|The README 313-315 validation list passes (unauthorized publish or edit fails, eligible agents discover, excluded roles cannot invoke, edits to the original leave the shared release unchanged, survives author rename or retirement, update, revoke and rollback, escalation attempts fail, source inspection needs no manage permission, writes to a published artifact denied, a patch against an older base is rebased and rechecked, no private desk, history, credential or path exposure); a copy registers under the agent namespace with source tool ID, base version and digest, inherits no credentials or approvals and never shadows /toolbox.*; consumers stay on their pinned version until they opt in; deferred proposals are not listed as available; a meeting vote alone neither publishes nor grants toolbox.manage; toolbox.manage cannot touch protected commands; fork lineage is recorded so revocation notices reach forks
```

### T09 — Implement command namespaces and alias dispatch

- Parent N13; blockers T06, H11, U03; phase 27; unblocks X02.
- Implements: RC:13-28,56-58; README:269; PS:21; DD:57.
- Replaces report suggestions: operations T06/#24, readme-2 F08.

```
T09|N13|Implement command namespaces and alias dispatch|T06,H11,U03|Command dispatcher over the F07 registry: /nimblenewt.*, /toolbox.*, canonical /a_<id>.* agent prefixes and optional context-bound /agent.* and /custom.* aliases, resolved and bound before queuing, with UI actions and tool calls mapped to the same operation (runtime-compatibility-and-namespaces 13-28, 56-58; README 269)|The runtime-compatibility 56-58 cases pass; queued work stores the resolved canonical target; an ambiguous alias stays unresolved and asks; aliases resolve only in their bound context; renaming an agent changes no canonical command or record; operation ID, schema version, owner, revision and display name are kept separate; lowercase grammar with normalized or encoded collisions rejected and no last-installed-wins; agents cannot claim /nimblenewt.* or /toolbox.*; the provider wire-name mapping stays collision-free per provider
```

### P04 — Implement ongoing responsibility checks, incidents and coverage

- Parent N14; blockers P01, S08, H13, V01, L03; phase 30; unblocks X03.
- Implements: README:110-118; ORG:19,66-67; PO:9.
- Replaces report suggestions: readme-1 P04 (#39-47), contracts #28, operations #14.

```
P04|N14|Implement ongoing responsibility checks, incidents and coverage|P01,S08,H13,V01,L03|Responsibility records with managed resources, desired condition, availability need, check schedule and event sources, permitted actions, maintenance windows and escalation rules; deterministic check scheduler; observation and incident records; per-resource maintenance leases (README 110-118; organization-and-workers 19, 66-67; portability-and-configuration 9)|Each check produces a bounded task or a recorded observation, calling an agent only when interpretation or action is needed; checks are generated idempotently and survive host restart; intended state, observed state, last successful check and open incidents stay distinct and "no recent observation" is never shown healthy; repeated alerts group into one incident with bounded retries and escalation, preserved through restart; provider outages and NimbleNewt downtime show as coverage gaps with start, end and reason, and missed events are reconciled on return; a second agent's update to the same resource blocks visibly on the lease; failed validation triggers authorized rollback or escalation, both recorded; Suspend checkpoints the responsibility without stopping the managed service and Suspend and Release names the new monitor owner; pausing the maintenance agent keeps queued alerts and ownership; a remote host is managed through an approved tool with no worker enrolled on it
```

### P05 — Implement external contribution and pull-request workflow

- Parent N14; blockers P02, A06, A07, T03, F09; phase 33; unblocks X02.
- Implements: README:229-233,645,668; ORG:27-29,64; PS:149.
- Replaces report suggestions: readme-1 P05, contracts P04, operations #38, readme-3 #70.

```
P05|N14|Implement external contribution and pull-request workflow|P02,A06,A07,T03,F09|Contribution adapter (push, open and revise PR or MR, read review and CI status) behind separate action scopes, repository-instruction discovery, pre-submission diff check and linked multi-repository change sets (README 229-233, 645, 668; organization-and-workers 27-29, 64; pitfalls-and-safeguards 149)|Existing contribution guides and instruction files are discovered and applied without adding NimbleNewt conventions; the checkout's starting state is recorded; an automated diff check blocks unrelated files, NimbleNewt state, ignore-rule edits and secrets before commit or PR; the requested PR contains only intended files and keeps unrelated local work; a local edit grant does not permit push, PR or merge, and owner approval does not bypass branch protection or CI; revision after review comments works; attribution is accurate; each push and PR is an effect-ledger operation; a multi-repository change set records review order, shows partial completion and is resumable, never treated as atomic
```

### P06 — Implement project and agent retirement and archival

- Parent N14; blockers P01, H11, L03, K06; phase 31; unblocks X03.
- Implements: README:611; OC:91; ORG:15.
- Replaces report suggestions: readme-3 P04.

```
P06|N14|Implement project and agent retirement and archival|P01,H11,L03,K06|Retirement commands for projects, agents and responsibilities that release resources, revoke execution access and archive records (README 611; operational-contracts 91)|Archived records stay searchable under the same access rules; active resources, leases and worker slots are released; execution grants and credentials are revoked; retirement is refused while live assignments remain unless they are released or transferred first; a retired agent's ID is never reused and its records are retained per the retention policy; an archived project can be restored
```

### P07 — Implement simulation mode

- Parent N14; blockers P03, R02, T03; phase 33; unblocks X03.
- Implements: README:245,612.
- Replaces report suggestions: readme-3 P05.

```
P07|N14|Implement simulation mode|P03,R02,T03|Isolated simulation scope where a workflow runs against simulated tools, events and providers before real write access is granted (README 612, 245)|A workflow runs end to end against simulated tools and events including provider failure and competing edits; no real write, send or spend is possible in the scope (asserted against the effect ledger); results are labelled simulated; the owner grants real access separately; replay reruns use the same isolated scope
```

### Q04 — Implement defect tracking, review cycles and overrides

- Parent N15; blockers Q02, C08; phase 35; unblocks X03.
- Implements: README:122-136.
- Replaces report suggestions: readme-1 Q04 (#50/#51/#53).

```
Q04|N15|Implement defect tracking, review cycles and overrides|Q02,C08|Defect records (severity, evidence, responsible agent, resolution), bounded repair and review cycles, escalation of unresolved disagreements and explicit owner override records (README 122-136)|A defect links to the version and finding; after the configured number of repair and review cycles it escalates to the owner; an owner override records the decision and the remaining findings and a failed check is never rewritten as passed; a QA agent that commits a fix becomes a contributor and cannot approve it; periodic and incident-triggered reviews run without interrupting contributors; chat answers what has been checked, what waits for QA and team-wide risks with evidence links
```

### K06 — Implement retention, quotas, archive, export and deletion

- Parent N17; blockers K01, S06, C02; phase 30; unblocks X01, P06.
- Implements: OC:129; PS:125; README:247,641; DD:73; PO:57.
- Replaces report suggestions: contracts K06, operations K06, readme-1 #71.

```
K06|N17|Implement retention, quotas, archive, export and deletion|K01,S06,C02|Retention, export and deletion policy and runner covering derived data (summaries, indexes, caches) and backups, per-agent and per-project storage quotas, and reserved capacity for shutdown and recovery records (operational-contracts 129; pitfalls-and-safeguards 125; README 247, 641; design-decisions 73)|Material referenced by a resumable task or by replay is never deleted and shows as retained; a user-requested deletion removes or marks derived summaries, indexes and cached replies and records how backups are handled; export excludes secrets; archived work restores; with the disk near full the next checkpoint and shutdown and recovery records still write and a disk-full checkpoint is never reported successful; quotas enforced with visible warnings; retention configurable
```

### K07 — Implement maintenance windows and update orchestration

- Parent N17; blockers K02, K01, L06, U11; phase 32; unblocks X08, G11.
- Implements: MU:3-44; PO:61.
- Replaces report suggestions: operations K07 (#56-63).

```
K07|N17|Implement maintenance windows and update orchestration|K02,K01,L06,U11|Maintenance windows (timezone, duration, scope, channel, exact version, authorization, preparation limits, health deadlines, rollout status, rollback eligibility, failure history) set via chat and UI, and the Prepare, Quiesce, Checkpoint, quarantined Activate, Verify and Commit-or-revert sequence (maintenance-and-updates 3-44)|A delayed window never deploys at an unrelated time; Prepare verifies the artifact, tests migration on an isolated copy with fake services and checks space; Quiesce uses Suspend without release and defers and reports rather than silently Force Stopping; input acknowledged during downtime is kept in an independent compatible inbox or unavailability is reported; activation is quarantined with dispatch and effects disabled and a single writer; verification runs startup, registration, a local admin request and a fake task, checkpoint and restore cycle; revert terminates the candidate process tree, restores state and verifies the old release; an updater crash or reboot recovers from the journal; a failed artifact is quarantined with no update/rollback loop and the owner is notified; both releases failing enters bounded recovery mode; cancelled maintenance clears only its own gates; the maintenance-and-updates 44 fault matrix passes on macOS, Linux and Windows
```

### G11 — Qualify the Pi Durable runtime upgrade path

- Parent N03; blockers G03, F07, K07; phase 33; unblocks X08.
- Implements: RC:38-61; README:269.
- Replaces report suggestions: operations G11 (#64/#65), readme-2 #27.

```
G11|N03|Qualify the Pi Durable runtime upgrade path|G03,F07,K07|Runtime upgrade procedure: upstream inventory and explicit compatibility map, registry check including native commands and wire names, fixtures with paused and suspended agents, pending decisions, queued commands, interrupted effects and branches, and staged version-set activation (runtime-compatibility-and-namespaces 38-61; README 269)|An unknown mapping blocks activation; a name-only mapping fails when semantics change; a native collision blocks activation; the G02 and G03 suites, a reserved-name conflict scan and rollback to the previous pinned runtime run before activation; the full version set is recorded with each environment and checkpoint and old-version metadata is retained for long-suspended work; agents resume only after verification; run on macOS, Linux and Windows with fake services
```

## 1b. Dependency edits to existing cards

Needed so every new card reaches the single leaf D04 (plan.test.mjs requires exactly one root G01 and one leaf D04) and so ordering is right. All targets are `planned` cards; no implemented card gains a blocker (plan.test.mjs requires an implemented card's blockers to be implemented).

| Existing card | Add to dependencies | Reason |
| --- | --- | --- |
| H02 | H12 | remote workers use the local dispatch contract |
| P02 | H12 | coding work runs on the worker runtime |
| P03 | H12 | non-code work runs on the worker runtime |
| L02 | T07 | Suspend/Stop inventory and process-tree termination use job records |
| M02 | C08 | motions are checked against owner decisions |
| Q01 | S10 | submission checked against the task contract revision |
| Q02 | C08 | work bound to a superseded decision fails review |
| T03 | F09 | MCP credentials resolve through OS secret stores |
| U04 | A07, U10 | policy editing uses action classes and the configuration service |
| U07 | R05 | cost views |
| V01 | H11 | concerns route to the responsible supervisor |
| H10 | R05 | children spend delegated sub-budgets |
| B01 | R05 | P/PC accounting on slot time and attribution |
| B04 | A08 | experiments run in disposable environments |
| X01 | H12, T07, K06, L06 | crash campaign covers worker runtime, jobs, retention and shutdown |
| X02 | A07, A09, A10, T08, T09, P05 | adversarial campaign covers policy classes, environments, private records, toolbox, command namespaces, contributions |
| X03 | U09, U11, U12, U13, M03, M05, M06, R03, R04, P04, P06, P07, Q04, U08, H13, L06 | chat-only workflow exercises the new product features |
| X08 | K07, G11 | soak and audit cover maintenance windows and runtime upgrade |

Result: levels change only for H02 (22 to 26) and H07 (23 to 27); the longest chain stays 46 cards (G01 ... B05, X03, X04, X07, X08, D03, D04) and the phase count stays 46.

## 2. Clause additions to existing cards

Only `planned` cards receive clauses. Suggestions the reports made for implemented cards (S01, S02, S04, S08, R01, A02, A05, C01, C02, H03, H04, F02, F03, F07, G01, U01) are redirected to new cards (see the redirect table below), because changing an implemented card's acceptance would make its recorded status untrue. Deliverable appends start with `; ` and are concatenated to the end of the existing deliverable; acceptance appends are added after `; ` at the end of the existing acceptance.

- **G06** (operations #8; PO:28,90)
  - Deliverable append: (none)
  - Acceptance append: `; path cases include Unicode, case-insensitive collisions, drive roots, paths over 260 characters and junctions`
- **G09** (readme-1 #21; operations #29; README:211; PS:45)
  - Deliverable append: (none)
  - Acceptance append: `; continuity is also validated across a provider change and the correction of an old owner decision; the resume record labels native restore, reconstruction or restart`
- **A04** (readme-2 #34/#35 (GAP #35); contracts #50; operations #8; README:357-359; RR:32)
  - Deliverable append: (none)
  - Acceptance append: `; .git protection also covers deletion, replacement, renaming, truncation, permission changes, ancestor move or delete and both the worktree .git entry and the backing metadata; agent-written hooks or Git configuration never run with service privileges; a rejected conditional write keeps the pending change for review; Unicode, case-insensitive collisions, drive roots, long paths and Windows junctions handled`
- **A06** (contracts #26; AUTH:39; ORG:21)
  - Deliverable append: (none)
  - Acceptance append: `; attribution also records grant source, commit identity and later integration history; externally verified review references are accepted; no forged authorship`
- **C03** (contracts #43/#45/#47; readme-2 #32; operations #70; RR:9,13,41; MCP:13)
  - Deliverable append: (none)
  - Acceptance append: `; dependency kinds include decisions, shared records, tool and environment versions, external resources and negative lookups; MCP resource reads are recorded with server, URI, hash or ETag and observation time; external dependencies use conditional reads or authoritative queries, otherwise freshness uncertainty is recorded`
- **C04** (readme-1 #18; readme-2 #9/#43; readme-3 #68; README:205,414,641)
  - Deliverable append: `; the manifest also holds summary lineage, source ranges, compression state, branch relationships, message cursor, routing and environment revisions and adapter metadata, with credentials only as references`
  - Acceptance append: `; resume after restart and after a model change continues the same conversation identity; a disk-full or failed durability check never yields a checkpoint reported complete; no secret appears in a checkpoint`
- **C05** (readme-2 #47; readme-1 #34; README:155,435-437)
  - Deliverable append: (none)
  - Acceptance append: `; a branch records its return destination, which persists until resumed or explicitly changed and survives a newer urgent task; a delegated child task receives only selected context references, not a fork of the parent context`
- **C07** (readme-1 #19/#20; operations #30; README:206-207; PS:47; DD:70)
  - Deliverable append: (none)
  - Acceptance append: `; the budget reserves the expected response size; falling back to a smaller-window route rebuilds the context view and blocks with a visible reason if essential constraints do not fit; a second compressor on the same context is refused at registration; summary lineage is recorded and earlier owner decisions stay retrievable after repeated compactions and after model fallback`
- **L01** (contracts #4/#7/#8/#39; readme-3 #77; OC:37-45; API:19; README:677)
  - Deliverable append: (none)
  - Acceptance append: `; observed execution state (pausing, stopping, recovery-required, unreachable) is recorded apart from lifecycle intent; agent-level Pause spans all the agent's task contexts while a task-level Pause still allows a separately authorized response or meeting task; a manual Pause never gains an automatic return; queued messages and state updates reach a paused agent's inbox without resuming it; each request records actor, scope, mode, operation ID and policy revision; a paused agent keeps its tasks despite an idle replacement, an urgent deadline or elapsed time`
- **L02** (contracts #5/#6 (GAP #6); readme-2 #16/#37-39/#41/#44/#45; readme-3 #79; OC:41; README:382-398,416-425,683)
  - Deliverable append: (none)
  - Acceptance append: `; Stop leaves assignments unchanged and never cancels the task goal; task cancellation needs task-scoped authority and settles or reports pending and uncertain effects and children while keeping history; stopping, stopped and recovery-required are separate from task completion, completed preparation is reused and Stop never resumes execution to shut down; cleanup has a configured deadline and spend budget and may use an eligible backup model; an unsettleable operation offers wait, restart from an earlier boundary or Force Stop and is never labelled safely suspended to meet a deadline; only scoped cleanup runs during preparation; the inventory covers foreground operations, local processes, T07 jobs and delegated child work; Suspended is reported only after checkpoint and artifact durability checks pass; agent-originated lifecycle requests without the grant are refused; Stop during preparation, model loss during cleanup and deadline expiry are tested and restart reports graceful versus forced`
- **L03** (readme-2 #42; readme-1 #36/#45; contracts #10; operations #54 (GAP); README:104,410-412; OC:117; DD:59)
  - Deliverable append: (none)
  - Acceptance append: `; the handoff package carries brief, acceptance criteria, exact versions, outstanding questions, audience, completed and unfinished work, drafts, uncommitted changes, results, background operations, locks released or transferred, risks and next action within sharing scope and without wholesale private scratch; handoff readiness is reported explicitly; forced takeover or authorized emergency reassignment needs fenced exclusive authority and is a visible exception listing missing cleanup and uncertain effects; a temporary reassignment may carry an authorized auto-return that re-checks eligibility and keeps manual holds; responsibilities are released like tasks`
- **L04** (readme-1 #22; contracts #48/#49; operations #28; readme-3 #64; RR:21-26; PS:43; README:193,630)
  - Deliverable append: (none)
  - Acceptance append: `; resume records whether native history or reconstruction was used and its fidelity limits; resume statuses collecting, verifying, reviewing, ready, blocked and executing carry the verified revision set; a permission-filtered delta packet shows old and new versions and affected assumptions with a recorded relevance verdict and rationale; unchanged dependencies avoid a rebuild; bounded retries surface churn as a blocker; missing critical context yields a typed blocker; a deep-history constraint is recovered after restart on a different model route`
- **H02** (contracts #29 (GAP)/#31; ORG:39,43,47,73)
  - Deliverable append: `; workers use the H12 dispatch contract and negotiate a controller-worker protocol version`
  - Acceptance append: `; relocating an attempt to another host fences the old attempt, transfers checkpoint and artifacts with integrity checks and refuses when platform, path, credential or data-location policy is unmet; the native Pi store has one exclusive owner host; an incompatible worker protocol version is refused visibly`
- **H05** (contracts #22-25 (GAP #25); readme-1 #52; operations #31; readme-3 #65; AUTH:25-43; PS:73; README:132,634)
  - Deliverable append: (none)
  - Acceptance append: `; a review request carries tool version, arguments, working directory, environment revision, affected resources, script hashes, expected effects, authority source, budget and bounded context with secrets redacted, and missing essential context forbids allow; verdicts are allow, deny, request-context or requires-owner-decision; a reviewer reaches a safe boundary and pauses its own task without reassignment, and held reviewers are never woken; requests carry a deadline and escalation and block only the gated change; a reviewer who commits to the version under review becomes a contributor and cannot approve it; queue delay, latency, false blocks, missed hazards and cost are recorded; a redundant request matched to an existing grant is cleared with recorded authority and a mandatory human gate is never converted to an agent gate`
- **H06** (operations #19; readme-3 #45; README:588; PS:65)
  - Deliverable append: (none)
  - Acceptance append: `; per-subscription cooldowns; the causation chain is recorded and self-triggered loops suppressed; producers are slowed when queues are full`
- **H07** (contracts #30; ORG:39,43)
  - Deliverable append: (none)
  - Acceptance append: `; placement filters on data-location policy and repository access, and credentials are delivered per attempt only to eligible hosts`
- **H10** (readme-2 #48; README:441)
  - Deliverable append: (none)
  - Acceptance append: `; parents assign outcomes and acceptance criteria and children spend only sub-budgets delegated through R05`
- **U02** (readme-2 #57; contracts #40/#41; operations #17/#18; API:25-27; ORG:41; PO:58; README:480)
  - Deliverable append: (none)
  - Acceptance append: `; remote exposure is opt-in with local binding by default and TLS; scoped revocable client credentials for external agents, with the authenticated client recorded apart from the claimed sender; an external client gains no tool, task or filesystem capability; sender, recipient discovery, project scope, message type and delegated authority are checked, content is treated as untrusted and action requests go to authorization; request rate and size limits and backpressure; a paused or stopped agent's lifecycle gate applies to API calls`
- **U03** (readme-1 #24-26 (GAP #26); readme-2 #29; contracts #12; operations #37; readme-3 #69; README:169,177-181,271,644; AUTH:67; PS:143)
  - Deliverable append: `; a persistent coordinator agent (controller-managed, with its own grants, fallback list and lifecycle controls) answers from records and opens inquiries only when records are insufficient; proposal records; chat commands for agent, team and task-contract records`
  - Acceptance append: `; a drafted project or assignment is saved as a proposal and nothing is admitted until an explicit request applies it; per-project conversation context is retained across switches and changing focus never retargets a running task; every dispatched task carries an explicit project and checkout; the controller keeps working when the coordinator is unavailable; the coordinator decomposes an outcome into tasks with dependencies and proposes or, if granted, makes assignments`
- **U04** (contracts #37; API:7; AUTH:69)
  - Deliverable append: (none)
  - Acceptance append: `; a direct API or UI edit appears in the next agent context build; forwarded messages record authenticated origin and forwarding agent separately; policy edits use the A07 action classes and the U10 configuration service`
- **U05** (readme-1 #8/#10 (GAP)/#16/#30; readme-3 #44/#49/#75; operations #73; README:169,221,259,599,669; MCP:23-25)
  - Deliverable append: (none)
  - Acceptance append: `; answers what changed since a given time, which tools were used (MCP server and capability included) and what was delivered, with links; the overview filters by project, agent and state and shows observation time, freshness and uncertainty; routine status comes from records without waking workers and stale reports are flagged; a blocker shows its kind (technical, enforced permission, policy conflict) and resolution route, and a supervisor or team preference cannot be a blocker on an owner-decided outcome; a permission-filtered noticeboard summarizes current assignments, latest stand-up reports and deliverables with links to owner desks; the failed-event queue can be listed and inspected`
- **U06** (contracts #35; OC:127)
  - Deliverable append: (none)
  - Acceptance append: `; Force Stop and provider or route exclusion work without a model; replies distinguish received, accepted, activated and effected`
- **U07** (readme-3 #53; README:605)
  - Deliverable append: `; blocker and cost views`
  - Acceptance append: (none)
- **V01** (contracts #33; OC:109)
  - Deliverable append: (none)
  - Acceptance append: `; signals include request duration, last step, repeated equivalent actions and errors, job status, budget and acceptance evidence; concerns route to the agent's responsible supervisor (H11); thresholds depend on difficulty; suspected stalls are shown apart from confirmed failures`
- **V02** (contracts #33/#34; OC:109-121)
  - Deliverable append: (none)
  - Acceptance append: `; switching model or context never resets cumulative retry, time or cost limits; supervisors are subject to the same detection; an intervention and queued input are persisted before a stuck request is cancelled, and a resume on a backup route or rebuilt context records what context was carried`
- **M02** (readme-3 #14/#22/#29/#30/#31 (GAP)/#32 (GAP)/#39/#73; operations #39; README:509,525,547-549,578; PS:155)
  - Deliverable append: (none)
  - Acceptance append: `; the summary lists attendance, key updates, decisions with reasons and links to the discussion, dissent, unresolved questions, actions and plan, and separates adopted from applied; a full-discussion view sits beside it and answers why a decision was taken from the record; transcript and summary stay durable and access-controlled when the meeting is interrupted or the summarizer fails; entries are typed (motion, amendment, ruling, vote, correction) and corrections are linked updates; decisions apply with expected revisions and a conflict shows as not applied; a conclusion published from private records is marked unverifiable when its source cannot be shared and asking for rationale grants no desk access; stand-up plans persist`
- **T01** (readme-2 #5; operations #13; README:319,343; PO:32)
  - Deliverable append: `; manifest schema (purpose, input and output schema, entry point, interpreter, OS and architecture, dependency versions, requested access, resource limits, cancellation and recovery behaviour)`
  - Acceptance append: `; a skill without an executable grant cannot run anything; a tool unavailable on a host reports why before run time`
- **T02** (contracts #19; readme-3 #62; OC:95; README:627)
  - Deliverable append: (none)
  - Acceptance append: `; revocation applies the configured policy to in-flight operations and a personal fork of a revoked tool gains no authority; non-maintainer publication is refused and rollback to a prior release works`
- **T03** (readme-2 #30/#31 (GAP); operations #67/#68 (GAP)/#69/#72 (GAP)/#73; contracts #43; readme-3 #50; README:291-293,600; MCP:7-25)
  - Deliverable append: `; connection record (protocol and transport version, trusted administrator, audience, scope, allowed capabilities) covering tools, resources and prompts; supported MCP revision, transport and SDK pin list`
  - Acceptance append: `; local servers launch through the A03 launcher with only granted environment variables and no inherited secrets and remote servers need TLS and scoped credentials; each call is pinned to server identity, protocol version and catalogue revision or records observation time and uncertainty, checks the lifecycle gate first and appears in task-linked activity with server, capability, outcome and uncertainty for permitted readers; resource reads enter C03 manifests; protected tools work with no MCP server`
- **T05** (contracts #44; API:46)
  - Deliverable append: (none)
  - Acceptance append: `; a protocol-version upgrade preserves thread IDs, cursors and audit history`
- **P01** (readme-1 #28 (GAP)/#54; contracts #11; operations #55 (GAP); README:73,161,227; OC:55; DD:11)
  - Deliverable append: `; optional workstreams, milestones and due dates and authorized participants on the project record`
  - Acceptance append: `; passing a due date changes no progress state; one repository bound to two projects with separate access scopes; a moved or same-named checkout does not redirect a task`
- **P02** (readme-1 #55; operations #38; README:227; PS:149)
  - Deliverable append: (none)
  - Acceptance append: `; the task workspace admits only repositories in the task's access scope and records the initial working state`
- **Q01** (readme-1 #32/#38; contracts #13; readme-3 #48; README:97,165; OC:59)
  - Deliverable append: (none)
  - Acceptance append: `; draft, submitted, under-review, accepted, rejected and superseded are distinct versioned events; the deliverable records type, responsible agent, audience and access scope; an operational outcome can be a deliverable with verifiable reference, system version and observation time; source and exported artifacts can be grouped under one version; submission is checked against the task contract revision in force (S10)`
- **Q02** (readme-1 #14 (GAP)/#48/#49/#53; README:122-136,215)
  - Deliverable append: `; review policy (scope, triggers including periodic and incident, required checks, whether independent review gates completion) and a project QA view`
  - Acceptance append: `; a verdict cites the current acceptance-criteria and decision revisions and a rejection must cite an unmet owner requirement; a team vote cannot override an owner decision and work bound to a superseded decision fails review (C08); findings record environment, criteria revision and time; passed, failed, blocked and not-run are distinct and absent evidence fails the gate; invalidation schedules revalidation`
- **Q03** (readme-1 #35/#36; README:102-104)
  - Deliverable append: (none)
  - Acceptance append: `; doc obligations record owner, applicable version, implementation references and validation status and stale or unverified docs are flagged; the impact check creates assigned update tasks; a release change flags linked docs, support guidance and promotional assets`
- **B01** (readme-3 #47; operations #42-48, #52 (GAP), #44 (GAP); readme-1 #37; PC:9-25,43-53; PS:15)
  - Deliverable append: `; category on the task contract; occupied worker-slot time as accounting basis (R05)`
  - Acceptance append: `; a continuous backlog of either kind cannot starve the other; approved PC work gets reserved capacity within its wait bound while P keeps its protected share under PC spend and concurrency ceilings; unused PC lends to P with a reason and is reclaimed at safe boundaries without ownership change; emergency borrowing needs explicit direction with reason, scope, expiry and review and repeated urgency cannot remove the floor; paused or suspended work is never woken to meet a quota; an unmet reservation is reported with its cause; relabeling or delegation cannot move spend; an expiring override survives restart; chat answers what was delivered and whether improvement was starved, and an allocation change by chat is a revision applied to pending dispatch only; external campaign spend limits are enforced`
- **B02** (readme-3 #24; contracts #25; operations #76; README:531; AUTH:43; LI:9)
  - Deliverable append: `; agent-submitted friction and improvement proposals with owner and disposition; approval stalls, redundant prompts and failed reviews as observation sources`
  - Acceptance append: (none)
- **B03** (readme-3 #24; operations #51; README:531; PC:39-41)
  - Deliverable append: `; project improvement backlog linked to meeting agenda items`
  - Acceptance append: `; the evaluated outcome is reported to the proposer`
- **B04** (readme-3 #57; operations #49; README:609; PC:29-33)
  - Deliverable append: (none)
  - Acceptance append: `; candidates run in a disposable environment (A08) and are compared with the baseline; proposals record problem, affected work, change, effort, running cost, benefit, evaluation and stopping condition; metrics cover time to accepted result, rework, cost per success, adoption and maintenance without double-counting savings`
- **B05** (operations #50; PC:31,52; LI:15)
  - Deliverable append: (none)
  - Acceptance append: `; adoption needs an existing grant and independent review; a finished PC task does not publish a shared tool`
- **K02** (operations #57/#58/#74; readme-2 #15/#27; contracts #31; readme-3 #25; MU:9-17; DW:7,31; RC:38)
  - Deliverable append: `; separate deterministic launcher and updater with current and candidate directories, a durable update journal and a last-known-good record; release-management permission distinct from toolbox.manage`
  - Acceptance append: `; authorization is bound to digest, migration plan and target installations; an interruption resolves to old or new, never mixed, on macOS, Linux and Windows; running executables are never overwritten and a routine release cannot replace the launcher; a supervisor role alone cannot change protected extensions; controller-worker protocol compatibility is checked before activation and rollback is tested against mixed versions; an agent-built candidate of NimbleNewt itself cannot stage or activate itself; Pi runtime changes follow G11`
- **K03** (operations #62; MU:36-38)
  - Deliverable append: (none)
  - Acceptance append: `; a defined rollback period with additive schema; code rollback only to a tested compatible pair; destructive migrations deferred; the watchdog distinguishes release defects from provider or host failures; health thresholds and probation are configurable and a rollout can be stopped`
- **X02** (operations #74/#75 (GAP); readme-3 #74; DW:7,27; PS:177; README:663)
  - Deliverable append: (none)
  - Acceptance append: `; a project named NimbleNewt gains no authority over the installation or updater; no outbound telemetry, issue, PR or report leaves without explicit scoped authorization (network capture); agent B cannot reach suspended agent A's scratch through file paths, search or artifact links, repeated after restart and harness change`
- **X03** (readme-1 #31; readme-3 #71/#73; README:171,651,662)
  - Deliverable append: (none)
  - Acceptance append: `; at each step from assignment through tool use, pause or worker loss, handoff, submission, review and completion, chat, project view and API report the same owner, activity, blocker and delivery state and stale or uncertain is never shown complete; the README 651 meeting scenario set passes; routing by difficulty, a queued advice exchange and an event-triggered task are exercised`
- **X04** (readme-1 #6; operations #10/#11/#15; readme-3 #60/#63; README:75,629; PO:13,27,33)
  - Deliverable append: (none)
  - Acceptance append: `; with each optional integration (local inference, MCP server, remote worker, cache backend) absent or failing, core lifecycle, chat and recovery still work and report it unavailable; core runs with optional adapter packages not installed; the controller runs as the chosen background service and planned OS shutdown is distinguished from a crash; UI settings persist across restart; clean uninstall leaves no service registration or data outside chosen folders and common setup needs no single-platform tooling`
- **X05** (as X04; readme-3 #60; README:625)
  - Deliverable append: (none)
  - Acceptance append: `; same optional-integration, service, settings and uninstall checks as X04; two distinct deployments configured from a release extract with no source edits`
- **X06** (as X04)
  - Deliverable append: (none)
  - Acceptance append: `; same optional-integration, service, settings and uninstall checks as X04`
- **X07** (readme-1 #23; README:193)
  - Deliverable append: (none)
  - Acceptance append: `; report reconstruction count, retention and resume-correctness checks, accepted-result rate, time and cost for equivalent cases`
- **D02** (readme-2 #28/#44; README:267,416,422)
  - Deliverable append: (none)
  - Acceptance append: `; documents flush guarantees for process crash, orderly shutdown and power loss, and the rule that a non-TypeScript component needs a recorded justification, bounded interface and maintenance plan`
- **D03** (readme-1 #78; operations #12; README:46; PO:35; OC:91)
  - Deliverable append: (none)
  - Acceptance append: `; the release manifest contains no preset team, backlog, credentials or self-development automation and states the support matrix (OS versions, Linux distributions, architectures, filesystems); the owner inspection policy and the other pre-release owner decisions are recorded`

## 3. Doc-side fixes and owner decisions

### 3a. Doc statements that are wrong, stale or contradictory (fix regardless of decisions)

| Doc:line | Problem | Proposed wording / action |
| --- | --- | --- |
| README.md (repo root):88 | Says "assignment, delivery, the API, workers, the UI and everything else are not built", but S02 (assignment), S03 (delivery), S04-S09, U01 (state API), A01/A02/A05, C01/C02, H01/H03/H04 and R01 are implemented per PROGRESS. | "...project and task records, verified artifacts, assignment and delivery, the durable inbox and effect ledger, reconciliation, typed waits, authentication and grants, desks and retrieval, and the first state API are implemented; workers, the network transport, the UI and the remaining features are not built." (Or regenerate this sentence from PROGRESS.) |
| docs/nimblenewt/implementation-plan/g07-architecture-and-coverage.md:22 | Hard-coded counts. | "151 cards under 22 workstream parents ..., a longest dependency chain of 46 cards, and 46 dependency phases." Also update the "Requirement coverage" matrix (section 5) and the "Areas the plan covers only partly, or not at all" list: agent/team records, owner inspection, replay, presence and the other named gaps now have cards. |
| docs/paperclip-backlog.md:3 and docs/paperclip-project-brief.md:22 | "the plan has 113 since 2026-10-21". | "the plan has 151 since <date> (38 cards added from the documentation audit: F08, F09, S10, C08, C09, A07-A10, L06, H11-H13, R03-R05, U08-U13, M03-M06, T06-T09, P04-P07, Q04, K06, K07, G11)"; paperclip-sync-status.md should list the 38 cards as not yet imported. |
| README.md (docs/nimblenewt):495, 651 and pitfalls-and-safeguards.md:155 | Meeting mechanics are called "proposed behavior to refine" / validated "once their policy is agreed", while design-decisions.md:33 lists votes with reasons and human-present agreement as accepted direction and the plan now builds them (M03-M06). | After the owner decides (OD-6), replace with "The mechanics below are the first-release meeting behavior; exact quorum thresholds and seconding are configurable (defaults: majority quorum, ties fail, no second)." and drop "once their policy is agreed" from line 651. |
| README.md:59 ("Multiple agents can operate through different harnesses") | Only a Pi adapter is planned; nothing says a second harness is out of first-release scope. | After OD-1: "Multiple agents can operate through different harnesses; the first release ships the Pi Durable adapter only, behind a harness capability contract (F08) that later adapters must pass." Same note at README:335 ("parity across harness adapters"): "once a second adapter exists". |
| README.md:204-207 vs C07 | README asks for one coordinated compression owner with explicit control; C07 records the owner's 2026-10-21 decision to keep Pi's automatic compaction (bounded by hooks). | Add one sentence at README:207: "The first release keeps the runtime's own automatic compaction as the single compression owner, bounded by NimbleNewt timeouts and a fallback summariser (owner decision 2026-10-21; see context-window-stalls.md)." |
| design-decisions.md:28 ("Environments") and README:339-374 | README describes environment maintenance in detail; the register row says only "per-agent skills/tools/extensions and enforced isolation". | Add "versioned per-agent environments with reviewed changes, disposable trial and rollback (A08, A09)" so the register matches the README and the plan. |
| PROGRESS notes in generate_task_plan.py | Notes name owners that are now wrong or vague: F02 ("history, drafts ... belong to ... U04"), R01 ("reading the configuration document into a table is a later step"), A01 ("tool gate is not yet called by any tool path (T01, A04, A05)"), A05 ("nothing calls it yet"), F07 ("S02, T01, A05 carry that forward"), H04 ("nothing starts the addressee's work"), C01 ("installation-owner read rules ... open to the owner"), U01 ("the transport cards"). | Optional but recommended: point them to U10, U10, H12, H12, T06/T09/H12, U12, A10 and U02 respectively. Notes are free text; no test reads them. |

### 3b. OWNER DECISIONS (not decided here; recommendation given)

| # | Doc:line | Question | Recommendation |
| --- | --- | --- | --- |
| OD-1 | README:59, 85-87, 335 | Is a second harness in first-release scope? | No. Ship Pi only; keep F08 (capability declaration + refusal, tested with a fake harness) and mark multi-harness and adapter parity as post-first-release in README:59/335 and the register. |
| OD-2 | README:247, 261; operational-contracts:91 ("defined before release") | Content of the owner inspection policy for private desks and scratch. | Decide before A10 starts: owner may read any agent record, every read is audited and shown to the agent; recovery service access is separate. Record in G01's decision record. |
| OD-3 | README:261; design-decisions:73; pitfalls-and-safeguards:125 | Retention defaults, deletion of backups, RTO/RPO. | K06 makes them configurable; record defaults (keep everything referenced by resumable work; 90-day archive of inactive work; backup retention as K01) in the G01 record. Do not block K06 on numbers. |
| OD-4 | design-decisions:75 | Notification delivery method. | In-product notifications (web UI and chat) plus one optional generic webhook; no third-party push vendor in the first release. U11 implements whatever is chosen. |
| OD-5 | README:564 | Quorum thresholds and whether motions need a second. | Majority of the fixed roster, ties fail, no second; configurable in M06. |
| OD-6 | README:495, 651; pitfalls-and-safeguards:155 | Are parliamentary mechanics (amendments, points of order, sealed initial positions) first-release requirements or proposals? | Keep M06 for roster, quorum, motions, ballots with reasons and owner-present rules; let the owner explicitly defer points of order and sealed initial positions if M06 is too large, and say so in README:557-562. |
| OD-7 | README:533; development-workflow:3-25 | NimbleNewt-source development workflow (agents build candidate releases of NimbleNewt). | Mark out of first-release scope in README:533 as development-workflow.md already implies; the safety rule (a candidate cannot stage or activate itself, project name grants nothing) stays in K02 and X02 clauses. |
| OD-8 | README:612 | Simulation mode in first release? | Keep P07 (small: simulated tools/events, no real effects, labelled results). Deferral is cheap if the owner wants a smaller first release; it is a leaf feeding X03 only. |
| OD-9 | README:353, 361 | Direct sandboxed editing vs mediated editing of shared workspaces; concrete protected-path rules. | Decide before A04 starts; A04 acceptance must name the chosen mode. |
| OD-10 | README:396, 476 | Default cleanup deadline and escalation; backup latency guarantee. | Record defaults (for example 10-minute preparation deadline, then owner prompt) in the G01 record; L02 and L06 use them; no latency guarantee claimed. |
| OD-11 | README:237, 243 | Should provider-returned reasoning ("thinking") ever appear in replay? | No, as the docs say: replay shows recorded activity and stated explanations only (C09/U09 say so). Only revisit if the owner wants labelled provider reasoning summaries shown. |
| OD-12 | portability-and-configuration:35 | Supported filesystems and Linux distributions list. | Owner confirms the list; D03 clause requires it in the release manifest (F04b already refuses network filesystems). |
| OD-13 | README:653, 697 | MVP selection (explicitly deferred). | Leave deferred. If the owner wants a smaller first release, the low-cost cuts are P07, F08's fake-harness suite, M06 procedure extras, G11 (until the first Pi upgrade) and T08 proposals; each is a near-leaf. |

Docs already defer these and no change is proposed: multiple human accounts (organization-and-workers:3, 55), offline autonomous worker execution (organization-and-workers:45), several active schedulers / NimbleNewt-managed controller failover (organization-and-workers:49, K05), arbitrary live-process restoration (design-decisions:73), Rust rewrite (README:267), public hosting (README:699), "ideas to explore" (README:689-693).

## 4. Checklist: every GAP row in the five reports

Format: report #row (short) → resolution. "cl." means clause on that existing card.

### readme-1 (25 GAP)
- #1 agent registry and hierarchy → H11
- #4 difficulty profiles → R03 (+ S10 difficulty field)
- #10 noticeboard → U05 cl.
- #13 owner decision records and supersession → C08
- #14 reviewers judge against owner requirements → Q02 cl.
- #26 proposals distinct from applied changes → U03 cl.
- #28 workstreams/milestones, due date not progress → P01 cl.
- #40 responsibility checks produce tasks/observations → P04
- #41 intended vs observed vs last check → P04
- #42 incidents grouped, bounded repair, escalation → P04
- #43 coverage gaps → P04
- #46 per-resource maintenance coordination → P04
- #50 defect records and repair cycles → Q04
- #51 owner override records → Q04
- #56 follow repository instructions → P05
- #58 pre-contribution diff inspection → P05
- #59 cross-repository PR sets → P05
- #60 chronological replay → C09 + U09
- #63 redactions and incomplete ranges → C09 + U09
- #64 summary timeline, filters, branches, outcome states → U09
- #65 "what evidence and instruction led to this change" → U09
- #66 decision explanations at material choices → C09
- #67 retrospective explanations labelled → C09
- #68 replay read-only, never re-executes → U09 (+ P07 isolated rerun)
- #72 playback validation scenario → U09

### readme-2 (21 GAP)
- #1 protected agent tools (desk, tasks, communication, ballots, jobs, discovery, env requests) → T06 (ballots via M06, jobs via T07, env requests via A09)
- #2 stable bridge (discovery, schemas, on-demand descriptions, no reload) → T06
- #3 execution service validating arguments/permissions → T06
- #4 declarations refreshed at next request boundary → T06
- #6 bounded jobs, structured args, durable handles → T07 (structured args: T06)
- #7 harness-extension change as environment maintenance → A09
- #8 per-agent base + home/config/packages/skills → A08
- #9 environment manifest referenced by checkpoints → A08 + C04 cl.
- #11 agents add extensions and restart under standing permission → A09
- #14 environment change policy classes, trial, install scripts in boundary → A09
- #18 toolbox read-only access and provenance copies → T08
- #19 improvement proposals and maintainer decisions → T08
- #23 /toolbox.* scoping, shortcuts, no cross-scope overwrite → T09 + T08
- #26 durable agent IDs as command prefixes, aliases, friendly names → T09 + H11
- #31 MCP calls in task-linked activity views → T03 cl. (+ H12 journal, U05 cl.)
- #35 Git hooks/config cannot run with service privileges → A04 cl.
- #36 team/system Stop and Suspend, reboot, LLM-independent bookkeeping → L06
- #50 child escalation with budgets, routing reasons persisted → R03
- #54 drain reporting (applied / in-flight / safe to stop) → R04
- #59 delivery classes → U12
- #60 focus periods, interruption allowance, coalescing → U12

### readme-3 (25 GAP)
- #1 stand-up schedule config with timezone → M03
- #2 advance notice and briefs → M03
- #4 plan around meeting time → M04 (first acceptance clause)
- #7 owner meeting commands → M05
- #8 floor control and bounded turns → M05
- #12 unanswered questions become follow-up tasks → M05
- #16 owner-present agreement rules → M06
- #19 later owner decision takes precedence across agents and restart → C08
- #20 ballots with reasons, bound to motion version → M06
- #21 agent personalities never change permissions → H11
- #26 supervisor-captured agenda items → M03
- #28 agenda item states → M03
- #31 "why did the team choose that" from the record → M02 cl.
- #32 transcript/summary survive interruption and summarizer failure → M02 cl.
- #33 parliamentary procedure → M06 (see OD-6)
- #34 fixed roster, quorum, no vote inflation → M06
- #37 start with available participants, brief not shown as live → M04
- #40 end of meeting resumes only attendance pauses → M04
- #41 notify absent agents and revalidate → M04 + C08
- #42 timebox discussion and spend, waiting-on view → M05
- #56 activity history and replay → C09 + U09
- #58 retirement and archival → P06
- #59 simulation mode → P07 (see OD-8)
- #61 renames preserve queued targets → H11 + T09
- #76 conflicting owner decision wins after team agreement, across pause and restart → C08 + M06

### contracts (13 GAP)
- #1 agents, teams, roles, role-conflict rules → H11
- #2 local worker runtime and dispatch → H12
- #3 job records and job state machine → T07
- #6 task cancellation needs task authority; Stop is not cancellation → L02 cl.
- #15 planning-only instructions and holds stay binding → C08
- #16 concurrent owner sessions/devices, conflicting instructions → C08
- #18 owner inspection policy for private records → A10 (+ OD-2)
- #20 action classes, default policy, presets, effective policy, preview → A07
- #25 redundant approval reconciliation; friction as learning → H05 cl. + B02 cl.
- #27 full contribution loop (push, PR, CI, branch protection) → P05
- #29 relocating a task's execution between hosts → H02 cl.
- #36 retention/export/deletion incl. derived data; capacity reserve → K06
- #46 filesystem watchers as hints → H13

### operations (26 GAP)
- #1 settings and administration UI → U08
- #2 effective value and precedence → U10
- #5 agent and team records → H11
- #7 per-OS secret stores → F09
- #20 owner decision record and correction propagation → C08
- #21 per-agent environments, reviewed installs, rollback → A08 + A09
- #22 durable computer-assigned IDs, never reused, clone/import → H11
- #23 command namespace and alias dispatcher → T09
- #36 quotas, reserved capacity, retention, archive, deletion → K06 (RTO/RPO and inspection rules: OD-3, OD-2)
- #38 checkout identity, initial state, multi-repo PRs → P05 + P02 cl.
- #40 read-only replay → C09 + U09
- #41 notifications → U11 (+ OD-4)
- #44 slot-time accounting, shortfall surfaced → R05 + B01 cl.
- #45 background and meeting overhead attribution → R05
- #52 chat P/PC questions and allocation revisions → B01 cl.
- #53 configuration combination validation → U10
- #54 task return policy → L03 cl. (+ M04 for meetings)
- #55 optional milestones and due dates → P01 cl.
- #56 maintenance windows → K07
- #59 Prepare and Quiesce steps, downtime inbox → K07
- #60 quarantined activation and verification → K07
- #61 updater crash recovery, quarantine, recovery mode → K07
- #66 compatibility/migration status in UI → U08
- #68 local MCP servers sandboxed, remote needs TLS → T03 cl.
- #72 MCP protocol/transport/SDK pin list → T03 cl.
- #75 no automatic telemetry, issues or PRs → X02 cl.

**GAPs not resolved: none.** Items resolved only partly on purpose (they are PARTIAL rows, not GAPs): adapter parity across harnesses (readme-2 #25, waits for a second adapter, OD-1) and the NimbleNewt-source candidate-build workflow (readme-3 #25, OD-7; only its safety rule is carried by K02/X02).

### PARTIAL rows (compact map, for completeness)

- readme-1: #2 F08; #3 A08; #5 U10, U08; #6 X04-X06; #7 L06; #8 U12, U05; #9 M03; #11 H13, S10; #12 U12; #15 C08; #16 U05; #17 C08; #18 C04; #19 C07; #20 C07; #21 G09; #22 L04, F08; #23 X07; #24 U03; #25 U03; #27 S10; #29 H12, T01; #30 U05; #31 X03; #32 Q01; #33 H12; #34 C05; #35 Q03; #36 L03, Q03; #37 A07, B01; #38 Q01; #39 P04; #44 P04; #45 P04, L03; #47 P04; #48 Q02; #49 Q02; #52 H05, Q04; #53 Q02, Q04; #54 P01; #55 P02; #57 P05; #61 C09; #62 C09; #69 C08, C09; #70 U09; #71 C09, K06; #73 H11; #74 A10; #75 A10; #76 U12; #77 A10; #78 D03; #79 no change (covered by M03 and U03).
- readme-2: #5 T01; #10 T08; #12 A08; #13 T06; #15 A09, K02; #16 L02; #17 T08; #20 T08; #21 T08; #22 T06; #24 T08; #25 T06 (parity: OD-1); #27 G11, K02; #28 D02; #29 U03; #30 T03; #32 C03; #33 A08; #34 A04; #37 L02; #38 L02; #39 L02; #40 L06; #41 L02; #42 L03; #43 C04; #44 L02, D02; #45 L02; #46 L06; #47 C05; #48 H10; #49 R03; #51 R04; #52 R04; #53 R04; #55 R04; #56 R04; #57 U02; #58 U12.
- readme-3: #3 M03; #5 M04; #6 M04; #9 M05; #10 M05; #11 M06, M05; #13 M04; #14 M02; #15 M06; #17 M06; #18 M06, M02; #22 M02, A10; #23 M06; #24 B02, B03, M03; #25 K02, X02 (OD-7); #27 M03, C08; #29 M02; #30 M02; #35 M06; #36 M04; #38 M04; #39 M02; #43 H13; #44 H13, U05; #45 H06, H13; #46 H13; #47 B01; #48 S10, Q01; #49 U05; #50 T03; #51 S10; #52 R05; #53 U07; #54 L06; #55 C08; #57 B04; #60 X05, U08; #62 T02; #63 X04-X06, U08; #64 L04; #65 H05; #66 A08, A09; #67 R05; #68 K06, C04; #69 U03; #70 P05; #71 X03; #72 C08; #73 X03, R03, H13, M02; #74 X02; #75 U05; #77 L01; #78 R04; #79 L02.
- contracts: #4 L01; #5 L02, H12; #7 L01, L06; #8 L01, M04; #9 M04; #10 L03; #11 P01; #12 S10, U03; #13 Q01; #14 H12; #17 A07; #19 T02, A10, T08; #21 A07; #22 H05; #23 H05; #24 H05; #26 A06; #28 P04; #30 H07; #31 H02, K02; #32 M06; #33 V01, V02; #34 V02; #35 U06; #37 U04; #38 U13; #39 L01; #40 U02; #41 U02; #42 U12, U02; #43 C03, T03; #44 T05; #45 C03; #47 C03; #48 L04; #49 L04; #50 A04; #51 H12.
- operations: #3 U10; #4 U10; #6 R03; #8 A04, G06; #9 T07; #10 X04-X06; #11 X04-X06; #12 D03 (OD-12); #13 T01; #14 P04; #15 X04-X06; #16 R04; #17 U02; #18 U02, U12; #19 H06, S10, U12; #24 T09; #25 T08; #26 T06, A08; #27 T06; #28 L04; #29 G09, F08; #30 C07; #31 H05; #32 A10; #33 R05; #34 L06; #35 R04; #37 U03, U05; #39 M02, M04, M05, M06; #42 B01, S10; #43 B01; #46 B01; #47 B01; #48 B01; #49 B04; #50 B05; #51 B03, M03; #57 K02; #58 K02; #62 K03; #63 K07; #64 G11; #65 G11; #67 T03, U08; #69 T03; #70 C03, T03; #71 T07; #73 T03, U05; #74 X02, K02; #76 B02.

## 5. Generator, test and doc constraints to update

1. `scripts/generate_task_plan.py`: paste the 38 lines from section 1 into `raw` (order is free; the generated task-plan.md lists cards in `raw` order). Apply the section 1b dependency edits and section 2 clauses to the existing lines. No `|` or newline may appear in any field (none does). No change to `parents` (all new cards use existing N02-N17 parents). No PROGRESS entry for new cards (they default to `planned`). A ready patched copy is at a scratch copy kept outside the repository: `diff` it against the repo file to apply.
2. Regenerate: `python3 scripts/generate_task_plan.py` then `npm run roadmap:write`. CI runs the generator and fails on `git diff --exit-code docs/` if the generated files are stale. `npm run roadmap:check` and scripts/roadmap.test.mjs fail if README.md's roadmap is stale (it will then read "36 of 151 tasks implemented, 2 awaiting sign-off" and list 46 phases).
3. `scripts/plan.test.mjs` constraints, all met by this proposal: ID regex `^[A-Z]\d{1,2}[a-z]?$`; parent regex `^N\d{2}[a-z]?$`; exactly one root (G01) and one leaf (D04), so every new card needs a downstream consumer (section 1b gives each one); implemented cards may not gain blockers or have unimplemented blockers (none touched); g07's text must contain `"151 cards under 22 workstream parents"` and `"46 dependency phases"`.
4. `docs/nimblenewt/implementation-plan/g07-architecture-and-coverage.md`: update line 22 (151 cards, longest chain 46, 46 phases). The coverage matrix test only checks that areas match design-decisions.md's accepted table and that named cards exist, so adding cards is optional but recommended: Product purpose +H12; Project delivery +S10; Conversational configuration +U08, U10; Approval profiles +A07; Authority +C08, A07; Lifecycle +L06; Desks +A10; Agent APIs +U12, U13; Environments +A08, A09; Tools +T06, T07, T08, T09; Naming +T09, H11; Routing +R03, R04, R05; Meetings +M03, M04, M05, M06; Quality assurance +Q04; Work balance +R05; Replay +C09, U09; Repositories +P05; Runtime +F08, G11; Distribution +K07; Product/development separation +K07, G11; Human users +A10. Rewrite the "Areas the plan covers only partly, or not at all" list. If the owner adds new accepted areas to design-decisions.md (for example Notifications, Retention, Simulation), the matrix needs matching rows or the test fails.
5. `packages/pi-adapter/src/capabilities.test.ts` only checks that cards named in g02-acceptance.md exist; unaffected.
6. Paperclip: 38 new cards to import under `NimbleNewt-plan-20261016/<id>` markers, and native blocker edits for the 18 cards in section 1b; update paperclip-sync-status.md, docs/paperclip-backlog.md:3 and docs/paperclip-project-brief.md:22 (they say 113).
