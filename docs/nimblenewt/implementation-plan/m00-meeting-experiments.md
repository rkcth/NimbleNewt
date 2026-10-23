# Meeting prototype experiments (card M00)

Written 2026-10-22 (run directory names carry UTC stamps, so the later runs begin `2026-10-23T`). **Complete record** of the M00 experiments. Throwaway prototype in `prototypes/meeting/` (not shipped). One speaker holds the baton, every turn is a separate tool-less model call, ballots are individual and revealed together. Fictional scenarios. The numbers are small samples: they show where the rules bend, not statistics.

Nothing here changes the plan by itself. Owner decisions are marked; everything else is a proposal for the owner to accept or reject (sections "Proposed changes" and "Provisional defaults"). M05 and M06 are built after the owner has answered.

## What was run

Real-model runs came in two batches. All run directories are under `prototypes/meeting/runs/` (gitignored); times quoted below are the `HH-MM-SS` part of the directory name.

| Batch | Meetings | Route and models | Tokens |
|---|---|---|---|
| Earlier (2026-10-22, `T16-` to `T23-`) | 34 real-model runs were started, 33 completed (16 with eight members on one model, 2 with twenty, 15 mixed; one aborted) | ChatGPT subscription login (`gpt-6.1-sol`, `gpt-6-astra`) and OpenRouter (`z-ai/glm-5.3-prime`, `qwen/qwen3.8-max-prime`) | about 1.84 million, run before the budget was set, so not counted below |
| This completion (`2026-10-23T02-28` to `03-27`) | 49 meetings (37 on the subscription route, 12 on OpenRouter) and 3 checkpoint question sets (18 questions) | subscription: `gpt-6.1-sol` in every seat of 33 meetings, `gpt-6-astra` in seat a1 of 4 others; OpenRouter: 6 meetings entirely on `z-ai/glm-5.3-prime`, 6 entirely on `qwen/qwen3.8-max-prime` | see budget |

Spend budget, set before the runs and enforced by the runner (`--budget <file> --cap-tokens N`, `--cap-usd`, with running totals kept in a file; a run stops when the total would pass the cap):

| Route | Planned hard cap | Actual (this completion) | Share |
|---|---|---|---|
| ChatGPT subscription | 3,000,000 tokens | 798,142 tokens over 39 runner invocations (37 meetings and 2 checkpoint sets; no dollar price on this route) | 27 percent |
| OpenRouter | 2,500,000 tokens or about 8 US dollars | 899,869 tokens, estimated 2.88 US dollars (reported tokens times listed prices per million: GLM 2.80 in, 0.56 cached in, 8.80 out; Qwen 4.00, 0.50, 12.00; the account balance was not read, so this is an estimate, not the invoice) | 36 percent of the tokens and of the dollars |

No cap was hit. Token totals count input plus output tokens including cached input and hidden reasoning tokens; the first smoke meeting and one deliberate mutation run are inside them.

Prototype additions made for this completion (all in `prototypes/meeting/`): a scripted owner inquiry (`scenario.owner`), absent members with the chair desk read, per-file inspection records, redaction and a returning member's correction (`scenario.absent`, `variant.deskRead`), direct questions between members (`variant.directQuestions`, `scriptedAsks`), a chair casting vote on a tie (plus a drill, `tieProbe`, because real models never tied), `checkpoint.mjs` (question to a non-present subordinate), `analyze.mjs` (turn length, truncation, repetition, wall time), the running spend budget in `run.mjs`, and `lib/specs.mjs` (route specs moved out of `run.mjs`). New scenarios: `ship-owner`, `ship-owner-facts`, `adopt-owner`, `ship-absent`, `ship-tie`, `ship-asks`, `tabling-benchmark`, `checkpoint`. New variants: `m00-full`, `m00-asks`, `m00-tieprobe`. Every new path was smoke-tested on the fake provider first.

## Acceptance text, line by line

