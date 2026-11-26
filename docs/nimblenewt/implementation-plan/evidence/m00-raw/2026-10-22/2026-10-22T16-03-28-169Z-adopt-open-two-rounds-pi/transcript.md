# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"open-two-rounds","firstRound":"open","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose requiring Lintwise immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we should measure its impact here rather than assume the same overhead. I suggest a non-blocking trial in our monorepo, then reconsider a required check based on the bugs it catches and the time it adds.

**#3 Marcus** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. Our CI builds already average 11 minutes, and we have no measurements of Lintwise’s runtime or effect on our queue. Priya’s experience is a reason to test, not a prediction of our results. I support a non-blocking trial in our monorepo, measuring added build time, queue wait, and actionable findings before deciding whether to make it mandatory.

**#4 Elena** _(round 1)_ [against]
I oppose requiring Lintwise now and support a non-blocking trial in our monorepo. From a security perspective, we have no evidence here that it detects exposed secrets or risky dependencies; being a static code-quality checker does not establish those capabilities. The trial should assess actionable findings and added CI time, and verify any claimed security coverage before we rely on it. Adopting Lintwise should not be treated as addressing secrets or dependency risk without that evidence.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise mandatory now. I write most of our JavaScript and have tried Lintwise on a side project, but that does not establish how useful or disruptive it would be in our monorepo. I support a non-blocking trial that measures actionable JavaScript findings, added CI time, and the effort needed to resolve or dismiss findings. We should review those results before making it a merge requirement. The motion should also reflect our actual scope: we maintain one monorepo.

**#6 Sana** _(round 1)_ [against]
I oppose requiring Lintwise before we test it in our monorepo. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. We do not yet know whether its coverage and findings will be useful for that code. I support a non-blocking trial that checks Python and SQL coverage, actionable findings, remediation effort, and added CI time. Our builds already average 11 minutes, so we should measure the impact before adding a merge requirement. Any revised motion should address our one monorepo rather than “every repository.”

**#7 Lars** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. As QA lead, I want evidence that a blocking check provides useful signal without excessive noise. I have read its documentation, but that does not establish how its findings will perform in our monorepo. I support a non-blocking trial measuring actionable findings, false positives, triage effort, and added CI time. We should review those results and agree which findings, if any, justify blocking merges. Any revised motion should refer to our one monorepo.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. A required check would apply a consistent standard, but we have not established whether Lintwise provides enough useful signal to justify blocking merges or extending our current 11-minute CI builds. As merge-policy owner, I support a non-blocking trial in our one monorepo. We should measure actionable findings, false positives, triage effort, added CI time, and queue impact across our code. Before making it mandatory, we should review those results and agree which findings warrant blocking, who maintains the configuration, and how exceptions are handled.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise now and support a non-blocking trial in our monorepo. As a newer developer, I want clear code-style guidance, but I have not used Lintwise and do not know whether its findings would provide that clarity. During the trial, we should check whether suggested fixes are understandable and consistent with our agreed conventions, alongside measuring useful findings and added CI time. Before any findings block merges, we should document the rules and explain how developers can resolve findings or request exceptions.

**#10 Chair** _(fact-finding question)_
To Priya: Findings and CI overhead in prior use (What kinds of real bugs did Lintwise catch on your previous team, and how was the roughly four-minute CI increase measured?)

**#11 Priya** _(answer to chair)_ [against]
I used Lintwise for six months on my previous team. It caught real bugs and added about four minutes to CI, but I cannot provide specific bug examples or explain how that increase was measured from the information I have. That experience does not establish its impact in our monorepo. I support a non-blocking trial before requiring it.

**#12 Chair** _(fact-finding question)_
To Tom: JavaScript side-project findings (What findings did Lintwise produce on your JavaScript side project, and which required useful fixes versus dismissal?)

**#13 Tom** _(answer to chair)_ [against]
I tried Lintwise on a JavaScript side project, but I cannot provide specific findings or distinguish useful fixes from dismissals from the information I have. That experience is not enough to justify making it mandatory in our monorepo. I support a non-blocking trial to assess its JavaScript findings here.

**#14 Priya** _(round 2)_ [against]
I should correct my earlier answer: I checked my desk notes. On my previous team, Lintwise caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. My notes do not explain how those timings were measured, and neither result predicts performance here. I still oppose requiring it now. I support the proposed non-blocking trial in our one monorepo, measuring actionable findings, triage effort, added CI time, and queue impact. We should test caching rather than assume either overhead figure applies, then agree which findings warrant blocking merges.

**#15 Marcus** _(round 2)_ [against]
Priya’s caching update strengthens the case for measuring rather than assuming overhead. I have not measured Lintwise myself. My desk notes confirm that our builds average 11 minutes and queue wait is already six minutes at peak. We should measure added build time and peak queue impact separately during a non-blocking trial in our one monorepo, testing both default and cached runs. Alongside actionable findings and triage effort, those results should inform whether any checks become mandatory. I still oppose the motion as written; before requiring Lintwise, we should agree on acceptable CI impact, blocking rules, configuration ownership, and exceptions.

