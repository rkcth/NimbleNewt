# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-facts-rolling","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"tldrStyle":"facts","summaryWords":60,"summarizeAbove":70,"chairNotes":"rolling","chairReminders":2}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose making Lintwise mandatory immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; I don’t know what overhead it would add here. I recommend a non-blocking trial in our monorepo, measuring useful findings and CI time before deciding whether to require it.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise immediately. Our CI builds average 11 minutes, and we don’t know its runtime or effect on queue length in our monorepo. Priya’s previous experience is useful, but it doesn’t establish the overhead here. As the CI owner, I support a non-blocking trial measuring added runtime, queue impact, and useful findings before we consider a required pre-merge check. The motion also says “every repository,” while we currently maintain one monorepo; we should make the intended scope explicit.

**#4 Elena** _(round 1)_ [against]
I oppose requiring Lintwise immediately. From a security perspective, we have not established whether it detects exposed secrets or risky dependencies; being a static code-quality checker does not establish that coverage. I support a non-blocking trial in our monorepo, measuring useful findings and CI impact while verifying its security capabilities. We should not treat it as a substitute for secrets or dependency checks without evidence. Any revised motion should explicitly name our monorepo rather than “every repository.”

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise required immediately. I write most of our JavaScript and have tried Lintwise on a side project, but that does not establish how useful or costly it would be in our monorepo. I support a non-blocking trial that evaluates JavaScript findings alongside added CI runtime and queue impact. Our builds already average 11 minutes. We should use the trial results to decide whether it merits blocking merges, and revise the scope from “every repository” to our monorepo.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise required immediately. I maintain our data pipelines, mostly in Python and SQL, and have not used Lintwise. We have not established its coverage or usefulness for that code. I support a non-blocking trial in our monorepo that evaluates actionable Python and SQL findings, added CI runtime, and queue impact before deciding whether to block merges. The motion should explicitly name our monorepo rather than “every repository.”

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise immediately. As QA lead, I want actionable findings, not a noisy merge gate. I have read its documentation, but that does not establish its signal quality in our codebase. I support a non-blocking trial in our monorepo, reviewing useful findings, false positives, and overlap with existing checks, alongside added CI runtime and queue impact. Before making it mandatory, we should agree which findings justify blocking merges and how exceptions will be handled. The motion should name our monorepo explicitly.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. Consistent checks can help, but a required merge gate needs evidence that its findings justify the disruption. Our CI already averages 11 minutes, and Lintwise’s overhead and usefulness in our monorepo remain unknown. I support a non-blocking trial measuring actionable findings, false positives, overlap with existing checks, added runtime, and queue impact across our languages. As merge-policy owner, I want us to agree on blocking criteria and an exception process before making it mandatory. A revised motion should explicitly cover our monorepo, with a separate decision on enforcement after reviewing the trial.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise immediately. As a newer developer, I want clear code-style guidance, but I have not used Lintwise and do not know whether its recommendations match our conventions. I support a non-blocking trial in our monorepo. Alongside useful findings and CI impact, we should assess whether its messages clearly explain what to change and why. Before it blocks merges, we should document which rules we adopt and how developers can question a finding or request an exception.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings and CI comparability (Which real bugs did Lintwise catch on your prior team, and how did that team's CI setup compare with our monorepo?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. I don’t have details establishing how that team’s CI compares with our monorepo, so those timings are not predictions for us. I still oppose making it required before a non-blocking trial.

**#12 Chair** _(fact-finding question)_
To Marcus: CI baseline measurements (Beyond the current 11-minute average build time, what runtime and queue measurements are already available to assess a non-blocking trial?)

**#13 Marcus** _(answer to chair)_ [against]
Beyond our 11-minute average build time, my notes show CI queue wait is already 6 minutes at peak. I have no other baseline measurements to report. I have not measured Lintwise myself, so I cannot estimate its overhead here. A non-blocking trial should measure added runtime and changes in queue wait against those baselines.

**#14 Priya** _(round 2)_ [against]
Marcus’s report of six-minute peak queue waits reinforces my support for a non-blocking trial rather than an immediate merge gate. My previous team’s cache reduced Lintwise’s added CI time from about four minutes to about one, but neither timing predicts performance here. We should test caching in our monorepo and measure runtime, queue impact, actionable findings, false positives, and overlap with existing checks. I also support explicitly limiting the revised motion to our monorepo and making enforcement a separate decision, with agreed blocking rules and an exception process.

**#15 Marcus** _(round 2)_ [against]
I remain against the motion as written. Builds average 11 minutes, and peak queue wait is already 6 minutes. Priya’s caching results make caching worth testing, but they do not establish Lintwise’s overhead here; I have not measured it myself. I support a non-blocking trial in our monorepo, measuring added runtime and queue impact alongside actionable findings, false positives, and overlap with existing checks. We should compare cached and uncached runs rather than assume the prior team’s improvement transfers. Any revised motion should name our monorepo and reserve mandatory enforcement for a separate decision after reviewing results and agreeing on blocking criteria and exceptions.

**#16 Elena** _(round 2)_ [against]
I remain against immediate mandatory enforcement, but I can update my earlier uncertainty about secrets coverage. My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and required rotation. That is concrete evidence of potential value here, though it does not establish comprehensive secrets coverage or dependency-risk detection. I support a non-blocking trial in our monorepo that tests this rule set alongside actionable findings, false positives, runtime, and queue impact. Priya’s caching experience is worth testing, not assuming. Mandatory enforcement should remain a separate decision after reviewing results and agreeing on blocking criteria and exceptions.

**#17 Tom** _(round 2)_ [against]
I remain against requiring Lintwise immediately. My notes show that on my side project, its default rules produced about 30 percent noise in JavaScript files. I did not try tuning the rules, so that does not establish what a tuned configuration would do in our monorepo. Elena’s secrets example strengthens the case for testing it, not necessarily for making every finding a merge blocker. I support a non-blocking monorepo trial comparing default and tuned JavaScript rules, reviewing actionable findings and noise, and measuring runtime and queue impact with and without caching. Mandatory enforcement should be a separate decision after we agree on blocking rules and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial first; my side-project defaults were noisy, but I never tested tuning.

**#18 Sana** _(round 2)_ [against]
I remain against requiring Lintwise immediately. My notes show our pipeline code has no static checks today, and two outages last year came from typos in config keys. That gives us a concrete issue to investigate, but I have not used Lintwise and do not know whether it can detect those mistakes. The non-blocking monorepo trial should test that capability alongside actionable Python and SQL findings. Tom’s JavaScript noise rate does not establish signal quality for our pipelines, just as Priya’s timings do not predict our CI overhead. I support measuring false positives, runtime, and queue impact, including cached runs. Mandatory enforcement should remain a separate decision after reviewing results and agreeing on blocking rules and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise on pipeline code, explicitly testing config-key typo detection; do not assume coverage or require it before reviewing results.

**#19 Lars** _(round 2)_ [against]
I remain against immediate mandatory enforcement. Tom’s noisy defaults make rule tuning worth testing, not a reason to assume Lintwise cannot provide useful signal. Its documentation describes a baseline mode that ignores existing findings and reports only new ones; we should evaluate that mode while separately reviewing existing findings. In a trial I read about, a tuned rule set had about an 8 percent false-positive rate, but that does not predict our results. I support a non-blocking monorepo trial measuring actionable findings, false positives, overlap with existing checks, runtime, and queue impact. It should also test the specific secrets and pipeline concerns Elena and Sana raised. Enforcement should require a separate decision on blocking rules and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial first: test tuning and baseline mode, measure our own signal and CI impact, and agree on blocking criteria before requiring Lintwise.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Elena’s secrets example supports testing Lintwise, while Tom’s noisy defaults and Marcus’s queue measurements argue against immediate enforcement. Our merge policy requires a trial period and a rollback path; we have reversed two past policy changes after rolling them out repo-wide at once. I support a non-blocking trial explicitly scoped to our monorepo, testing tuning, baseline mode, and caching while measuring actionable findings, false positives, runtime, and queue impact. The write-ups I reviewed recommend publishing false-positive rates and promoting rules to blocking one at a time. After reviewing our results, we should separately decide which rules, if any, should block merges, with documented exceptions and rollback criteria.
> tl;dr (what later speakers saw in summary mode): Trial first in our monorepo; require a separate enforcement decision, rule-by-rule rollout, and a rollback path.

**#21 Olga** _(round 2)_ [against]
I remain against requiring Lintwise immediately. Elena’s secrets example gives us a concrete reason to test it, but Tom’s experience with noisy defaults reinforces the need to evaluate and tune its findings first. I have not used Lintwise. Style questions take the most time in my reviews, so I want the non-blocking trial in our monorepo to assess whether its style rules match our conventions and whether messages clearly explain what to change and why. I support Jin’s proposal to decide on blocking rules separately after reviewing results. Before enforcement, we should publish the adopted rules and document how to question a finding, request an exception, and roll back enforcement.

**#22 Priya** _(objection)_
The motion requires immediate enforcement without a trial or agreed blocking criteria, despite Lintwise adding about four minutes to CI on my previous team.

**#23 Marcus** _(objection)_
The motion still requires immediate enforcement, without a trial to measure CI time and queue impact or a separate enforcement decision.

**#24 Tom** _(objection)_
The motion still requires immediate enforcement rather than the trial and separate enforcement decision discussed.

**#25 Olga** _(objection)_
The motion requires Lintwise immediately, while the discussion calls for a trial and a separate enforcement decision.

**#26 Chair** _(ruling)_
Amended. New wording: The team adopts a non-blocking trial of Lintwise in our monorepo to assess actionable findings, false positives, overlap with existing checks, language coverage, rule clarity, and CI runtime and queue impact, including cached and uncached runs; mandatory enforcement requires a separate decision after reviewing results and agreeing on blocking rules, exceptions, and rollback.

**#27 Chair** _(chair reminder)_
Reminder from Sana's full statement: "My notes show our pipeline code has no static checks today, and two outages last year came from typos in config keys."

**#28 Chair** _(chair reminder)_
Reminder from Jin's full statement: "Our merge policy requires a trial period and a rollback path; we have reversed two past policy changes after rolling them out repo-wide at once."

## Ballots (revealed together at the close)
- Priya: **yes** — The amended motion tests Lintwise’s value and CI impact in our monorepo without blocking merges, reserving enforcement for a separate decision with agreed rules, exceptions, and rollback.
- Marcus: **yes** — The non-blocking trial will measure cached and uncached runtime and queue impact against our 11-minute build average and six-minute peak queue wait before a separate enforcement decision.
- Elena: **yes** — The non-blocking trial lets us evaluate secret-detection value without assuming comprehensive security coverage, while reserving enforcement for a separate decision with agreed rules, exceptions, and rollback.
- Tom: **yes** — The non-blocking trial lets us assess JavaScript findings and tune the noisy defaults I encountered on my side project, while reserving enforcement for a separate decision.
- Sana: **yes** — The non-blocking trial lets us assess Python and SQL coverage, including config-key typo detection, and CI impact before a separate enforcement decision.
- Lars: **yes** — The non-blocking trial evaluates actionable findings and noise alongside CI impact, while reserving enforcement for a separate decision with agreed rules, exceptions, and rollback.
- Jin: **yes** — The amended motion supports a non-blocking trial consistent with our merge policy and reserves enforcement for a separate decision on evidence, blocking rules, exceptions, and rollback.
- Olga: **yes** — The non-blocking trial will assess rule clarity and usefulness before a separate enforcement decision with agreed blocking rules, exceptions, and rollback.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}