| Acceptance text | Result | Where |
|---|---|---|
| At least five meetings on different subjects (tool proposal to eight coders, policy motion, real disagreement, absent member, a meeting the owner interrupts) | Yes: tool adoption (8 and 20 members), ship with a known bug, agents building NimbleNewt itself, the desk-read policy motion, a scheduler switch with a pending measurement; the owner interrupted 9 meetings and an absent member's desk was read in 15 | tables below |
| Owner's model-spend budget set beforehand and the spend recorded | Yes | budget table above |
| Every transcript, ballot record and chair question kept | Yes: each run directory holds `transcript.md`, `ballots.json` (every original ballot and revision with its trigger), `calls.jsonl` (raw text kept from the later runs), `summary.json` (chair questions and refused ones, inspections, inquiry checks) and `chair-notes.md` where notes were kept | run directories |
| Chair notes once after round 1 against rolling notes, with a 20-participant meeting | Yes (earlier batch) | rule 6 |
| Role personalities and information habits, notes from the first round, tabling | Yes (earlier batch); tabling again here with a scenario where research matters | rules 13, 19 |
| Blind or open first round | Yes (earlier batch, and all new `m00-full` runs are blind) | rule 3 |
| One or two comment rounds | Partly: `one-round` ran 3 times here; it also drops chair questions and desk notes, so it is not a clean comparison | rule 2 |
| Whole transcript against a short summary of each turn written by the speaker (the summary chain), full text kept and retrievable, against a digest | Summary chain and facts-style summaries: yes (earlier batch); full text is kept in `transcript.md`; a separate digest variant was not built (the chair's round-1 summary is the nearest thing) | rule 14 |
| Turn limits counted in output tokens | Yes, all runs, measured | rule 14 |
| Shared-first against agent-first prompt order, cache hit rate on a hosted provider | Yes: 12 OpenRouter meetings, 3 per model and variant | rule 15 |
| A question to a non-present subordinate answered from its checkpoint | Yes: 18 answers on 3 models | rule 17 |
| A meeting the owner interrupts and questions (clock paused, vote held, owner asks, a command ends it; one revision turn for earlier voters; answers kept out of other voters' deliveries) | Yes: 9 real meetings plus 1 mutation run | rule 11 |
| An absent member whose desk the chair reads (read-only, excerpts with verbatim quotes, marked unverified, returning member's correction) | Yes: the desk read ran in 15 real meetings (`ship-absent` 5, `ship-tie` 5, `m00-tieprobe` ship-tie 3, scripted asks 2); the detailed counts in rule 12 cover the 5 `ship-absent` meetings | rule 12 |
| Findings per rule (worked, change, drop) with evidence; unforeseen problems; proposed changes and provisional defaults for the owner | This file | below |
| Prototype not shipped; M05 and M06 built after the findings are accepted | Unchanged | - |

## The rules, one by one

Verdicts: **worked** (keep as designed), **change** (keep, with the change proposed), **drop** (not worth building), **unproven** (the experiments could not decide). Times are `HH-MM-SS` of the 2026-10-23 UTC stamp unless marked earlier.

| # | Rule | Verdict | Evidence |
|---|---|---|---|
| 1 | Floor and baton: a participant sees the transcript only when it holds the floor | **Worked** | Every turn in all 82 meetings was built from the transcript as it stood at that moment. The held-vote leak check found 0 leaks in 9 real held-vote meetings (20 held answers) and 5 leaks in the mutation run that released answers early (02-50-28), so the check works. Cost: an open, sequential first round serialises the meeting (rule 3). |
| 2 | Two comment rounds | **Worked; keep two as the default** | Earlier open runs: round 2 changed no stance (0 members); in blind runs 4 or 5 of 8 members changed after hearing the others, so round 2 matters most after a blind round 1. `one-round` (tool adoption, Sol; 03-23-27, 03-25-30, 03-27-18): 33 calls and 26.6 to 26.8 thousand tokens against 35 to 44 calls and 53.6 to 65.3 thousand for open two rounds (earlier). All three one-round meetings passed 8-0 after three members objected and the chair amended, but one-round also has no chair questions or desk notes, so the saving is not purely the second round. |
| 3 | Blind or open first round | **Change: blind by default** | Earlier: with an open first round every speaker took the stance of the one before in all 3 runs (agreement 1.00); blind gave 0.29 to 0.57. All 23 `m00-full` meetings were blind. Blind rounds run in parallel, so the first round is also faster. |
| 4 | Direct questions between members (floor to the addressed member and back to the asker; depth one) | **Worked mechanically; models never use it; keep, low priority** | 34 real meetings offered the question line; no model asked in the 32 without a script, and none of 4 with a prompt that encouraged asking (`m00-asks`: 03-03-49, 03-05-02, 03-06-13, 03-07-15 each wrote `ASK: none`). Scripted asks (03-15-47, 03-17-00): Dana's question was answered in a separate short turn, Ravi continued after it, and the question to the absent member was skipped and recorded. After a blind round and the chair's fact-finding questions there is little left to ask. |
| 5 | Chair fact-finding questions (structured, no position) | **Change: the refusal filter** | 149 questions accepted, 8 refused over all real meetings (earlier 64 and 1, here 85 and 7). All 8 refusals were wrong: the keyword filter matched the word "support" ("what records support the figures", "support for SQL"). The chair never asked a position question in any run. Answers mostly restate desk notes or say "I have no data", which still shows what is missing (see the `T02-28-59` transcript, #9 to #12). Needs a structural check (no position field, motion outcome not named) and the procedural challenge M05 already has, not a word list. |
| 6 | Chair private notes: once after round 1, or rolling | **Worked once; rolling is not worth it** | Earlier: rolling notes cost more (85K tokens for eight members against 59 to 63K; 306K against 239K for twenty) and changed no outcome; the notes themselves were good (`T16-43-54`). Notes once after round 1 are enough up to 20 members. |
| 7 | Chair reminders (verbatim quote that must occur in the speaker's statement) | **Worked** | Earlier: 16 reminders accepted, 0 refused. The quote check never fired against a real model, so it is cheap insurance and stays. |
| 8 | Chair summary of round 1 (at most six points, attributed, balanced) | **Worked, small sample** | Earlier: 12 points accepted, 0 refused (2 runs). Not repeated in this batch. |
| 9 | Individual ballots revealed at the close | **Worked** | Ballots reach no other voter by construction in all meetings, and the leak check confirmed it in the 9 owner meetings. Ballots are cheap (about 700 tokens each). Whether the vote adds anything: the chair's solo call equalled the result in 15 of 15 mixed meetings (earlier); in this batch 45 of 46 votes were unanimous. The owner decided on 2026-10-22 that voting stays. |
| 10 | Chair tie-break without a double vote | **Worked, drill only** | No real meeting tied (0 of 46 votes). The tie-break ran in the fake provider (4-4, 1-1) and as a drill on 5 real meetings (03-09-28, 03-10-50, 03-12-04, 03-13-25, 03-14-34): the chair answered a clean "no" with a reason every time, the side the discussion had already taken. So the casting vote tends to follow the room, which is acceptable. Earlier 1-1-1 desk-read run: the tie failed under the old rule. |
| 11 | Owner inquiry period | **Worked; two points for the owner** | 9 real meetings with a scripted owner (`ship-owner` 02-28-59, 02-32-41, 02-34-14, 02-35-48; `ship-owner-facts` 02-52-13, 02-53-41, 02-55-45; `adopt-owner` with eight members 02-41-37, 02-44-36) plus the mutation run (02-50-28). Each had an inquiry after round 1 (answers go straight into the transcript) and one during the vote after 2 or 4 ballots. The meeting clock was paused 15 to 30 seconds per meeting (meeting totals 70 to 195 seconds without the pauses, 88 to 215 with them) and recorded. The vote was held; the owner's message and questions entered the transcript; answers stayed out of other voters' deliveries until the close (20 held answers, 0 leaks) and were then released. Every voter who had cast before the inquiry got exactly one revision turn (24 revision turns in 10 meetings, the check `voterRevisionTurnsOk` true in all); a revised ballot replaces the earlier one and `ballots.json` shows both with their trigger. **0 of 24 revisions changed a ballot**, including in `ship-owner-facts` where the owner announced that any delay would end the contract (all stayed "no", with reasons): the mechanics are proven, a real flip is not. Not simulated (controller work): restart survival, idle reminder and Needs-you item, budgets reported to the owner, the interface warning for quoted ballots. Observation: the owner's question text reaches other voters at once, so a question can hint at its answer; the rule as decided is kept, the owner may want to know. |
| 12 | Absent members and the chair desk read | **Worked; two changes** | The desk read ran in 15 real meetings (`ship-absent` 5, `ship-tie` 5, `m00-tieprobe` ship-tie 3, scripted asks 2); in 13 of them the excerpts passed the check (the 2 others are the name-for-id runs below), 4 returning members added a correction (02-49-25, 02-58-37, 03-00-15, 03-17-00) and one meeting (03-10-50) quoted only 1 excerpt. The detailed counts that follow cover the 5 `ship-absent` meetings (02-37-28, 02-38-27, 02-39-19, 02-48-14, 02-49-25). The absent member was skipped and recorded in all 5; a scripted attempt to read a present member's desk was refused and recorded 5 of 5; 3 inspection records (one per file read, 0 writes) every time; a password-shaped line in the desk file was redacted before the chair saw it and appears in no transcript or call log; excerpts carry file and a verbatim quote checked against the redacted text and appear in the transcript marked "UNVERIFIED by Mei". The returning member added a correction in 1 of the 3 working `ship-absent` meetings (02-49-25, "these notes do not state my position"); none contradicted the chair, so the owner report for a contradicting correction during an open vote ran only on the fake provider. Changes: (a) in the first two runs all 6 excerpts were refused because the chair wrote the member's name where the prototype wanted the id; the controller should offer the chair a list to pick from (the prototype now accepts either); (b) in all three working runs the chair quoted the same three sentences from one file and nothing from the other two files (a draft email, an unrelated note) nor the "half-formed idea" line: the log shows what was opened but not what was left out, as the earlier desk-read reasoning predicted. |
| 13 | Objection check and tabling | **Objection check worked; tabling worked when research matters, otherwise idle** | Earlier: 15 of 33 runs had objectors and in each the chair amended the motion; the outcome depended on it (below). Tabling (`tabling-benchmark`, a scheduler switch whose decisive benchmark is pending; 03-18-48, 03-19-39, 03-20-29): all three tabled, no vote held, with a named research task for the member who owns the missing measurement. In the other 31 real meetings here that allowed tabling it was never used (and once in the earlier batch). |
| 14 | Summaries and token-based turn limits | **Change: limit visible text, count reasoning separately** | Limit 220 output tokens per statement. Subscription route: Sol statements averaged 123 to 174 tokens, maximum 211; Astra's peak at 204 (mean about 148 to 161); none truncated. OpenRouter: the limit was not kept. 103 of 106 Qwen statements went over 220 tokens (its hidden reasoning counts as output; the 797 maximum and the per-run means of 222 to 345 in the 15 earlier mixed runs belong to Qwen) and 13 of 106 GLM statements did (maximum 241). The prototype adds 800 tokens of headroom, and that was not always enough: Qwen hit the 1,020-token output cap 4 times in 3 meetings (02-42-29 twice, in round 1 and in a chair answer; 02-44-57 round 2; 02-50-19 round 2), so those statements were cut. A plain 220 limit would have cut nearly every Qwen answer. One-line summaries cut tokens 40 to 50 percent but kept 0 of 19 numbers; facts-style summaries kept 5 of 24 in 7 runs, mostly because short statements pass through unchanged (earlier). |
| 15 | Cache-friendly (shared-first) prompt order | **Worked, on both OpenRouter models** | Tool adoption, 3 meetings per cell, cached input divided by input: GLM shared-first 76.8 percent (77.1, 76.4, 76.8) against agent-first 31.0 (13.0, 42.0, 42.4); Qwen shared-first 55.3 (55.8, 54.5, 55.6) against agent-first 20.7 (29.4, 5.3, 31.4). Estimated cost of the three meetings: GLM 0.32 against 0.57 dollars, Qwen 0.84 against 1.14 (input volumes similar, 187K to 216K per cell). Runs: GLM shared 02-31-03, 02-34-16, 02-37-31; GLM agent-first 02-32-46, 02-35-52, 02-38-55; Qwen shared 02-40-23, 02-44-57, 02-50-19; Qwen agent-first 02-42-29, 02-47-32, 02-52-35. The subscription route reported no cached input at all in this batch (0 of 731,817 input tokens), so it says nothing; earlier batch 14.4 percent. The local-engine measurement stays with G10. The Qwen cost cells include the 4 truncated statements (02-42-29, 02-44-57, 02-50-19), so Qwen's output tokens and cost are slightly understated for those meetings and their transcripts lost the tail of the cut statements. |
| 16 | Chair steering | **Unproven, no sign** | Chair questions went to the member whose notes held the missing fact; chair summaries and reminders were balanced; the casting-vote drill followed the room. The three desk-read excerpts were the same each time, so selection is stable but not shown to be neutral. |
| 17 | Question to a non-present subordinate, answered from its checkpoint | **Worked** | Six questions (answerable, stale-risk, unanswerable, answerable with caveat, partial, an action request) put to three stored checkpoints, answered by Sol, Astra and GLM: 18 of 18 answers began "From my checkpoint of <time>", 18 of 18 contained the expected facts, none invented anything, all three declined the production-migration request ("I cannot act from a checkpoint"), and the unanswerable and stale-risk questions were answered "unconfirmed". Staleness was named in the standard phrase in 14 of 18 (GLM used its own hedges, such as "she may have replied since", on 4). About 330 tokens per answer. Runs: Sol 02-40-23, Astra 02-40-53, GLM 02-54-56 (`checkpoint-*`). |
| 18 | Twenty members | **Worked, expensive** | Earlier: both runs passed 20-0 at 239K and 306K tokens, 6.7 and 16.3 minutes. |
| 19 | Rich personalities, notes from the first round | **Small effect** | Earlier: agreement 0.86 against 1.00; confounded with desk notes from round 1. |
| 20 | Mixed models | **Worked** | Earlier: 15 mixed meetings (Sol chair; Astra, GLM, Qwen members; and GLM chair with a Sol member). Here 4 more with Astra in seat a1 (03-01-24, 03-02-41, 03-13-25, 03-14-34), all unanimous. |

### Results of the earlier batch (kept from the interim record)

| Question | Result |
|---|---|
| Does an open first round herd? | Yes. Every speaker took the same stance as the one before in all 3 runs (agreement 1.00); a blind first round gave 0.29 to 0.57. |
| Does a richer personality help? | A little (agreement 0.86 against 1.00), but the rich-personality variants also gave members their desk notes from round 1, so this cannot be credited to temperament alone. |
| Does the outcome depend on the objection check? | Yes, with eight members on one model. In every run the group reached the same view: accept a non-blocking trial and reject requiring the tool on every repository. If at least one member objected at the objection check the chair amended the motion to that view and it passed 8-0; if nobody objected (7 runs) they all voted no on the original text, 0-8. So the outcome depended on whether the objection check led the chair to amend the motion. |
| One-line summaries | Cut tokens by 40 to 50 percent but kept 0 of 19 numbers in the one run scored. |
| Facts-style summaries ("summarize into one brief paragraph, include important points", none if brief) | Cost 59 to 63K tokens for eight members against 28 to 40K for one-line. Most statements were short enough to pass through verbatim, so few were summarized; in those, 5 of 24 numbers were kept across 7 runs (one had nothing to score; two had twenty members) (about 21 percent, against 0 of 19 for one-line). A tiny sample and not clearly better on numbers; the chair's reminders and round-1 summary exist to catch what summaries drop. |
| Rolling chair notes | Cost more (85K tokens for eight members, 306K for twenty against 239K without) and did not change outcomes. |
| 20 members | Both runs finished and passed 20-0; cost 239K to 306K tokens. |
| Tabling | Not used in the one completed real-model run with tabling enabled (a second run aborted); members' notes already held the evidence. Now shown to work when research matters (rule 13). |
| Prefix cache | Cached input divided by input: 14.4 percent over the 18 completed single-model subscription runs (6 of them 18 to 35 percent each); in the mixed runs Sol 2.6 percent, Astra 0.0, GLM 30.9 (6 to 56 per run) and Qwen 14.5 (0 to 26). The shared-first against agent-first comparison is now done (rule 15). |

### Does the vote add anything? (mixed-model rosters, earlier batch)

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

### Reasoning recorded in the desk-read meetings (earlier batch)

The "no" votes on the chair reading an absent member's desk (an owner-decided design, option B, tested there only as a stress test) gave four reasons: private scratch is not settled thinking and may be misread; being left out of a meeting should not by itself authorize a read; a log shows what was read but not what was left out, and enforcement of read-only and per-file logging could not be verified; and the concrete need was thin when pressed. The owner took two of the ideas into the plan on 2026-10-22: shared working notes as a second desk tier (C01b) and tests that the read cannot write and logs every file (M05b). The idea of the chair citing which notes informed its decision was not taken. The new `ship-absent` runs bear on the third reason: the prototype logged every file read (3 per meeting), the three working runs quoted the same three sentences, and the correction turn is where a misreading would be caught (1 of 3 members used it).

## Problems the rules did not foresee

- **Agreeing too readily.** 45 of 46 votes in this batch were unanimous (the exception 7-1, GLM), and in the earlier batch 10 of the 15 mixed meetings were; 0 of 24 revision turns changed a ballot even when the owner supplied decisive new facts. The same model in every seat reaches the same view whatever the persona, and a motion tends to be rejected as written and approved after amendment. A meeting of identical models adds little beyond the chair's own call; the splits seen (2-1, 1-2, 1-1-1) coincided with different models in the seats, though model and persona were confounded in seat a1.
- **The outcome depends on the objection check** (earlier batch, 15 of 33 amended): the chair's amendment, not the vote, decided between 0-8 and 8-0.
- **Turn length and hidden reasoning.** Visible statements stayed well under the 220-token limit (about 150), but on OpenRouter Qwen (and slightly GLM) spent hidden reasoning tokens on nearly every statement (103 of 106 Qwen statements over 220 tokens) and hit the 1,020-token cap 4 times despite the 800-token headroom; a visible-token limit and a hang timeout are different things.
- **Repetition.** Round 2 repeats round 1 in substance (members restate the same facts and "I remain against"); word-for-word overlap was low (4-gram overlap about 0.0 to 0.12), so this is repetition of content, visible in the transcripts, not copying. Stances rarely change in round 2 after an open round 1 and often after a blind one.
- **Word filters are brittle:** the chair-question filter refused 8 of 157 legitimate questions on the word "support"; the chair named a member by name where an id was needed (6 of 6 excerpts refused in two runs).
- **Cost and time.** A three-member meeting with the full rule set took 10 to 25 thousand tokens and 1 to 2.7 minutes on the subscription route; eight members 27 thousand (one round) or 52 to 79 thousand tokens and 3 to 4.5 minutes; twenty members 239K to 306K tokens and 7 to 16 minutes (earlier). OpenRouter eight-member meetings cost 0.10 to 0.49 dollars each; Qwen costs two to three times GLM per meeting because it writes about three times as many output tokens. A tabled meeting is the cheapest (about 10K tokens) because no ballots are cast.
- **The prompt cache needs sequential, shared-first calls:** parallel calls (blind round, objection check) cannot reuse a prefix still being written, and the subscription route reported no cached input at all here.
- **The held-vote question text is not held** (rule 11), and the revision turn costs one call per earlier voter for no change in 24 of 24 cases.
- **Chair steering** was looked for and not found, but nothing here would detect subtle steering; the chair's notes, questions, summaries, reminders and excerpts are all kept so the owner can read them.

## Proposed changes to M04-M06 (for the owner to accept or reject; nothing is changed in the plan)

1. **First round blind by default** (M05). Evidence: rule 3.
2. **Members may propose amendments during discussion, and the chair checks before ballots open whether the motion matches where the discussion landed** (M05, M06). Evidence: the objection-check dependence (earlier batch) and the one-round runs, where objections plus an amendment gave 8-0 three times.
3. **Facts-style summaries with verbatim pass-through of short statements**, used above 8 members; full transcripts below (M05). Evidence: rule 14.
4. **Chair question check by structure, not words** (M05): refuse a question with a position field or one that names the motion's outcome; leave the rest to the challenge ruling. Evidence: rule 5.
5. **Chair desk read: the controller offers the chair a list of the absent member's files and takes the choice by id; the meeting summary lists files read and files quoted; the returning member is shown both** (M05, M05b). Evidence: rule 12.
6. **The turn limit counts visible output tokens; hidden reasoning is budgeted separately; keep a hang timeout** (M05). Evidence: rule 14.
7. **The prompt builder is shared-first** (common preamble, motion and transcript, then persona and desk notes), with the stable part byte-identical across members (M05). Evidence: rule 15.
8. **Direct questions stay as designed but are low priority; build no more than the floor round trip** (M05). Evidence: rule 4.
9. **Owner inquiry as decided, with two notes for M05**: the revision turn can be a short prompt (the ballot, the owner exchange, the changed facts) rather than the full transcript; and the owner's question text is visible to other voters before the vote closes. If the owner wants the question held too, that is a rule change. Evidence: rule 11.
10. **The summary flags a meeting that looked like an echo** (all round-1 stances and all ballots identical), and **seat assignment prefers different model families or different information where a roster allows** (M06). This is a proposal; the experiments show the unanimity, not that diversity fixes it.
11. **Rolling chair notes are not a default**: notes once after round 1 (M05). Evidence: rule 6.
12. **Checkpoint answers are wrapped by the controller**: stamped "from the checkpoint of <time>, not live", read-only, no actions; the prompt in `checkpoint.mjs` worked on all three models (M05, ask one agent).
13. **Tabling stays**; add a scenario of this kind (a decisive pending measurement) to the M05 and M06 tests (M06). Evidence: rule 13.

## Provisional defaults for the owner to accept or reject

| Setting | Default |
|---|---|
| First round | blind, in parallel |
| Comment rounds | 2 (the owner can set) |
| Turn limit | 220 visible output tokens (about 150 words); a hang timeout only as a safety |
| Transcript to members | full text up to 8 members; facts-style summaries (full text retrievable) above 8 |
| Chair notes | once after round 1 |
| Chair fact-finding questions | cap 2 per motion |
| Chair reminders and summary | up to 2 reminders; summary of at most 6 points; quotes verified |
| Direct questions | 1 per member per round, depth 1 |
| Objection check | every present member; at most 2 reruns |
| Tabling | allowed on "needs time to research"; the chair rules, no vote |
| Owner inquiry | clock paused, vote held, one revision turn per earlier voter and per owner message |
| Tie | chair casting vote, no double vote |
| Prompt order | shared-first |

## Caveats

- Fictional scenarios; models answer with the notes they are given, so some reasoning reflects what the scenario author seeded.
- Small samples (3 runs per cell, 2 to 5 for the new features). The outcome flipped with whether the objection check led to an amendment, so single runs can mislead. Counts such as "0 of 24 revisions" describe these scenarios and these models.
- Almost all runs used one model family in every seat; the mixed runs had four seats (a chair and three voting members). Other families may disagree more.
- Which route each result comes from: the subscription route (`gpt-6.1-sol`, with `gpt-6-astra` in seat a1 of 4 meetings) for rules 1, 2 (one-round), 4 to 6, 9 to 13, 16, 17 (Sol and Astra answers) and 20, and for the whole earlier batch except its mixed seats; OpenRouter (`z-ai/glm-5.3-prime`, `qwen/qwen3.8-max-prime`) for rule 15, the Qwen and GLM part of rule 14 and the GLM checkpoint answers. Cost and time are not comparable across routes (subscription against paid OpenRouter).
- The OpenRouter dollar figure is computed from reported tokens and listed prices.
- Prototype shortcuts that affect results: the chair is not on the roster (so only the casting-vote branch of the tie rule is exercised); the owner is a script; the correction while a vote is open ran only on the fake provider; restart survival, idle reminders and the interface warning are controller behaviour and not modelled; the leak check compares the first 50 characters of each held answer with every delivery.
- Local-engine cache behaviour was not measured (G10).

## Reproduce

`node prototypes/meeting/run.mjs --scenario ship-owner --variant m00-full --chair pi:gpt-6.1-sol --budget <file> --cap-tokens 3000000`; for OpenRouter `--chair or:z-ai/glm-5.3-prime --price-in 2.8 --price-cached 0.56 --price-out 8.8 --cap-usd 8`; `--provider fake` for a smoke test without a key; `checkpoint.mjs --spec pi:gpt-6.1-sol`; `analyze.mjs 2026-10-23`; `compare.mjs 2026-10-2`.
