# M03h part 1 — owner chat reach for stand-ups

## Plan (written before the work)

What is already in this branch from earlier M03h slices, checked by reading the code: `standup.prepare` and `standup.add-statement` are in `CHAT_OPS` and resolved in `chat.ts` from the owner's own words
(`meetingTopic`, `agentName`), the `standup_briefs` status kind reads a brief, and `StandupService.recent` feeds the *meetings* status answer. So this card's remaining build is the stand-ups status kind and the
gaps around the three chat operations.

1. Explore (`CHAT_OPS`, `STATUS_KINDS`, `status.ask`, `standups.ts`, the capacity/release views as shape models). This plan is the deliverable.
2. New status kind `standups` (`projectId`, `limit`): a new read `StandupService.overview` (each stand-up of the project: title, state, recurrence/time/zone, window, length, roster, next planned occurrence, last occurrence and how many were held), one `standupsLines` answer in `status/status.ts`, wired in `api/start.ts`, `ask()` case, `StatusRequest` union, `STATUS_KINDS`, and the chat's project-focus list. Tests: `standups/standups.test.ts` (the read: order, ended left out with a count, limit/`more`, rights, empty project, bad limits) and `status/status.test.ts` (the answer's lines, cites, limit line, no-right reads as missing, no-dep reads as missing), plus a chat turn that asks in ordinary words.
3. Chat op "prepare a stand-up now": already present; add tests for wording not yet covered and make the refusal honest when the project has stand-ups but none that can be prepared (their meeting has not been created yet), so the owner is told what exists instead of "there are none".
4. Chat ops "read a brief" and "add a statement for an agent": already present; add the missing guards' tests (a note or a stand-up name the interpreter invented is refused, not guessed; a note cannot be put on another project's stand-up) and keep them proposals in every profile.
5. Regenerate the prompt/API docs (`npm run api:docs:write`), say what the `status.ask` summary now names, and add an `implementation-notes.md` entry that states plainly which parts were already built by earlier slices.
6. `npx tsc --build --force`; the sandboxed chat/status/api/meetings test files; `node --test scripts/plan.test.mjs`. Counts here, honestly, including failures.

Not built here (rest of M03h, unchanged): the usage sink, an agenda outcome that asks the owner a new question, an end-to-end controller test with every sink, a per-project stand-up index.
No keyword scan of owner text is added anywhere: intent is the interpreter's; only the existing foreign-value/whole-word guard applies to names and note text.

## What was done

Five commits on `pi-m03h-chat`: one for each numbered step, with steps 5 and 6 in the last of them (the report could not carry the step-6 counts before they had been measured) and one small wording commit after them.

**Step 1 — the plan.** Committed as `a6296c9f`, before any code was written.

**Step 2 — the status view (`3f98d6d5`).** `STATUS_KINDS.standups` (`projectId`, `limit`) answers "what stand-ups does this project have?" from a new read, `StandupService.overview`: for every stand-up the project has set up, its state, how often and at what time it is held, its zone, length and window, its roster, how many meetings it has made, the meeting coming up next and how the last one ended. Unlike the existing `recent` read (which the *meetings* answer already uses and which knows a stand-up only through an occurrence), a stand-up that has not met yet is shown, and ended ones are counted and left out unless asked for. Two lines per stand-up: the schedule as set, with the title quoted because whoever set it up wrote it, then its meetings. Wired in `api/start.ts`, added to the `StatusRequest` union and `ask()`, and to the chat's list of kinds whose project comes from the focus. The right to the answer is the right to read the project's meetings; a readable project with none is answered plainly rather than with nothing.

**Step 3 — preparing a stand-up by chat (`c740fbaf`).** The op was already in `CHAT_OPS` from an earlier slice; what it could not reach was the stand-up an owner is most likely to name. It resolved the owner's words through `standup.recent`, so a stand-up set up this morning was invisible and the answer said no stand-up in the project could be prepared — untrue of a project with two waiting for their first meeting. The chat now reads the project's stand-ups from the schedules too: words that fit one are answered about it ("… is set up in this project but has no meeting to prepare right now"), words that fit none are refused with the titles the project has, and nothing is offered from a project with none or from an ended stand-up. The meeting worked on is still the planned one, or the last one when it passed unprepared, so a catch-up still works.

