# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
I oppose the motion as written. Owner approval before installation is necessary, but it does not contain everything an agent can do while developing a candidate. A separate checkout is not, by itself, a security boundary: builds and tests may execute code, and the project may inherit credentials, network access, or write permissions. I do not know which protections NimbleNewt currently provides. I would support agents autonomously proposing fixes, and potentially preparing candidates in a constrained environment with no production credentials, no write access to the running system, explicit resource limits, and an auditable record of changes and tests. The owner should authorize installing a specific reviewed artifact, not merely approve a project whose contents can change afterward. Until those boundaries are specified, keep owner initiation as the default.
> tl;dr (what later speakers saw in summary mode): Installation approval alone is insufficient; autonomous self-development needs explicit isolation, limited authority, and approval tied to a specific artifact.

**#3 Jonas** _(round 1 (blind))_ [against]
I would keep owner initiation as the default. A separate checkout protects the working installation, and explicit installation approval is essential, but neither controls the work spent producing unsolicited candidates. Maintenance includes reviewing proposals, reproducing defects, and deciding which fixes belong together; an automatically opened release project can add to that burden before anything is installed.

Agents should proactively report recurring defects and propose a scoped repair, including evidence and a validation plan. The owner can then authorize the candidate-release project. I would consider delegated standing permission for narrowly defined maintenance work, with explicit resource limits and stop conditions, rather than a general right to start work on NimbleNewt itself.
> tl;dr (what later speakers saw in summary mode): Keep agents proactive about defect reports and repair proposals, but require owner authorization before candidate-release work begins.

**#4 Lena** _(round 1 (blind))_ [against]
My concern is review-load accumulation. Each candidate release individually seems harmless, but agents noticing recurring defects could each open one, creating an unbounded queue of items the owner feels obligated to triage. The "nothing installed without explicit approval" gate is necessary but not sufficient — the owner still pays attention cost to evaluate each candidate. Without a rate limit or deduplication mechanism, this turns the owner's desk into an inbox they must constantly clear. I'd support this only if paired with a hard cap on concurrent candidate projects and a requirement that agents consolidate related findings into a single candidate rather than spawning many.
> tl;dr (what later speakers saw in summary mode): Unbounded candidate releases risk flooding the owner's attention even though each is individually gated.

**#5 Chair** _(fact-finding question)_
To Jonas: Review burden of unsolicited agent work (Any concrete experience with autonomous agent projects that produced review queue or attention costs, and how those were handled)

**#6 Jonas** _(answer to chair)_ [against]
I have no concrete example in my notes of an autonomous-project review queue or how it was handled. My review-burden concern is a judgment, not an observed incident. Agents do usually notice defects first, often repeatedly; waiting for owner initiation can delay fixes by days. Uninstalled candidates still cost compute and review time. I favor scoped standing permission over unrestricted initiation.
> tl;dr (what later speakers saw in summary mode): The delay is documented in my notes; review-queue accumulation is a concern, not an experience I can substantiate.

**#7 Chair** _(fact-finding question)_
To Noor: Isolation capabilities of NimbleNewt (What NimbleNewt currently provides in terms of credential isolation, resource limits, or sandboxing for a separate project checkout)

**#8 Noor** _(answer to chair)_ [against]
My notes say the initiating agent retains the same grants as in any project. A separate project limits where changes land, not what the agent can read. I have no confirmed details on credential isolation, resource limits, or sandboxing. Starting work is cheap to stop; installation is the dangerous step and remains with the owner.
> tl;dr (what later speakers saw in summary mode): Separate projects do not establish read isolation; other protections remain unconfirmed.

**#9 Noor** _(round 2)_ [against]
I remain against version 1, but distinguish starting work from installing it: my notes say starting is cheap to stop, while installation creates the lasting self-modification risk and remains with the owner. That is a meaningful safeguard. Still, the initiating agent retains its usual grants; a separate project limits where changes land, not what it can read. I cannot confirm additional isolation protections. Jonas’s scoped standing permission offers a better compromise than unrestricted initiation, and Lena’s concurrency cap and consolidation requirement would help bound unsolicited work. I would support owner-delegated maintenance authority with defined scope, resource limits, and stop conditions, plus installation approval tied to the specific reviewed artifact. Review burden remains a plausible concern, not an incident established here.
> tl;dr (what later speakers saw in summary mode): Keep owner initiation by default; allow scoped standing permission with bounded work and approval of a specific artifact before installation.

**#10 Jonas** _(round 2)_ [against]
I remain against version 1, but owner initiation has a real cost: my notes say agents usually encounter defects first, repeatedly, and fixes can wait days for the owner to start work. That argues for delegated maintenance authority, not an unrestricted default. Noor’s clarification also corrects my earlier wording: a separate checkout separates changes; it does not establish protection for the working installation or credentials. Lena’s concurrency cap and consolidation requirement would help control compute and review costs. I would support standing owner permission for a defined class of repairs, with resource limits, stop conditions, and bounded concurrent work. Agents should otherwise report the defect and propose a repair. Installation must remain an explicit owner step for the specific reviewed candidate.
> tl;dr (what later speakers saw in summary mode): Allow scoped, owner-delegated maintenance with bounded work, rather than unrestricted autonomous candidate projects.

**#11 Lena** _(round 2)_ [against]
I remain against version 1. Noor's point that starting is cheap to stop is fair, but my concern is not installation—it is the owner's attention cost at evaluation time. Each candidate still demands triage, and my notes confirm the owner already reviews approvals, notifications, and meetings. A flood could bury the candidates that matter. I have no data on how many agents would actually initiate, so I cannot confirm or dismiss that risk. Jonas's scoped standing permission with resource limits and Lena's concurrency cap and consolidation requirement together would address my concern better than unrestricted initiation. I would support that combination as a revised motion.
> tl;dr (what later speakers saw in summary mode): Attention cost at evaluation, not installation, is the real risk; scoped permission with caps is better than unrestricted initiation.

## Ballots (revealed together at the close)
- Noor: **no** — Version 1 permits autonomous work with unchanged agent grants and no specified resource or isolation limits; separate checkouts and owner-controlled installation do not bound development-time risks.
- Jonas: **no** — I favor scoped owner-delegated maintenance authority with resource limits and bounded concurrent work, not general permission to initiate candidate releases.
- Lena: **no** — The motion lacks any concurrency cap or consolidation requirement, leaving the owner's review queue unbounded and their attention cost unprotected against a flood of unsolicited candidates.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}