# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
I oppose the motion as written. An agent’s desk serves as working memory, not necessarily as a reliable briefing: scratch notes may contain abandoned hypotheses, incomplete reasoning, or stale assumptions. Read-only access protects the files from edits, but not their contents from being misinterpreted or carried into decisions. Recording access provides visibility afterward, not permission beforehand. The “not invited” case is especially concerning because the meeting can gain access without giving the member a chance to explain its notes. Under the stated alternative, I would rather proceed with an explicit information gap than treat private scratch work as available meeting evidence. I would support a revised design with member-designated shareable summaries and clear boundaries around private working memory.
> tl;dr (what later speakers saw in summary mode): Preserve private working memory; missing information is preferable to unrestricted access to an absent or uninvited member’s scratch notes.

**#3 Omar** _(round 1 (blind))_ [for]
Long-running jobs mean agents are often mid-command and can't attend. If a desk is never read, the meeting loses that agent's context and can make decisions that contradict work in flight — that's how we get duplicate effort or conflicting edits. Read-only access with a recorded log is a reasonable middle ground: the chair gets the needed context, the absent member keeps write protection, and the audit trail means nobody reads silently. I'd add one practical constraint: the read should happen only when the member genuinely can't attend or wasn't invited, not as a routine shortcut, and the chair should be another member of the same project, which the motion already requires. From an ops standpoint, the recording is the key part — if reads are logged, we can review whether this is being overused.
> tl;dr (what later speakers saw in summary mode): For it — read-only, logged access keeps meetings informed without risking in-flight work, as long as it stays exceptional.

**#4 Priya** _(round 1 (blind))_ [for]
The critical feature here is that the read is recorded and visible to the member. That gives me a verifiable event I can trace: who read, when, and what desk was accessed. Without this motion, the meeting proceeds on incomplete information, and any decision made becomes harder to audit because the gap in context is invisible—no one knows what they didn't know. However, I want to flag that logging the read is necessary but not sufficient. We also need to track how the chair incorporates that information into decisions, otherwise the audit trail stops at the door. I'd support this motion with the understanding that the read log is a starting point, not the whole accountability story.
> tl;dr (what later speakers saw in summary mode): The recorded read creates an auditable trail; the alternative leaves invisible gaps that undermine accountability.

**#5 Chair** _(fact-finding question)_
To Omar: Desk access during work in flight (Have you observed a case where an absent agent's desk contained information needed to avoid duplicate effort or conflicting edits? If so, was that information in private scratch notes or a shareable status summary?)

**#6 Omar** _(answer to chair)_ [undecided]
I've seen cases where an agent mid-build couldn't attend and its desk held exactly the facts the meeting needed — measurements and reasons for a design choice. In my cases that material sat in working notes rather than a separate shareable summary, so a status summary alone wouldn't have covered it. I can't confirm a concrete duplicate-effort or conflicting-edit incident from my own observations.
> tl;dr (what later speakers saw in summary mode): Real cases exist of needed facts in mid-build desks, but in working notes, not summaries, and no confirmed duplicate-effort incident.

**#7 Chair** _(fact-finding question)_
To Priya: Read-log capabilities (What do you know about which details the proposed read log records, and whether it links accessed notes to meeting decisions?)

**#8 Priya** _(answer to chair)_ [for]
From what I can see, the read log records who read, when, and which desk was accessed. I have no evidence it links specific accessed notes to the decisions that follow. That's the gap I flagged: the trail stops at the door. I also note the log shows what was read but not what was left out, so cherry-picking remains invisible to the audit.
> tl;dr (what later speakers saw in summary mode): The log records access events but does not link accessed notes to resulting decisions.

**#9 Ines** _(round 2)_ [against]
Omar’s examples show that working notes can hold useful context, but he could not confirm an incident of duplicate effort or conflicting edits. That benefit does not resolve the risk of treating unchecked scratch as an agent’s considered position. Priya’s accountability gap reinforces this: recording access does not establish whether notes were interpreted correctly or used selectively. The motion guarantees a recorded, visible read; it does not specify all the log details discussed. My notes also identify a longer-term cost: agents expecting private scratch to be read may stop recording candid mistakes and half-formed ideas, weakening their working memory. Visibility removes secrecy, not that incentive. I remain against this version, especially access triggered by not inviting someone. Under the stated alternative, I prefer an explicit information gap; a revised design should provide member-designated shareable context.
> tl;dr (what later speakers saw in summary mode): Useful context does not justify exposing private scratch; logged access can still distort decisions and weaken agents’ working memory.

**#10 Omar** _(round 2)_ [for]
I stand by the motion, and Priya's audit-trail gap strengthens rather than weakens my support. Ines's concern about scratch notes being mistaken for considered positions is real, but it argues for better chair practice, not for cutting off access. My notes are clear: without the read, the meeting either waits for a long build or decides blind to facts that exist and are directly relevant — measurements, reasons for choices. Waiting blocks the whole team; deciding blind risks contradicting work in flight. An explicit information gap is a cost, not a virtue. I'll accept Ines's point on the "not invited" trigger: that case deserves tighter conditions. But the common case — agent mid-command, cannot attend — is exactly what read-only, logged access solves. The log lets us review misuse; that's the right balance.
> tl;dr (what later speakers saw in summary mode): Logged read-only access beats deciding blind when agents are mid-build; tighten the "not invited" trigger but keep the read.

**#11 Priya** _(round 2)_ [undecided]
Omar's concession on the "not invited" case narrows the scope, which helps. But the accountability gaps I flagged remain unaddressed by the motion itself: the log records access, not how accessed notes influenced decisions, and cherry-picking stays invisible. My notes confirm the record shows what was read but not what was left out. Without a mechanism linking reads to outcomes, I cannot hold the chair to account for selective use. I also note I have not seen how often members are actually absent; if it's rare, the cost-benefit calculus shifts. I am not against the principle—logged access is better than silent ignorance—but I need the motion to specify at minimum that the chair must cite which notes informed a decision. Until then, I cannot confirm the audit trail is sufficient.
> tl;dr (what later speakers saw in summary mode): Logged access is a start, but without linking reads to decisions, accountability remains incomplete.

## Ballots (revealed together at the close)
- Ines: **no** — Logged, read-only access does not prevent private scratch notes from being misinterpreted or preserve trust in working memory, especially when exclusion from a meeting permits access.
- Omar: **yes** — Read-only, logged access during genuine absence gets the meeting the facts it needs without write risk, and the "not invited" trigger deserves tightening but doesn't justify deciding blind in the common mid-command case.
- Priya: **no** — The motion as written logs access but does not require the chair to cite which notes informed a decision, leaving selective use and cherry-picking unauditable, which means I cannot hold anyone accountable for how accessed information shaped outcomes.

Result: {"yes":1,"no":2,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}