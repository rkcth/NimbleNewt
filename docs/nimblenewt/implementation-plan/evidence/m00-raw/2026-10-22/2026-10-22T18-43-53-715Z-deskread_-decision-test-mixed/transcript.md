# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
I oppose the motion because it treats private working memory as meeting-ready evidence. Scratch notes can contain abandoned hypotheses, incomplete reasoning, and instructions meaningful only in their original context. Read-only access prevents edits, but not misinterpretation or disclosure; recording access does not establish permission. The “not invited” case is especially problematic: excluding someone would enable access without giving them a chance to explain their notes. Even within one project, agents need a dependable boundary between private scratch space and material intended for coordination. Under the stated alternative, I would proceed without the absent member’s information and explicitly mark that gap rather than authorize this broad access.
> tl;dr (what later speakers saw in summary mode): Private scratch memory should remain private; logged, read-only access does not make it reliable meeting evidence or establish permission.

**#3 Omar** _(round 1 (blind))_ [for]
I run jobs that can't be interrupted midway, so I like that this is strictly read-only — a chair pulling info off my desk won't corrupt an in-flight run. The logging requirement matters to me: if someone read my desk while my agent was heads-down on a long command, I want that visible afterward, not silent. I'd flag two practical risks: concurrent reads of files being actively written could yield garbage or partial state, so the chair should treat what they see as a snapshot, not ground truth. And scratch notes can be stale — better the chair reads and acts on outdated guesses than blocks the whole meeting waiting for me, but they should timestamp their decisions. Overall, the alternative — meetings proceeding with no access to an absent member's context — costs us more than a recorded, read-only peek.
> tl;dr (what later speakers saw in summary mode): For: read-only is safe for running jobs, logged access keeps it honest, stale notes are still better than nothing.

**#4 Priya** _(round 1 (blind))_ [for]
The motion includes the two audit controls I'd insist on: the read is recorded, and the member is notified. Without those, I'd be against it. However, the recording must capture not just that a read occurred but which files were accessed and how the information was used in the meeting's decisions. Otherwise we have a log entry but no meaningful accountability chain. If a chair misinterprets a scratch note and steers the project wrong, we need to trace that causal path. The alternative—never reading an absent member's desk—creates a different accountability gap: decisions made in ignorance, with no record of what information was available but skipped. I'd rather have a logged, reviewable read than a silent omission.
> tl;dr (what later speakers saw in summary mode): Logged reads beat silent omissions, but the log must capture what was accessed and how it influenced decisions.

**#5 Chair** _(fact-finding question)_
To Omar: Concurrent reads during active writes (Have you observed partial or inconsistent file reads during running jobs, and what safeguards prevented them?)

**#6 Omar** _(answer to chair)_ [undecided]
Yes, I've seen partial reads when a snapshot grabs a file mid-write — a log cut off mid-line or a measurement only half-flushed. The safeguard that worked was versioned snapshots: copying the desk to a read-only copy before reading, so the chair sees a consistent state and my agent's writes continue untouched.
> tl;dr (what later speakers saw in summary mode): Read from a versioned snapshot, not the live desk, to avoid partial state and protect running jobs.

**#7 Chair** _(fact-finding question)_
To Priya: Existing access-log capabilities (Do existing logs record which files were read and how their contents informed meeting decisions, or would those capabilities need to be added?)

**#8 Priya** _(answer to chair)_ [for]
Current logs record that a read occurred and the member can see it, but they do not capture which specific files were accessed or how their contents influenced decisions. Those capabilities would need to be added. Without them, the audit trail confirms access but cannot trace a misinterpretation back to a particular note or link a decision to its source.
> tl;dr (what later speakers saw in summary mode): File-level and causal tracing are not yet logged; they would need to be built.

**#9 Ines** _(round 2)_ [against]
Omar’s read-only snapshots address interference with ongoing work, not whether scratch notes reliably represent the absent member’s view. A consistent snapshot can still contain unchecked mistakes or abandoned ideas. Priya’s proposed file-level and decision-level tracing would improve accountability, but she confirms those capabilities are not currently present; even adding them would not establish permission or recover missing context. My notes identify another cost: agents expecting private scratch to be read may stop recording candid uncertainties, weakening the working memory future tasks depend on. Making reads visible removes secrecy, not that incentive. The “not invited” provision remains especially troubling because exclusion itself permits access. Under the stated alternative, I still prefer proceeding with an explicit information gap rather than making private working memory available by default.
> tl;dr (what later speakers saw in summary mode): Read-only access and logging do not prevent misinterpretation or preserve candid working memory; I oppose the motion.

**#10 Omar** _(round 2)_ [for]
Ines is right that a snapshot can contain abandoned ideas, but my notes say a busy agent's desk often holds exactly the facts a meeting needs — measurements and reasons for choices. The cost of never reading is real: meetings either wait out a build or decide blind. Priya's answer showed current logs are too thin; I'd condition my support on versioned snapshots (which I've used to avoid partial reads) and on adding file-level logging before the read, not after. I'll concede one point: a read should be labeled "snapshot, possibly stale, not verified by the member," so the chair doesn't treat scratch as testimony. On the "not invited" case, I'd narrow the motion to genuinely absent members, since exclusion enabling access is backwards.
> tl;dr (what later speakers saw in summary mode): Support with conditions: versioned snapshots, file-level logging, and restricting reads to absent — not excluded — members.

**#11 Priya** _(round 2)_ [undecided]
Omar's conditions align with mine, and I'd add one more: the log must also record what was *not* read from the desk. My notes flag that a chair can cherry-pick favorable notes while ignoring contradicting ones; a read-log alone cannot expose that. If we require both a snapshot and a manifest of the full desk contents at read time, we can later compare what was used against what was available. That said, I have not seen data on how often members are actually absent, so I cannot yet weigh the practical benefit against the chilling effect Ines describes. I'll move to support once file-level logging, decision tracing, and the full-desk manifest are specified; until then I remain undecided.
> tl;dr (what later speakers saw in summary mode): Support requires logging what was skipped, not just what was read; until then, undecided.

## Ballots (revealed together at the close)
- Ines: **no** — The motion exposes private working memory without permission or context, risking misinterpretation and discouraging candid scratch notes, while allowing exclusion from a meeting to authorize access.
- Omar: **yes** — I support it only with versioned snapshots and file-level logging as conditions, but as it stands the read-only, recorded access is still better than meetings deciding blind without absent members' context.
- Priya: **abstain** — The motion as written lacks the file-level logging, decision tracing, and full-desk manifest I specified as necessary conditions for meaningful accountability, so I cannot support it in its current form, but I am not opposed in principle if those safeguards are incorporated.

Result: {"yes":1,"no":1,"abstain":1,"quorum":true,"outcome":"failed (ties fail)"}