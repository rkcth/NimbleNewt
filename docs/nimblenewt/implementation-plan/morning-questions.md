# Questions for the owner (collected overnight, 2026-10-22)

Written by the implementing AI session while the owner slept. Nothing below blocked the work; each has a default that was used.

1. ~~**Provisional defaults.**~~ Reviewed with the owner and decided on 2026-10-22 ([provisional-defaults.md](provisional-defaults.md)).
2. ~~**Sign-offs.**~~ G01 and G02 signed off by the owner on 2026-10-22 (G02's real-hardware QA stays under D04).
3. **Paperclip import.** Verification needs access (the company ID or a configured profile). Status in [paperclip-sync-status.md](paperclip-sync-status.md).
4. **N00 gate** (the implementation gate parent issue) and **token rotation** (the GitHub token used for CI checks and pushes is long-lived).
5. **Windows hardware** for A03b (Windows Sandbox launcher) and G05 (isolation proof per OS); neither can be finished without a real machine.
6. **Plan changes to confirm:** A03b, A07c and A08b were split out of A03, A07 and A08; C07b was split out of C07 tonight (the Pi-side and dispatch wiring of context budgets) and H12 now depends on it.
7. **CI time.** The Windows Node 24 cell now takes close to 25 minutes, so the job limit was raised from 30 to 50 minutes. Say if you would rather shorten the suite (for example fewer PostgreSQL repetitions of the transport tests, which take 10 to 20 seconds each on Windows).
8. **Resource limits.** On macOS and Windows no per-agent limit is enforced yet (every launch records that); on Linux the CPU, memory and process limits need a user systemd session, and disk is only a per-file cap. Is that acceptable for the first release, or should a Windows Job Object and a macOS equivalent be a card of their own?
9. **Abandoned watchers.** A host that crashes while subscribed to an event stream holds producers back until the owner cancels its subscription (no idle expiry yet). Should idle expiry be added to H06 or to the dispatcher cards?
