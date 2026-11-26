# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
Owner approval of installation is necessary, but it does not bound the authority exercised before installation. A separate checkout isolates edits, not necessarily credentials, execution privileges, network access, or resource consumption. An agent that goes wrong could use an unsolicited candidate project to run unsafe code or consume resources without ever installing a release. I would support a narrower motion: agents may propose candidate work automatically, but starting executable work requires either owner approval or a previously authorized sandbox with explicit resource limits, restricted credentials, and no ability to alter the running system. Installation approval should identify the exact artifact being installed. Until those boundaries are part of the motion, I favor the existing default.
> tl;dr (what later speakers saw in summary mode): Keep owner-initiated work unless autonomous candidate projects have explicit containment and resource limits; installation approval alone is insufficient.

**#3 Jonas** _(round 1 (blind))_ [for]
As the maintainer, I want defects fixed faster. Agents already notice recurring issues before I do, since they see the failure logs firsthand. Today, if I'm busy or asleep, that knowledge sits idle until the owner or I spin up work. Letting an agent open a candidate-release project on its own means diagnosis and a patch draft can be ready when I arrive, not started from zero. The guardrails matter: separate checkout means no risk to running code, and nothing gets installed without the owner's explicit approval, so this is research-and-draft autonomy, not deployment autonomy. My concerns: candidate projects could pile up unreviewed, and agents could duplicate each other or drift from my own fix work. That's manageable with a note in the ticket or a quick check before starting. Net effect: faster turnaround on defects, no loss of owner control.
> tl;dr (what later speakers saw in summary mode): Approve it — agents can prepare candidate fixes in isolated projects while owner still controls all installation.

**#4 Lena** _(round 1 (blind))_ [against]
My concern is review load. The motion removes the owner's control over *when* NimbleNewt work starts but keeps them as the sole approval gate. If three agents each notice a "recurring defect" in the same week, the owner now gets three candidate-release reviews they didn't ask for, on top of their normal project queue. The separate-project isolation protects the codebase, but it doesn't protect the owner's attention. Without a rate limit, a prioritization mechanism, or a triage step that filters before anything reaches the owner, this motion converts an unpredictable stream of agent initiatives into an unpredictable stream of review requests. I'd support a version that adds a cap or a queue with deferral, but as written it increases load with no throttle.
> tl;dr (what later speakers saw in summary mode): Self-initiated work creates unbounded review inflow with no throttle; protect the owner's attention first.

**#5 Chair** _(fact-finding question)_
To Jonas: Isolation of candidate projects (What verified restrictions, if any, prevent a separate project from accessing shared credentials, altering the running system, or consuming unbounded resources?)

**#6 Jonas** _(answer to chair)_ [undecided]
Honest answer: I don't know of any verified technical restrictions. Separate projects get their own checkout, which keeps edits isolated, but I can't point to enforcement around credentials, network, or resource limits. Noor's point that isolation of edits isn't isolation of execution is fair. I'd assumed "nobody installs = harmless," but my notes only justify cost in compute and review time, not safety.
> tl;dr (what later speakers saw in summary mode): I assumed checkout isolation was enough; I can't verify restrictions on credentials or resources, so I'm not certain.

**#7 Chair** _(fact-finding question)_
To Lena: Existing workload controls (What existing NimbleNewt mechanisms, if any, cap active projects, deduplicate defect work, or defer review requests?)

**#8 Lena** _(answer to chair)_ [against]
I have no record of any existing mechanism in NimbleNewt that caps active projects, deduplicates defect work, or defers review requests. My notes confirm the owner already handles approvals, notifications, and meetings; nothing I've seen limits how many items arrive. I also have no data on how many candidates agents would actually start, so I can't estimate whether the flood risk is real or theoretical.
> tl;dr (what later speakers saw in summary mode): No existing caps, deduplication, or deferral mechanisms are known to me; review load is unbounded today.

**#9 Noor** _(round 2)_ [against]
Jonas's correction resolves the key uncertainty: we have no verified execution isolation. My notes add that the initiating agent retains its ordinary project grants; the separate project limits where changes land, not what it can read. This does not establish new privileges, but it permits unsolicited use of existing ones. I also acknowledge the distinction Jonas emphasized: starting work is cheap to stop, while installation is the dangerous, lasting step and remains with the owner. That gate matters, but does not cover pre-installation activity. Lena's concern supports a queue or cap, although we cannot claim a flood is likely. I would support automatic proposals, with executable work requiring owner approval or a previously authorized, restricted sandbox and resource budget. Installation approval should bind to the exact artifact. Without those conditions, I remain against version 1.
> tl;dr (what later speakers saw in summary mode): Keep owner-controlled installation, but require authorization or enforced sandbox limits before agents independently execute candidate-release work.

**#10 Jonas** _(round 2)_ [undecided]
I came in expecting to defend version 1, but the fact-finding changed my picture. I have no notes showing any execution isolation—only edit isolation via the separate checkout—and Noor is right that agents keep their ordinary grants, so unsolicited work means unsolicited execution and resource use with no bounds I can verify. I also can't dispute Lena: I know of no deduplication or cap, and agents hit the same recurring defects repeatedly, so duplicates aren't hypothetical. Still, my core observation stands: defects are noticed first by agents, and every fix waits on owner availability, costing days. So I want this capability, but not as written. I'd support a version requiring sandboxed, resource-bounded execution for agent-initiated candidates, artifact-bound installation approval, and a queue with deduplication before review.
> tl;dr (what later speakers saw in summary mode): I still want agent-initiated candidate releases, but with sandboxed execution, resource limits, and dedup—version 1 lacks all three.

**#11 Lena** _(round 2)_ [against]
I confirm my earlier concern and add that the fact-finding reinforced it. Jonas admitted no execution isolation exists; Lena's own notes show no cap, no deduplication, no deferral mechanism. The convergence here is clear: all three of us want agent-initiated defect work eventually, but version 1 lacks the prerequisites. I'd support a revised motion that includes a queue with deduplication, a cap on concurrent candidates, and a triage step so only non-duplicate, high-confidence items reach the owner. Until those are specified, the owner's attention remains unprotected and I cannot vote for version 1.
> tl;dr (what later speakers saw in summary mode): Version 1 lacks deduplication, caps, and triage; the owner's review load stays unbounded, so I remain against.

## Ballots (revealed together at the close)
- Noor: **no** — Separate checkouts and installation approval do not establish limits on unsolicited execution, credential access, or resource use before installation.
- Jonas: **no** — I want this capability, but fact-finding showed we lack execution isolation, resource bounds, deduplication, and a review queue, so I'd only support a revised version with those prerequisites.
- Lena: **no** — Version 1 provides no cap, deduplication, or triage mechanism, so it converts agent initiative into an unbounded, unpredictable stream of review requests on the owner's desk without any throttle to protect their attention.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}