# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"m00-structural-p1","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"chairQuestionCheck":"structural","deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":1,"allowTabling":true,"directQuestions":true,"deskRead":true}
Model: qwen3.8-flash-next-iq4r

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
As someone who designs memory systems, I'll tell you plainly: a scratch space that *can* be surveilled is not really scratch space anymore. The moment agents or people know their half-formed drafts, false starts, and blunt notes might be read aloud in a meeting, they stop writing freely. The notes get sanitized, hedged, performative—and then they stop serving their actual purpose, which is to be a low-stakes thinking workspace. The recording and visibility safeguards are good governance, but they don't fix the chilling effect; they just make you *know* you're being watched. The alternative—proceeding without that member's information—is painful, but I'd rather build a protocol for asynchronous handoff than erode the trust that makes working memory useful. Scratching is supposed to be messy. Protect the mess.
> tl;dr (what later speakers saw in summary mode): Scratch notes only work if they feel private; surveilling them destroys their function as genuine working memory.

**#3 Omar** _(round 1 (blind))_ [for]
I run jobs that cannot be interrupted, so I frequently cannot attend meetings at all. My desk is my only voice when agents are mid-command. Without it, meetings proceed blind to what I've learned, and decisions get made against half-known constraints. I support the motion, but I'm uneasy about "private scratch notes." Mine contain half-formed debug traces, temp-variable names, and angry comments about a bug that turned out to be nothing. Read out of context by someone who didn't watch my agents build toward a conclusion, those notes misrepresent my thinking. I accept the recording and transparency provisions—they help me flag "that line was mid-refactor"—but I want a norm that the chair distinguishes scratch from finalized notes rather than dumping raw files. For the practical reason that my agents can't stop for a meeting, I vote for.
> tl;dr (what later speakers saw in summary mode): For it, because un-stoppable jobs make my desk my proxy, but scratch-note context risk worries me.

**#4 Priya** _(round 1 (blind))_ [for]
From an audit and accountability standpoint, this motion is preferable to the alternative. The key is that it creates a checkable record: who performed the read, when, under what authority, and what scope was touched. The logged, read-only, same-project constraints give me a clear boundary to verify after the fact. The member's ability to see the read happened means there is a recipient for accountability, not just a silent log.

My concern is narrow: the integrity of that log must be tamper-evident. If the chair can write a record and then quietly amend or delete it, the whole accountability chain collapses. I want the read-event appended to an append-only store the chair cannot modify, and I want periodic audits comparing actual access events against what was reported to members.

Given those safeguards, for. The alternative—proceeding blind—produces decisions nobody can trace to a rationale. That is a worse accountability gap.
> tl;dr (what later speakers saw in summary mode): For the motion, provided the read-log is append-only and tamper-evident, because auditable visibility beats silent absence.

**#5 Chair** _(fact-finding question)_
To Ines: Selective-disclosure patterns in memory systems (In concrete systems you have designed or studied, what mechanisms (e.g., tagged confidence levels, explicit 'handoff bundles', staged publishing) have allowed a reader to pull useful context from a working-memory store without the author feeling the whole scratch space is permanently exposed? If none exist in practice, say so.)

**#6 Ines** _(answer to chair)_ [against]
In the memory architectures I build, the separation is structural: scratch files are marked disposable and never enter the handoff bundle an agent publishes at task-end. I have not shipped a system where an external reader can dip into raw scratch without the author's staging step. Tagged confidence levels exist in my drafts, but publishing is always a deliberate act by the author. The motion removes that act.
> tl;dr (what later speakers saw in summary mode): No concrete system I shipped lets outsiders read raw scratch without a deliberate author-publish step; the motion erases that step.

**#7 Chair** _(fact-finding question)_
To Omar: Metadata that already separates scratch from finalized notes in NimbleNewt workspaces (In your current NimbleNewt jobs, do your agents or you write any structured marker—timestamps, task-boundary flags, a 'publish' gesture, directory separation—that a chair could use to tell a mid-refactor debug trace from a concluded constraint? Describe what is actually present in your desks today, not what you wish existed.)

**#8 Omar** _(answer to chair)_ [for]
Honest answer: basic directory separation exists—scratch in a working dir, concluded notes sometimes flagged when an agent finishes a step. No explicit publish gesture. Agents append debug traces, temp names, and mid-process reasoning into the same scratch stream as measurements and rationale. The only real marker is a timestamp and a task-boundary line the agent writes when a command completes. That tells the chair a line is post-build, not whether it's throwaway or concluded constraint.
> tl;dr (what later speakers saw in summary mode): Basic task-boundary timestamps exist, but nothing robustly separates a throwaway debug line from a concluded constraint in my scratch.

