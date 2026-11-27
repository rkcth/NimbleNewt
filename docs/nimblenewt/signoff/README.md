# Real-hardware sign-off checklists (cards Y02 and Y03)

Written 2026-11-27 for Rob, who decided that the QA checkpoints Y02 and Y03 get a real sign-off on his own machines, with no waiver. Each checklist has numbered steps you can copy and paste, what you should see, what to write down if you see something else, and a sign-off block at the end.

- [Y02 checklist](y02-checklist.md): QA checkpoint 2 (isolation, stop and recovery). About 4.5 to 6 hours of elapsed time across the three machines, most of it waiting for test runs. Your own hands-on time is about 1.5 hours. None of it needs a model, apart from one optional section.
- [Y03 checklist](y03-checklist.md): QA checkpoint 3 (the first full workflow driven from chat). About 2 hours can be done now without a model. The core of the card needs a model and several pieces that are not built yet; the checklist names them.

## Before you start

- **The model server (Radiance) is offline.** Each step says whether it needs a model. Steps that need one are grouped in a section headed "When Radiance is back", so you can do everything else now. No step asks you to load, unload or switch a model.
- **No step asks for a key or password.** If a model server needs a key, the checklist uses `node scripts/nimblenewt.mjs secret set NAME`, which asks for the key without showing it. Never paste a key into a chat, a terminal command or a file.
- **Nothing here touches the live site** or any real customer data. Each run uses its own new data folder, which you delete at the end.
- **One commit for everything.** All three machines must test the same commit. The coordinator names it on the day you start. Write it in the box at the top of each checklist and check it out exactly as shown.
- **Gaps are listed, not hidden.** Where a step cannot work today because a piece is not built, the checklist says so and lists it under "Gaps". Do the rest of the steps, and record the gap as "not run: gap" in the sign-off block.

## How a signed checklist becomes a card flip

The card is flipped by a coding session, never by the checklist itself. The steps are:

1. You fill in the sign-off block at the end of the checklist and send it, with the evidence files, to the coordinator.
2. For **Y02** the coordinator copies your sign-off into `y02-signoff.json` and runs `node scripts/y02-checkpoint.mjs gate` on the evidence folder. The card can flip only when that gate reports `complete: true` for the commit. The gate is described in the [own-hardware runners guide](../own-hardware-runners.md) and in the implementation notes, in the Y02 section on the file formats the gate reads.
3. For **Y03** there is no gate program yet (see the gaps in the Y03 checklist). Your signed checklist is copied in as the card's record, in the same way as the Y01 record ([y01-qa-checkpoint.md](../implementation-plan/y01-qa-checkpoint.md)).
4. The flip itself is a `PROGRESS` entry in `scripts/generate_task_plan.py` with `status='implemented'`, the commits, the CI run ids (the ci_runs field, and qa_runs for the QA workflow), `record=` the checkpoint record, and a note that quotes your sign-off. After it, the plan files are generated again and `npm run roadmap:write` is run. `scripts/plan.test.mjs` refuses the flip while any blocker of the card is still planned. Today Y02 still waits on G05, G06 and A03b, and Y03 waits on Y02 and P02.
