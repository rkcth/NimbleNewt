# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"rich-personas","firstRound":"open","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"richPersonas":true,"deskFromStart":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [undecided]
I checked my notes from six months using Lintwise on my previous team. It caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. That makes me optimistic, but I have no measurements for our monorepo. With CI already averaging 11 minutes, I would first run a non-blocking trial with caching enabled and measure added time and useful findings before making it a required pre-merge check.

**#3 Marcus** _(round 1)_ [against]
I oppose making Lintwise mandatory now. Our CI builds average 11 minutes, and peak queue wait is already 6 minutes. I have not measured Lintwise myself; Priya’s four-minute default-run figure is not a measurement for our monorepo. I support her proposed non-blocking trial with caching enabled, provided we measure added build time, peak queue wait, compute cost, and useful findings. We should review those results before deciding whether to require it.

**#4 Elena** _(round 1)_ [against]
I oppose the motion as written, but see a concrete security reason to evaluate Lintwise. My incident notes show that last quarter a hard-coded test key reached main and had to be rotated. Lintwise’s secret-detection rules would have flagged that commit. That supports testing those rules, not requiring every code-quality check immediately. I support a non-blocking trial with caching enabled, measuring the costs Marcus identified and reviewing useful findings. We should verify detection of the documented incident and assess false positives before deciding whether secret detection should become a blocking check. I have no evidence here about its dependency-risk coverage.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. On my side project, its default rules produced about 30 percent noise in JavaScript files. I did not try tuning the rules, so I cannot say whether that noise would persist after configuration or apply to our monorepo. I support a non-blocking trial with caching enabled. Alongside CI time, queue wait, compute cost, and useful findings, we should measure JavaScript false positives and test whether rule tuning reduces them. We should review those results before deciding which checks, if any, should block merges.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise mandatory before we test it. I have not used it. My pipeline notes show that we have no static checks today and that two outages last year came from typos in config keys. Those are concrete cases to investigate, but I do not know whether Lintwise can detect them. I support a non-blocking trial with caching enabled, covering our Python and SQL pipelines. Alongside the proposed CI, queue, cost, and false-positive measurements, we should test whether it flags those documented config mistakes. Then we can decide which checks, if any, merit blocking merges.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise before we have evidence from our monorepo. Its documentation describes a baseline mode that ignores existing findings and reports only new ones; I suggest using that in the proposed non-blocking, cached trial. A trial report I read found about an 8 percent false-positive rate with tuned rules. That is not a prediction for our code, nor directly comparable to Tom’s default-rule experience. What false-positive rate do we observe after tuning, and which rules produce useful findings? Alongside the proposed performance and cost measurements, we should review findings by rule and test the documented incident cases. We should agree on acceptable signal and noise before making any checks blocking.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. We have reversed two policy changes after rolling them out repo-wide at once. The write-ups I reviewed recommend starting with non-blocking warnings, publishing the false-positive rate, and promoting rules to blocking one at a time. I support the cached, baseline-mode trial proposed here, with the performance, cost, and incident tests already identified. Before changing merge policy, we should agree on acceptance criteria and a rollback path. I also want to ask everyone: how would this affect your workload and confidence in merging? We should assess time spent reviewing and tuning findings alongside the technical results. Consistency matters, but requiring every check before we understand its value and burden risks another reversal.

**#9 Olga** _(round 1)_ [against]
I oppose making Lintwise required now, but support the proposed non-blocking trial. I have not used it, so I do not know whether its findings would help me. My notes show that style questions take the most time in my reviews. Clear, agreed guidance could help my workload and confidence in merging, but I would want each finding to explain the issue and the expected change. During the trial, can we check whether the messages are understandable and whether the style rules match our team’s expectations? I would also like clear guidance on which warnings to fix and whom to ask when a finding is unclear. We should assess review and tuning time before making any rules blocking.