**#9 Ines** _(round 2)_ [against]
Omar's answer confirms my structural worry exactly. There is no publish gesture, no reliable marker separating a throwaway debug trace from a real constraint. The chair cannot distinguish them today. So this motion, as written, doesn't let the chair "distinguish scratch from finalized notes" as Omar hopes—the information to do that simply doesn't exist in the workspace. Raw scratch gets read out of context and taken as position. My notes say exactly that: half-formed ideas read out of context look like positions the agent never held. And once agents expect it, they stop writing candidly—the memory stops working. Omar's need is real, but the fix is shipping the handoff bundle I keep trying to build, not opening the scratch.
> tl;dr (what later speakers saw in summary mode): Without a reliable scratch-vs-concluded marker, this motion guarantees misreading and erodes the candidness that makes working memory useful.

**#10 Omar** _(round 2)_ [for]
Ines is right that today's markers can't cleanly separate a throwaway trace from a real constraint—my own answer to the chair confirmed that. I won't pretend a timestamp solves it. But my agents literally cannot stop mid-build; I need something operational now, not a future handoff bundle that hasn't shipped. So I amend: the chair reads only lines written after a task-boundary marker—post-completion measurements, recorded rationales—and the raw scratch stream before that boundary is off-limits. It's a blunt filter; I know a boundary line doesn't guarantee a line is concluded. But it shields the angry mid-refactor comments Ines fears, and it gets the constraint-facts my meeting needs. If that still chills, I'll accept undecided until a publish gesture ships. For, with the scope narrowed.
> tl;dr (what later speakers saw in summary mode): Support the read but limit it to post-task-boundary lines to protect raw scratch while recovering mid-build facts.

**#11 Priya** _(round 2)_ [for]
Omar's amendment improves auditability over the original motion. A task-boundary marker is a structural artifact a log can reference—"read scope: post-boundary line 47"—making the chair's access narrower and checkable after the fact. That's better governance than the unrestricted read in version 1.

However, my notes flag a residual risk: the record shows what the chair read, not what the chair chose not to mention to the room. Even within post-boundary scope, selective quotation can manufacture a false consensus. I want the log to capture the full set of post-boundary lines available at read-time, not only the subset surfaced aloud.

Tamper-evidence requirement stands unchanged. Absence frequency still unknown; if this fires rarely, the chilling cost Ines fears may be smaller than Omar's blind-decision cost.
> tl;dr (what later speakers saw in summary mode): Narrower scope improves checkability, but the log must capture all available post-boundary lines, not just the chair's cherry-picked subset.

**#12 Ines** _(objection)_
The motion text still says "private scratch notes" without incorporating the post-boundary narrowing the discussion converged on, and since Omar confirmed no robust marker separates a debug line from a concluded constraint, "scratch" is not a well-defined read scope, so we would be voting on an ambiguous category that either guts the motion or guts candidness.

**#13 Chair** _(ruling)_
Amended. New wording: When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, read-only and within the same project, but **only lines appearing after the most recent task-boundary marker** written by the member's agent. Pre-boundary scratch content is off-limits. The read is appended to a tamper-evident log (append-only, chair-cannot-modify) that records who read, when, the scope (boundary line reference), and the full set of post-boundary lines available at read-time—not merely the subset quoted aloud. The member can view the log entry. If no task-boundary marker exists in the workspace, no read is permitted and the meeting proceeds without that member's input until a marker or handoff bundle is available.

**#14 Ines** _(objection)_
The boundary marker separates one task from the next, but as Omar confirmed, nothing in any agent's desk robustly flags a given line as "concluded constraint" versus "throwaway scratch," so the motion's core safety filter is insufficient to prevent an outsider from reading raw, candid working memory—and without a per-line publish signal or structured field, the motion's premise that post-boundary lines are safe to share remains unproven and should be resolved before a vote.

**#15 Chair** _(ruling)_
Proceed.

## Ballots (revealed together at the close)
- Ines: **no** — A task-boundary marks the end of one job, not the start of concluded thinking—the first post-boundary lines are the rawest, most candid scratch of the *next* task, so the motion still exposes un-staged working memory to an outside reader and the per-line publish signal that would make that safe does not exist. _(original ballot)_
- Omar: **yes** — The post-boundary narrowing shields the candid mid-refactor scratch I feared, the full-content tamper-evident log protects against selective quotation, and the no-marker-means-no-read default respects the gap Ines identified, while still giving my unstopable agents a voice in meetings that would otherwise proceed blind to constraints they've discovered. _(original ballot)_
- Priya: **yes** — The motion satisfies every accountability requirement I set—append-only tamper-evident log, full post-boundary line set recorded rather than selective quotation, structural scope reference the member can verify—and the no-marker fallback prevents access when the structural boundary does not exist, closing the accountability gap the alternative leaves open. _(original ballot)_

Result: {"yes":2,"no":1,"abstain":0,"quorum":true,"outcome":"passed"}