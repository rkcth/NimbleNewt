# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-chain","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose the motion as written. I used Lintwise for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we should measure its impact here before making it a required pre-merge check. I propose a non-blocking trial in our monorepo, tracking useful findings and added CI time, then deciding whether to require it.
> tl;dr (what later speakers saw in summary mode): Lintwise caught real bugs on my previous team, but we should measure its local value and CI cost before requiring it.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise before we measure its effect on our CI pipeline. Our builds already average 11 minutes, and added work could increase both build time and queue length. Priya’s experience is useful evidence, but it does not establish the cost in our monorepo. I support a non-blocking trial that tracks useful findings, added runtime, and queue impact. We should review those results before making it a merge requirement.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then decide based on useful findings, build time, and queue impact.

**#4 Elena** _(round 1)_ [against]
I oppose making Lintwise mandatory before we establish what it checks and how it performs in our monorepo. From a security perspective, we should not assume a static code-quality checker detects exposed secrets or risky dependencies. I support the proposed non-blocking trial, with an explicit review of its security-relevant coverage alongside useful findings, added runtime, and queue impact. Any gaps in secrets or dependency checks should be addressed separately. We can reconsider a merge requirement once we know its local value and operational cost.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first; verify security coverage and CI impact before making it a merge requirement.

**#5 Tom** _(round 1)_ [against]
I oppose requiring Lintwise before we test it in our monorepo. I write most of our JavaScript and have tried Lintwise on a side project, but that experience does not establish its value here. I support a non-blocking trial that checks whether its JavaScript findings are actionable, whether they duplicate existing checks, and how much runtime it adds to our current 11-minute average CI build. We should review the results before deciding which checks, if any, should block merges. Since we maintain one monorepo, I would also narrow the motion to that repository rather than every repository.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then require only checks that demonstrate local value at an acceptable CI cost.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise mandatory before we test it in our monorepo. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. A non-blocking trial should establish whether it supports our code and produces actionable findings rather than duplicating existing checks. We should also measure its added runtime against our current 11-minute average CI build. I support reviewing those results before deciding which checks, if any, should block merges. The motion should refer to our monorepo, not every repository.
> tl;dr (what later speakers saw in summary mode): Test Lintwise without blocking merges, evaluate its Python and SQL findings and CI cost, then decide whether to require it.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise before we establish its signal quality in our monorepo. I have read its documentation, but that does not establish how useful or noisy its findings will be on our code. I support a non-blocking trial that records actionable findings, false positives, overlap with existing checks, and added CI time against our current 11-minute average. We should review the results before selecting any checks to block merges, with clear ownership for investigating failures. The motion should also refer to our monorepo rather than every repository.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; require only checks that demonstrate useful signal, manageable noise, and acceptable CI cost.

**#8 Jin** _(round 1)_ [against]
I oppose version 1. A required check would make Lintwise part of our merge policy before we know whether its findings justify the disruption. Consistency matters, but so does keeping useful changes moving. I support a non-blocking trial in our monorepo, measuring actionable findings, false positives, overlap with existing checks, and added time against our current 11-minute CI average. Before making any checks mandatory, we should agree on acceptance criteria, assign responsibility for failures, and define an exception process. As merge-policy owner, I would bring a revised proposal after reviewing the trial results with the team.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; require only checks supported by local evidence and a clear failure-handling policy.

**#9 Olga** _(round 1)_ [against]
I oppose version 1 and support a non-blocking trial. As someone newer to the team, I want clear code-style guidance, but I have not used Lintwise and cannot judge whether its rules match our conventions. During the trial, I would like findings to explain what needs changing and point to agreed guidance. We should distinguish required fixes from optional suggestions and identify whom to ask when a finding is unclear. That would help me learn without making unfamiliar or disputed rules an immediate barrier to merging. We can consider required checks after reviewing useful findings, noise, and added CI time.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first, with clear explanations and agreed rules, before making it a merge requirement.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings (What bugs did Lintwise catch on your previous team, and what do you know about its false positives and added CI time?)

**#11 Priya** _(answer to chair)_ [undecided]
I used Lintwise for six months on my previous team. It caught three null-handling bugs in the first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. I don’t have false-positive data in my notes.
> tl;dr (what later speakers saw in summary mode): Lintwise caught real bugs, but its local value, false positives, and CI cost still need testing before we require it.

