# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"blind-first","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1 (blind))_ [against]
I oppose the motion as written. I used Lintwise for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes. I don’t know whether we would see the same overhead here, so I would first run it non-blocking in our monorepo and assess useful findings and added CI time. We can then decide whether to make it a required pre-merge check.
> tl;dr (what later speakers saw in summary mode): Lintwise caught bugs in my experience, but we should measure its benefit and CI cost here before making it mandatory.

**#3 Marcus** _(round 1 (blind))_ [undecided]
I’m not ready to make Lintwise a required pre-merge check. Our CI builds already average 11 minutes, and we have no measurements of its runtime or effect on queue length. We maintain one monorepo, so I’d first run it there as a non-blocking check. I’d measure added pipeline time, runner usage, queue delays, and whether its findings are actionable. We should also agree on how checker failures and existing violations would be handled before making it mandatory. I’d support revisiting the motion once we have that evidence.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then decide based on measured CI costs and actionable findings.

**#4 Elena** _(round 1 (blind))_ [undecided]
I cannot support a required pre-merge check without knowing whether Lintwise detects secrets or dependency risks, what access it needs, and how it handles source code and findings. Being a static code-quality checker does not establish those security capabilities. For our eight-person team maintaining one monorepo, I recommend a nonblocking trial first. Evaluate useful findings, false positives, permissions, data handling, and added time against our current 11-minute average CI build. Require it only after we agree on blocking rules and an exception process. It should not replace dedicated secrets or dependency checks unless its coverage is demonstrated.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise before mandating it; verify security coverage, data handling, and CI impact.

**#5 Tom** _(round 1 (blind))_ [undecided]
I write most of our JavaScript and have tried Lintwise on a side project, but that alone doesn’t establish that it should block merges in our monorepo. Our CI already averages 11 minutes; I don’t know what Lintwise would add or how useful its findings would be here. I’d first run it without blocking merges, review its findings, and measure its effect on CI time. Then we can agree which checks justify blocking a merge before making it required.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise in our monorepo before requiring it, using finding quality and added CI time to guide the decision.

**#6 Sana** _(round 1 (blind))_ [undecided]
I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. I need evidence that it provides useful checks for both languages before supporting a required pre-merge gate. Our CI already averages 11 minutes; we should measure added runtime and review whether findings are actionable. I suggest a non-blocking trial in the monorepo, covering representative pipeline code, before deciding which checks should block merges. The trial should also establish how we handle false positives and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then decide based on Python and SQL coverage, actionable findings, and added CI time.

**#7 Lars** _(round 1 (blind))_ [against]
I oppose making Lintwise a required pre-merge check immediately. As QA lead, I want blocking checks to provide actionable signal without unnecessary noise. The information available here does not establish Lintwise’s false-positive rate, coverage, or effect on our existing 11-minute CI builds. I propose a non-blocking trial in our monorepo, reviewing findings for usefulness and measuring added CI time. We can then decide which rules, if any, should block merges and how exceptions will be handled.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then require only rules that demonstrate useful signal and acceptable CI overhead.

**#8 Jin** _(round 1 (blind))_ [against]
I support consistent code-quality checks, but not an immediate blanket merge requirement. Our eight-person team maintains one monorepo, and CI already averages 11 minutes. We have no evidence here about Lintwise’s added runtime, findings, or fit with our codebase. As merge-policy owner, I would first run it without blocking merges, review its findings, and measure its effect on feedback time. We could then require specific checks that produce actionable results, with a documented exception process. That would establish consistency without making an untested checker a gate for every change.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then require validated checks rather than adopting an untested blanket gate.

