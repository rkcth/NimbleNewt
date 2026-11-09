# Flaky approval: from magic phrase to shown proposal — report

Branch `pi-flaky-confirm`. Commits: `c4f023a6` (step 2), `ec84768e` (step 3), `e61f6760` (step 4).
Nothing was pushed or merged; `scripts/generate_task_plan.py` was not touched.

## What the code does now

An owner asks for an approval in any words. The interpreter proposes `release.approve` with the
candidate ID the owner named (that whole-word check is kept — `foreignValue`/`RELEASE_ID_KEYS`).
The chat then:

1. reads `release.gate` itself and **drops the interpreter's `acknowledgeFlaky` and
   `expectedFailures`** (both are now on the `unchecked` list so the words-check never echoes the
   argument name back at the owner);
2. refuses outright if the gate cannot be read — with no reading there is nothing to show and
   nothing to bind (previously an unreadable gate only refused a model-set acknowledgement);
3. draws up a **proposal** whose preview says, in plain language, exactly which platforms passed
   only after earlier failures and names the attempt IDs (or, on a clean gate, says no platform
   failed before it passed and that a moved gate will be refused and shown again);
4. binds the shown attempt IDs into the approval as `expectedFailures` (always, `[]` on a clean
   gate) and sets `acknowledgeFlaky: true` itself when the gate is flaky — the proposal line
   (`describe`) hides both internal fields so the owner sees prose, not field names;
5. applies only when the owner confirms that shown proposal. `release.approve` is `mode: "propose"`
   in `CHAT_OPS`, so an approval can never apply at once, and the `release.ts` drift check (shown
   vs. current earlier failures) still refuses at confirmation if the gate moved — including the
   clean-proposal-became-flaky case, which is now caught for *every* chat approval because every
   chat approval now carries `expectedFailures`.

Removed: `saysAcknowledgeFlaky` and its eleven regex helpers (`FLAKY_*`, `CANDIDATE_IDS`,
`nearestCandidate`, `ownerAccepts`) in `commands.ts`, the keyword gate in `chat.ts`, and the
"…approve it with acknowledgeFlaky" hint in every message. `release.ts`'s flaky refusal now says
"Read release.gate again, then approve with the earlier failures it shows"; the status view's
flaky line says "an approval shows these failures and accepting it means accepting them";
`operations.ts`/`api-v1.md` describe what the approval carries, not words to say (docs
regenerated with `npm run api:docs:write`). All gate *checks* in `release.ts` are unchanged.

## Tests (step 3)

`chat/release-words.test.ts`: the `saysAcknowledgeFlaky` tests are deleted; the file keeps the
ID whole-word, platform-spelling and curly-apostrophe checks.
`chat/release-owner-words.test.ts` now asserts, on all four backends:

- (a) `yeah ship the release candidate <id>, I've seen those failures are just noise` yields a
  **proposal** (not a refusal) whose preview names "linux x64 passed only after 1 earlier
  failure" and the failing attempt ID;
- (b) nothing is approved while the proposal waits, a model-set `acknowledgeFlaky` is dropped and
  re-read from the gate, and confirmation in a later turn is what applies it;
- (c) a non-flaky approval behaves as before (proposed, applied on confirmation) — it now carries
  `expectedFailures: []` (bound to the clean gate it was shown) and no `acknowledgeFlaky`;
- (d) the `turn` helper scans **every outcome** (status, message, preview, answer lines) of every
  turn in the two main tests and asserts it never contains "acknowledgeFlaky";
- the drift sequence (clean proposal → gate gains a failure → confirmation refused → asked again
  with the failure shown → applied) still passes, as does "the interpreter's invented
  expectedFailures are never used, nor shown".

One genuine test-writing miss caught by running: the discard intent's `evidence` must be a phrase
of the owner's message ("forget it" ∉ "no, forget that one" → `untrusted_authority`); fixed.

## Step 4 — grep results

After the change, "acknowledgeFlaky" survives only at: the API argument name itself
(`release.ts` signature/validation, `operations.ts` args table, `api-v1.md` argument list — these
document a real argument for direct API callers), internal code comments and the chat's own
drop-and-refill lines, and `docs/nimblenewt/implementation-plan/implementation-notes.md`, which is
the historical record and was left untouched. The interpreter prompt (`OPERATION_LINES`) lists
only `CHAT_OPS` verbs and argument names and never mentioned it; `model-interpreter.test.ts`'s
prompt loop passes.

## Step 5 — review of saysMainAutomatic and saysPlatform (not rewritten)

- **`saysMainAutomatic` is a keyword gate on intent, same family as the removed flaky gate.**
  A command whose args set `landing: "main-automatic"` is refused before any proposal unless the
  owner's own message matches phrase regexes ("main automatic", "automatic to/onto main",
  "straight/directly to main", negation-aware). Worse, its refusal message supplies an example
  sentence ("for example \"land finished work on main automatically\"") — it literally tells the
  owner what to say. It is mitigated: the flag always travels on `integration.set`/
  `project.create`, which are proposals the owner confirms anyway, so by the target design the
  shown proposal could carry the acceptance and the scan could go — but removing it changes the
  landing-policy behaviour and its own test set, so per instructions I only note it here.
- **`saysPlatform` is an ID/evidence-style check, not a phrase gate.** It asks whether a fixed
  choice value (`os`/`arch`) appears in the owner's words under *any* common spelling (linux-x64,
  my mac, x86_64…), refusing only the *interpreter's* invented platform, exactly like the
  `foreignValue`/`wholeWord` ID guard the brief says to keep; ambiguity between two named
  platforms asks instead of guessing. Its messages list the allowed choices, not magic words.
  (Note: `saysPlatform` itself is now only exercised by tests; chat uses `platformsNamed`, same rules.)
  No change made.

## Step 6 — measured results

- `npx tsc --build --force` → clean, exit 0.
- Instructed path `dist/chat/*.test.js` etc. does not exist at the repo root (the build emits to
  `packages/controller/dist`), so the same globs were run there:
  `NIMBLENEWT_REQUIRE_SANDBOX=1 node --import .../scripts/offline-guard.mjs --test
  packages/controller/dist/{chat,release,status,api}/*.test.js` →
  **1624 tests, 1624 pass, 0 fail, 0 cancelled** across 151 test files (all four storage
  backends; ~145 s), exit 0.
- `node --test scripts/plan.test.mjs` → **6 pass, 0 fail**, exit 0.
- Earlier targeted run of the two rewritten files: 38/38 pass.

## What I did not do

- Did not touch `release.ts` gate logic (only two message/comment wordings), `saysMainAutomatic`,
  `saysPlatform`, or `MOVE_VERBS`/`durationInWords` (the latter two are phrase/value scans of the
  same family — `durationInWords` refuses a drain whose seconds the owner did not state — noted,
  not changed).
- Left `implementation-notes.md` history as written, including its old ASSUMPTION lines.
- No push, no merge, no changes to `scripts/generate_task_plan.py`.
