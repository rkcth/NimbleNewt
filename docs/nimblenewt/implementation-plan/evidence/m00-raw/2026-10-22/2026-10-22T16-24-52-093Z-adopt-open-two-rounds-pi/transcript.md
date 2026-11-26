# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"open-two-rounds","firstRound":"open","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose making Lintwise mandatory immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we do not yet know its impact on this monorepo. I would support a trial that measures bugs caught and added CI time before we require it for every merge.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise immediately. As the CI owner, I want evidence of its effect on our 11-minute builds and queue length before making it a merge gate. Priya’s experience is useful, but it does not establish the cost on our monorepo. I support a non-blocking trial that measures added CI time, queue impact, and actionable findings. We should agree on acceptable results before the trial and revisit mandatory enforcement afterward.

**#4 Elena** _(round 1)_ [against]
I oppose the motion as written. From a security perspective, we have not established whether Lintwise detects exposed secrets or dependency risks, so we should not assume it provides those protections. I support a non-blocking trial with agreed evaluation criteria: actionable findings, coverage relevant to our security needs, added CI time, and queue impact. Before making it mandatory, we should also review what source code or credentials it can access and how any findings are handled. A required check should have a demonstrated benefit and a clear response process.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. I write most of our JavaScript and have tried Lintwise on a side project, but that does not establish how useful or costly it would be in our monorepo. I support a non-blocking trial with criteria agreed in advance. Alongside CI time and queue impact, we should assess whether its JavaScript findings are actionable and how much work they take to resolve. We should decide whether to require it only after reviewing those results.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise mandatory now. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. We have not established whether its checks cover those languages usefully in our monorepo. I support a non-blocking trial with evaluation criteria agreed beforehand. Alongside added CI time and queue impact, we should assess actionable Python and SQL findings, false positives, and the effort needed to resolve findings. We should review those results before deciding whether it should block merges.

**#7 Lars** _(round 1)_ [against]
I oppose making Lintwise a required merge check now. As QA lead, I want evidence that its findings provide useful signal without excessive noise. I have read its documentation, but that does not establish its accuracy or value on our monorepo. I support a non-blocking trial with evaluation criteria agreed beforehand: actionable findings, false positives, triage and remediation effort, added CI time, and queue impact. We should also distinguish static-analysis findings from test results rather than treat the checker as a substitute for tests. Before enforcement, we should agree who reviews findings and how incorrect or disputed findings are handled.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. A required merge check can improve consistency, but we have not established Lintwise’s value or cost on our monorepo. As owner of the merge policy, I support a non-blocking trial with evaluation criteria agreed beforehand: actionable findings across our languages, false positives, remediation effort, added CI time, and queue impact. Before any enforcement, we should review access permissions and define who triages findings, which findings block merges, and how disputed findings or checker failures are handled. We should revisit mandatory adoption after reviewing the trial results, rather than commit every merge to an unvalidated gate.

