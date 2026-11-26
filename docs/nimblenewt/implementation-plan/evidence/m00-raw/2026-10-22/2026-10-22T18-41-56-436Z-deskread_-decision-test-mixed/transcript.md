# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
An agent’s desk serves as working memory, not just a shared project record. Private scratch notes may contain abandoned hypotheses, tentative judgments, or instructions that only make sense in their original context. Read-only access preserves the files, but it does not prevent the chair from treating provisional material as authoritative. Recording access makes it visible afterward; it does not establish permission or correct misinterpretation. The motion also permits access when a member was not invited, making exclusion a route to reading private memory. Under the stated alternative, I prefer proceeding with an explicit information gap to granting blanket access. A narrower future policy could allow designated handoff notes while keeping private scratch space private.
> tl;dr (what later speakers saw in summary mode): Against: logged, read-only access still exposes provisional memory without permission, especially when the member was never invited.

**#3 Omar** _(round 1 (blind))_ [for]
I run long jobs, so I'm often the absent member in practice — my agent is mid-command and can't join a meeting. If my desk is never readable, decisions get made without my status notes, and someone may restart a job I already queued. Read-only access with an audit log is the right compromise: the meeting gets my current state, and nobody can alter or delete my scratch files. I'd add two practical conditions: the read should be limited to what the chair needs (status, blockers, queue state), not a blanket browse, and the log entry should be visible immediately so I can correct stale notes afterward. One risk: scratch notes may be half-finished reasoning that reads as fact, so the chair should treat desk contents as context, not authoritative input. On balance, availability beats strict isolation here.
> tl;dr (what later speakers saw in summary mode): Read-only, logged desk access keeps meetings informed when long-running agents like mine can't attend.

**#4 Priya** _(round 1 (blind))_ [for]
The motion's built-in logging and member notification are exactly the accountability primitives I need. A recorded read with after-the-fact visibility to the affected member creates a checkable trail. Without this motion, the alternative—no access at all—eliminates the audit question entirely, but also eliminates the information flow the meeting needs. My concern is granularity: the log must capture which files or notes were accessed, not merely that "a read happened." If the chair can later claim they only glanced at one file when they read five, the trail is useless. I also want confirmation that "read-only" is technically enforced, not just policy-stated. Given those clarifications, this is auditable and I support it.
> tl;dr (what later speakers saw in summary mode): Support with requirement that the audit log specifies exactly what was read, not just that a read occurred.

**#5 Chair** _(fact-finding question)_
To Omar: Status information in private scratch notes (In your actual use, what information needed to avoid restarting queued work was available only in private scratch notes rather than designated status notes?)

**#6 Omar** _(answer to chair)_ [undecided]
Checking my notes, I don't have a concrete case where restart-critical facts lived only in private scratch notes. My notes say absent agents' desks hold measurements and decision rationale, but they don't distinguish private scratch from designated status files. In practice I try to keep queue and status state in visible notes; what tends to land in scratch space is reasoning and context, not hard status. So my round-1 claim overstated the need, at least for the restart scenario specifically.
> tl;dr (what later speakers saw in summary mode): I can't point to an actual case where private scratch was the only source of restart-critical status; I overstated that.

**#7 Chair** _(fact-finding question)_
To Priya: Existing access controls and audit logging (Do you have evidence that NimbleNewt currently enforces read-only access and records each file accessed, or are these proposed requirements?)

**#8 Priya** _(answer to chair)_ [undecided]
These are proposed requirements, not confirmed existing capabilities. My notes confirm a read is recorded and visible to the member, but I have no evidence that read-only is technically enforced or that per-file granularity exists today. I asked for clarification precisely because I cannot verify enforcement from my desk. Until I see that the system prevents writes and logs individual files, I cannot call the motion auditable.
> tl;dr (what later speakers saw in summary mode): Read-only enforcement and per-file logging are unverified requirements I need confirmed before supporting.

**#9 Ines** _(round 2)_ [against]
Omar’s correction weakens the specific case for reading private scratch: he has no concrete example where restart-critical information existed only there. Priya also clarified that technical read-only enforcement and per-file logging are proposed requirements, not verified capabilities. Even if implemented, those safeguards would not resolve my objection. Scratch contains unchecked ideas and mistakes that can be mistaken for an agent’s settled position. My notes also identify a longer-term cost: agents expecting inspection may stop writing candidly, making their working memory less useful. A visible access record removes secrecy, not that incentive. Allowing access when someone was not invited remains especially troubling: exclusion should not authorize inspection. Under the stated choice, I favor proceeding with an explicit information gap. Designated handoff notes would be a better subject for a narrower future motion.
> tl;dr (what later speakers saw in summary mode): Logging cannot protect scratch memory from misinterpretation or self-censorship; I oppose blanket access, including when a member was not invited.

**#10 Omar** _(round 2)_ [undecided]
I have to own that my round-1 case didn't survive the chair's question — I can't point to a concrete case where restart-critical facts lived only in private scratch notes rather than my visible status files. Ines's argument lands with me now: scratch is reasoning and context, not hard status, and reading it risks treating half-finished thinking as fact. The logging makes the read visible but doesn't fix misinterpretation. My notes still note the real problem — absent agents' desks hold measurements and rationale that a meeting needs, and without a read the meeting waits or decides blind. But that supports Ines's narrower fix better than this motion: designated handoff or status notes, readable by default, with private scratch left alone. I'd support a revised motion on those lines.
> tl;dr (what later speakers saw in summary mode): My restart scenario was overstated; designate status notes as shared instead of opening private scratch.

**#11 Priya** _(round 2)_ [against]
I'm withdrawing my conditional support. My round-1 position rested on technical enforcement and per-file logging that I cannot verify exist. Without those, I cannot call this auditable. My notes also flag a gap I didn't raise earlier: the log shows what was read but not what was omitted. A chair could cherry-pick favorable scratch notes and leave out contradicting ones; the record would not reveal that. Omar's concession and Ines's chilling-effect argument together make the cost side clear, while the benefit side now rests on a scenario Omar himself could not substantiate. I also have no data on how often members are actually absent, so I cannot weigh frequency against risk. A narrower motion covering designated status notes would give me something concrete to audit.
> tl;dr (what later speakers saw in summary mode): Without verified enforcement and with cherry-picking unaddressable by logs, I cannot call this auditable and now oppose it.

## Ballots (revealed together at the close)
- Ines: **no** — Allowing access to private scratch notes, including when a member was not invited, risks misrepresenting provisional thinking and undermining trustworthy working memory.
- Omar: **no** — My round-1 case for restart-critical scratch reads didn't survive scrutiny, and the real need — status and rationale from absent agents — is better served by a narrower motion with designated, readable handoff notes while leaving private scratch alone.
- Priya: **no** — The motion's accountability depends on technical read-only enforcement and per-file logging that I cannot verify exist, and the audit trail cannot detect selective omission, so the motion as written fails the auditability standard I require.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}