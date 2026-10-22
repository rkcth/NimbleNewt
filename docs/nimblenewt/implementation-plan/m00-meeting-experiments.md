# Meeting prototype experiments (card M00)

Written 2026-10-22. **Interim record**, not the full M00 evidence: the spend budget, owner-interrupt and absent-member meetings, the checkpoint question and a per-rule worked/change/drop verdict are still to do. Throwaway prototype in `prototypes/meeting/` (not shipped). One speaker holds the baton, every turn is a separate tool-less model call, ballots are individual and revealed together. 34 real-model runs were started (33 completed: 16 with eight members on one model, 2 with twenty, 15 mixed; one aborted) on two routes: ChatGPT subscription login (`gpt-6.1-sol`, `gpt-6-astra`) and OpenRouter (`z-ai/glm-5.3-prime`, `qwen/qwen3.8-max-prime`). Fictional scenarios, eight members except where stated. The numbers are small samples: they show where the rules bend, not statistics.

Nothing here changes the plan by itself. Owner decisions are marked; the rest are proposals for the owner to accept or reject.

## What the runs showed

| Question | Result |
|---|---|
| Does an open first round herd? | Yes. Every speaker took the same stance as the one before in all 3 runs (agreement 1.00); a blind first round gave 0.29 to 0.57. Proposal: blind first round by default. |
| Does a richer personality help? | A little (agreement 0.86 against 1.00), but the rich-personality variants also gave members their desk notes from round 1, so this cannot be credited to temperament alone. |
| Does the outcome depend on the objection check? | Yes, with eight members on one model. In every run the group reached the same view: accept a non-blocking trial and reject requiring the tool on every repository. If at least one member objected at the objection check the chair amended the motion to that view and it passed 8-0; if nobody objected (7 runs) they all voted no on the original text, 0-8. So the outcome depended on whether the objection check led the chair to amend the motion. Proposal: let members propose amendments during discussion, and have the chair check before ballots whether the motion matches where the discussion landed. |
| One-line summaries | Cut tokens by 40 to 50 percent but kept 0 of 19 numbers in the one run scored. |
| Facts-style summaries ("summarize into one brief paragraph, include important points", none if brief) | Cost 59 to 63K tokens for eight members against 28 to 40K for one-line. Most statements were short enough to pass through verbatim, so few were summarized; in those, 5 of 24 numbers were kept across 7 runs (one had nothing to score; two had twenty members) (about 21 percent, against 0 of 19 for one-line). That is a tiny sample and not clearly better on numbers; the chair's reminders and round-1 summary exist to catch what summaries drop. |
| Rolling chair notes | Cost more (85K tokens for eight members, 306K for twenty against 239K without) and did not change outcomes. |
| 20 members | Both runs finished and passed 20-0; cost 239K to 306K tokens. |
| Tabling (research requests) | Not used in the one completed real-model run with tabling enabled (a second run aborted); members' notes already held the evidence. Needs a scenario where research matters. |
| Prefix cache | Cached input divided by input: 14.4 percent over the 18 completed single-model subscription runs (6 of them 18 to 35 percent each); in the mixed runs Sol 2.6 percent, Astra 0.0, GLM 30.9 (6 to 56 per run) and Qwen 14.5 (0 to 26). The `agent-first-order` variant that M00 calls for was not run, so the shared-first against agent-first comparison is still open. Real cache tests belong on the local engines (G10). |

## Does the vote add anything? (mixed-model rosters)

Four seats: a chair and three members from different models (Sol chair; Astra, GLM, Qwen members), three fictional scenarios, 3 runs each (9 meetings), then 6 runs with GLM as chair and Sol as a member on two of the scenarios (15 meetings). The chair gave a private decision and a predicted tally before the ballots, after the whole discussion, so it is not a no-meeting baseline.

| Scenario | Chair | Chair's solo call matched the result | Ballots |
|---|---|---|---|
| Ship a payments API with a known bug | Sol | 3 of 3 | 3-0, 3-0, 0-3 |
| Agents start work on NimbleNewt itself | Sol | 3 of 3 | 3-0, 0-3, 0-3 |
| Chair reads an absent member's desk | Sol | 3 of 3 | 0-3, 1-2, 1-1-1 (one abstention) |
| Chair reads an absent member's desk | GLM | 3 of 3 | 2-1, 2-1, 1-2 |
| Agents start work on NimbleNewt itself | GLM | 3 of 3 | 0-3 three times |

The chair's predicted tally was exact in 13 of 15 meetings and one vote off in two (both with Sol as chair: the payments scenario, run 2, and the desk-read scenario, run 3). Ten of the 15 meetings were unanimous, where matching the chair's call is easy. Astra always sat in seat a1 with the same persona in the Sol-chair runs, so model and persona cannot be separated. The 1-1-1 desk-read run was a tie that failed under the old rule; the chair's "no" means the new casting vote would give the same result. Dissent came from the models in particular seats (Astra's seat voted no on desk reads in every run; Qwen and the others varied), not from who chaired.

**Reading, with the owner's decision:** with these samples the chair's own call would have given the same result as the vote. The owner decided on 2026-10-22 that **voting stays**: it costs almost nothing, and the ballots and dissent are valuable information to the human. The owner also found the discussion itself valuable (in the desk-read meetings it led to the shared working-notes idea); this rests on that one case. The chair breaks a tie without a double vote (M06).

## Reasoning recorded in the desk-read meetings

The "no" votes on the chair reading an absent member's desk (an owner-decided design, option B, tested here only as a stress test) gave four reasons: private scratch is not settled thinking and may be misread; being left out of a meeting should not by itself authorize a read; a log shows what was read but not what was left out, and enforcement of read-only and per-file logging could not be verified; and the concrete need was thin when pressed. The owner took two of the ideas into the plan on 2026-10-22: shared working notes as a second desk tier (C01b) and tests that the read cannot write and logs every file (M05b). The idea of the chair citing which notes informed its decision was not taken.

## Proposed changes still awaiting the owner

1. Blind first round by default (M05).
2. Members may propose amendments during discussion, and the chair checks the motion against the discussion before ballots open (M05, M06).
3. Facts-style summaries with verbatim pass-through of short statements (M05).
4. A further experiment where research matters (tabling) and one on local engines for cache behaviour (G10).

## Caveats

- Fictional scenarios; models answer with the notes they are given, so some reasoning reflects what the scenario author seeded.
- Small samples (three runs per cell); the outcome flipped with whether the objection check led to an amendment, so single runs can mislead.
- Eight-member runs used one model; the mixed runs had four seats (a chair and three voting members).
- Cost and timing are not comparable across routes (subscription against paid OpenRouter).
