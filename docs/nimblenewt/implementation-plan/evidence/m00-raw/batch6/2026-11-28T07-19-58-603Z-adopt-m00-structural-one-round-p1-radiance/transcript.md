# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"m00-structural-one-round-p1","firstRound":"blind","rounds":1,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"chairQuestionCheck":"structural","deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":1,"allowTabling":true,"directQuestions":true,"deskRead":true}
Model: qwen3.8-flash-next-iq4r

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1 (blind))_ [for]
I used Lintwise for six months on my previous team. It caught real bugs—null dereferences, race conditions—that would have shipped. That's the kind of thing I want checked before merge. My concern is CI time. We're already at 11 minutes; Lintwise added roughly 4 minutes on my old team, pushing us to 15. With eight engineers on one monorepo, that's a noticeable drag on iteration speed. I'd support making it required, but I'd push us to scope it: run it only on changed files or the affected package, not the whole monorepo, so we keep the bug-catching value without paying the full time cost every build.
> tl;dr (what later speakers saw in summary mode): I'm for it—real bug-catching value—but we must scope it to changed files to avoid bloating our 11-minute CI.

**#3 Marcus** _(round 1 (blind))_ [for]
I support this, with a condition. A static checker is cheap compared to our 11-minute builds. If Lintwise catches a lint failure in, say, 30 seconds, we save a full 11-minute CI slot that would have been wasted on code that should never have merged. That directly shortens queue length for everyone. My concern is the "required" framing: if Lintwise itself becomes flaky or slow, it blocks merges and inflates queue time for no reason. I want a hard timeout—say 90 seconds—and a rule that a Lintwise infrastructure failure does not block a merge, only a genuine lint violation does. I'll instrument the pipeline to report Lintwise's added wall-clock time per run so we can confirm the net queue benefit within two sprints.
> tl;dr (what later speakers saw in summary mode): Fast static checks save full CI slots; support adoption if we add a timeout and avoid blocking on tool failures.

**#4 Elena** _(round 1 (blind))_ [undecided]
I lean toward supporting a required pre-merge gate, but I need to know whether Lintwise actually inspects for hardcoded secrets—API keys, tokens, connection strings—or whether it's purely a style and complexity linter. If it's the latter, I'm not convinced it moves the needle on the risks I own. Dependency scanning is a separate concern; a code-quality checker won't flag a vulnerable transitive package unless it integrates a lockfile audit. My practical worry: if Lintwise produces noisy findings unrelated to security, developers will start rubber-stamping the check, and the gate becomes theatre. I'd support adoption *if* we configure it to fail the build on any detected secret pattern and integrate it alongside a dependency audit step. Otherwise I'd rather keep secrets-detection as its own dedicated, non-bypassable check. I need the team to clarify scope before I commit.
> tl;dr (what later speakers saw in summary mode): Support only if Lintwise catches secrets and runs alongside dependency scanning; otherwise it's style policing, not security.

**#5 Tom** _(round 1 (blind))_ [for]
I tried Lintwise on a small side project last quarter. It caught a handful of unused variables and inconsistent error-handling patterns that ESLint missed, and the autofix suggestions were genuinely useful for my JS/TS files. That said, my side project was one app with three contributors. Our monorepo has eight people and far more edge cases—generated code, vendored libraries, build artifacts. My concrete worry is false-positive noise on non-JS directories blocking merges for people who aren't frontend. I'd vote yes, but only if we scope Lintwise to our source directories and give everyone a one-week grace period where warnings don't block. Otherwise we'll spend the first two sprints fighting the tool instead of shipping.
> tl;dr (what later speakers saw in summary mode): Tried it on a side project, liked the JS checks; adopt it but scope it and add a grace period.

**#6 Sana** _(round 1 (blind))_ [undecided]
I'm not opposed in principle, but I can't endorse this yet. I've never run Lintwise, so I don't know how it handles SQL files—my pipelines are a mix of Python and raw SQL, and static checkers often produce noisy false positives on query syntax. More importantly, "required pre-merge check" means a false positive blocks my deploy. Our CI already averages eleven minutes; I need to know how many seconds Lintwise adds before I commit to it gating every merge. I'd support a trial period on a non-blocking advisory run first, so I can see whether it actually catches real issues in my pipeline code or just floods me with style warnings I'll learn to ignore. Give me a week of data and I'll revisit.
> tl;dr (what later speakers saw in summary mode): I need a non-blocking trial run before I accept Lintwise as a hard merge gate, especially for SQL.

**#7 Lars** _(round 1 (blind))_ [for]
I'm for this, with one condition. As QA lead, my biggest headache is sifting through CI logs to separate real test failures from noise. A static pre-merge check that catches style violations, dead code, and obvious bugs before they hit the test suite means fewer "red" builds that are actually just lint failures masquerading as test problems. That's better signal.

However, I've read Lintwise's docs, and it ships with roughly 200 rules enabled by default. If we turn all of them on, every PR gets flagged with cosmetic nits, and developers start ignoring the check entirely. That's noise, and it defeats the purpose.