**#9 Olga** _(round 1)_ [against]
I oppose making Lintwise mandatory before we evaluate it. As a newer developer, I would welcome clear, consistent code-style guidance, but I have not used Lintwise and do not know whether its recommendations match our conventions. I support a non-blocking trial with criteria agreed beforehand. Alongside CI impact and actionable findings, we should assess whether its messages explain what to change and why. Before enforcement, we should document the rules we adopt and identify whom to ask when a finding is unclear or conflicts with existing code.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings (What kinds of real bugs did Lintwise catch on your previous team, and what false positives did you encounter?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. I do not have specific false-positive examples in my notes, so I cannot characterize those reliably. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. Those results support a trial, not immediate mandatory adoption on our monorepo.

**#12 Chair** _(fact-finding question)_
To Lars: Documented language coverage and access requirements (What did the documentation you read establish about Python and SQL coverage and required source-code or credential access?)

**#13 Lars** _(answer to chair)_ [against]
My notes do not establish Python or SQL coverage or required source-code or credential access. We need to verify those before a trial. They establish a baseline mode that reports only new findings. A trial I read about reported about 8 percent false positives with tuned rules; that does not establish noise levels here.

**#14 Priya** _(round 2)_ [against]
I remain against immediate mandatory adoption. My previous team’s three null-handling bugs caught in the first month show potential value, not proven value for this monorepo. Caching reduced our added CI time from about four minutes to about one minute, so the trial should measure cached performance rather than assume the default overhead is unavoidable. Lars’s baseline-mode finding could help limit initial noise, but we still need to verify language coverage and access requirements before a trial. I support a non-blocking trial with agreed criteria for actionable findings, false positives, remediation effort, CI time, and queue impact, followed by a separate decision on enforcement.

**#15 Marcus** _(round 2)_ [against]
I remain against immediate mandatory adoption. Our CI builds average 11 minutes, and my notes show queue waits already reach 6 minutes at peak. I have not measured Lintwise myself. Priya’s report that caching reduced overhead to about one minute is encouraging, but we should not assume that result transfers to our monorepo. After verifying language coverage and access requirements, I support a non-blocking trial with evaluation criteria agreed beforehand. For CI, we should measure both cached and uncached runtime and peak queue impact. Baseline mode may limit findings, but we should measure its performance rather than assume it reduces runtime. We should review those results alongside finding quality and remediation effort before a separate enforcement decision.

**#16 Elena** _(round 2)_ [against]
I remain against immediate mandatory adoption, but I can clarify my earlier uncertainty about secrets coverage. My notes establish that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and required rotation. That is a concrete reason to evaluate it; it does not establish dependency-risk coverage or its overall effectiveness here. I agree with Marcus that we should verify access requirements and language coverage before a non-blocking trial, then measure cached and uncached CI impact alongside finding quality. For security findings, we should also define who receives reports and handles remediation without unnecessarily exposing detected secrets. Mandatory enforcement should remain a separate decision after reviewing the results.

**#17 Tom** _(round 2)_ [against]
I remain against immediate mandatory adoption. My side-project notes show that Lintwise’s default rules produced about 30 percent noise in JavaScript files. I did not try tuning the rules, so that does not establish its noise level with tuned rules or on our monorepo. Lars’s reported trial and my experience are not directly comparable. Elena’s secret-detection example strengthens the case for evaluation, but not for making every finding a merge blocker. After verifying access requirements and language coverage, I support a non-blocking trial that evaluates JavaScript findings against our conventions, measures noise before and after tuning, and records triage and remediation effort alongside CI and queue impact. Enforcement should require a separate decision.

**#18 Sana** _(round 2)_ [against]
I remain against immediate mandatory adoption. My notes show that our pipelines have no static checks today and that two outages last year came from typos in config keys. That gives us a concrete failure mode to evaluate, but I do not know whether Lintwise can detect it. Elena’s secrets example strengthens the case for a trial without establishing coverage for our pipeline needs. Before a non-blocking trial, we should verify Python and SQL coverage and access requirements. During it, we should test whether Lintwise catches representative config-key errors, assess actionable findings and false positives, and record remediation effort alongside cached and uncached CI time and queue impact. I support a separate enforcement decision after reviewing those results.

**#19 Lars** _(round 2)_ [against]
I remain against immediate mandatory adoption. Tom’s side-project noise rate and the roughly 8 percent false-positive rate in the tuned trial I read about are not directly comparable; neither establishes our expected signal quality. Baseline mode reports only new findings, which could keep the trial focused, but it does not prove accuracy or lower runtime. After verifying language coverage and access requirements, I support a non-blocking trial with criteria agreed beforehand. We should assess actionable findings, false positives, missed representative defects, and triage effort alongside CI and queue impact. Sana’s config-key errors are useful evaluation cases, not established Lintwise capabilities. We should retain tests, assign finding reviewers, and define dispute handling before a separate enforcement decision.

**#20 Jin** _(round 2)_ [against]
I remain against immediate mandatory adoption. Priya’s caching experience and Elena’s secrets example justify evaluation, while Tom’s noise report and Sana’s coverage questions caution against a blanket gate. Our merge-policy changes require a trial and rollback path; we have reversed two past changes after rolling them out repo-wide at once. After verifying access requirements and language coverage, I support non-blocking warnings with agreed evaluation criteria. The write-ups I reviewed recommend publishing false-positive rates and promoting rules to blocking one at a time. We should measure finding quality, remediation effort, cached and uncached runtime, and queue impact, then make a separate enforcement decision. Before any blocking rollout, we should assign reviewers, define dispute and checker-failure handling, document rollback, and explicitly ask the team about workflow impact.

**#21 Olga** _(round 2)_ [against]
I remain against immediate mandatory adoption. Style questions take the most time in my reviews, so consistent guidance could help me, but I have not used Lintwise. Tom’s noise report makes it especially important to check whether findings match our conventions rather than assume every recommendation is useful. I support a non-blocking trial after language coverage and access requirements are verified. Alongside finding quality and CI impact, we should assess whether messages explain what to change and why, and whether they help resolve style questions. I agree with Jin that we should explicitly ask about workflow impact. Before any rule becomes blocking, we should document it, identify someone to answer questions, and define how conflicting or unclear findings are handled. Enforcement should remain a separate decision.

## Ballots (revealed together at the close)
- Priya: **no** — My previous team saw real bugs caught, but we need a non-blocking trial to establish Lintwise’s value and CI impact on our monorepo before requiring it.
- Marcus: **no** — We have not measured Lintwise’s impact on our 11-minute builds or peak queue waits, so I support a non-blocking trial before mandatory enforcement.
- Elena: **no** — Secret detection warrants evaluation, but mandatory adoption should await a non-blocking trial, verified access requirements, and a clear process for handling security findings.
- Tom: **no** — My side-project experience showed substantial JavaScript noise, so I support a non-blocking trial before requiring Lintwise on every merge.
- Sana: **no** — We have not verified useful Python and SQL coverage or measured CI impact on our monorepo, so I support a non-blocking trial before mandatory enforcement.
- Lars: **no** — We have not established Lintwise’s signal quality or CI impact on our monorepo; a non-blocking trial should precede mandatory enforcement.
- Jin: **no** — Mandatory adoption should follow a non-blocking trial demonstrating useful findings and acceptable workflow impact, with clear handling and rollback procedures.
- Olga: **no** — I support a non-blocking trial to assess whether Lintwise provides clear guidance consistent with our conventions before making it mandatory.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}