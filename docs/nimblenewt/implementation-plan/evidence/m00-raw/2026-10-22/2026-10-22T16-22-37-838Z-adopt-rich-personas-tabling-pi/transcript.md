# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"rich-personas-tabling","firstRound":"open","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"richPersonas":true,"deskFromStart":true,"allowTabling":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [undecided]
I checked my notes from six months using Lintwise on my previous team. It caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. That makes me optimistic, but I have no measurements for our monorepo. With CI already averaging 11 minutes, I would prefer a trial with caching enabled before making it a required pre-merge check. We should measure bugs caught and added CI time, then decide whether to require it.

**#3 Marcus** _(round 1)_ [against]
I oppose making Lintwise required now. Our CI builds already average 11 minutes, with a 6-minute queue wait at peak. I have not measured Lintwise myself; the four-minute overhead Priya quoted is not a measurement for our monorepo. I support a non-blocking trial with caching enabled. Before requiring it, we should measure added build time, peak queue wait, compute cost, and useful findings, then agree on acceptable limits.

**#4 Elena** _(round 1)_ [against]
I oppose the blanket requirement as written, but I see a concrete case for secret detection. Last quarter, a hard-coded test key reached main and had to be rotated. My notes confirm that Lintwise’s secret-detection rules would have flagged that commit. That supports evaluating those rules specifically; it does not establish the value of requiring the entire checker. I support a non-blocking trial with caching enabled, measuring CI overhead and useful findings, including secret-detection results. We should then consider a narrower required check backed by that evidence. I have no evidence here that Lintwise addresses dependency risk.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise required as written. On my side project, about 30 percent of its default-rule findings in JavaScript files were noise. I did not try tuning the rules, so that does not establish how useful a tuned setup would be in our monorepo. Since I write most of our JavaScript, I want to check that before making findings block merges. I support a non-blocking trial with caching enabled. Alongside CI overhead and useful findings, we should measure JavaScript noise and try rule tuning. Then we can decide which rules, if any, justify a required check.

**#6 Sana** _(round 1)_ [against]
I oppose requiring Lintwise as written, but support a small, non-blocking trial with caching enabled. I maintain our Python and SQL pipelines and have not used Lintwise. My notes show no static checks for our pipelines today, and two outages last year came from typos in config keys. Those incidents give us concrete test cases, not evidence that Lintwise would catch them. During the trial, I would test whether it flags those mistakes and measure useful Python and SQL findings, false positives, and added CI time. With builds already averaging 11 minutes, we should agree on acceptable overhead before making any rules mandatory.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise as written. Its documentation describes a baseline mode that ignores existing findings and reports only new ones; that could keep a trial focused, but does not establish finding quality. A trial report I read recorded about an 8 percent false-positive rate with a tuned rule set. That is not a measurement for our monorepo. I support a non-blocking trial with caching and baseline mode enabled. We should review findings, tune rules, and measure false positives alongside useful findings and CI overhead. What false-positive rate would we accept before findings block merges? We should agree on that threshold before deciding which rules, if any, become required.

**#8 Jin** _(round 1)_ [against]
I oppose the requirement as written. We have reversed two policy changes after rolling them out repo-wide at once. The write-ups I reviewed recommend starting with non-blocking warnings, publishing false-positive rates, and promoting rules to blocking one at a time. I support a trial in our monorepo with caching and baseline mode enabled, agreed limits for CI overhead and false positives, and a rollback path before any rule becomes mandatory. Alongside useful findings, queue impact, and compute cost, we should track review and tuning workload. Before setting merge policy, I also want to ask everyone: how would this affect your confidence, frustration, and daily work? Those answers should inform the decision alongside measurements, not replace them.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise as written, but support a non-blocking trial. I have not used it, so I do not know whether its findings would give me useful style guidance. My notes say style questions take the most time in my reviews. Clear messages explaining each finding could help me learn our conventions; unexplained blocking messages would leave me unsure how to proceed. During the trial, could we review whether messages explain the issue and how to fix it, and identify whom to ask when a finding is unclear? Alongside the proposed measurements, I would track whether it reduces style questions in reviews. I would want documented rules and clear guidance before any findings block merges.