**#12 Chair** _(fact-finding question)_
To Jin: Failure-handling policy (What existing team procedures, if any, cover disputed findings or unavailable pre-merge checks?)

**#13 Jin** _(answer to chair)_ [against]
Our merge-policy changes require a trial period and a rollback path. My notes do not identify an existing procedure for disputed findings or unavailable checks, so I cannot confirm one. We reversed two previous policy changes after repo-wide rollouts. Before making Lintwise mandatory, we should trial it as non-blocking and define dispute handling, outage handling, and rollback.
> tl;dr (what later speakers saw in summary mode): Trial and rollback are required; existing dispute and outage procedures are unconfirmed.

**#14 Priya** _(round 2)_ [against]
I oppose making Lintwise mandatory now, but support a non-blocking trial. My notes clarify my earlier answer: on my previous team, it caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. Those results do not establish its value or cost in our monorepo, and I have no false-positive figures. With our builds already averaging 11 minutes, we should measure useful findings, noise, and added runtime, including cache performance. Jin’s point also matters: before requiring it, define dispute handling, outage handling, and a rollback path.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise non-blocking first; require it only after measuring local benefits and CI cost and defining failure handling.

**#15 Marcus** _(round 2)_ [against]
I still oppose requiring Lintwise now and support a non-blocking trial in our monorepo. Our builds average 11 minutes, and peak queue waits are already six minutes. I have not measured Lintwise myself. Priya’s clarification about caching is useful, but neither her four-minute default overhead nor her one-minute cached overhead establishes our local cost. During the trial, I would measure added runtime, cache performance, and peak queue impact alongside useful findings and noise. Before making any checks mandatory, we should agree on acceptable CI impact and define dispute handling, outage handling, and rollback.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure local runtime and queue impact before requiring checks, with clear failure-handling and rollback rules.

**#16 Elena** _(round 2)_ [against]
I oppose requiring Lintwise now and support a non-blocking trial. My notes provide one concrete security reason to test it: last quarter, a hard-coded test key reached main and had to be rotated; Lintwise’s secret-detection rules would have flagged that commit. That supports testing secret detection, not requiring every rule. I have no evidence here about its dependency-risk coverage. I agree with Marcus that we need local measurements of useful findings, noise, added runtime, and queue impact against our current 11-minute average builds. Before making proven checks mandatory, we should agree on acceptable CI impact, disputed-finding and outage handling, and rollback.
> tl;dr (what later speakers saw in summary mode): Trial secret detection using our known incident, measure local costs and noise, and define failure handling before requiring proven checks.

**#17 Tom** _(round 2)_ [against]
I still oppose requiring Lintwise now and support a non-blocking trial. On my side project, about 30 percent of its default-rule findings in JavaScript files were noise. I did not try tuning the rules, so that does not establish what we should expect in our monorepo. Elena’s example supports testing secret detection, not enabling every rule as a blocker. We should measure useful findings and noise by rule, try tuning, and measure runtime and queue impact against our current 11-minute average builds. Before requiring proven checks, we also need agreed dispute, outage, and rollback procedures.
> tl;dr (what later speakers saw in summary mode): Trial and tune Lintwise first; require only locally proven checks with acceptable CI impact and clear failure-handling procedures.

**#18 Sana** _(round 2)_ [against]
I oppose making Lintwise mandatory now and support a non-blocking trial. I have not used it. Our pipeline repos have no static checks today, and two outages last year came from typos in config keys. That gives us a concrete test: can Lintwise identify those mistakes? We should not assume it can. I agree with Tom that JavaScript noise rates do not establish what we will see in Python and SQL. Measure useful findings and noise by rule in our pipelines, plus runtime and queue impact against our current 11-minute average builds. Before requiring any checks, agree on dispute, outage, and rollback procedures.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise on Python, SQL, and known config mistakes before requiring locally proven checks with clear failure handling.

**#19 Lars** _(round 2)_ [against]
I remain against requiring Lintwise now and support a non-blocking trial. Sana is right that results elsewhere do not establish signal in our Python and SQL. Lintwise’s documentation describes a baseline mode that ignores existing findings and reports only new ones; that could keep the trial focused, but we should separately test the known config-key mistakes. A trial I read about reported about 8 percent false positives with tuned rules—not a prediction for us. Measure useful findings and false positives by rule, alongside runtime and queue impact against our 11-minute average builds. Require only checks that demonstrate local value, with agreed dispute, outage, and rollback procedures.
> tl;dr (what later speakers saw in summary mode): Trial baseline mode and targeted historical mistakes; require only locally proven, low-noise checks after measuring CI impact and defining failure handling.

