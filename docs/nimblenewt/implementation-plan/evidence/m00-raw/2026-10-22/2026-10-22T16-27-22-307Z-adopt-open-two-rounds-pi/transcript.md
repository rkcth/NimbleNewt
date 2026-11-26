# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"open-two-rounds","firstRound":"open","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose the motion as written, not Lintwise itself. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we should measure its impact here before making it a required gate. I suggest a non-blocking trial in our monorepo, then reviewing the bugs caught and added CI time before deciding whether to require it.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then decide based on bugs caught and CI impact.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise before we measure its effect on our pipeline. Our CI already averages 11 minutes. Priya’s experience is useful, but it does not establish the added runtime or queue impact in our monorepo. I support a non-blocking trial, tracking total CI duration, queue wait, and actionable findings. We should agree on acceptable overhead before reviewing the results and deciding whether to make it a merge gate.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure runtime, queue impact, and useful findings before requiring it.

**#4 Elena** _(round 1)_ [against]
I oppose the motion as written. We know Lintwise checks code quality, but we have no evidence here that it detects exposed secrets or dependency risks. We should not treat it as covering those security needs. I support a non-blocking trial in our monorepo, measuring actionable findings and CI overhead before requiring it. The review should also establish what security checks, if any, Lintwise provides and what remains outside its scope.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise before mandating it, and verify its security coverage rather than assuming it addresses secrets or dependency risks.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. I write most of our JavaScript and have tried Lintwise on a side project, but that does not establish how useful its findings would be in our monorepo. I support a non-blocking trial that measures actionable JavaScript findings, added CI time, and the effort needed to address findings. With CI already averaging 11 minutes, we should agree on acceptable overhead and review the results before making it a merge gate.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then decide based on useful findings, CI overhead, and remediation effort.

**#6 Sana** _(round 1)_ [against]
I oppose the motion as written. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. We do not yet know whether its findings would be useful for that code. I support a non-blocking trial in our monorepo that includes Python and SQL, measures actionable findings, added CI time, and remediation effort, and establishes any coverage gaps. With CI already averaging 11 minutes, we should agree on acceptable overhead before reviewing the results and deciding whether to require it.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise on Python and SQL before requiring it, measuring useful findings, coverage gaps, CI overhead, and remediation effort.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise before we establish the quality of its signal in our monorepo. As QA lead, I want findings that justify interrupting a merge, not noise that encourages people to ignore checks. I have read its documentation, but that does not establish how actionable its findings will be here. I support a non-blocking trial tracking actionable findings, false positives, remediation effort, and CI overhead. Before the trial, we should agree on criteria for making any checks blocking and how disputed findings or exceptions will be handled. Then we can decide whether a required gate is justified.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then require only checks whose signal and operational cost justify a gate.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. As tech lead and merge-policy owner, I want consistent checks, but requiring Lintwise now would set a blocking policy before we know its value or cost in our monorepo. I support a non-blocking trial covering our JavaScript, Python, and SQL. Before starting, we should agree on acceptable CI overhead, what makes a finding actionable, and criteria for promoting checks to blocking. Track CI duration, queue wait, false positives, and remediation effort, and document coverage gaps. Any later merge requirement should specify which findings block, who handles disputed findings, and how exceptions work. We can then adopt a consistent policy based on evidence rather than require every finding to interrupt development.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges, then require only checks whose value and overhead justify a consistent merge policy.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise now. As a newer developer, I want clear code-style guidance, but I have not used Lintwise and do not know whether its rules match our team’s expectations. I support a non-blocking trial in our monorepo. Alongside measuring useful findings and CI overhead, we should check whether its messages explain what to change and why. Before any rules become blocking, we should document the agreed conventions and how to ask about unclear or disputed findings. That would help me learn our standards without treating every automated suggestion as team policy.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first, and provide clear, agreed guidance before making its findings block merges.

