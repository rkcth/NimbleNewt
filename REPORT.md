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

(to be written)