**Step 4 — reading a brief and leaving a note (`426b8227`).** Both ops existed; the same reach gap applied to reading. Asking what a stand-up that has not met had briefed was answered as a name that fits nothing. Reading, preparing and noting now share one schedule read (`#standupTitles`, sorted, ended ones left out), so the answer is about the stand-up the owner named, and a refusal lists the project's stand-ups in one order. An agent who is not on that stand-up is still refused rather than answered with someone else's brief; the owner's note comes back on the read-back as the owner's own words, quoted.

**Step 5 — docs and notes (this commit).** `status.ask`'s summary in `api/operations.ts` now names `standups` beside `meetings` (its test in `api.test.ts` requires every `STATUS_KINDS` kind to appear there), `npm run api:docs:write` regenerated `docs/nimblenewt/api-v1.md`, and `implementation-notes.md` has an M03h part 1 entry that says plainly which parts were already built by earlier slices and what this one added.

**Wording commit (`5e2363fa`).** Three refusals each built their own list of the project's stand-ups, so a project with three of them was described differently depending on which question had been asked; they share one phrase now. No behaviour the card asked for changed.

**Step 6 — the runs**, all with the offline guard (`NIMBLENEWT_REQUIRE_SANDBOX=1`), from `packages/controller`. Every one of these was run again after the last commit, so the figures below describe the branch as it stands:

| command | result |
| --- | --- |
| `npx tsc --build --force` (repo root) | clean, exit 0 |
| `node --import scripts/offline-guard.mjs --test dist/chat/*.test.js dist/status/*.test.js dist/api/*.test.js dist/meetings/*.test.js dist/standups/*.test.js` | 2063 tests, 2063 pass, 0 fail |
| `node --test scripts/plan.test.mjs` | 6 pass, 0 fail |
| `npm run check:deps` | "package boundaries ok" |
| `npm run roadmap:check` | "roadmap ok" |
| `npm run api:docs:write` | rewrote `docs/nimblenewt/api-v1.md` (the `status.ask` summary changed) |

Run separately while working (before the last two commits, and not re-run since except as listed above): `dist/standups/standups.test.js` 104 pass / 0 fail, `dist/chat/standup-commands.test.js` 32 pass / 0 fail, `dist/status/status.test.js` with `dist/chat/standup-commands.test.js` 192 pass / 0 fail, `dist/chat/*.test.js` alone 945 pass / 0 fail, `dist/meetings/*.test.js` alone 469 pass / 0 fail, `dist/api/*.test.js` alone 373 pass / 0 fail. No failures were left, and nothing was skipped or marked todo.

New tests, each against four backends (reference store, SQLite, SQLite on a worker thread, PostgreSQL): one `overview` suite (13 suites × 4 backends of them ran inside `standups.test.js`), one `standups` status suite, and three chat suites of ordinary sentences. Two of them caught real defects while being written, both fixed rather than written around: the status view detached `overview` from its service and crashed with `Cannot read properties of undefined`, and the listed stand-ups came out in whatever order the backend returned records, so the same question answered twice could name them in different orders.

## What was not done

- **Nothing in the card's two bullets was left out, but most of the chat half was already built.** `standup.prepare`, `standup.add-statement` and the `standup_briefs` reading kind were in this branch before the card was taken up (earlier M03h slices). What this card added is the `standups` view and the reach the existing controls lacked. Nothing here changed what the owner is allowed to say: there is still no keyword scan of owner text, the interpreter decides intent, and the only check on a name or a note is the existing whole-word/foreign-value guard. The tests use ordinary sentences and the scripted interpreter, exactly as the existing stand-up chat tests do.
- **Still open in M03h, untouched:** the usage sink; an owner's question raised by a stand-up; an agenda outcome that asks the owner a new question; an end-to-end controller test with every sink fitted; and a per-project stand-up index — `overview`, like `list` and `recent`, scans every stand-up record of the installation and says so in its comment.
- **Not verified by running one:** that the model actually picks the new `standups` kind on its own. The prompt is generated from `STATUS_KINDS` and `model-interpreter.test.ts` asserts every kind appears in it, but no test drives a real model, so "the model offers this view when asked in words" rests on the table and the prompt, not on an observed call.
- **No push and no merge:** four local commits on `pi-m03h-chat`, nothing sent anywhere. `scripts/generate_task_plan.py` and the task plan were not touched, and `git status` is clean apart from this branch's own commits.
- One wording choice was made rather than asked: the answer tells ten stand-ups and ten roster names at a time (the read behind it defaults to twenty, at most fifty), with anything left over counted in the reply. Recorded as an `ASSUMPTION:` line in the implementation-notes entry.