**#10 Chair** _(fact-finding question)_
To Priya: Findings and CI overhead in prior use (During your six months using Lintwise, what kinds of real bugs did it catch, and how was the roughly four-minute CI increase measured?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. My notes record about four minutes of added CI time with the default run, dropping to about one minute with its result cache enabled. I do not have the measurement method recorded, so I cannot explain how those timings were established or predict our monorepo’s overhead.
> tl;dr (what later speakers saw in summary mode): Prior use caught null-handling bugs; caching reduced recorded overhead, but the measurement method is not in my notes.

**#12 Chair** _(fact-finding question)_
To Tom: JavaScript findings in side-project use (What specific useful or incorrect JavaScript findings did you encounter, and what effort did they take to resolve?)

**#13 Tom** _(answer to chair)_ [against]
On my side project, about 30 percent of Lintwise’s default-rule findings in JavaScript files were noise. My notes do not record specific useful or incorrect findings or the effort needed to resolve them, so I cannot supply those details. I did not try tuning the rules. I still oppose requiring it before a non-blocking trial here.
> tl;dr (what later speakers saw in summary mode): My side-project notes show about 30 percent noise with default rules, but no specific examples or remediation effort.

**#14 Priya** _(round 2)_ [against]
I still oppose the motion as written and support a non-blocking trial. Marcus is right that my previous team’s timings do not establish overhead here. My notes show about four added minutes with the default run and about one with caching, but do not record the measurement method. We should test caching rather than assume either figure applies to our monorepo. Lars’s concern about noise and Tom’s experience also reinforce the need to evaluate findings before making them blocking. Lintwise caught three null-handling bugs in my previous team’s first month, so I see potential value. Before the trial, we should agree on acceptable overhead and blocking criteria, then measure actionable findings, false positives, and remediation effort across our languages.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure its value and overhead here before adopting a required gate.

**#15 Marcus** _(round 2)_ [against]
I still oppose requiring Lintwise now. My notes show peak CI queue waits already reach six minutes, alongside our 11-minute average builds. I have not measured Lintwise myself. Priya’s clarification makes caching worth testing, but neither prior timing predicts our pipeline’s overhead. I support a non-blocking monorepo trial that tracks queue wait and total CI duration, not just the checker’s runtime. We should compare cached and uncached runs and agree on acceptable overhead before starting. Tom’s reported noise and Lars’s concerns also support measuring actionable findings, false positives, and remediation effort before deciding which checks, if any, should block merges.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise without blocking merges; measure queue impact, CI overhead, and finding quality before making it mandatory.

**#16 Elena** _(round 2)_ [against]
I still oppose the motion as written, but I can correct my earlier uncertainty about secret detection. My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and required rotation. That gives us a concrete security case to evaluate, not evidence that it covers dependency risk. I support the non-blocking trial others proposed, including testing that rule set against the known commit. Priya’s caching results and Tom’s reported noise reinforce the need to measure overhead and false positives here. We should evaluate secret-detection rules separately when deciding which checks merit blocking, rather than require all findings to block merges.
> tl;dr (what later speakers saw in summary mode): Lintwise could have caught our leaked test key, but we should validate security rules and overhead before requiring a merge gate.

**#17 Tom** _(round 2)_ [against]
I still oppose the motion as written. Elena’s secret-detection example supports evaluating that rule set separately, not making every finding blocking. On my side project, about 30 percent of default-rule findings in JavaScript files were noise, but I did not try tuning the rules. That does not establish the noise level we would see here or after tuning. I support a non-blocking monorepo trial that compares default and tuned JavaScript rules, tracks actionable findings and remediation effort, and measures total CI duration and queue wait. Priya’s experience makes caching worth testing too. Before starting, we should agree on acceptable overhead and criteria for promoting individual rules to blocking.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first; measure tuned rules, caching, and pipeline impact before deciding which checks should block merges.

**#18 Sana** _(round 2)_ [against]
I still oppose the motion as written and support a non-blocking trial. My notes show our data pipelines have no static checks today, and two outages last year came from typos in config keys. I have not used Lintwise, so I cannot say it would catch those errors. We should test it against those known cases and assess its Python and SQL coverage. Elena’s example supports evaluating specific rules separately rather than making all findings blocking. Tom’s reported noise also reinforces measuring actionable findings and remediation effort here. Alongside cached and uncached CI duration and queue wait, the trial should document which pipeline risks Lintwise does not cover. Agree on acceptable overhead and rule-level blocking criteria before starting.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise against known pipeline failures and measure coverage, noise, and CI impact before requiring specific rules.

**#19 Lars** _(round 2)_ [against]
I still oppose the motion as written. Elena’s and Sana’s known cases give us concrete tests, but we should evaluate each rule’s signal before making it blocking. My documentation notes show Lintwise has a baseline mode that ignores existing findings and reports only new ones. We should test that mode while assessing existing findings separately. In a trial I read about, a tuned rule set had about an 8 percent false-positive rate; that does not predict our results or establish an acceptable threshold. Tom’s experience reinforces comparing default and tuned rules here. I support a non-blocking trial measuring actionable findings, false positives, remediation effort, and CI overhead, including caching. Before starting, agree on rule-level blocking criteria and a clear process for disputed findings and exceptions.
> tl;dr (what later speakers saw in summary mode): Trial baseline mode and tuned rules; require only checks whose local signal and overhead justify blocking merges.

**#20 Jin** _(round 2)_ [against]
I still oppose the motion as written. Elena’s and Sana’s known cases give us useful tests; Lars’s baseline mode could help separate new findings from existing debt. Neither justifies a blanket gate. My notes say merge-policy changes need a trial and rollback path; we have reversed two changes after rolling them out repo-wide at once. I support a non-blocking monorepo trial, with acceptable CI overhead and rule-level promotion criteria agreed beforehand. Measure total CI duration, queue wait, actionable findings, false positives, and remediation effort; test caching, tuning, and baseline mode. The rollout guidance I reviewed recommends publishing false-positive rates and promoting rules individually. Any later blocking policy should name the rules, define disputes and exceptions, and specify rollback triggers and ownership.
> tl;dr (what later speakers saw in summary mode): Trial non-blocking checks first; promote individual rules only with measured evidence, clear exceptions, and a rollback path.

**#21 Olga** _(round 2)_ [against]
I still oppose the motion as written and support a non-blocking trial. My notes say style questions take the most time in my reviews, so I want to test whether Lintwise makes our conventions clearer, not just whether it produces findings. I have not used it. Tom’s reported noise and Lars’s baseline proposal reinforce checking whether messages explain what to change and why, and distinguish agreed conventions from optional suggestions. Jin’s proposal to promote rules individually makes sense to me. Before any style rule blocks merges, we should document the convention, provide clear guidance, and identify whom to ask about disputed findings. The trial should assess message clarity alongside actionable findings, remediation effort, and CI overhead.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise first; require clear explanations and agreed conventions before making individual style rules blocking.

**#22 Lars** _(objection)_
The motion still mandates checks everywhere, while the discussion favors a non-blocking trial before deciding which rules should block merges.

**#23 Jin** _(objection)_
The motion still mandates a blanket merge gate; it should first be amended to a non-blocking trial with evidence-based promotion of individual rules, clear exceptions, and a rollback path.

**#24 Chair** _(ruling)_
Amended. New wording: The team adopts a non-blocking Lintwise trial in its monorepo, agreeing beforehand on acceptable CI overhead and rule-level promotion criteria. The trial will assess actionable findings, false positives, remediation effort, message clarity, and coverage gaps; measure CI duration and queue wait; and test caching, tuning, baseline mode, and known bug cases. Any later required checks must be approved individually, with documented dispute and exception processes, ownership, and rollback triggers.

## Ballots (revealed together at the close)
- Priya: **yes** — The amended motion tests Lintwise’s value and CI overhead here without blocking merges, while requiring evidence and individual approval before any rule becomes mandatory.
- Marcus: **yes** — The amended motion requires a non-blocking trial with agreed CI overhead limits and measurements of build duration and queue wait before any individual check becomes required.
- Elena: **yes** — The non-blocking trial lets us test secret detection against our known case, document dependency-risk coverage gaps, and require evidence before approving individual blocking checks.
- Tom: **yes** — The non-blocking trial will test JavaScript rule tuning and measure noise, remediation effort, and CI overhead before any individual checks become required.
- Sana: **yes** — The non-blocking trial will assess Python and SQL coverage and our known config-key bug cases without assuming Lintwise catches them, while requiring evidence before individual checks become blocking.
- Lars: **yes** — The amended motion measures signal and noise in a non-blocking trial and requires individual rule approval with dispute, exception, and rollback safeguards before checks become mandatory.
- Jin: **yes** — The amended motion protects developer speed with a non-blocking trial and requires evidence, individual rule approval, clear ownership, and rollback safeguards before changing merge policy.
- Olga: **yes** — The non-blocking trial assesses message clarity and requires individual approval and documented dispute processes before any rules become required checks.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}