**#20 Jin** _(round 2)_ [against]
I remain against version 1. Lars’s rule-by-rule approach fits our merge policy: changes need a trial and a rollback path. We have reversed two policy changes after rolling them out repo-wide at once; I do not want to repeat that. I support a non-blocking trial in our monorepo, measuring useful findings, false positives by rule, runtime, and queue impact against our current 11-minute build average. The write-ups I reviewed recommend publishing false-positive rates and promoting rules to blocking one at a time. Before any promotion, we should agree on who resolves disputed findings, what happens during checker outages, and when to roll back. Those procedures remain unconfirmed. I have not yet asked the team directly about the proposed merge-policy details.
> tl;dr (what later speakers saw in summary mode): Trial non-blocking first; promote proven rules individually only with agreed dispute, outage, and rollback procedures.

**#21 Olga** _(round 2)_ [against]
I’m against version 1 and still support a non-blocking trial. Style questions take the most time in my reviews, so I would like to see whether Lintwise makes those decisions clearer. I haven’t used it, and I don’t know whether its messages explain findings well. Alongside the measurements others proposed, I’d check whether each finding explains what needs changing and which agreed team rule applies. I support Jin’s request to identify who resolves disputed findings before any rule becomes blocking. As someone newer to the team, I need clear guidance, not just a failed check.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first; require only proven checks with clear explanations, agreed style rules, and a named route for resolving disputes.

**#22 Priya** _(objection)_
The motion still requires Lintwise immediately, rather than providing for a non-blocking trial and agreed criteria for making proven checks mandatory.

**#23 Elena** _(objection)_
The motion still mandates Lintwise immediately rather than a non-blocking trial to verify security coverage, CI cost, and failure-handling procedures.

**#24 Tom** _(objection)_
The motion still requires Lintwise immediately rather than reflecting the proposed non-blocking trial and evidence-based adoption of individual checks.

**#25 Sana** _(objection)_
The motion still requires Lintwise immediately, rather than a non-blocking trial followed by evidence-based checks and agreed failure-handling procedures.

**#26 Lars** _(objection)_
The motion still requires Lintwise immediately, rather than a non-blocking trial followed by locally proven, low-noise checks with acceptable CI cost and agreed failure handling.

**#27 Jin** _(objection)_
The motion still requires Lintwise immediately, without the non-blocking trial, rule-by-rule evidence, and agreed dispute, outage, and rollback procedures discussed.

**#28 Olga** _(objection)_
The motion still requires Lintwise immediately, rather than a non-blocking trial followed by proven checks with agreed rules and dispute handling.

**#29 Chair** _(ruling)_
Amended. New wording: The team trials Lintwise as a non-blocking check on its monorepo, measuring useful findings, false positives, CI runtime, and queue impact. Individual checks become required pre-merge only after team agreement on local evidence, acceptable CI cost, and dispute, outage, and rollback procedures.

## Ballots (revealed together at the close)
- Priya: **yes** — Lintwise caught real bugs on my previous team but added about four minutes to CI, so I support a non-blocking trial before requiring individual checks under agreed procedures.
- Marcus: **yes** — The non-blocking trial measures CI runtime and queue impact before any checks become required, with team agreement on acceptable cost and failure-handling procedures.
- Elena: **yes** — The non-blocking trial lets us assess security findings and CI impact before requiring individual checks with agreed failure-handling procedures.
- Tom: **yes** — The amended motion provides a non-blocking trial and requires local evidence, acceptable CI cost, and agreed failure-handling procedures before individual checks block merges.
- Sana: **yes** — The non-blocking trial lets us evaluate Python and SQL findings and CI costs before requiring individual checks with agreed failure-handling procedures.
- Lars: **yes** — The non-blocking trial measures useful signal, false positives, and CI impact before individual checks become required with team agreement and failure-handling procedures.
- Jin: **yes** — The motion preserves merge speed during the trial and requires local evidence, acceptable CI cost, and agreed dispute, outage, and rollback procedures before individual checks become mandatory.
- Olga: **yes** — The non-blocking trial lets us assess Lintwise before requiring checks, with team agreement and dispute procedures to support clear guidance.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}