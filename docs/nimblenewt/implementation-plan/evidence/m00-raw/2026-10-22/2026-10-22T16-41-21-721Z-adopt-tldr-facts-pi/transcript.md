# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-facts","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"tldrStyle":"facts","summaryWords":60,"summarizeAbove":70,"chairNotes":true,"chairReminders":2}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes. That does not establish how much time it would add here, but it warrants testing before we make it mandatory. I recommend a non-blocking trial in our monorepo, then deciding based on bugs caught and added CI time.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise before we test it in our monorepo. As the CI owner, I want evidence of its effect on our current 11-minute average build time and on queue length. Priya’s experience warrants caution, but does not predict our results. I support a non-blocking trial that measures added CI time, queue impact, and useful findings. We should review those results before making it a merge gate.

**#4 Elena** _(round 1)_ [against]
I oppose making Lintwise mandatory before a trial. From a security perspective, we have no evidence here that it detects exposed secrets or risky dependencies; being a static code-quality checker does not establish those capabilities. I support a non-blocking trial in our monorepo to assess useful findings, added CI time, and queue impact. We should verify its security coverage separately and not treat it as a substitute for secrets or dependency checks.

**#5 Tom** _(round 1)_ [against]
I oppose requiring Lintwise before we test it in our monorepo. I write most of our JavaScript and have tried Lintwise on a side project, but that alone does not establish its usefulness or CI cost here. I support a non-blocking trial that assesses useful JavaScript findings, noisy warnings, and added CI time and queue impact. We should review those results before making it a merge gate.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check before testing it. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. We do not yet know how well it supports those languages or whether its findings would be useful for our pipelines. I support a non-blocking monorepo trial that checks Python and SQL coverage, useful findings, noisy warnings, and effects on CI time and queues. We should review those results before deciding whether to require it.

**#7 Lars** _(round 1)_ [against]
I oppose making Lintwise mandatory before a non-blocking trial. As QA lead, I want evidence that its findings provide useful signal rather than noise. I have read its documentation, but that does not establish how useful its findings will be in our monorepo. The trial should assess actionable findings, noisy warnings, and overlap with existing checks, alongside added CI time and queue impact. We should review those results before deciding whether to make it a merge gate.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. As tech lead and merge-policy owner, I want consistent checks, but we lack evidence that requiring Lintwise would justify its effect on developer speed. We maintain one monorepo, so I support a non-blocking trial there before adopting a broader requirement. The trial should assess actionable findings, noisy warnings, language coverage, overlap with existing checks, added CI time, and queue impact. We should agree on acceptance criteria before reviewing results, then decide whether any checks merit becoming merge blockers.

**#9 Olga** _(round 1)_ [against]
I oppose making Lintwise mandatory before a trial. As a newer developer, I want clear code-style guidance, but I have not used Lintwise and do not know whether its findings would provide that here. I support a non-blocking trial in our monorepo. Alongside useful findings, noise, and CI impact, we should assess whether its messages explain what needs changing and align with the team’s agreed style. We should document which rules we expect developers to follow before making any of them merge blockers.

