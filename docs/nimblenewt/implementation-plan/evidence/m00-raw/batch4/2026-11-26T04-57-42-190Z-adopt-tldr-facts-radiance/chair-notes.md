# Chair's private notes after round 1

**PRIVATE NOTES — Chair**

| # | Speaker | Key claims / evidence | Gaps / unclear | Factual follow-ups |
|---|---------|----------------------|----------------|--------------------|
| 2 Priya | Ran Lintwise 6 mo prior team; caught null-derefs, dead code. +4 min CI. Supports with 2-wk trial. | Her team's monorepo size? Did they use parallel or serial? | What parallel config, if any, did her prior team use? |
| 3 Marcus | Owns pipeline. Queue contention at peak. Needs parallel-vs-serial answer. | Doesn't state whether he's ever seen Lintwise run parallel on *our* runner pool. | Has he tested or simulated a parallel lint job on our current runner image set? What container base does Lintwise need? |
| 4 Elena | Wants secret-scan + CVE/license gating. 3 near-misses this quarter. | No specific evidence that Lintwise *itself* covers secrets/CVEs vs. a separate scanner. | Does Lintwise ship native secret-detection and dependency-CVE rules, or must we bolt on additional rule-packs/plugins? Can Noah or Vera confirm from their prior installs? |
| 5 Tom | Side-project React tuning cost: 2 evenings. ~3.5 min serial. | Side project size vs. our monorepo file count unknown. | How many JS/TS files in his project vs. ours? How many rules did he disable vs. tune? |
| 6 Sana | Needs `.sql` first-class parsing, unparameterized-WHERE detection, noqa-style suppressions. Nightly ETL eats 8 of 11 min. | Hasn't actually run Lintwise on SQL. Docs claim unclear. | Does Lintwise parse `.sql` files natively, or only SQL-in-string patterns? Can Omar or Sana confirm from the vendor docs before week 1? |
| 7 Lars | Signal-erosion risk. Wants baseline + severity override + advisory-first. | No quantified "signal dilution" metric. | Has he logged how often PRs with >10 style findings also had ignored test failures? (triage-speed data) |
| 8 Jin | Merge-policy owner. Severity-tiered plan, exception ledger (3/dev/quarter). | Exception policy detail (who approves, audit trail). | What tooling hosts the exception ledger? Jira, GitHub, custom? |
| 9 Olga | New-dev clarity need. Wants 2-wk advisory, 1-page doc. | No technical gaps—policy/UX ask. | None beyond doc owner (Ben committed). |
| 10 Ravi | 6 mo backend daily use. +4 min. Caught race conditions, SQL-injection patterns. | Prior team runner config? | Did his team run serial or parallel? What language mix (Go, Python)? |
| 11 Mei | Pipeline owner. 11→15 = 36% queue increase. Peak queue 4-5 PRs. | Cold-start container pulls unaccounted in others' numbers. | What is the cold-pull cost for Lintwise's container on our ephemeral runners? Has she measured? |
| 12 Noah | Security-tier blocking. Wants seeded-secret canary test. Separate waiver path. | No evidence Lintwise secret rules exist out-of-box. | Does he know of a concrete Lintwise rule ID for "hardcoded secret"? Or is this an open question for trial week 1? |
| 13 Zoe | React side project false positives. Volunteering for JS/TS tuning. | Side-project scale vs. monorepo. | Same as Tom's file-count question. |
| 14 Omar | Hasn't touched Lintwise. Needs Airflow/dbt repo test. SQL injection detection unverified. | Zero first-hand experience. | None to Omar—direct question to Sana/Noah on SQL rule existence. |
| 15 Hana | Read docs; confirms severity tiers, baseline-ignore, parallel with container cache. | Hasn't run it. | Docs version? Does the parallel-job-with-own-pass/fail config require a specific CI framework feature (e.g., GitHub Actions `needs: []`)? |
| 16 Ben | Policy owner. Commits to 2-sprint advisory, doc by sprint 1, exception ledger. | None—owns deliverables. | Confirm: does he have capacity to write the doc *and* run baseline snapshots day 1 of trial? |
| 17 Ida | New intern perspective. Wants to be trial-reader test. | No technical gaps. | None. |
| 18 Kofi | Pipeline owner. p95 queue-depth under 20-PR burst is the gate. | Same runner-pool question as Mei/Marcus. | Has he or Mei previously load-tested 20 concurrent PRs with an added parallel job? What runner pool size? |
| 19 Lena | RN/JS tuning volunteer. Mobile builds already >12 min. | Mobile pipeline is separate from main CI? | Does the mobile build share the same runner pool and build cache as the monorepo CI? |
| 20 Theo | Release manager. Scope correction: monorepo, not "every repo." Approves post-trial. | None—owns policy doc + exception ledger. | Confirm: will the revised motion text circulate before next round? |
| 21 Vera | 6 mo prior team. 300 legacy findings without baseline → morale hit. Wants baseline pin day 1. Co-owns security rules. | Prior team size? | How many engineers, how many repos in her prior team? Was the +4 min serial or parallel there? |

---

**CHAIR — Round 2 prompt**

Thank you, everyone. The group has converged on a structure: severity-tiered blocking (null-derefs, leaked secrets, CVSS 7+ CVEs, unparameterized SQL), advisory for everything else, two-week advisory sprint on real PRs, baseline pinned day one, parallel execution with a sub-ninety-second cap, and a seeded-secret canary before enforcement. Ben and Theo are drafting the revised motion scoped to our single monorepo.

Before we move to a second round, I have a short list of **factual questions** that, if answered, close the remaining gaps. Please answer only what you know from your own experience or the Lintwise documentation you've read. No one needs to restate their vote.

1. **Secret & CVE coverage.** Elena, Noah—have either of you seen Lintwise ship a *named* rule for hardcoded-secret detection or dependency-CVE lookup, or do those require a plug-in/rule-pack we'd have to configure separately? Vera, on your prior team, was secret-scan part of the default ruleset or an add-on?

2. **SQL parsing.** Sana, Omar—does Lintwise's documentation (you've read it, Sana) describe `.sql` files as first-class parse targets with unparameterized-WHERE detection, or does it only catch SQL patterns embedded inside Python/JS strings? This is the single fact that determines whether Omar's ETL repos are testable in week one.

3. **Parallel execution on our runners.** Mei, Kofi, Marcus—do our current ephemeral runner images already include a container base compatible with Lintwise's runtime, or would we need a custom image? Have any of you previously simulated a 20-concurrent-PR burst with an added parallel job and measured p95 queue depth?

4. **Cold-start cost.** Mei mentioned cold-pull penalties unaccounted for. Has anyone measured the container-pull time for a lint-sized image on our current pool? What is the runner-pool size (number of concurrent slots)?

5. **Prior-team scale.** Priya, Ravi, Vera—how many engineers and how many repos on the teams where you saw the +4-minute figure, and was Lintwise serial or parallel there? This calibrates whether the 4-minute number transfers to our monorepo.

Please keep answers to two or three sentences. If you don't know the fact, say so and I'll assign it as a trial-week-one measurement task. After these answers we'll do a quick second round and, if the group is ready, move to a vote on the revised motion.