**#10 Chair** _(fact-finding question)_
To Priya: Cache operation and maintenance (In your previous team's use, what work was needed to enable and maintain caching, and did you observe cache-related missed findings?)

**#11 Priya** _(answer to chair)_ [against]
I checked my notes. They record that enabling the result cache reduced added CI time from about four minutes to about one minute. They do not record the setup steps, maintenance effort, or whether caching caused missed findings. I cannot reliably answer those parts from my experience. I support measuring cache operation and checking for missed findings during the non-blocking trial before requiring Lintwise.

**#12 Chair** _(fact-finding question)_
To Lars: Baseline-mode behavior (Does the documentation explain how to test historical incident examples when baseline mode ignores existing findings?)

**#13 Lars** _(answer to chair)_ [against]
My notes confirm that baseline mode ignores existing findings and reports only new ones. They do not explain how to test historical incident examples in that mode, so I cannot confirm whether the documentation provides a procedure. We should verify that before relying on baseline-mode results to assess detection of those incidents.

**#14 Priya** _(round 2)_ [against]
I remain against requiring Lintwise now, but optimistic about a non-blocking trial. My notes show three null-handling bugs caught and about one minute added to CI with caching on my previous team—not measurements for our monorepo. Lars’s answer leaves historical-incident testing unresolved; we should verify how to test those cases without baseline mode hiding them. We should also compare cached and uncached findings rather than assume caching preserves detection. I support measuring CI time, queue wait, compute cost, false positives by rule, and review and tuning effort. To Jin’s workload question: I have no numbers for our team. Clear messages and guidance, as Olga requested, should be part of the evaluation. We should agree on acceptance criteria and a rollback path before promoting individual rules to blocking.

**#15 Marcus** _(round 2)_ [against]
I remain against the motion as written. My pipeline notes show builds averaging 11 minutes and peak queue waits of 6 minutes. I have not measured Lintwise; neither of Priya’s timing figures establishes its impact here. I support the non-blocking trial, but cached-versus-uncached comparisons and incident tests also consume CI resources. We should include those runs when measuring added build time, peak queue wait, and compute cost. Priya’s suggestion to compare findings is important because cache correctness remains unverified. To Jin’s workload question: I cannot quantify maintenance effort yet; the trial should record cache setup, troubleshooting, and rule-tuning time. Before making individual rules blocking, we should agree on acceptable performance, cost, and finding quality, with a rollback path.

**#16 Elena** _(round 2)_ [against]
I remain against requiring Lintwise now. My notes document a hard-coded test key reaching main last quarter and requiring rotation; its secret-detection rules would have flagged that commit. That is a concrete reason to evaluate secret detection, not evidence for requiring every rule. I support the non-blocking trial, including Priya’s cached-versus-uncached comparison and Marcus’s accounting for the resources those tests consume. We must verify how to test the documented commit without baseline mode hiding its finding. We should assess secret-rule false positives, message clarity, and review effort before deciding whether those rules should block merges, with agreed acceptance criteria and a rollback path. I have no evidence about Lintwise’s dependency-risk coverage or our likely maintenance workload.

**#17 Tom** _(round 2)_ [against]
I remain against requiring Lintwise now. My side-project notes show about 30 percent noise from default rules in JavaScript files. I did not tune them, so that does not establish what tuned rules would do here. Lars’s report is not directly comparable. I support the non-blocking, cached trial and comparing cached with uncached findings. For JavaScript, we should record false positives by rule before and after tuning, plus time spent reviewing findings and maintaining configuration. To Jin’s question, I cannot quantify the workload yet; noisy warnings could add review work rather than reduce it. Olga’s request for clear messages and guidance matters: developers need to understand which warnings warrant changes. We should agree on acceptance criteria and a rollback path before promoting individual rules to blocking.

**#18 Sana** _(round 2)_ [against]
I remain against requiring Lintwise now, but support a small non-blocking trial covering our Python and SQL pipelines. My notes show no static checks today and two outages last year caused by config-key typos. I have not used Lintwise and do not know whether it can detect those mistakes. Following Lars’s clarification, we should establish how to test those examples without baseline mode hiding findings. I also support comparing cached and uncached results and counting the resources those tests consume. To Jin’s workload question, I cannot quantify the impact yet; we should record time spent investigating warnings, tuning rules, and maintaining the cache. Clear messages and guidance would matter for pipeline findings too. Before making individual rules blocking, we should agree on acceptance criteria and a rollback path.

**#19 Lars** _(round 2)_ [against]
I remain against requiring Lintwise now. The trial report I read found about an 8 percent false-positive rate with tuned rules; that is neither a forecast for our monorepo nor directly comparable to Tom’s default-rule results. What false-positive rate do we observe here, by rule, before and after tuning? Baseline mode reports only new findings, so we must establish a procedure for testing historical incidents rather than assume they remain visible. I support comparing cached and uncached findings and including those tests in resource accounting. To Jin’s workload question, I have no measurements; we should record investigation and tuning time, including whether messages make findings understandable. Agree on signal, noise, performance, and workload criteria before promoting individual rules to blocking, with a rollback path.

**#20 Jin** _(round 2)_ [against]
I remain against requiring Lintwise now. We reversed two policy changes after repo-wide rollouts; the write-ups I reviewed recommend non-blocking warnings, published false-positive rates, and promoting rules individually. I support the proposed trial, with cached-versus-uncached comparisons and a verified procedure for historical-incident tests. Count the resources and maintenance work those tests require. I heard concerns about noisy warnings, unclear messages, and investigation time; we do not yet have workload measurements. Alongside technical results, we should ask whether developers feel more confident merging and whether warnings help or interrupt their work. Those responses should inform, not replace, the evidence. Before changing merge policy, we should agree on acceptance criteria, clear warning-handling guidance, and a rollback path. Consistency is valuable, but it should come from rules demonstrated to help this team.

**#21 Olga** _(round 2)_ [against]
I remain against requiring Lintwise now and support a non-blocking trial. I have not used it. My notes show that style questions take the most time in my reviews, so I want to learn whether its messages clarify our expectations rather than add more questions. To Jin’s workload question, I cannot quantify the impact yet. We should record time spent understanding findings and asking for help, alongside investigation and tuning time. Could the trial guidance explain which warnings to fix, which are optional, and whom to ask when a message is unclear? I support checking message clarity and agreement with our style expectations before promoting individual rules to blocking. The cached-versus-uncached comparisons and historical-incident tests also need clear procedures, as others have noted.

**#22 Olga** _(objection)_
Please clarify whether we are voting on mandatory checks as written or the non-blocking trial discussed.

**#23 Chair** _(ruling)_
Amended. New wording: The team conducts a non-blocking Lintwise trial in our monorepo, evaluating detection, false positives, message clarity, CI performance, compute cost, and maintenance and review effort; required checks will need a separate decision with agreed acceptance criteria and a rollback path.

## Ballots (revealed together at the close)
- Priya: **yes** — My previous team saw useful bug detection, but we need this non-blocking trial to measure benefits, costs, and effort in our monorepo before separately deciding on required checks.
- Marcus: **yes** — The non-blocking trial will measure CI time, queue impact, compute cost, and maintenance effort before any separate decision on required checks.
- Elena: **yes** — The non-blocking trial can test detection of our documented hard-coded test key incident and assess false positives and effort without requiring checks before a separate decision.
- Tom: **yes** — The non-blocking trial will test whether the JavaScript noise I observed on my side project persists here and measure review effort before any separate decision on required checks.
- Sana: **yes** — A non-blocking trial lets us test whether Lintwise detects our documented config-key mistakes and measure its costs and workload before separately deciding on required checks.
- Lars: **yes** — The non-blocking trial will measure detection and false positives in our monorepo while reserving required checks for a separate decision with agreed acceptance criteria and a rollback path.
- Jin: **yes** — The non-blocking trial will assess benefits and developer workload without changing merge policy, while reserving required checks for a separate decision with acceptance criteria and a rollback path.
- Olga: **yes** — The non-blocking trial will assess whether messages clarify our style expectations and help reviews, while leaving required checks to a separate decision.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}