**#10 Chair** _(fact-finding question)_
To Priya: Useful findings and noise in prior use (During your six months using Lintwise, what kinds of real bugs did it catch, and what noisy warnings did you encounter?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. I have no specific noisy-warning examples in my notes, so I cannot characterize the noise reliably. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. Those results support testing it here, not assuming the same benefits or costs.

**#12 Chair** _(fact-finding question)_
To Tom: JavaScript findings on a side project (What useful findings or noisy warnings did Lintwise produce on your JavaScript side project?)

**#13 Tom** _(answer to chair)_ [against]
On my side project, about 30 percent of Lintwise’s default-rule findings in JavaScript files were noise. I did not try tuning the rules. My notes contain no specific examples of useful findings or noisy warnings, so I cannot give those details. This does not establish what the noise level would be in our monorepo.

**#14 Priya** _(round 2)_ [against]
I remain against the motion as written. Tom’s reported noise reinforces the need to assess findings here, but neither his side project nor my previous team predicts our results. My notes show three null-handling bugs caught in the first month and added CI time dropping from about four minutes to about one with caching enabled. We should test caching in a non-blocking monorepo trial, alongside actionable findings, noise, language coverage, overlap with existing checks, and queue impact. I support Jin’s proposal to agree on acceptance criteria before reviewing results, and Olga’s request to document expected rules before making them merge blockers.

**#15 Marcus** _(round 2)_ [against]
I remain against the motion as written. Our CI builds average 11 minutes, and my notes show peak queue waits already reach 6 minutes. I have not measured Lintwise myself. Priya’s reported reduction from about four added minutes to about one with caching makes caching worth testing, but does not establish its impact here. I support a non-blocking monorepo trial that measures added build time and peak queue impact, alongside actionable findings and noise. We should agree on acceptance criteria before reviewing results and document the rules before making any checks mandatory.

**#16 Elena** _(round 2)_ [against]
I remain against the motion as written, but I can correct my earlier uncertainty about secrets coverage. My notes show that last quarter a hard-coded test key reached main and had to be rotated. Lintwise includes a secret-detection rule set that would have flagged that commit. That supports testing those rules here; it does not establish dependency-risk coverage or justify making every check mandatory. I support a non-blocking monorepo trial, including secret-detection findings, noise, caching, added CI time, and queue impact. We should agree on acceptance criteria and document expected rules before deciding which, if any, become merge blockers.

**#17 Tom** _(round 2)_ [against]
I remain against the motion as written. Elena’s secret-detection evidence supports testing that rule set, not requiring all checks immediately. On my side project, about 30 percent of default-rule findings in JavaScript files were noise, but I did not try tuning the rules. That leaves open whether tuning would improve the signal here. I support a non-blocking monorepo trial comparing default and tuned JavaScript rules, testing caching, and measuring actionable findings, noise, added CI time, and queue impact. We should agree on acceptance criteria beforehand and document any rules proposed as merge blockers.

**#18 Sana** _(round 2)_ [against]
I remain against the motion as written. My notes show that our pipelines have no static checks today, and two outages last year came from typos in config keys. That identifies a gap worth investigating, but I have not used Lintwise and do not know whether it could catch those errors. Elena’s evidence supports testing secret detection; it does not establish Python, SQL, or pipeline-config coverage. I support a non-blocking monorepo trial that checks those capabilities, actionable findings, and noise, alongside caching, CI time, and queue impact. We should agree on acceptance criteria beforehand and document any rules proposed as merge blockers.

**#19 Lars** _(round 2)_ [against]
I remain against the motion as written. Tom’s experience supports testing tuned rules, but my notes offer another data point: a trial I read about reported about an 8 percent false-positive rate with a tuned rule set. That does not predict our results, and we should not directly compare it with Tom’s measure of noise. Lintwise also has a baseline mode that ignores existing findings and reports only new ones. We should test that mode without treating suppressed findings as resolved. I support a non-blocking monorepo trial measuring actionable findings, false positives, overlap with existing checks, language coverage, and CI and queue impact, including caching. We should agree on acceptance criteria beforehand and document any rules proposed as merge blockers.
> tl;dr (what later speakers saw in summary mode): Test tuned rules and baseline mode locally; neither outside results nor suppressed findings establish readiness for mandatory checks.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Elena’s evidence supports testing secret detection, while the coverage and noise concerns argue against requiring all checks together. Our merge-policy changes need a trial period and a rollback path; we have reversed two past policy changes after rolling them out repo-wide at once. The write-ups I reviewed recommend non-blocking warnings first, promoting rules to blocking one at a time, and publishing the false-positive rate. I support a non-blocking monorepo trial with agreed acceptance criteria, testing caching, tuned rules, and baseline mode without treating suppressed findings as resolved. Before promoting any rule, we should document it, review findings and CI and queue impact, define rollback conditions, and ask developers about its effect on their workflow.
> tl;dr (what later speakers saw in summary mode): Trial first; promote justified rules individually, with published false-positive rates and a rollback path.

**#21 Olga** _(round 2)_ [against]
I remain against the motion as written. Style questions take the most time in my reviews, so I want to test whether Lintwise provides clear, actionable explanations that match our agreed style. I have not used it, and useful bug or secret detection does not establish that its style guidance will help. I support the non-blocking monorepo trial and Jin’s proposal to ask developers about workflow impact. Before promoting individual rules, we should document what they require, check whether developers understand their messages, and agree on acceptance criteria and rollback conditions. Tuned rules may help, but we need evidence from our own reviews.

**#22 Marcus** _(objection)_
We have not assessed Lintwise’s impact on our 11-minute CI builds or queue length before making it mandatory.

**#23 Elena** _(objection)_
The mandatory rule set and trial evidence remain unspecified, including whether secrets and dependency risks are covered.

**#24 Sana** _(objection)_
We have not established whether Lintwise’s Python and SQL checks are reliable enough to require for our data pipelines.

**#25 Lars** _(objection)_
We have not established readiness for mandatory checks through a trial with measured false-positive rates and a rollback path.

**#26 Olga** _(objection)_
We have not established which rules would be required or provided clear guidance for resolving findings before making Lintwise mandatory.

**#27 Chair** _(ruling)_
Amended. New wording: The team conducts a non-blocking Lintwise trial in its monorepo, agreeing beforehand on acceptance criteria and measuring actionable findings, false-positive rates, language and rule coverage, guidance clarity, CI time, and queue impact, including caching and rule tuning. Any later proposal to require individual rules must document their requirements, trial evidence, and rollback conditions.

**#28 Chair** _(chair reminder)_
Reminder from Lars's full statement: "Lintwise also has a baseline mode that ignores existing findings and reports only new ones."

**#29 Chair** _(chair reminder)_
Reminder from Jin's full statement: "Our merge-policy changes need a trial period and a rollback path; we have reversed two past policy changes after rolling them out repo-wide at once."

## Ballots (revealed together at the close)
- Priya: **yes** — The amended motion tests usefulness and CI cost in our monorepo, including caching, before any individual rule can be proposed as mandatory with evidence and rollback conditions.
- Marcus: **yes** — The amended motion addresses my objection by requiring a non-blocking trial with agreed acceptance criteria and measurements of CI time and queue impact, including caching and rule tuning, before any mandatory rules are proposed.
- Elena: **yes** — The non-blocking trial will assess secret-detection findings and rule coverage without assuming dependency-risk coverage, while requiring evidence and rollback conditions before individual rules become mandatory.
- Tom: **yes** — The non-blocking trial will test default and tuned JavaScript rules for actionable findings and false positives while measuring CI impact before any rules become mandatory.
- Sana: **yes** — The non-blocking trial will assess Python and SQL coverage and useful findings before any individual rules are proposed as requirements with supporting evidence and rollback conditions.
- Lars: **yes** — The amended motion requires a non-blocking trial with measured actionable findings and false-positive rates, plus documented evidence and rollback conditions before individual rules become mandatory.
- Jin: **yes** — The amended motion protects developer speed through a non-blocking trial with agreed acceptance criteria and requires evidence, documented requirements, and rollback conditions before individual rules become mandatory.
- Olga: **yes** — The amended motion provides a non-blocking trial that assesses guidance clarity and requires documented requirements, evidence, and rollback conditions before individual rules become mandatory.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}