**#9 Olga** _(round 1 (blind))_ [undecided]
As a newer developer, I would welcome clear, consistent code-style guidance. But I have not used Lintwise, so I cannot judge whether its checks would be useful or how much time they would add to our current 11-minute CI builds. Before making it a required pre-merge check, I would like a trial in our monorepo, an agreed rule set, and clear instructions for fixing findings or handling exceptions. That would help me follow team expectations without making unfamiliar checks an unexplained barrier to merging.
> tl;dr (what later speakers saw in summary mode): I support clearer guidance, but want a trial and agreed rules before making Lintwise mandatory.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings and CI overhead (What kinds of real bugs did Lintwise catch on your previous team, and how was the roughly four-minute CI increase measured?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. My notes record about four minutes of added CI time with the default run, dropping to about one minute with its result cache enabled. I don’t have the measurement method documented, so I can’t explain how that increase was measured.
> tl;dr (what later speakers saw in summary mode): It caught null-handling bugs; caching reduced recorded overhead, but I cannot verify the measurement method.

**#12 Chair** _(fact-finding question)_
To Tom: JavaScript trial findings (In your side-project trial, what actionable findings or false positives did you observe, and did you measure runtime?)

**#13 Tom** _(answer to chair)_ [undecided]
On my side project, about 30 percent of Lintwise’s default-rule findings in JavaScript files were noise. I did not try tuning the rules. My notes don’t identify specific actionable findings or record runtime measurements, so I can’t provide examples or a measured runtime.
> tl;dr (what later speakers saw in summary mode): Default JavaScript rules produced about 30 percent noise; I have no documented actionable examples or runtime measurements.

**#14 Priya** _(round 2)_ [against]
I remain against the motion as written and support the non-blocking monorepo trial others proposed. My previous team’s experience shows potential value: Lintwise caught three null-handling bugs in its first month. My notes also qualify my initial runtime concern: the default run added about four minutes, but enabling its result cache reduced that to about one minute. I cannot document the measurement method or predict our overhead. Tom’s reported noise reinforces the need to review and tune rules rather than require the defaults. The trial should measure actionable findings and CI impact, including cache behavior, and assess coverage across our languages. Before making any checks mandatory, we should agree on blocking rules and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; use measured findings, cache performance, and agreed rules to decide whether it should become mandatory.

**#15 Marcus** _(round 2)_ [against]
I remain against the motion as written. My CI notes add an important constraint: peak queue wait is already six minutes, alongside our 11-minute average build. Priya’s cache result is encouraging, but her measurement method is undocumented, and I have not measured Lintwise myself. We should not assume either her default or cached overhead will transfer here. I support a non-blocking monorepo trial measuring added pipeline time, runner usage, peak queue delays, and cache behavior. Tom’s reported noise also supports reviewing and tuning findings before choosing blocking rules. Before making any check mandatory, we should agree on acceptable CI impact, handling of checker failures and existing violations, and an exception process.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure runtime and queue impact before adopting agreed blocking rules.

**#16 Elena** _(round 2)_ [against]
I remain against the motion as written, but my notes resolve part of my earlier uncertainty: Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and required rotation. That is a concrete reason to evaluate it, not evidence of comprehensive secrets or dependency coverage. Priya’s cache experience and Tom’s reported noise support measuring runtime and tuning rules here rather than adopting defaults as a blanket gate. I support a non-blocking monorepo trial that evaluates the secret rules alongside code-quality findings, permissions, data handling, and CI impact. Before requiring checks, we should agree on blocking rules and exceptions. We should not treat Lintwise as a replacement for dedicated security checks without demonstrated coverage.
> tl;dr (what later speakers saw in summary mode): Lintwise could address a known secrets failure, but trial results and security review should precede mandatory checks.

**#17 Tom** _(round 2)_ [against]
I remain against the motion as written. Priya’s bug findings and Elena’s secret-rule example give us reasons to evaluate Lintwise, but they do not establish that its defaults should block every merge here. On my side project, about 30 percent of default-rule findings in JavaScript files were noise; I did not tune the rules, so that is not evidence that tuning would fail. I support a non-blocking monorepo trial that reviews JavaScript findings alongside our other languages and compares default and tuned rules. Marcus’s queue concerns also make measuring CI impact important, including cache behavior rather than assuming Priya’s results will transfer. We should choose blocking rules and document exceptions only after reviewing the trial.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure CI impact and tune findings before deciding which rules should become required.

**#18 Sana** _(round 2)_ [against]
I remain against the motion as written and support a non-blocking trial in our monorepo. My notes say our pipeline code has no static checks today, and two outages last year came from typos in config keys. That gives us a concrete problem to investigate, but I do not know whether Lintwise can detect those mistakes. I have not used it. The trial should test representative Python, SQL, and configuration files, including whether it would flag those known errors. Priya’s findings and Elena’s secret-rule example show reasons to evaluate it, not proof of coverage for our pipelines. Tom’s noise report and Marcus’s queue concerns reinforce measuring actionable findings and CI impact before selecting blocking rules. We should also document exceptions and how existing violations will be handled.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise against our pipeline languages and known configuration mistakes before making any checks mandatory.

**#19 Lars** _(round 2)_ [against]
I remain against the motion as written and support a non-blocking monorepo trial. Lintwise’s documentation describes a baseline mode that ignores existing findings and reports only new ones. That addresses part of Marcus’s concern about existing violations, though we still need to decide how to handle them. A trial I read about reported about an 8 percent false-positive rate with tuned rules. That supports testing rule tuning, not assuming we will achieve the same rate here or directly comparing it with Tom’s side project. From QA’s perspective, we should review actionable findings and false positives across our languages, test relevant known defects, and measure CI and queue impact, including cache behavior. Only then should we select blocking rules and document checker-failure handling and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial tuned rules and baseline mode first; require checks only after measuring signal, noise, and CI impact here.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Priya’s bug findings and Elena’s secret-rule example justify evaluation, while Tom’s noise report and Marcus’s queue concerns argue against an immediate blanket gate. Our merge-policy changes need a trial period and rollback path; we have reversed two past policy changes after repo-wide rollouts. I support non-blocking warnings in our monorepo, measuring actionable findings, false positives, and CI and queue impact. Lars’s baseline finding is worth testing for handling existing violations. The write-ups I reviewed recommend publishing the false-positive rate and promoting rules to blocking one at a time. After the trial, we should agree on specific blocking rules, exceptions, checker-failure handling, and rollback criteria. I have not yet asked the team about their comfort with that staged approach.
> tl;dr (what later speakers saw in summary mode): Trial non-blocking checks first, then promote proven rules individually with published results, clear exceptions, and a rollback path.

**#21 Olga** _(round 2)_ [against]
I remain against making Lintwise mandatory immediately and support the non-blocking monorepo trial. My notes say style questions take the most time in my reviews, so consistent guidance could help me. But I have not used Lintwise and do not know whether its messages would explain findings clearly. Alongside the runtime and false-positive measurements others proposed, I would like the trial to assess whether findings explain what is wrong and how to fix it. Tom’s noise report reinforces the need for an agreed, tuned rule set rather than requiring defaults. Jin’s staged approach makes sense to me: publish clear guidance and exception instructions before promoting individual rules to blocking.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first, checking whether its findings provide clear, actionable guidance before making specific rules mandatory.

## Ballots (revealed together at the close)
- Priya: **no** — I support a non-blocking monorepo trial to measure useful findings and CI impact before making Lintwise a required pre-merge check.
- Marcus: **no** — We should measure Lintwise’s runtime, runner usage, and queue impact in a non-blocking monorepo trial before requiring it for merges.
- Elena: **no** — I support a non-blocking trial to assess security coverage, permissions, data handling, and CI impact before requiring Lintwise as a merge gate.
- Tom: **no** — My side-project trial had noisy default JavaScript findings, so I support a non-blocking monorepo trial before requiring Lintwise for merges.
- Sana: **no** — I support a non-blocking trial to establish useful coverage for our Python, SQL, and configuration files and measure CI impact before requiring Lintwise.
- Lars: **no** — We should first validate actionable findings, false positives, and CI impact in a non-blocking monorepo trial before requiring specific checks.
- Jin: **no** — I support a non-blocking monorepo trial before requiring specific rules, with measured CI impact, documented exceptions, and rollback criteria.
- Olga: **no** — I support a non-blocking trial to assess clear, useful guidance and agree on rules and exceptions before making Lintwise mandatory.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}