My condition: we start with a curated subset—error-level rules only—then expand gradually based on actual violation data over two sprints. I also want the check to run in parallel with the build, not sequentially, so we don't push past that 11-minute ceiling.
> tl;dr (what later speakers saw in summary mode): Adopt Lintwise for cleaner test signal, but gate it to error-level rules first and run it in parallel to protect CI time.

**#8 Jin** _(round 1 (blind))_ [for]
I'm in favor, with one condition. As the person who owns our merge policy, I've watched style drift accumulate in the monorepo for two quarters. A required pre-merge check gives us a single enforcement point instead of relying on reviewer memory. That said, our CI already averages eleven minutes. If Lintwise adds more than roughly ninety seconds to the pipeline, I want it running in parallel with existing checks, not appended serially. I also want a two-week grace period where violations produce warnings, not hard blocks, so developers can adapt without feeling the gate slams shut overnight. Consistency matters, but not if it costs us meaningful velocity. Make it parallel, make it gradual, and I'll sign off on the policy change today.
> tl;dr (what later speakers saw in summary mode): Support the gate if it runs in parallel and has a two-week warning-only ramp.

**#9 Olga** _(round 1 (blind))_ [for]
As someone newer to the team, I genuinely want automated style guidance. Right now I often guess whether a naming convention or formatting choice matches what the rest of the team expects, and I rely on a senior dev catching it in review. A required pre-merge check means I get feedback before I even open a PR, which saves everyone time. I haven't used Lintwise yet, so I'd appreciate a short onboarding doc or a one-time walkthrough of its rule set—especially how to read and fix its messages—so I don't spend my first weeks fighting opaque errors. I'm also mildly worried about the CI time growing beyond the current 11-minute average if the check is slow, but I trust the team to benchmark it before we flip it to required. Overall, clearer guardrails help me contribute confidently sooner.
> tl;dr (what later speakers saw in summary mode): Automated style checks give me the clear, upfront guidance I need as a newer dev; I just want a quick onboarding on Lintwise's rules.

**#10 Chair** _(fact-finding question)_
To Priya: Lintwise false-positive rate and incremental (changed-files-only) execution (During your six months using Lintwise, what was the approximate false-positive rate you observed on real PRs, and did the tool support running only on changed files or the affected package? If so, what wall-clock time did that incremental mode add versus a full-repo scan?)

**#11 Priya** _(answer to chair)_ [for]
I didn't formally track a false-positive rate, but over six months I recall very few—perhaps one or two style nits—against three confirmed null-handling bugs caught in month one. On incremental execution: I don't recall a true changed-files-only mode. What worked was Lintwise's result cache, which cut wall-clock from roughly 4 minutes to about 1 minute by skipping unchanged files. That cache gave us most of the speed benefit without a separate incremental flag.
> tl;dr (what later speakers saw in summary mode): Low false-positive rate; no dedicated changed-files mode, but the result cache cut CI time from 4 minutes to roughly 1 minute.

**#12 Chair** _(fact-finding question)_
To Lars: Lintwise parallel-execution support and error-level rule subset size (From the documentation you read, does Lintwise support running as a parallel CI job alongside the build, or does it require sequential execution? Also, roughly how many of the ~200 default rules are classified as error-level versus warning/cosmetic?)

**#13 Lars** _(answer to chair)_ [for]
From the docs, Lintwise runs as a standalone CLI, so it can be a parallel CI job—no sequential dependency. On the rule split: I recall ~200 defaults but did not note a precise error-vs-warning count. My notes confirm a tuned rule set yielded roughly 8 percent false positives in a trial, supporting an error-level-only start. I'd like someone to pull the exact count before we finalize.
> tl;dr (what later speakers saw in summary mode): Lintwise supports parallel CI execution; I lack the exact error-rule count but endorse starting with a curated subset.

**#14 Elena** _(needs time to research)_
I would verify whether Lintwise ships secret-detection rules and can be configured to run in the same CI stage as our existing dependency scanner, because without confirmed secret-capture coverage the gate is style policing and I cannot endorse it as a hard merge blocker.

**#15 Chair** _(tabled)_
Motion tabled to the next meeting. Research: Elena: Confirm whether Lintwise ships secret-detection rules (API keys, tokens, connection strings) and whether it can run in the same CI stage as our existing dependency scanner. Report findings to the team before the next meeting. | Sana: Run Lintwise in advisory (non-blocking) mode on a representative sample of your Python/SQL pipeline files for one week. Report false-positive count and wall-clock time added per run. | Lars: Pull the exact count of error-level vs. warning/cosmetic rules from Lintwise's default rule set so we can finalize the curated subset size.

## Ballots (revealed together at the close)

Result: {"outcome":"tabled","research":["Elena: Confirm whether Lintwise ships secret-detection rules (API keys, tokens, connection strings) and whether it can run in the same CI stage as our existing dependency scanner. Report findings to the team before the next meeting.","Sana: Run Lintwise in advisory (non-blocking) mode on a representative sample of your Python/SQL pipeline files for one week. Report false-positive count and wall-clock time added per run.","Lars: Pull the exact count of error-level vs. warning/cosmetic rules from Lintwise's default rule set so we can finalize the curated subset size."]}