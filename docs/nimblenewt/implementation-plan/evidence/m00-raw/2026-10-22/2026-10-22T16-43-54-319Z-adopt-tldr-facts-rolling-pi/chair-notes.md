# Chair's private notes (rolling)

Priya: Supports non-blocking trial and separate enforcement review. Prior team caught three null-handling bugs in month one; caching reduced added CI time from about four minutes to one. Local performance unknown. Follow-up: What trial duration and finding-classification criteria are proposed?

Marcus: CI owner; opposes immediate mandate. Reports 11-minute average builds and six-minute peak queue wait; measurement methods unclear. Local overhead unmeasured. Follow-up: How were baselines measured, and how would comparable runtime, queue, usefulness, noise, and overlap data be collected?

Elena: Opposes immediate enforcement; supports trial. Says secret-detection rules would have flagged last quarter’s hard-coded test key, which reached main and required rotation. Broader coverage unknown. Follow-up: How was detectability established, and what tests would assess broader coverage?

Tom: Opposes immediate mandate; supports trial and separate enforcement decision. Side-project default JavaScript rules produced about 30 percent noise; local quality unknown. Proposes default/tuned and cached/uncached comparisons. Follow-up: How was noise calculated? How would findings and tuning changes be classified?

Sana: Opposes immediate mandate; supports trial. Reports no pipeline static checks and two outages last year from config-key typos. Has not used Lintwise; detection capability unknown. Follow-up: Which past errors can be tested? How would config, Python, and SQL findings be classified?

Lars: Supports non-blocking monorepo trial and separate enforcement decision. Documentation describes new-findings-only baseline mode; reviewed tuned-trial report cites about 8 percent false positives. Local applicability unknown. Follow-up: How was that rate calculated? Which checks overlap, and what classification and exception procedures exist?

Jin: Opposes motion; supports non-blocking trial measuring tuning, baseline mode, caching, findings, false positives, runtime, and queues. Says merge policy requires trial and rollback; two past repo-wide policy changes were reversed. Reviewed write-ups recommend publishing false-positive rates and promoting rules individually. Follow-up: What are policy requirements and write-ups’ classification methods?

Olga: Opposes immediate mandate; supports non-blocking monorepo trial and separate blocking-rule review. Has not used Lintwise. Says style questions consume most review time; wants convention fit and message clarity assessed. Requests published adopted rules and documented challenge, exception, and rollback procedures before enforcement. Local fit unknown. Follow-up: What conventions are documented, and how would alignment and explanation clarity be assessed?