**#10 Chair** _(fact-finding question)_
To Priya: Cached CI performance (In your previous team's six months using Lintwise, did the roughly one-minute cached overhead remain consistent, and what codebase did that measurement cover?)

**#11 Priya** _(answer to chair)_ [against]
I checked my notes: enabling the result cache reduced added CI time from about four minutes to about one minute. They do not establish whether that stayed consistent across the six months or identify the codebase covered. I cannot give a reliable answer on either point, and I would not treat that figure as a prediction for our monorepo.

**#12 Chair** _(fact-finding question)_
To Elena: Secret-detection evidence (What evidence in your notes confirms that Lintwise's secret-detection rules would have flagged the hard-coded test key?)

**#13 Elena** _(answer to chair)_ [against]
My notes state that Lintwise’s secret-detection rule set would have flagged that commit. They do not include a scan result, rule identifier, or reproduction, so I cannot substantiate that statement further. The incident and key rotation are documented in my notes; detection should be verified during a non-blocking trial before we require the check.

**#14 Priya** _(round 2)_ [against]
I remain against the blanket requirement and support a non-blocking trial in our monorepo with caching and baseline mode enabled. My notes record three null-handling bugs caught in the first month on my previous team, but they do not predict our results. As I clarified, the roughly one-minute cached overhead is not a demonstrated long-term figure. Marcus’s queue and cost concerns and Tom’s JavaScript noise concerns reinforce the need for local measurements. We should agree on acceptable overhead and false-positive limits before evaluating the trial, then promote only rules supported by useful findings and clear guidance. I also support testing Elena’s secret-detection example and Sana’s config mistakes rather than assuming Lintwise catches them.

**#15 Marcus** _(round 2)_ [against]
I remain against the blanket requirement. My notes show builds averaging 11 minutes and peak queue waits of 6 minutes; I have not measured Lintwise. Priya’s clarification reinforces that neither quoted overhead predicts our monorepo’s performance. I support a non-blocking trial with caching and baseline mode enabled. Before starting, we should agree on acceptable added build time, peak queue wait, compute cost, and false-positive limits. We should also track the review and tuning workload Jin raised. Useful findings alone would not justify a check that overloads shared CI. Any move to blocking should be rule by rule, backed by local measurements, clear guidance, and a rollback path.

**#16 Elena** _(round 2)_ [against]
I remain against the blanket requirement. Priya’s and Marcus’s calls for local measurements are important, and Tom’s noise concerns argue for evaluating individual rules rather than requiring the default checker. Our hard-coded test key incident gives us a concrete security test case, but my notes contain no scan result substantiating that Lintwise would catch it. During a non-blocking trial with caching and baseline mode enabled, we should explicitly test that past commit; baseline mode should not exclude the historical example from verification. If secret-detection rules demonstrate useful findings within agreed overhead and false-positive limits, I would support considering them separately for blocking, with clear remediation guidance and a rollback path. I have no evidence that Lintwise addresses dependency risk.

**#17 Tom** _(round 2)_ [against]
I remain against the blanket requirement. My side-project notes show about 30 percent noise from default rules in JavaScript files; I did not tune them, so that is not evidence against a tuned setup here. Lars’s tuned-rule report does not settle that question for our monorepo either. I support a non-blocking trial with caching and baseline mode enabled, measuring JavaScript findings before and after tuning. Marcus’s point about review workload matters: sorting out noisy findings takes time even when CI stays fast. Olga’s request for clear explanations also matters; a blocking finding should tell us what needs fixing. We should agree on overhead and false-positive limits before evaluating results, then consider individual rules with clear guidance and a rollback path. Useful, demonstrated checks could improve my confidence; unexplained blockers would add frustration.

**#18 Sana** _(round 2)_ [against]
I remain against the blanket requirement and support a small, non-blocking trial with caching and baseline mode enabled. I have not used Lintwise. My notes show no static checks for our pipelines today and two outages last year caused by config-key typos; neither establishes that Lintwise would catch them. Elena’s point about baseline mode applies here too: we should test those historical mistakes explicitly rather than let the baseline hide them. For Python and SQL, I would measure useful findings, false positives, added CI time, and review and tuning workload. Marcus’s shared-CI concerns and Olga’s request for clear remediation guidance belong in the acceptance criteria. Demonstrated detection would increase my confidence; unexplained blocking findings would disrupt pipeline work. Agree on limits first, then consider individual rules with a rollback path.

**#19 Lars** _(round 2)_ [against]
I remain against the blanket requirement. Tom is right that the roughly 8 percent false-positive rate in the tuned-rule trial I read does not establish performance in our monorepo. We need our own results, reported by rule and language, with a clear distinction between false positives and valid findings we consider low value. I support a non-blocking trial with caching and baseline mode enabled. As Elena and Sana noted, historical test cases must be checked explicitly because baseline mode ignores existing findings. Before evaluating results, what false-positive rate will we accept, and how will we classify disputed findings? Agree on those definitions and limits alongside CI overhead and review workload. Only demonstrated, low-noise rules with clear remediation guidance and a rollback path should be considered for blocking.

**#20 Jin** _(round 2)_ [against]
I remain against the blanket requirement. Our two reversed repo-wide policy changes support a staged approach; the write-ups I reviewed recommend non-blocking warnings, published false-positive rates, and promoting rules individually. I support a trial with caching and baseline mode enabled, explicitly testing the historical examples Elena and Sana raised. Lars’s distinction between false positives and valid but low-value findings should guide reporting. Before starting, we should agree on acceptance limits, review and tuning responsibilities, and a rollback path. Tom and Sana have described how useful checks could build confidence and unexplained blockers could disrupt work. I would like to hear from the others: what would increase your confidence, and what would add frustration or workload? Those responses should inform merge policy alongside local measurements, not substitute for them.

**#21 Olga** _(round 2)_ [against]
I remain against the blanket requirement and support a non-blocking trial with caching and baseline mode enabled. I have not used Lintwise, so I cannot judge its guidance yet. To answer Jin: clear explanations and documented rules would increase my confidence; unexplained blockers would add uncertainty and time spent asking for help. My notes say style questions take the most time in my reviews. During the trial, I want to check whether findings explain both the issue and how to fix it, and whether style questions actually decrease. Lars’s distinction also matters: a valid finding is not necessarily useful guidance. Could we identify whom to ask about unclear findings and how disputed ones will be resolved? Before any rule blocks merges, I want demonstrated value, clear remediation guidance, and a rollback path alongside the agreed performance and noise limits.

## Ballots (revealed together at the close)
- Priya: **no** — My previous team’s results justify a non-blocking trial, not a blanket requirement without measurements from our monorepo.
- Marcus: **no** — Requiring Lintwise now is premature without monorepo measurements of added build time, peak queue wait, and compute cost against agreed limits.
- Elena: **no** — My notes do not substantiate secret detection, so I support a non-blocking trial before requiring any rules.
- Tom: **no** — My side-project experience showed substantial noise from default JavaScript rules, and we need a non-blocking trial in our monorepo before requiring checks.
- Sana: **no** — I support a non-blocking trial to measure pipeline findings and CI overhead before requiring Lintwise.
- Lars: **no** — The blanket requirement lacks monorepo evidence of useful findings, acceptable false-positive rates, and CI overhead; I support a non-blocking trial first.
- Jin: **no** — I oppose the blanket requirement without a non-blocking trial establishing local value, acceptable CI impact, and manageable developer workload before promoting individual rules.
- Olga: **no** — I support a non-blocking trial, but want demonstrated value, documented rules, and clear remediation guidance before Lintwise becomes required.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}