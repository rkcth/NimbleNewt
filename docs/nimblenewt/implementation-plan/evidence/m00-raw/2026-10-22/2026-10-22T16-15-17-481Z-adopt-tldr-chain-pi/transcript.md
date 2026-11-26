# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-chain","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose making Lintwise mandatory immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we don’t yet know its impact on this monorepo. I’d support a non-blocking trial to measure useful findings and added CI time before requiring it for merges.

**#3 Marcus** _(round 1)_ [against]
I oppose the motion as written. Our CI builds already average 11 minutes, and we have no measurements of Lintwise’s runtime or effect on queue length in our monorepo. Priya’s experience is useful, but it does not establish what our pipeline would see. I support a non-blocking trial, tracking added CI time, queue delays, and useful findings. Before making it mandatory, we should review those results and agree on acceptable overhead and how to handle checker failures.

**#4 Elena** _(round 1)_ [against]
I oppose making Lintwise mandatory now. We know it is a static code-quality checker; we do not know whether it detects exposed secrets or risky dependencies. We should not treat it as covering those risks without evidence. I support a non-blocking trial that measures useful findings and CI overhead, with explicit checks of any claimed security coverage. Before requiring it, we should agree on which findings block merges and how failures or exceptions are handled.

**#5 Tom** _(round 1)_ [against]
I oppose requiring Lintwise now. I write most of our JavaScript and have tried Lintwise on a side project, but that alone does not establish its value for our monorepo. I support a non-blocking trial to assess useful JavaScript findings, noisy warnings, and added time against our current 11-minute average CI build. Before making it mandatory, we should agree on blocking rules and an exception process. The motion should also reflect that we currently maintain one monorepo, rather than impose a blanket requirement on every repository.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise mandatory now. I maintain our data pipelines, mostly in Python and SQL, and have not used Lintwise. We should first run a non-blocking trial in our monorepo to establish whether it supports our pipeline code and produces actionable findings. Track noisy warnings and added CI time against our current 11-minute average. Before adopting a merge gate, agree on which findings block merges and how exceptions are handled. Any revised motion should apply to our current monorepo, not every repository.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise now. As QA lead, I want evidence that its findings provide useful signal without excessive noise. I have read its documentation, but that does not establish how well it will work on our code. Run a non-blocking trial in our monorepo. Review findings for actionability, track noisy or duplicate warnings, and measure added CI time against our current 11-minute average. Before making it a merge gate, agree on blocking rules, ownership of findings, and an exception process. Revise the motion to cover our current monorepo rather than every repository.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. A required merge check creates a consistent standard, but we have not established Lintwise’s value or cost on our monorepo. I support a non-blocking trial that measures actionable findings, noisy warnings, added CI time against our current 11-minute average, and merge delays. As merge-policy owner, I would require agreed blocking rules, responsibility for resolving findings, and an exception process before enabling enforcement. Revise the scope to our current monorepo and bring the trial results back for a decision rather than committing every repository now.

**#9 Olga** _(round 1)_ [against]
I oppose making Lintwise mandatory before we have tried it on our monorepo. I have not used it, so I cannot judge its usefulness yet. As someone newer to the team, I would welcome consistent code-style guidance, but I need to understand which findings require changes and how to fix them. I support a non-blocking trial with documented rules, examples of acceptable fixes, and someone to ask when a warning is unclear. We should review its findings and added CI time before deciding whether it should block merges.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings (Priya, what kinds of real bugs did Lintwise catch on your previous team, and what do you know about its false positives or added CI time?)

**#11 Priya** _(answer to chair)_ [undecided]
I used Lintwise for six months on my previous team. It caught three null-handling bugs in the first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. I don’t have false-positive data in my notes.

**#12 Priya** _(round 2)_ [against]
I agree with the calls for a non-blocking trial rather than adopting the motion as written. My previous team’s results show potential value: three null-handling bugs caught in the first month. But the default run added about four minutes to CI; caching reduced that to about one minute. Those results don’t establish the impact on our monorepo, where builds already average 11 minutes. We should measure useful findings, false positives, cached CI overhead, and queue impact here, then agree on blocking rules and exceptions before making Lintwise mandatory.

**#13 Marcus** _(round 2)_ [against]
I remain against the motion as written and support a non-blocking trial on our monorepo. Priya’s caching results are encouraging, but they do not establish our CI cost. Builds already average 11 minutes, and peak queue wait is six minutes. I have not measured Lintwise myself. During the trial, we should measure added build time with and without caching, peak queue impact, useful findings, and false positives. Before requiring it, we should agree on acceptable CI overhead, blocking rules, and exceptions.

