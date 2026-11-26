# Chair's private notes (rolling)

Priya: Supports non-blocking trial. Prior team found three null-handling bugs in month one; caching reduced overhead from about four minutes to one. Local comparability and longer-term detection unknown. Follow-up: What cache requirements and false-positive data are documented?

Marcus: CI owner; opposes immediate mandate. Reports peak queue waits of six minutes; builds average 11 minutes. No local Lintwise measurements. Wants runtime, queue impact, useful findings, impact limits, and disable procedure. Follow-up: What measurement period supports queue figures? What limits are proposed?

Elena: Opposes immediate mandate; supports trial and validated blockers. Notes identify a secret-detection rule set that would have flagged last quarter’s hard-coded test key, which reached main and required rotation. Broader coverage unproven. Follow-up: What documentation or tests establish detection and limitations?

Tom: Opposes immediate mandate. Side-project default JavaScript findings were about 30% noise; rules untuned. Monorepo comparability unclear. Supports default/tuned comparison, overlap and CI measurements, validated blockers, ownership, and rollback. Follow-up: How was noise classified, across how many findings? How comparable was the setup?

Sana: Opposes immediate mandate; supports non-blocking trial. Pipeline code lacks static checks; two outages last year involved config-key typos. No Lintwise experience; detection and Python/SQL support unknown. Follow-up: What failure records and coverage documentation exist? Can known failures be detected?

Lars: Opposes immediate mandate; supports trial measuring quality, overlap, and CI impact. Documentation describes new-findings-only baseline mode. Read of tuned-rule trial with about 8% false positives; local relevance unproven. Follow-up: What methods and sample size underpin 8%? What overlap, baseline limitations, and governance are documented?

Jin: Tech lead and merge-policy owner; opposes immediate gate. Policy requires trial and rollback; two repo-wide changes were reversed. Write-ups recommend warnings, rule-by-rule promotion, and published false-positive rates. Supports language-specific tests, default/tuned and cached/uncached comparisons, blocking criteria, ownership, disputes, CI limits, and rollback. Other policy provisions unverified. Follow-up: What do policy and write-ups establish?

Olga: Opposes mandate now; no Lintwise experience. Reports style questions consume most review time. Supports non-blocking trial assessing message clarity and convention alignment; fewer findings need not mean better guidance. Supports individual validated rules, ownership, disputes, CI limits, rollback, and guidance/contact before blocking. Follow-up: Which conventions are documented? Do sample messages explain what to change and why? Who handles confusing findings?
