# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
I oppose version 1 as written. Owner approval before installation is necessary, but it does not bound the authority exercised while preparing a release. A separate checkout is not, by itself, a security boundary: build scripts, tests, credentials, network access, and resource consumption still matter. I would support agent-initiated candidates under an owner-authorized standing policy: isolated execution, no production credentials or release-signing authority, explicit resource limits, and an audit trail identifying the initiating agent and changes. Candidates should remain untrusted artifacts until independently reviewed; agents must not change their own approval controls. Without those constraints, the motion grants more initiative than its installation safeguard adequately contains.
> tl;dr (what later speakers saw in summary mode): Keep owner initiation as the default until candidate work has explicit isolation, authority limits, and independent review.

**#3 Jonas** _(round 1 (blind))_ [for]
I field the defect reports, and recurring bugs sit in my queue for days because work only starts when the owner initiates it. Letting an agent open a candidate-release project on its own initiative would catch those earlier, while the project still gets its own checkout so it can't clobber the live system. The hard line stays where it matters: nothing installs without the owner's explicit step, so I retain final control over what runs. My concern is noise — agents spawning speculative releases for trivial issues — so I'd want candidates to cite a concrete defect report or reproducible failure, not a hunch. But as a default, self-initiated candidate work with owner-gated installation is a reasonable loosening. Worst case, I review a candidate I don't want and reject it at install time.
> tl;dr (what later speakers saw in summary mode): Candidate releases should be self-initiated but defect-justified; owner-gated installation keeps real control.

**#4 Lena** _(round 1 (blind))_ [against]
The motion preserves the owner's install gate but says nothing about how many candidate releases can arrive for review. If several agents each notice a "recurring defect" in the same sprint, the owner gets multiple review requests with no triage or deduplication layer. My job is to keep the owner's queue manageable; this motion adds an unbounded intake source without a rate limit, priority filter, or consolidation step. I'd support a version that includes a cap (e.g., one open candidate per agent per cycle) or a designated triage role that merges duplicates before they reach the owner.
> tl;dr (what later speakers saw in summary mode): Self-initiated candidates create unbounded review load unless we add rate limits or triage before they reach the owner.

**#5 Chair** _(fact-finding question)_
To Jonas: Recurring defects awaiting owner initiation (Can you give a concrete example from your defect queue, including what evidence would justify starting candidate work?)

**#6 Jonas** _(answer to chair)_ [for]
A concrete example: agents repeatedly hit a bug in NimbleNewt's worktree handling during builds. I have three near-identical reports in my queue this week; the owner hasn't started anything yet. Evidence that justifies a candidate: multiple independent agent reports with stack traces or reproduction steps tied to the same code path, not a vague hunch.
> tl;dr (what later speakers saw in summary mode): Multiple matching reports with reproducible failure evidence should suffice to open a candidate, pending owner review.

**#7 Chair** _(fact-finding question)_
To Noor: Existing isolation and permission controls (Which execution, credential, network, and resource restrictions are known to apply to separate candidate projects today, and which remain unverified?)

**#8 Noor** _(answer to chair)_ [against]
My notes confirm that the initiating agent retains its ordinary project grants. A separate project limits where changes land, not what it can read. I cannot verify execution isolation, credential restrictions, network limits, or resource caps for candidate projects. Starting work is easier to stop than installation, and the owner retains the installation gate, but that does not establish preparation-time safeguards.
> tl;dr (what later speakers saw in summary mode): Separate projects constrain changes, not necessarily authority; additional restrictions remain unverified.

**#9 Noor** _(round 2)_ [against]
Jonas’s reported worktree failures offer a concrete reason to propose a fix, and Lena’s triage requirement would reduce duplicate work. Neither addresses preparation-time authority. My notes say the initiating agent keeps its ordinary grants: a separate checkout limits where changes land, not what it can read. Rejecting a candidate at installation therefore is not the worst possible outcome; work may already have exercised those grants or consumed resources. I agree that starting work is easier to stop and that owner-controlled installation protects the most consequential step. I would support an amendment allowing agent initiation under an owner-authorized standing policy with verified execution isolation, restricted credentials and network access, resource limits, and deduplicated intake. Those safeguards are not established here, so I remain against version 1.
> tl;dr (what later speakers saw in summary mode): Owner-gated installation matters, but autonomous preparation needs bounded authority and intake controls before becoming the default.

**#10 Jonas** _(round 2)_ [undecided]
Noor's point is fair: my "reject at install time" argument understated what a candidate can read or consume before review, since a separate checkout only limits where changes land, not grants. My notes say an uninstalled candidate costs compute and review time — real, but bounded only if resources are capped, which I can't verify either. I still think agent-initiated candidates are the right default in principle, since defects sit in my queue for days while the owner is away. I'd move to support an amended version: agent initiation allowed, requiring concrete evidence (multiple independent reports with repro steps, like the worktree bug), plus Noor's safeguards and Lena's dedup/triage cap. As written, version 1 grants more than the install gate contains.
> tl;dr (what later speakers saw in summary mode): Support agent-initiated candidates only with evidence requirements, resource and credential limits, and intake dedup added.

**#11 Lena** _(round 2)_ [against]
Jonas now endorses my triage cap and Noor's safeguards, which is encouraging convergence. But I still lack data on how many candidates agents would actually start. My notes confirm the owner already reviews approvals, notifications, and meetings; each unrequested candidate adds burden. Without a verified cap or deduplication layer, a flood could bury the ones that matter. I'd support an amended version that includes: (1) a concrete-evidence threshold like Jonas described, (2) a per-agent or per-cycle cap, (3) a consolidation step before anything reaches the owner, and (4) Noor's preparation-time safeguards. Version 1 as written provides none of these, so I remain against it.
> tl;dr (what later speakers saw in summary mode): Against version 1; would support an amended version with volume caps, deduplication, and preparation-time safeguards.

## Ballots (revealed together at the close)
- Noor: **no** — Version 1 permits preparation-time authority without verified isolation, credential restrictions, or resource limits, which owner approval at installation does not address.
- Jonas: **no** — Version 1 lacks the evidence threshold, intake cap, and preparation-time safeguards the group converged on, so I support only the amended version, not the motion as written.
- Lena: **no** — Version 1 provides no evidence threshold, no per-agent cap, no consolidation step, and no verified preparation-time safeguards, so it adds an unbounded intake source to the owner's review queue without any of the controls I identified as necessary.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}