**#14 Elena** _(round 2)_ [against]
I still oppose the motion as written and support a non-blocking trial. My notes provide one concrete security benefit: last quarter, a hard-coded test key reached main and had to be rotated; Lintwise’s secret-detection rules would have flagged that commit. That supports testing its secret detection, not requiring every finding to block merges. I agree with Marcus that we need local measurements of CI overhead and false positives. We should also verify dependency-risk coverage rather than assume it exists, and define which security findings warrant blocking and how exceptions work before adopting a mandatory gate.

**#15 Tom** _(round 2)_ [against]
I still oppose the motion as written and support a non-blocking trial on our monorepo. Elena’s security example supports testing specific rules, not making every finding a merge blocker. On my side project, Lintwise’s default rules produced about 30 percent noise in JavaScript files. I did not try tuning them, so that does not establish the noise level we would see here. Since I write most of our JavaScript, I want the trial to assess tuned rules on our code, alongside CI overhead against our current 11-minute average. Before requiring it, we should agree on blocking findings and exceptions.

**#16 Sana** _(round 2)_ [against]
I still oppose making Lintwise mandatory now. Tom’s JavaScript experience reinforces the need to test rules on our own code; it does not tell us how useful Lintwise would be for Python and SQL. I have not used it. Our pipelines have no static checks today, and two outages last year came from typos in config keys. During a non-blocking monorepo trial, I want us to test whether Lintwise can detect those mistakes rather than assume it can. We should assess useful findings, noise, and CI overhead against our current 11-minute average, then agree on blocking rules and exceptions before requiring it.

**#17 Lars** _(round 2)_ [against]
I agree with Sana: we should test the mistakes we care about, not assume Lintwise detects them. Its documentation describes a baseline mode that ignores existing findings and reports only new ones; that could keep a trial focused without making us clear historical findings first. A trial I read about reported roughly 8 percent false positives with a tuned rule set, but that is not evidence of our likely noise level. I support a non-blocking monorepo trial measuring useful findings, false positives, and CI overhead against our 11-minute average. Before requiring any checks, we should agree on which findings block merges and how developers handle exceptions.

**#18 Jin** _(round 2)_ [against]
I remain against version 1’s immediate mandatory gate. Lars’s baseline suggestion is worth testing, but it does not replace local evidence or a rollback path. We have reversed two policy changes after rolling them out repo-wide at once. As merge-policy owner, I propose a non-blocking trial in our monorepo, measuring useful findings, false positives, and CI impact against our current 11-minute average. My notes recommend publishing the false-positive rate and promoting rules to blocking one at a time. Before any promotion, we should agree on exceptions and rollback conditions, and ask developers how the trial affects their workflow.

**#19 Olga** _(round 2)_ [against]
I support Jin’s non-blocking trial rather than version 1’s immediate requirement. I have not used Lintwise, so I cannot judge its accuracy. Style questions take the most time in my reviews; I would like the trial to test whether findings give clear explanations and actionable guidance, not just flag violations. Developer feedback should include whether newer team members understand what to change and why. Before any rule blocks merges, we should publish that guidance alongside the exceptions and rollback conditions others proposed.

## Ballots (revealed together at the close)
- Priya: **no** — Lintwise caught real bugs on my previous team but added about four minutes to CI, so I favor a non-blocking trial before requiring it here.
- Marcus: **no** — I support a non-blocking trial to measure build-time and queue impact before making Lintwise a required pre-merge check.
- Elena: **no** — We should verify secrets and dependency coverage and measure CI impact in a non-blocking trial before requiring Lintwise.
- Tom: **no** — I support a non-blocking trial on our monorepo to measure JavaScript noise and CI overhead before making Lintwise mandatory.
- Sana: **no** — I have not used Lintwise and want a non-blocking trial to verify its value for our Python and SQL pipelines before making it mandatory.
- Lars: **no** — We should validate Lintwise’s signal, false-positive noise, and CI impact in a non-blocking monorepo trial before requiring it for merges.
- Jin: **no** — I support a non-blocking trial before requiring merge checks, with local evidence, clear rule-specific enforcement, exceptions, and a rollback path.
- Olga: **no** — I support a non-blocking trial with clear developer guidance before making Lintwise a required merge check.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}