**#16 Elena** _(round 2)_ [against]
I should update my earlier statement: my desk notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated. That establishes a concrete potential benefit for secrets detection, but not dependency-risk coverage or reliable performance across our monorepo. Priya’s caching update and Marcus’s queue figures reinforce the need to measure local impact. I still oppose requiring Lintwise as written. I support a non-blocking trial that tests secret detection alongside actionable findings, false positives, triage effort, default and cached runtime, and peak queue impact. We should then decide which rules warrant blocking merges, with clear ownership and exceptions.

**#17 Tom** _(round 2)_ [against]
I should update my earlier answer: my desk notes say Lintwise’s default rules produced about 30 percent noise in JavaScript files on my side project. I did not try tuning the rules, so that does not establish how noisy it would be in our monorepo or after configuration changes. Elena’s secret-detection update identifies a potential benefit, but it does not settle whether all findings should block merges. I still oppose the motion as written. I support a non-blocking trial in our one monorepo, comparing default and tuned JavaScript rules and measuring actionable findings, noise, and triage effort. We should also test caching and measure runtime and peak queue impact before choosing any blocking rules.

**#18 Sana** _(round 2)_ [against]
My desk notes add that our pipeline code has no static checks today, and two outages last year came from typos in config keys. That makes checking pipeline configuration worth investigating, but I do not know whether Lintwise can detect those errors. I have not used it. Elena’s secret-detection update identifies a potential benefit; Tom’s noise figures and Priya’s caching results show why we need local testing. I still oppose requiring it now. I support a non-blocking trial in our one monorepo that verifies Python, SQL, and configuration coverage, including whether it catches config-key typos. We should measure actionable findings, false positives, triage effort, cached and default runtime, and peak queue impact before selecting blocking rules.

**#19 Lars** _(round 2)_ [against]
I still oppose the motion as written. My desk notes add two relevant points: Lintwise has a baseline mode that ignores existing findings and reports only new ones, and a trial I read about reported about 8 percent false positives with tuned rules. That result does not predict our monorepo’s noise rate or directly compare with Tom’s side-project experience. Baseline mode could keep existing findings from overwhelming the trial, but it does not establish that new findings deserve to block merges. I support a non-blocking trial comparing default and tuned rules, assessing baseline mode, and measuring actionable findings, false positives, triage effort, cached runtime, and peak queue impact. We should verify the proposed secrets and pipeline checks, then agree which rules, if any, justify blocking.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Baseline mode, caching, and tuned rules offer options worth testing, not evidence that a mandatory check will preserve developer speed here. My desk notes say merge-policy changes need a trial period and a rollback path; we have reversed two policy changes because they were rolled out repo-wide at once. I support a non-blocking trial in our one monorepo, measuring useful findings, false positives, triage effort, runtime, and peak queue impact, while verifying secrets and pipeline coverage. Before any blocking rollout, we should agree on acceptable CI impact, specific blocking rules, configuration ownership, exceptions, and rollback criteria. Consistency matters, but it should come from tested rules and a staged rollout—not making every finding mandatory immediately.

**#21 Olga** _(round 2)_ [against]
I remain against requiring Lintwise now. My desk notes say style questions take the most time in my reviews, so clearer guidance would be valuable. I have not used Lintwise and do not know whether its messages would provide that guidance. Tom’s noise figures and Lars’s baseline option reinforce the need to test which findings help rather than assume every finding should block a merge. I support a non-blocking trial in our one monorepo. Alongside runtime, queue impact, and useful findings, we should assess whether messages explain the issue and how to fix it consistently with our agreed conventions. Before blocking merges, we should document the selected rules, configuration ownership, and exception process. I also support Jin’s call for a staged rollout and rollback criteria.

## Ballots (revealed together at the close)
- Priya: **no** — Lintwise caught bugs on my previous team, but we should measure its findings and CI impact in a non-blocking monorepo trial before requiring it.
- Marcus: **no** — We should measure Lintwise’s added build time and peak queue impact in a non-blocking monorepo trial before making it required.
- Elena: **no** — Lintwise’s secret-detection rules offer potential value, but we should verify coverage, noise, and CI impact in a non-blocking monorepo trial before requiring it.
- Tom: **no** — My side-project experience showed about 30 percent noise with default JavaScript rules, so I support a non-blocking monorepo trial before requiring Lintwise.
- Sana: **no** — We should first run a non-blocking trial in our monorepo to verify Python, SQL, and configuration coverage and measure useful findings, noise, and CI impact.
- Lars: **no** — We should first run a non-blocking trial in our monorepo to measure actionable findings, false positives, triage effort, and CI impact before choosing which rules warrant blocking merges.
- Jin: **no** — We need a non-blocking trial in our monorepo before requiring Lintwise, with agreed blocking rules, acceptable CI impact, ownership, exceptions, and rollback criteria.
- Olga: **no** — I support a non-blocking trial to assess useful findings and clear style guidance before requiring Lintwise to block merges.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}