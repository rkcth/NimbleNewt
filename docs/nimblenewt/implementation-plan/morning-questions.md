# Questions for the owner (collected overnight, 2026-10-22)

Written by the implementing AI session while the owner slept. Nothing below blocked the work; each has a default that was used.

1. ~~**Provisional defaults.**~~ Reviewed with the owner and decided on 2026-10-22 ([provisional-defaults.md](provisional-defaults.md)).
2. ~~**Sign-offs.**~~ G01 and G02 signed off by the owner on 2026-10-22 (G02's real-hardware QA stays under D04).
3. ~~**Paperclip import.**~~ The owner has another Claude instance update the Paperclip board periodically (stated 2026-10-22), so this session does not verify it and needs no access. Status in [paperclip-sync-status.md](paperclip-sync-status.md).
4. **N00 gate**: left closed by the owner on 2026-10-22 (the owner may have the implementing session build the whole plan directly instead of dispatching from the board). **Token rotation**: kept as is for now by the owner on 2026-10-22; revisit if the token is ever exposed (the GitHub token used for CI checks is long-lived).
5. ~~**Windows hardware** for A03b (Windows Sandbox launcher) and G05 (isolation proof per OS).~~ The owner's Windows and Mac machines are reachable through self-hosted GitHub runners (labels `nimblenewt-windows`, `nimblenewt-mac`); the own-hardware probe passed on both on 2026-10-21 (run 39650140016). The sandbox checks of A03b and G05 will be added as jobs in `.github/workflows/own-hardware.yml` (it has only the probe job today); the workflow is started by hand from `main`, and the runners are on for now (owner decision 2026-10-22; see [own-hardware-runners.md](../own-hardware-runners.md)).
6. ~~**Plan changes to confirm:**~~ The owner confirmed the splits of A03b, A07c, A08b and C07b on 2026-10-22.
7. ~~**CI time.**~~ Kept as is by the owner on 2026-10-22: the full suite stays and the job limit stays at 50 minutes.
8. ~~**Resource limits.**~~ Accepted for the first release by the owner on 2026-10-22: no per-agent limit on macOS and Windows (every launch records it); card A08c closes the gap after the first release.
9. ~~**Abandoned watchers.**~~ Decided by the owner on 2026-10-22: idle expiry is added (new card H06b, since H06 is implemented), with a default timeout and a recorded drop.
