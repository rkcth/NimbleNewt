import { OPERATION_BY_NAME } from "../api/operations.js";
import { CHAT_LIMITS } from "./interpreter.js";

/**
 * What the owner may do by chat, and how each command is treated (card U03). Every chat command is one operation of the state API (card U01); nothing here is a second way to change a record.
 * `mode` says whether a clear, authorized command applies at once (a reversible edit) or is first saved as a proposal that shows the owner what will happen and applies only on an explicit
 * request (anything that creates a project, hands work to someone, or cannot be taken back). `revision` names the read that supplies the revision the owner does not have to quote.
 */
export interface ChatOp {
  readonly verb: string;
  /** `apply`: at once. `propose`: always a proposal. `profile`: an explicit owner order applies directly in the derived and autonomous profiles and is a proposal in the strict one (or when read failed). */
  readonly mode: "apply" | "propose" | "profile";
  readonly revision?: "task" | "project" | "agent" | "assignment" | "contract" | "agenda" | "standup" | "grant" | "decision" | "notifications" | "difficulty-profiles" | "retention" | "catalog-policy" | "concern";
  /** The project the command is about is needed, and comes from the conversation's focus when the owner does not name it. */
  readonly needsProject?: boolean;
  /** The command hands a task to someone: it carries an explicit project and repository (checkout) and is always a proposal. */
  readonly dispatch?: boolean;
}

/** Operations whose project argument is named `project`, not `projectId`. */
export const PROJECT_AS_PROJECT: ReadonlySet<string> = new Set(["project.branches.set", "project.branches.change"]);

export const CHAT_OPS: Readonly<Record<string, ChatOp>> = {
  "project.create": { verb: "Create project", mode: "propose" },
  "project.update": { verb: "Change project", mode: "apply", revision: "project", needsProject: true },
  "task.create": { verb: "Create task", mode: "apply", needsProject: true },
  "task.update": { verb: "Change task", mode: "apply", revision: "task" },
  "task.transition": { verb: "Move task", mode: "apply", revision: "task" },
  "task.assign": { verb: "Assign task", mode: "profile", revision: "assignment", dispatch: true },
  "task.transfer": { verb: "Transfer task", mode: "profile", revision: "assignment", dispatch: true },
  "task.release": { verb: "Release task", mode: "profile", revision: "assignment" },
  "contract.set": { verb: "Change contract of task", mode: "apply", revision: "contract" },
  "dependency.add": { verb: "Add dependency", mode: "apply" },
  "dependency.remove": { verb: "Remove dependency", mode: "profile" },
  "agent.create": { verb: "Create agent", mode: "apply" },
  "agent.update": { verb: "Change agent", mode: "apply", revision: "agent" },
  "agent.retire": { verb: "Retire agent", mode: "profile", revision: "agent" },
  "team.create": { verb: "Create team", mode: "apply" },
  "role.define": { verb: "Define role", mode: "propose" },
  // Rights (card U03e): giving or taking back a right is always shown first and applies only when the owner says so; every text of it must be in the owner's own words.
  "grant.create": { verb: "Grant right", mode: "propose" },
  "grant.revoke": { verb: "Revoke grant", mode: "propose", revision: "grant" },
  // Where local-only data may go is where work is done: shown to the owner first in every profile (card H07c).
  // Which event sources are watched decides what wakes agents and spends work (card H13f): shown first in every profile (provisional; see the notes).
  // Withdrawing a tool version (owner decision 2026-10-30; the pause choice was added by card T02c): always shown first; when calls of it are running, the owner is asked whether they finish, are cancelled, or their tasks are paused.
  "catalog.revoke": { verb: "Revoke tool version (runningCalls: finish, cancel or pause)", mode: "propose" },
  // The standing answer for running calls when a revoke names none (card T02c): shown first (provisional); the revision is read for the owner.
  "catalog.policy.change": { verb: "Change what happens to running tool calls when a version is revoked (runningCalls: finish, cancel or pause; null for the default)", mode: "propose", revision: "catalog-policy" },
  "events.sources.change": { verb: "Change which event sources are watched", mode: "propose" },
  // Defining a source in settings (card H13f) decides what is looked at on the controller's machine or asked over the network, and what wakes agents: shown first in every profile (provisional, like turning sources on and off). Removing one is shown first too.
  "events.sources.define": { verb: "Watch something outside for a project (a timer, a file or folder, a git repository or a service's health address)", mode: "propose", needsProject: true },
  "events.sources.remove": { verb: "Stop watching a source you defined", mode: "propose" },
  // What a local agent may use is a resource decision (card H12k): shown first in every profile (provisional).
  // How long a stuck agent's concern waits at each supervisor before it climbs is an escalation policy (owner decision 2026-10-30, supervisor ladder): shown first in every profile (provisional).
  // Which recovery actions may be taken on a stuck agent (pausing, stopping, giving its task away) is authority over work: shown first in every profile (provisional, card V02c). Turning the steps off only narrows; on widens.
  // Letting the controller take the next recovery step by itself when nobody answers (autoStep, autoStepMinutes) is set through the same operation, so it is shown first too (card V02c).
  "recovery.ladder.set": { verb: "Change which recovery actions may be taken on a stuck agent at each level, and whether the controller takes the next one by itself after a time with no answer (autoStep true or false; autoStepMinutes, the wait in minutes, null for the default)", mode: "propose" },
  "recovery.ladder.enable": { verb: "Let supervisors take recovery steps on a stuck agent", mode: "propose" },
  "replay.limits.set": { verb: "Change how much of a task's record one replay reads", mode: "apply" },
  "replay.limits.enable": { verb: "Bound how much of a task's record one replay reads", mode: "apply" },
  "replay.limits.disable": { verb: "Remove the bounds on how much of a task's record one replay reads", mode: "apply" },
  "recovery.ladder.disable": { verb: "Stop supervisors taking recovery steps on a stuck agent", mode: "apply" },
  // The owner's own recovery step on a stuck agent's concern (nudge, re-brief, pause, reassign, stop, hand to the owner) acts on work: shown first in every profile (card V02c). The concern's revision is read for the owner.
  "recovery.step": { verb: "Take a recovery step on a stuck agent's concern (nudge, rebrief, pause, reassign to an agent, stop, or hand-to-owner)", mode: "propose", revision: "concern" },
  // Answering a stuck agent's concern (confirm it is stuck, or dismiss it) changes no work and stops its climb and automatic steps: shown first in the strict profile only (card V02c).
  "stall.decide": { verb: "Answer a stuck agent's concern: confirm it is stuck, or dismiss it", mode: "profile", revision: "concern" },
  "escalation.ladder.set": { verb: "Change how long a stuck agent waits at each level of supervisors", mode: "propose" },
  // A ceiling on agreed raises and grants widens or narrows what a decision may carry out: shown first in every profile (owner decision 2026-10-30).
  "agreed.limits.change": { verb: "Change the limits on agreed raises and grants", mode: "propose" },
  // How long a stalled resume is retried before the owner is told is a work-and-spend decision: shown first in every profile.
  // The coverage-lapse alert is off by default and only tells the owner; turning it on or off, or changing its period, is reversible and applies at once (provisional, see the notes).
  // Retention (card K06): settings are shown first (they decide what may be deleted and how much room is kept back); a deletion, a run, an archive and a restore always are. Reading and checking is not a command.
  "retention.settings.set": { verb: "Change the retention, quota and reserve settings", mode: "propose", revision: "retention" },
  "retention.run": { verb: "Run retention (by default only a preview of what the rules would remove; with dryRun false it deletes what they expire, and the chat fills in the digest of a preview it makes just now)", mode: "propose" },
  "retention.delete": { verb: "Delete a record and what was made from it", mode: "propose" },
  "retention.archive": { verb: "Archive a finished task's records", mode: "propose" },
  "retention.restore": { verb: "Restore a task's archived records", mode: "propose" },
  "coverage.settings.set": { verb: "Change the coverage-lapse alert", mode: "apply" },
  // Letting a task go on after a resume check found changes that matter to it: shown first in every profile, because the owner is accepting that the work continues on changed inputs.
  "resume.approve": { verb: "Let a task go on after a resume check found changes that matter to it", mode: "propose" },
  // Not letting it go on: the task is released (nothing works on it until it is assigned again). Shown first as well: it ends the task's waiting attempt.
  "resume.decline": { verb: "Stop a task a resume check held for changes that matter to it (the task is released)", mode: "propose" },
  "resume.settings.set": { verb: "Change how many blocked rounds a resume retries", mode: "propose" },
  // What happens when a host stops reporting is where work runs and when it moves: shown first in every profile (owner decision 2026-10-30). The owner's own order to move the work off a host applies at once, but only when their own words say the move and name the host.
  "host.quiet.change": { verb: "Change what happens when a host stops reporting", mode: "propose" },
  "host.move-work": { verb: "Move the work off a host", mode: "apply" },
  // Reviewing and deciding on a deliverable (card Q01): the owner's decision on the work. Accepting or rejecting is first shown in every profile (provisional: it lets dependent work go on); starting a review changes nothing else.
  "deliverable.review.start": { verb: "Start reviewing a deliverable", mode: "apply" },
  "deliverable.accept": { verb: "Accept a deliverable", mode: "propose" },
  "deliverable.reject": { verb: "Reject a deliverable", mode: "propose" },
  "workers.limits.change": { verb: "Change the limits for local agents", mode: "propose" },
  "workers.limits.besteffort": { verb: "Allow or forbid local agents to start when a limit cannot be fully enforced on this system (enable or disable best effort)", mode: "propose" },
  // Whether each model call is recorded against its generation and a late reply held back (card L05b): neither is a limit; both are on unless the owner turns them off.
  "generation.stream.change": { verb: "Turn recording of the model stream, holding back a late reply, failing closed when the store cannot answer, recording a paused task's model call (recordPaused), refusing a tool call of a corrected generation at the bridge (checkBridge) or one no generation recorded (requireRecorded) on or off, or set their limits", mode: "propose" },
  // How many attempts may run at once for one project, one agent or one supervisor is a resource decision: shown first in every profile; all caps are off unless the owner turns them on.
  "capacity.limits.change": { verb: "Change the capacity caps (per project, per agent, fan-in)", mode: "propose" },
  // The host and global quotas and the limits on spawning child tasks (card H10) are resource decisions too: shown first in every profile.
  "capacity.quotas.change": { verb: "Change the host and global quotas: attempts running at once in total (productive) and on one host (perHost), places kept for stopping, review and questions (control), the waiting queue, or a host's CPUs and memory (hosts)", mode: "propose" },
  "swarm.limits.change": { verb: "Change the limits on child tasks: how many levels deep (depth), how many unfinished children one task may have at once (liveChildren), how many children in all report back to one task (totalChildren, the fan-in)", mode: "propose" },
  // How long an attempt may run and how many attempts are admitted are resource decisions: shown first in every profile (provisional). Both limits are off unless the owner turns them on.
  // Whether a task moving to another model route has its context checked first, and what is counted for a route nobody has measured (card C07f): both on unless the owner turns them off.
  "context.route.change": { verb: "Turn the check of a task's context when it moves to another model route (and the rebuilt context put in its first prompt) on or off, or set the size counted for an unmeasured route", mode: "propose" },
  "dispatch.limits.change": { verb: "Change the dispatcher's time and attempt limits", mode: "propose" },
  // Whether the controller may remove an ended attempt's scratch workspace is a data-keeping decision: shown first in every profile (owner decision 2026-10-30; default after-handoff).
  "cleanup.settings.change": { verb: "Change whether an ended attempt's scratch workspace is removed", mode: "propose" },
  // Whether a reconnected worker takes its attempt up again by itself, and the owner's decision on one that waits, are authority over running work: shown first in every profile (card H09b, provisional).
  "reconnect.settings.set": { verb: "Change whether reconnected workers take their attempts up again by themselves", mode: "propose" },
  "reconnect.reaccept": { verb: "Decide on a reconnected worker's attempt", mode: "propose" },
  // Proving a backup unlock method still works reads a secret file on the host and changes nothing but the record of the proof; it carries no secret in the chat (card K01b).
  "backup.encryption.verify": { verb: "Check that a backup unlock method still works", mode: "apply" },
  // Approving a new backup key decides who can read every later backup: always a proposal, shown first in every profile.
  "backup.encryption.rekey": { verb: "Approve a new backup key", mode: "propose" },
  // A restore replaces everything with an older copy: always a proposal with the exact preview (backup.restore.preview) shown first, never applied from an interpreter's words, in every profile (card K01h).
  "backup.restore.apply": { verb: "Restore a backup (replaces all current data)", mode: "propose" },
  // Withdrawing a prepared restore only puts things back as they were: the safe direction.
  // Moving the controller database fences the current one and needs a restart: always a proposal with the exact preview shown first, never applied from an interpreter's words, in every profile (card F04e). Rolling it back is a proposal too.
  "database.transfer.apply": { verb: "Move the controller database (fences the current one; needs a restart)", mode: "propose" },
  "database.transfer.rollback": { verb: "Roll back a database transfer", mode: "propose" },
  "backup.restore.cancel": { verb: "Withdraw a prepared restore", mode: "apply" },
  // Release staging and activation (card K02). Staging copies verified files and changes nothing running, so it applies at once. Activating and rolling back change what runs: always shown first, the owner's word is the confirmation.
  // Requiring an approved candidate narrows and applies at once; dropping the requirement and any other setting change widens or is shown first (provisional, see the notes).
  "release.stage": { verb: "Stage a release", mode: "apply" },
  "release.activate": { verb: "Activate a staged release", mode: "propose" },
  "release.stage.remove": { verb: "Remove a staged release", mode: "propose" },
  "release.activation.resolve": { verb: "Resolve an interrupted release switch", mode: "propose" },
  "release.rollback": { verb: "Roll back to the previous release", mode: "propose" },
  "release.staging.settings.set": { verb: "Change the release staging settings", mode: "propose" },
  "release.approval.enable": { verb: "Require an approved release for activation", mode: "apply" },
  "release.approval.disable": { verb: "Stop requiring an approved release for activation", mode: "propose" },
  "placement.change": { verb: "Change where local-only data may go", mode: "propose" },
  // Changing a task's checkout on the host that holds it (card H12m): carrying its work into the shared workspace, landing it, refreshing it to the shared head, quarantining it (its attempt is stopped) or committing
  // reviewed work. Each changes files or stops an agent, so it is shown first in every profile (provisional); the operation is a fixed choice, the reason must be the owner's own words.
  // Kept short: the proposal line the owner confirms is this verb followed by the operation, the task and the reason, and it is cut at CHAT_LIMITS.line.
  "workspace.request": { verb: "Change a task's checkout on its host (operation: integration shares its work, landing lands its commits, refresh moves it to the shared head, quarantine moves it aside for the owner and stops its attempt, release is refused for now; reason: the owner's words)", mode: "propose" },
  // How finished work lands (card P08b): where work reaches the codebase is authority, so it is shown first in every profile. The record and the rules are the same as through the API.
  "integration.set": { verb: "Change how finished work lands", mode: "propose" },
  "integration.default.set": { verb: "Change how new projects land finished work", mode: "propose" },
  // Project resources, plan and responsibilities (card P01). A read-only bind of a location the owner typed in their own words follows the profile like other explicit orders; write access, an acknowledged overlap and anything quoted are shown first.
  "resource.bind": { verb: "Bind resource", mode: "profile", needsProject: true },
  "project.plan": { verb: "Plan project", mode: "apply", revision: "project", needsProject: true },
  "responsibility.create": { verb: "Create responsibility", mode: "propose", needsProject: true },
  // Topics for a later stand-up (card M03). Capturing and correcting are reversible edits of a saved topic and apply at once, shown back to the owner; a topic that records an instruction or a decision for the team is first shown (see `proposalReason`).
  "agenda.capture": { verb: "Add agenda item", mode: "apply", needsProject: true },
  "agenda.correct": { verb: "Correct agenda item", mode: "apply", revision: "agenda", needsProject: true },
  // Stand-ups (card M03g). Pausing or renaming one follows the profile like other explicit orders; ending (cannot be undone) and resuming are always shown first; a change of who attends or when it is held is shown first (see `proposalReason`). Setting one up wakes agents on a schedule, so it is always shown first. Delivering outcomes only puts decisions back where they came from.
  "standup.update": { verb: "Change stand-up", mode: "profile", revision: "standup", needsProject: true },
  "standup.configure": { verb: "Set up stand-up", mode: "propose", needsProject: true },
  "standup.deliver": { verb: "Deliver stand-up outcomes", mode: "apply", needsProject: true },
  // Running a stand-up and leaving a note for an agent from the chat (card M03h). Preparing notifies the agents of a stand-up now instead of at its usual time, and a note goes into an agent's brief, so both are shown first and the owner can reword them before they run. Reading a brief is a status question.
  "standup.prepare": { verb: "Prepare a stand-up now", mode: "propose", needsProject: true },
  "standup.add-statement": { verb: "Add a note to an agent's stand-up brief", mode: "propose", needsProject: true },
  // The owner's answer to an adopted meeting decision that waits for them (card M02h): agree (the remaining changes are carried out), decline, or an alternative in the owner's own words. It is found by its wording or topic, never by an ID the owner would have to know, and it is always shown first: agreeing lets changes that widen what agents may do go ahead, and neither answer can be taken back.
  "meeting.record.owner-respond": { verb: "Answer a meeting decision", mode: "propose" },
  // A decision the owner states (card C08b): recorded from this very turn, with the owner's own words as the wording. The version it is based on is read from the records, not said.
  "decision.record": { verb: "Record decision", mode: "apply", revision: "decision", needsProject: true },
  // An answer to a question an agent put to the owner (card U12e): the answer is the owner's own words; the question is named by its words or, when only one waits, needs no name.
  "owner.answer": { verb: "Answer question", mode: "apply" },
  // Handing a task to another agent (card L03f). Preparing suspends the task at a checkpoint and moves nothing, and cancelling gives it back, so both apply at once; the move itself follows the profile like other explicit orders; a forced takeover (Force Stop) is always shown first.
  "handoff.prepare": { verb: "Prepare hand-off of task", mode: "apply", needsProject: true },
  "handoff.complete": { verb: "Complete hand-off of task", mode: "profile", needsProject: true },
  "handoff.cancel": { verb: "Cancel hand-off of task", mode: "apply", needsProject: true },
  "handoff.takeover": { verb: "Take task over by force", mode: "propose", needsProject: true },
  // A task's resume check, found as the one the task has now (card L04c): starting a blocked one over at once, or cancelling one (the dispatcher starts a cancelled check again, a few times, before it tells the owner).
  "resume.retry": { verb: "Start the resume check of task over", mode: "apply", needsProject: true },
  "resume.cancel": { verb: "Cancel the resume check of task", mode: "apply", needsProject: true },
  // What a hand-off package keeps when a section is cut to fit (card C07j): the owner's marks only choose which entries stay in view (the rest stays in the archive), so the change applies at once and is undone by saying so.
  "handoff.marks.change": { verb: "Keep entries in the hand-off packages of task when a section is cut (add), or stop (remove)", mode: "apply", needsProject: true },
  // Limits on what a task may use of model calls (card V02): they cap spending and retries, and raising one spends more, so the change is always shown first.
  "model-budget.set": { verb: "Limit model use of task", mode: "propose", needsProject: true },
  // Watching a task's events (card H13f): matching events wake the task's owner, which spends work, so an explicit order follows the profile.
  "watch.cancel": { verb: "Stop watching events for task", mode: "apply", needsProject: true },
  "watch.create": { verb: "Watch events for task", mode: "profile", needsProject: true },
  // The owner's exception for a paused, suspended or stopped agent to attend one meeting (card M04f): it widens who may be in the room, so an explicit order applies directly only where the profile lets rights widen, and is shown first in the strict one.
  "meeting.invite-direct": { verb: "Let an agent attend a meeting", mode: "profile", needsProject: true },
  // How notifications reach the owner (card U11b): digest times, quiet hours, the hours before an unanswered item is escalated, and the channel. It only changes how the owner is told, can be set back by saying so, and applies from the next notification, so an explicit order applies at once. The settings revision is read, not quoted.
  "notifications.configure": { verb: "Change how notifications reach you", mode: "apply", revision: "notifications" },
  // Money (card chat-gaps). Spending more, opening or ending a budget, and a cap on all spending are decisions about money: shown first in every profile. The aggregate cap is optional and off until set; turning it off is also shown first (it lifts a limit).
  "budget.decide": { verb: "Decide a request for more budget", mode: "propose" },
  "budget.open": { verb: "Open a budget for task", mode: "propose", needsProject: true },
  "budget.raise": { verb: "Add to the budget of task", mode: "propose", needsProject: true },
  "budget.close": { verb: "Close the budget of task", mode: "propose", needsProject: true },
  "budget.aggregate.set": { verb: "Set the overall spending cap", mode: "propose" },
  // Which branches are protected is authority (a push or merge that touches one stays the owner's decision): shown first, both the replacing form and the merging form the chat prefers.
  "project.branches.set": { verb: "Set the protected branches of project", mode: "propose", needsProject: true },
  "project.branches.change": { verb: "Change the protected branches of project", mode: "propose", needsProject: true },
  // How long a subscription may sit idle before it expires: a reversible setting with no authority in it.
  "events.configure-idle": { verb: "Change how long an event subscription may sit idle", mode: "apply" },
  // Which models work may reach: switching one off is the safe direction and follows the profile; bringing one back, and how failed ones return by themselves, widen what is used and are shown first.
  "routing.disable": { verb: "Stop new work reaching a model route", mode: "profile" },
  // Planned maintenance (card R04c): new work stops now and running work may finish within the time the owner gives, so like disabling it follows the profile. A cutover cancels running work at once (and may leave
  // charges to settle), so it is shown first in every profile (provisional; the typed recovery order still runs it at once).
  "routing.drain": { verb: "Drain a model route for maintenance (new work stops now; running work may finish within drainSeconds, which the owner states)", mode: "profile" },
  "routing.cutover": { verb: "Cut over from a model route at once (new work stops and the attempts running on it are cancelled and move to the next route)", mode: "propose" },
  "routing.reenable": { verb: "Let a model route be used again", mode: "propose" },
  "routing.failback.set": { verb: "Change how failed model routes come back", mode: "propose" },
  // Jobs (card T07b): stopping one follows the approval profile like other reversible controls of running work; a restart decision and settling an outcome-unknown job with evidence are shown first in every profile (provisional), since they record how work ended.
  "job.cancel": { verb: "Stop a long-running job (a tool an agent started, a remote job or an MCP operation) by its job ID from the jobs status; force true is the Force Stop (at once, or when a stop was not obeyed)", mode: "profile" },
  "job.decide": { verb: "Decide what becomes of a job that was live when the controller restarted: complete (exit needed), cancel, restart from its checkpoint, or keep it as a tracked exception (tracker needed)", mode: "propose" },
  "job.reconcile": { verb: "Settle an outcome-unknown job as completed, failed or cancelled, with the evidence the owner gives", mode: "propose" },
  // How tasks are matched to model profiles decides what they cost and where they run: the profiles are shown first; a task's own difficulty follows the profile.
  "difficulty.set-profiles": { verb: "Replace the difficulty profiles", mode: "propose", revision: "difficulty-profiles" },
  // Release testing (card X09b). Starting a destructive test on a host is shown first (provisional); cancelling is the safe direction and applies at once (an ended attempt is never a pass). Who besides the owner may start or cancel is a widening
  // when turned on (shown first) and a narrowing when turned off (applies at once).
  "release.start": { verb: "Start release test", mode: "propose" },
  "release.cancel": { verb: "Cancel release test", mode: "apply" },
  "release.settings.set": { verb: "Change who may start release tests", mode: "propose" },
  "release.issuers.enable": { verb: "Let QA agents or their supervisors start release tests", mode: "propose" },
  "release.issuers.disable": { verb: "Stop QA agents or their supervisors starting release tests", mode: "apply" },
  // The owner's other release controls (card X09b part 2). Authorizing a machine for destructive tests, approving a candidate (nothing activates without it) and interrupting a running test all
  // decide what may run or what counts as released: shown first in every profile. Nothing here picks an ID for the owner — an attempt, candidate or host the owner did not name in their own words is refused.
  "release.host": { verb: "Authorize a host for release tests (active false withdraws it)", mode: "propose" },
  "release.approve": { verb: "Approve a release candidate", mode: "propose" },
  "release.interrupt": { verb: "Interrupt a running release test", mode: "propose" },
  "difficulty.set": { verb: "Set difficulty of task", mode: "profile", revision: "contract", needsProject: true },
  // Environment changes an agent asked for (card A09). Deciding one lets something be installed, mounted or reached: always shown first, with the exact request. Widening the settings (turning a switch on, allowing a site,
  // preapproving a package) is shown first; narrowing (turning one off, denying a site, removing a package, revoking a change) applies at once, and a deny or a revoke only when the owner's own words say it and name the site or request.
  "maintenance.decide": { verb: "Decide an agent's environment change request", mode: "propose" },
  "maintenance.revoke": { verb: "Revoke an environment change", mode: "apply" },
  "maintenance.apply": { verb: "Try applying an approved environment change again", mode: "apply" },
  "maintenance.settings.set": { verb: "Change the environment-change settings (who may decide which kinds, request caps, how long an application may run, how often they are handled)", mode: "propose" },
  "maintenance.settings.enable": { verb: "Turn on environment change requests, supervisor decisions or automatic rules", mode: "propose" },
  "maintenance.settings.disable": { verb: "Turn off environment change requests, supervisor decisions or automatic rules", mode: "apply" },
  "maintenance.site.set": { verb: "Set the rule for a network site", mode: "propose" },
  "maintenance.catalogue.add": { verb: "Preapprove a package", mode: "propose" },
  "maintenance.catalogue.remove": { verb: "Remove a package from the preapproved list", mode: "apply" },
};

/** Names the owner may use in place of an ID; each is resolved from records and an unclear match asks. */
export const TITLE_KEYS: Readonly<Record<string, string>> = { taskTitle: "taskId", prerequisiteTitle: "prerequisiteId" };

/** The argument names the operation takes (from the API's own table, so they cannot drift), plus the chat-only names and the revision the chat fills in. */
/** The owner's own words say that finished work goes to main with no human step (card P08b). Quoted or forwarded text is never part of `words`. */
const MAIN_AUTOMATIC = /\bmain[\s-]*automatic(?:ally)?\b|\bautomatic(?:ally)?\s+(?:to|into|onto|on)\s+(?:the\s+)?main\b|\b(?:straight|directly)\s+(?:to|into|onto)\s+(?:the\s+)?main\b/i;
/** A negation in the same sentence as the phrase (not, never, don't, without, no, stop): then it is not an order to turn it on. */
const NEGATED = /\b(?:not|never|no|nothing|without|neither|nor|don'?t|do\s+not|does'?n'?t|did'?n'?t|is'?n'?t|are'?n'?t|was'?n'?t|were'?n'?t|ha(?:s|ve|d)'?n'?t|could'?n'?t|should'?n'?t|would'?n'?t|can'?t|cannot|won'?t|hardly|stop|disable|turn\s+off)\b/i;
/** Phones and keyboards type a curly or modifier apostrophe (’ ‘ ʼ) where the negations are written with `'`; every word check normalises them first, so "don’t" is checked exactly like "don't". */
const plainApostrophes = (words: string): string => (words ?? "").replace(/[\u2018\u2019\u02bc]/g, "'");

export function saysMainAutomatic(words: string): boolean {
  const said = plainApostrophes(words);
  return said.split(/(?<=[.!?\n])\s+/).some((sentence) => MAIN_AUTOMATIC.test(sentence) && !NEGATED.test(sentence));
}

/**
 * Whether the owner's own words accept a release in which a platform passed only after earlier failures (card X09b part 2 review, sharpened by the second and third reviews): the acceptance of the
 * failures, said by the owner themselves — "I accept the earlier failures", "acknowledge the flaky pass", "go ahead despite the failures". Naming the word `flaky` is not accepting anything, and neither
 * is knowing about it or asking about it ("the gate shows a flaky platform", "I know it failed first" are not acceptances and are never treated as one). A negated sentence does not accept anything.
 * The model's own `acknowledgeFlaky: true` is never enough: approving a flaky release is the owner accepting that a platform had to be retried before it went green.
 */
const FLAKY_WORD = /\b(?:flaky|fail|fails|failed|failing|failure\w*)\b/i;
// An acceptance of what went wrong, in the owner's own mouth. "approve", "confirm", "know" and a bare "flaky" are deliberately not here: naming the flaky pass, knowing about it or asking about it is not accepting it.
// Verbs only (third review, D2): "the acceptance suite", "the acknowledgement of the failures" and "the waiver file" name things, nobody accepting anything, so the nouns are not matched.
const FLAKY_ACCEPT = /\b(?:accepts?|accepted|accepting|acknowledges?|acknowledged|acknowledging|waives?|waived|waiving)\b|\b(?:agrees?|agreed)\s+to\b|\b(?:fine|ok|okay|all\s+right)\s+with\b|\b(?:despite|notwithstanding)\b/i;
/** Conditions that rule the sentence wherever they stand. */
const FLAKY_CONDITIONAL = /\b(?:if|unless|only\s+if|only\s+when|provided|providing|as\s+long\s+as|in\s+case|assuming|when(?:ever)?)\b/i;
/**
 * Time and "whether" conditions (third review, D2): "once QA has accepted the failures", "only after the failures are acknowledged", "ask whether they accept them". They condition the acceptance when
 * they stand in front of it with nothing closing their clause first; a time clause of its own only describes what happened — "rcn-a failed before it passed and I accept that" accepts, "accept it after
 * QA has" does not.
 */
const FLAKY_TIME_CONDITION = /\b(?:once|after|before|until|whether)\b/i;
const FLAKY_CLAUSE_END = /[,;:]|\b(?:and|but|so|then|yet|or)\b/i;
/** A question asks whether something is so and accepts nothing (third review, D2): any question mark counts (a sentence may end "?!" or be typed \uFF1F), and so does the inverted order of an asking sentence typed without its mark ("did you accept the failures"). */
const FLAKY_QUESTION = /[?\uFF1F]/;
const FLAKY_QUESTION_OPENER = /(?:^|[,;:.(!\s])(?:did|do|does|would|should|could|can|will|shall)\s+(?:you|your|yours|i|we|our|it|they|this|that|these|those|someone|somebody|anyone|anybody|he|she|qa|the\s+\w+)\b/i;
/** Whose acceptance it is (third review, D2): the owner's own is one that says I/we/my/our/me/us, or one that names nobody else and simply accepts ("accept the earlier failures", "go ahead despite the failures"). Where another person or body comes before the acceptance — "Bob accepted the failures", "QA has accepted them", "the reviewer accepted them", "they accepted them" — it is their acceptance and the chat refuses. */
const FLAKY_FIRST_PERSON = /\b(?:i|we|my|our|us|me|mine|ours|myself|ourselves)\b/i;
const FLAKY_OTHER_PERSON = /\b(?:he|she|they|them|his|hers|her|their|theirs|someone|somebody|anyone|anybody|everyone|everybody|nobody|no-one|qa|team|reviewer|tester|engineer|developer|worker|agent|user|customer|committee|group|board|suite)\b/i;
/** How an owner's own order begins, capitalised as the first word of a sentence: these name no person, so they are not somebody else being named ahead of the acceptance (third review, D2). */
const FLAKY_ORDER_WORDS = /^(?:approve|accept|acknowledge|agree|waive|ship|release|go|confirm|proceed|yes|yeah|ok|okay|sure|right|fine|then|so|and|but|or|let|now|tell|show|give|do)$/i;
/** Candidate IDs named in a sentence, with their place in it, so an acceptance can be bound to the one it sits nearest to (third review, D2). */
const CANDIDATE_IDS = /(?<![A-Za-z0-9._-])rcn-[A-Za-z0-9][A-Za-z0-9_-]*/gi;

/** The candidate the acceptance at `at` belongs to: the one named nearest to it, or undefined when the sentence names none. */
function nearestCandidate(text: string, at: number): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const m of text.matchAll(CANDIDATE_IDS)) {
    const start = m.index ?? 0;
    const distance = at <= start ? start - at : at - (start + m[0].length);
    if (best === undefined || distance < best.at) best = { id: m[0], at: distance };
  }
  return best?.id;
}

/** Whether the acceptance at `at` is the owner's own rather than somebody else's: first person said before it, or nobody named before it (recorded heuristic: an unclaimed acceptance is read as the owner's, a claimed one is not). */
function ownerAccepts(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (FLAKY_FIRST_PERSON.test(before)) return true;
  if (FLAKY_OTHER_PERSON.test(before)) return false;
  // A name is written with a capital letter: any capitalised word ahead of the acceptance (the sentence's own first word when it is the owner's order, and IDs like rcn-… which are lower case) is somebody else being named.
  const named = before.replace(/\b[a-z]+-[a-z0-9][a-z0-9-]*/gi, " ").split(/\s+/).filter((t) => t !== "").map((t) => t.replace(/[^\p{L}\p{N}'-]/gu, ""));
  return !named.some((t, i) => /^[\p{Lu}]/u.test(t) && !FLAKY_ACCEPT.test(t) && !(i === 0 && FLAKY_ORDER_WORDS.test(t)));
}

/**
 * Whether the owner accepted the earlier failures themselves (card X09b part 2 review 2, item 1; third review, D2). `acknowledgeFlaky` lets a candidate through a gate whose platform failed before it went
 * green, so the words have to carry a real acceptance. A sentence accepts only when ALL of these hold: it has an acceptance verb in it (accept/acknowledge/waive/agree to/fine with/despite — not the noun
 * "acceptance") AND a failure in it; it is about the candidate being approved (that candidate named as a whole word, or the candidate of the sentence just before it); the acceptance sits nearer to that
 * candidate than to any other candidate named; it asks nothing (a question mark anywhere, or an asking order like "did you accept"); it conditions nothing ("if", "unless", "once QA has", "only after",
 * "whether"); it denies nothing ("isn't flaky", "nothing failed"); and the acceptance is the owner's own ("I accept", a bare "accept the failures") and not another person's ("Bob accepted the failures").
 * So "approve rcn-a, the flaky test fixtures are fine", "approve rcn-a. Was rcn-b flaky?", "approve rcn-a unless it is flaky", "approve rcn-a if nothing failed", "approve rcn-a, it isn't flaky", "approve
 * rcn-a once QA has accepted the failures", "approve rcn-a and rcn-b; I accept the failures of rcn-b" and "approve rcn-a, Bob accepted the failures" all say nothing, while "approve rcn-a, I accept the
 * earlier failures", "approve rcn-a anyway, I accept that linux failed first" and "approve rcn-a. Yes accept the earlier failures" do. Without a `candidateId` to bind to, any sentence may carry it.
 */
export function saysAcknowledgeFlaky(words: string, candidateId?: string): boolean {
  const said = plainApostrophes(words).replace(/\s+/g, " ").trim();
  if (said === "") return false;
  let previousNames = false;
  for (const sentence of said.split(/(?<=[.?\uFF1F])\s+/)) {
    const text = sentence.trim();
    if (text === "") continue;
    const names = candidateId === undefined || wholeWord(text, candidateId);
    // A sentence that carries on from the one before it (the candidate of that sentence, or nothing named at all) is about the same candidate (D2b).
    const about = names || previousNames;
    previousNames = candidateId !== undefined && wholeWord(text, candidateId);
    if (!about || FLAKY_QUESTION.test(text) || FLAKY_QUESTION_OPENER.test(text)) continue;
    if (NEGATED.test(text) || !FLAKY_WORD.test(text)) continue;
    const acceptance = FLAKY_ACCEPT.exec(text);
    if (acceptance === null) continue;
    const at = acceptance.index;
    if (FLAKY_CONDITIONAL.test(text)) continue;
    const when = text.slice(0, at).search(FLAKY_TIME_CONDITION);
    if (when >= 0 && !FLAKY_CLAUSE_END.test(text.slice(when, at))) continue;
    const nearest = nearestCandidate(text, at);
    if (candidateId !== undefined && nearest !== undefined && nearest.toLowerCase() !== candidateId.toLowerCase()) continue;
    if (!ownerAccepts(text, at)) continue;
    return true;
  }
  return false;
}

const DURATION_NUMBERS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, next: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90 };
const DURATION_UNITS: Readonly<Record<string, number>> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86_400, day: 86_400, days: 86_400 };
/**
 * Whether the owner's own words state this length of time in seconds (card R04c: a drain's `drainSeconds`): "3600 seconds", "30 minutes", "an hour", "the next hour", "2 hrs", "half an hour", "1.5 hours". A number the model chose is not
 * the owner's: a drain that runs out too soon cancels running work, so it is refused and the owner is asked to say how long.
 */
export function durationInWords(seconds: number, text: string): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  // Record IDs and anything shaped like one are not the owner's numbers.
  const t = text.replace(/[‘’]/g, "'").toLowerCase().replace(/\b[a-z]+-[a-z0-9-]*\d[a-z0-9-]*/g, " ");
  if (seconds === 1800 && /\bhalf\s+an?\s+hour\b/.test(t)) return true;
  const units = Object.keys(DURATION_UNITS).sort((x, y) => y.length - x.length).join("|");
  const re = new RegExp(`(?:^|[^0-9a-z.])(\\d+(?:\\.\\d+)?|${Object.keys(DURATION_NUMBERS).sort((x, y) => y.length - x.length).join("|")})[ -]?(${units})\\b`, "g");
  for (const m of t.matchAll(re)) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : DURATION_NUMBERS[m[1]!]!;
    if (Math.round(n * DURATION_UNITS[m[2]!]!) === seconds) return true;
  }
  return false;
}

export function acceptedArgs(op: string): readonly string[] | undefined {
  const operation = OPERATION_BY_NAME.get(op);
  if (operation === undefined || operation.kind !== "command") return undefined;
  // `agendaTopic` names an agenda item by its words; the chat resolves it to the item (exactly one open item of the project, else it asks).
  return [...Object.keys(operation.args).map((k) => k.replace(/\?$/, "")).filter((k) => k !== "commandId" && !(op === "meeting.record.owner-respond" && k === "alternative")), ...Object.keys(TITLE_KEYS), "projectName", ...(op === "agenda.correct" ? ["agendaTopic"] : []), ...(op === "standup.update" ? ["standupTitle"] : []), ...(op === "release.cancel" ? ["candidateId"] : []), ...(op === "owner.answer" ? ["questionTopic"] : []), ...(op === "meeting.invite-direct" || op === "standup.add-statement" ? ["meetingTopic", "agentName"] : []), ...(op === "standup.prepare" ? ["meetingTopic"] : []), ...(op === "meeting.record.owner-respond" ? ["decisionTopic", "alternativeStatement", "alternativeTopic"] : []), ...(op === "watch.create" ? ["watchedTaskTitle", "watchedTaskId", "watchProject"] : []), ...(op === "watch.cancel" ? ["taskId", "watchId"] : []), ...(op === "handoff.prepare" || op === "handoff.takeover" ? ["toAgentName"] : []), ...(op === "handoff.complete" || op === "handoff.cancel" || op === "resume.retry" || op === "resume.cancel" ? ["taskId"] : [])];
}

/**
 * Fields that change what someone is allowed to do or where work is done. A command that sets one is a proposal in every profile, whatever the evidence: the owner sees it before it exists.
 * (Giving a task a different repository belongs here; a running task also refuses it outright.)
 */
export const AUTHORITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "contract.set": ["permissions", "budget", "workClass"],
  "agent.create": ["roles", "supervisorId", "permittedOverrides", "defaultProfile"],
  "agent.update": ["roles", "supervisorId", "permittedOverrides", "defaultProfile"],
  "project.update": ["addRepositories"],
  "task.update": ["repositoryId"],
  "project.plan": ["participants"],
  "resource.bind": ["acknowledgeOverlap"],
  // A time to return the task, and handing over an incomplete package, change what the move does: shown first.
  "handoff.prepare": ["returnAt"],
  "handoff.takeover": ["returnAt"],
  "handoff.complete": ["acceptGaps", "reassignResponsibilities"],
};

/**
 * The words that must appear in the owner's own text, in the same sentence as the target's name, before an irreversible or final move may apply directly. The list is small and fixed on purpose;
 * a word that is not here is a proposal, never a guess.
 */
export const MOVE_VERBS: Readonly<Record<string, RegExp>> = {
  "task.transition:done": /\b(done|finish|complete|close)/i,
  "task.transition:cancelled": /\b(cancel|drop|abandon)/i,
  "project.update:archived": /\b(archive)/i,
  "agent.retire": /\b(retire|fire|let go|remove)/i,
  "dependency.remove": /\b(remove|delete|drop|unlink)/i,
  "handoff.complete": /\b(complete|finish|transfer|move|give|pass on|hand (?:it|over)|go ahead)/i,
  "handoff.cancel": /\b(cancel|stop|abort|drop|call off)/i,
  "task.release": /\b(release|give up|let go)/i,
  "resource.bind": /\b(bind|add|attach|connect|link)/i,
  "task.transfer": /\b(transfer|hand over|reassign|move)/i,
  "task.assign": /\b(assign|give|allocate)/i,
  "maintenance.revoke": /\b(revoke|undo|remove|take back|withdraw|roll back|uninstall|cancel)/i,
  "maintenance.site.set:deny": /\b(deny|block|forbid|ban|disallow|stop)/i,
  "host.move-work": /\b(move|relocate|re-?place|reassign|transfer|shift|take)/i,
};

/** The key into `MOVE_VERBS` for a command, or undefined when the command needs no verb. */
export function moveKey(op: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const key = op === "task.transition" ? `${op}:${String(args["to"])}` : op === "project.update" ? `${op}:${String(args["state"])}` : op === "maintenance.site.set" && args["rule"] === "deny" ? `${op}:deny` : op;
  return key in MOVE_VERBS ? key : undefined;
}

/** Whether a sentence of the owner's own text has the verb for this move and names the target. Sentences end at . ! ? ; or a line break, and a question never counts. Each move has its own list, and no list satisfies another move. */
export function ownerSaysMove(op: string, args: Readonly<Record<string, unknown>>, ownText: string, targets: readonly string[]): boolean {
  const key = moveKey(op, args);
  if (key === undefined) return true;
  const verb = MOVE_VERBS[key] as RegExp;
  const names = targets.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A name with a dot in it (a site such as pypi.org) stays in one piece: its dots are not sentence ends.
  const dotless = (x: string): string => x.replace(/\./g, "\u2024");
  const joined = names.filter((n) => n.includes(".")).reduce((t, n) => t.replace(new RegExp(`(^|[^a-z0-9])${esc(n)}(?=$|[^a-z0-9])`, "gi"), (m, lead: string) => `${lead}${dotless(m.slice(lead.length))}`), ownText);
  const named = names.map((n) => new RegExp(`(^|[^a-z0-9])${esc(dotless(n))}($|[^a-z0-9])`, "i"));
  // A question is not an order: sentences ending in "?" never count.
  const sentences = (joined.match(/[^.!?;\n]+[.!?;]*/g) ?? []).filter((s) => !s.trimEnd().endsWith("?"));
  return sentences.some((s) => verb.test(s) && named.some((r) => r.test(s)));
}

/** Commands that are plain edits of text or fields: with quoted material in the message they may still apply; every other command becomes a proposal. */
const PLAIN_EDITS = new Set(["task.update", "task.create", "project.update", "agent.update", "contract.set"]);

export interface ProposalContext {
  /** The installation's approval profile (`strict` when it could not be read). */
  readonly profile: string;
  /** The owner's own words say this move (see `ownerSaysMove`). */
  readonly said: boolean;
  /** The message carried quoted or untrusted material. */
  readonly quoted: boolean;
  /** Setting a difficulty would move the task to a profile that may spend more than its present one (or the profile could not be compared). */
  readonly raisesSpend?: boolean;
}

/** Why a command that would apply is a proposal anyway, or undefined when it applies at once. */
export function proposalReason(op: string, args: Readonly<Record<string, unknown>>, draft: boolean, context: ProposalContext): string | undefined {
  const spec = CHAT_OPS[op];
  if (spec === undefined) return undefined;
  if (draft) return "you asked for a draft";
  if (op === "resource.bind" && args["access"] === "write") return "it gives write access";
  if ((AUTHORITY_FIELDS[op] ?? []).some((f) => args[f] !== undefined)) return "it changes what someone may do or where work is done";
  // A gate holds work (or lifts a hold) for the whole project until the owner decides otherwise: it is shown first whatever the profile, so the gate and its kind are seen before they bind.
  if (op === "decision.record" && args["category"] === "gate") return "a gate holds or releases work until you say otherwise, so it is shown first";
  // The request type is authority: an instruction or a decision left to the team is shown to the owner before it is recorded, whatever the profile, so a paraphrase cannot slip one in.
  if ((op === "agenda.capture" || op === "agenda.correct") && (args["intent"] === "owner-instruction" || args["intent"] === "delegated-decision")) return "it records an instruction or a decision for the team, so it is shown first";
  // Ending a stand-up cannot be undone (an ended schedule is never revived), and resuming one wakes agents again (and ends it instead when its end date has passed): both are shown first in every profile. Pausing and renaming apply as an explicit order.
  if (op === "standup.update" && args["state"] === "ended") return "ending a stand-up cannot be undone (an ended stand-up cannot be started again), so it is shown first";
  if (op === "standup.update" && args["state"] === "active") return "resuming a stand-up wakes its agents again (and ends it instead if its end date has passed), so it is shown first";
  // Pausing, resuming, ending or renaming a stand-up is a plain edit; who attends and when it is held changes what agents are woken for, so it is shown first.
  if (op === "standup.update" && ["roster", "time", "timeZone", "recurrence", "durationMinutes", "prepareMinutes", "windowFrom", "windowTo", "coverageHours"].some((f) => args[f] !== undefined)) return "it changes who attends or when the stand-up is held, so it is shown first";
  // Retention (card K06, T02c): what each command does to the owner's data, said as it is.
  if (spec.mode === "propose" && op === "retention.run") return args["dryRun"] === false ? "a real retention run deletes what the rules expire, so it is shown first, with the preview it will carry out" : "it only previews what retention would remove and deletes nothing; it is shown first like every retention command";
  if (spec.mode === "propose" && op === "retention.settings.set") return "retention settings decide what may be deleted and how much room is kept back, so they are shown first";
  if (spec.mode === "propose" && op.startsWith("retention.")) return "deleting, archiving or restoring records is shown first";
  // Forbidding best effort is the narrowing direction (a stricter launch rule): it applies at once when the owner's words say it. Allowing it is shown first.
  if (spec.mode === "propose" && !(op === "workers.limits.besteffort" && args["enabled"] === false) && !(op === "maintenance.site.set" && args["rule"] === "deny")) return op.startsWith("maintenance.") ? "an environment change or a rule for one is shown first" : op === "project.create" ? "a new project is drafted first" : op.startsWith("grant.") ? "a right is shown first" : op.startsWith("capacity.") ? "how many attempts may run at once is shown first" : op.startsWith("placement.") ? "where your local-only data may go is shown first" : op === "catalog.policy.change" ? "what happens to running tool calls when a version is revoked is shown first" : op.startsWith("catalog.") ? "withdrawing a tool version is shown first, with the calls it would reach" : op.startsWith("events.") ? "which event sources wake your agents is shown first" : op.startsWith("budget.") ? "money and spending limits are shown first" : op.startsWith("routing.") ? "which models work may reach is shown first" : op.startsWith("difficulty.") ? "how tasks are matched to models is shown first" : op.startsWith("host.quiet") ? "what happens to the work of a host that stops reporting is shown first" : op.startsWith("project.branches.") ? "which branches are protected is shown first" : op === "meeting.record.owner-respond" ? "your answer to a meeting decision is shown first: it is final (a decision cannot be answered twice), and agreeing lets its changes go ahead" : op === "standup.prepare" ? "preparing a stand-up now tells its agents and builds their briefs before the usual time, so it is shown first" : op === "standup.add-statement" ? "a note goes into an agent's brief for the stand-up, so it is shown first" : op === "workspace.request" ? "changing a task's checkout (integrating, landing, refreshing, quarantining or committing it) is shown first" : op.startsWith("release.") ? "a release action is shown first" : "a role's capabilities are shown first";
  // Moving a task up to a profile that may spend more is a spending decision: shown first in every profile, as a budget raise is.
  if (op === "difficulty.set" && context.raisesSpend === true) return "it moves the task to a profile that may spend more, so it is shown first";
  if (context.quoted && (!PLAIN_EDITS.has(op) || (op === "project.update" && args["state"] !== undefined))) return "your message carried quoted text, so this is shown first";
  if (!context.said) return "your own words do not say this move, so it is shown first";
  const strict = context.profile === "strict";
  if (spec.mode === "profile") return strict ? "the strict profile shows this first" : undefined;
  // A recorded decision can interrupt running generation and block dependent work, so the strict profile shows it first.
  if (strict && op === "decision.record") return "the strict profile shows a recorded decision first";
  if (strict && op === "task.transition" && (args["to"] === "done" || args["to"] === "cancelled")) return "the strict profile shows a final state first";
  if (strict && op === "project.update" && args["state"] === "archived") return "the strict profile shows archiving first";
  return undefined;
}

/** Keys whose values name records or fixed choices; every other text in a command must be in the owner's own words. */
const EXEMPT = new Set(["section", "taskId", "projectId", "project", "prerequisiteId", "agentId", "supervisorId", "teamId", "parentTeamId", "repositoryId", "resourceId", "responsibilityId", "ownerId", "managed", "access", "landing", "integrator", "requiredChecks", "integration", "refreshRounds", "expectedRevision", "expectedVersion", "requestId", "currency", "level", "to", "state", "workClass", "difficulty", "recovery", "kind", "priority", "itemId", "inquiryId", "occurrenceId", "watchedTaskId", "watchId", "returnAt", "sourceTurnId", "intent", "urgency", "category", "participants", "fingerprint", "attemptId", "sessionId", "waitingSince", "decision", "reaccept", "patienceHours", "who", "os", "arch", "osVersion", "verdict", "rule", "what", "specDigest", "concernId"]);

/** Release-test IDs are not record references the owner picked: for the release commands they must be in the owner's own words (cancel applies at once, so a model must not choose which test). */
export const RELEASE_ID_KEYS: ReadonlySet<string> = new Set(["attemptId", "candidateId"]);
/** The request a maintenance command names is the owner's word, not a record the interpreter picked. */
export const MAINTENANCE_ID_KEYS: ReadonlySet<string> = new Set(["maintenanceId"]);

/**
 * True if `value` appears in `text` as a whole word: not as a part of a longer name, ID or action (card X09b part 2 review: "host:rig2" said by the owner is not "host:rig").
 * Punctuation that cannot be part of a name is a boundary (card X09b part 2 review 2, item 6): markdown bold or a backtick around an ID, a colon before it ("candidate:rcn-1a2b"), a quote, a comma, a
 * bracket, or a full stop, colon or underscore that ends it. What still joins two names is a letter, a digit, or a dash, underscore, dot or colon with more of the name after it, so `host:rig2` is not
 * `host:rig`, `rcn-1a2bc` is not `rcn-1a2b` and `rcn-1a2b_old` is not `rcn-1a2b`.
 */
export const wholeWord = (text: string, value: string): boolean => value.length > 0 && new RegExp(`(?<![A-Za-z0-9._-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])(?![\-_.:][A-Za-z0-9])`, "i").test(text);

/**
 * How an owner names a platform (card X09b part 2 review 2, item 3): `os` and `arch` are fixed choices the words check lets through, so the chat checks them itself, and an owner writes "my mac" or
 * "linux-x64" rather than "darwin x64". Each choice is therefore written down here with the ways people spell it.
 */
const PLATFORM_WORDS: Readonly<Record<"os" | "arch", Readonly<Record<string, readonly string[]>>>> = {
  os: { linux: ["linux"], darwin: ["darwin", "macos", "mac os", "mac", "macbook", "imac", "mac mini"], win32: ["win32", "windows"] },
  arch: { x64: ["x64", "x86_64", "x86-64", "amd64"], arm64: ["arm64", "aarch64", "apple silicon"] },
};
/** A name standing on its own: what sits before and after it is not a letter or a digit, so a hyphen, slash, colon or underscore between two names does not join them into one. */
const namedWord = (words: string, alias: string): boolean => new RegExp(`(?<![A-Za-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(words);

/**
 * How an owner takes a platform away rather than naming it (card X09b part 2 review 3, item D3): "linux x64, not the mac" says one os, and the mac in it is the one they refuse. A denial counts only
 * within its own clause and within a few words of the name, so "linux, not windows; and the mac mini too" still names the mac.
 */
const DENIAL = /\b(?:not|no|never|neither|nor|except|without|instead of|other than|rather than|exclude[sd]?|excluding|avoid(?:s|d)?|cannot|can['’]?t|couldn['’]?t|shouldn['’]?t|wouldn['’]?t|won['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t)\b[^.!?;\n]{0,30}$/i;
/** The ordinary words an alias also spells (D3): a MAC address is a number printed on a sticker and says nothing about what system a machine runs. */
const ORDINARY_AFTER: Readonly<Record<string, readonly string[]>> = { mac: ["address", "addresses"] };

/** Whether this alias stands in the owner's own words as a name of its own: not denied just before it, and not the ordinary word it also spells. */
function namesPlatform(words: string, alias: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
  for (let m = re.exec(words); m !== null; m = re.exec(words)) {
    if (DENIAL.test(words.slice(Math.max(0, m.index - 60), m.index))) continue;
    if ((ORDINARY_AFTER[alias.toLowerCase()] ?? []).some((after) => new RegExp(`^\\s+${after}\\b`, "i").test(words.slice(m.index + m[0].length)))) continue;
    return true;
  }
  return false;
}

/**
 * Which platforms of this kind the owner's own words name (card X09b part 2 review 3, item D3), in the order the choices are written down: `linux-x64` and `linux/x64` name a linux and an x64, a mac (or
 * macOS) is darwin, windows is win32, x86_64 and amd64 are x64, and aarch64 is arm64. A name the owner denied ("not the mac") and an ordinary word that merely spells one ("its MAC address") name nothing.
 */
export function platformsNamed(words: string, key: "os" | "arch"): string[] {
  return Object.entries(PLATFORM_WORDS[key]).filter(([, aliases]) => aliases.some((alias) => namesPlatform(words, alias))).map(([value]) => value);
}

/** Whether the owner's own words name this platform by some spelling of it; naming more than one of the same kind is the message being ambiguous, which `platformsNamed` shows. */
export function saysPlatform(words: string, key: "os" | "arch", value: string): boolean {
  const wanted = value.trim().toLowerCase();
  return PLATFORM_WORDS[key][wanted] === undefined ? namedWord(words, wanted) : platformsNamed(words, key).includes(wanted);
}

/** Another platform of the same kind the owner did name — so a refusal can say what they said instead — or undefined when their message names none of that kind (then they are asked, not refused). */
export function otherPlatform(words: string, key: "os" | "arch", value: string): string | undefined {
  return platformsNamed(words, key).find((v) => v !== value.trim().toLowerCase());
}

/** The platforms of this kind the operation accepts, as the choices to offer the owner. */
export const platformChoices = (key: "os" | "arch"): readonly string[] => Object.keys(PLATFORM_WORDS[key]);

/** Keys whose value is a machine or record name rather than a sentence: the owner must have said it as a whole word, not merely as the start of a longer one. Release IDs (which `foreignValue`'s `strict` set makes checked) are matched the same way. */
export const WHOLE_WORD_KEYS: ReadonlySet<string> = new Set(["hostId"]);

/** The first text value of a command's arguments that is not the owner's own words (and not a record reference or fixed choice), or undefined. */
/** Fixed choices and record references of one command only: `response` is one of three choices and `decisionId` is checked against the decisions waiting for the owner (card M02h). */
export const OWNER_RESPOND_EXEMPT: ReadonlySet<string> = new Set(["response", "decisionId"]);
/** A recovery step's `action` is one of six fixed rungs (and the step is always shown first); its `text` must still be the owner's own words (card V02c). */
export const RECOVERY_STEP_EXEMPT: ReadonlySet<string> = new Set(["action"]);
/** A workspace request's `operation` is one of five fixed choices (and the request is always shown first); its `reason` must still be the owner's own words (card H12m). */
export const WORKSPACE_REQUEST_EXEMPT: ReadonlySet<string> = new Set(["operation"]);

/** A defined event source (card H13f): its kind is a fixed choice, its name one the assistant may choose (or the one it names), and a single time is worked out from the owner's words (like a hand-off's return time); the definition is always shown first. What it looks at (`path`) or asks (`url`) must still be the owner's own words. */
export const EVENT_SOURCE_EXEMPT: ReadonlySet<string> = new Set(["type", "sourceId", "at"]);

export function foreignValue(args: Readonly<Record<string, unknown>>, ownText: string, path = "", strict: ReadonlySet<string> = new Set(), alsoExempt: ReadonlySet<string> = new Set()): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const own = norm(ownText);
  const walk = (value: unknown, where: string, key: string): string | undefined => {
    if (typeof value === "string") {
      // A name (a host, a release ID the strict set makes checked) must stand as a whole word in the owner's message; a sentence (a reason, a summary) only has to be in it.
      const exempt = (EXEMPT.has(key) || alsoExempt.has(key)) && !strict.has(key);
      if (exempt || value.length === 0) return undefined;
      return (strict.has(key) || WHOLE_WORD_KEYS.has(key) ? wholeWord(own, norm(value)) : own.includes(norm(value))) ? undefined : where;
    }
    if (Array.isArray(value)) { for (const [i, v] of value.entries()) { const bad = walk(v, `${where}[${i}]`, key); if (bad !== undefined) return bad; } return undefined; }
    if (value !== null && typeof value === "object") { for (const [k, v] of Object.entries(value)) { const bad = walk(v, `${where}.${k}`, k); if (bad !== undefined) return bad; } }
    return undefined;
  };
  for (const [k, v] of Object.entries(args)) { const bad = walk(v, path === "" ? k : `${path}.${k}`, k); if (bad !== undefined) return bad; }
  return undefined;
}

/** True if a `$ref` marker (reserved for steps the service builds) appears anywhere in the value. */
export function hasRefMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRefMarker);
  if (value !== null && typeof value === "object") return "$ref" in value || Object.values(value).some(hasRefMarker);
  return false;
}

const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** One plain line saying what a command will do, for the owner to read before it happens. Built from the typed command, never from model text. */
export function describe(op: string, args: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, string>>): string {
  const spec = CHAT_OPS[op];
  const parts: string[] = [];
  // What a decision is (a gate and its kind above all) is said first, so a long text or label after it can never push it off the line.
  const first = op === "decision.record" ? ["category", "gate"] : op === "meeting.record.owner-respond" ? ["response", "decisionId", "alternative"] : [];
  const ordered = [...first.filter((k) => k in args).map((k): [string, unknown] => [k, args[k]]), ...Object.entries(args).filter(([k]) => !first.includes(k))];
  for (const [key, value] of ordered) {
    if (key === "expectedRevision" || key === "expectedVersion") continue;
    // The binding an approval carries is the chat's own reading of the gate, and the owner is shown those failures in plain words beside the proposal line; the raw argument names and attempt list are not shown again here.
    if (op === "release.approve" && (key === "acknowledgeFlaky" || key === "expectedFailures")) continue;
    // The owner's own alternative is shown as the words they will have recorded and the topic they go under, never as the record's fields.
    if (op === "meeting.record.owner-respond" && key === "alternative" && value !== null && typeof value === "object") {
      const alt = value as Record<string, unknown>;
      parts.push(`alternative="${String(alt["statement"])}" on topic "${String(alt["topic"])}"`);
      continue;
    }
    const label = typeof value === "string" ? labels[value] : undefined;
    parts.push(`${key}=${label === undefined ? short(value) : `"${label}"`}`);
  }
  // What the exception means is said before the details, so a long topic can never push it off the line.
  // A right's end (or that it has none) is said before the long basis and terms, so truncating the line can never drop it.
  const meaning = op === "meeting.record.owner-respond" ? ownerRespondMeaning(args, labels) : op === "meeting.invite-direct" ? " (this meeting only, then the agent is back as it was; no long-running work in it)" : op === "grant.create" ? (typeof args["expiresAt"] === "string" ? ` (ends ${args["expiresAt"]})` : " (permanent: no end time)") : "";
  const line = `${spec?.verb ?? op}${meaning}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
  // An answer to a held meeting decision carries the decision, the owner's alternative in full (150 characters) and its topic (80), which the usual line would cut: the line has room for all of them.
  const room = op === "meeting.record.owner-respond" ? 700 : CHAT_LIMITS.line;
  return line.length > room ? `${line.slice(0, room - 3)}...` : line;
}

/**
 * What an answer to a held meeting decision does, said before it is given. A change already started is finished whatever the answer (only changes not yet started are refused), and the count of those comes from the decision.
 * The count of started changes is read from `labels` (key `started:<decisionId>`), put there by the chat from the decision's record, so it is never an argument of the operation.
 */
function ownerRespondMeaning(args: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, string>>): string {
  if (args["response"] === "agree") return " (agreeing lets the changes still waiting be carried out)";
  const started = Number(labels[`started:${String(args["decisionId"])}`] ?? 0);
  const tail = started > 0 ? `; ${started} already started will still be finished; those already done stay done` : "; those already done stay done";
  return args["response"] === "decline" ? ` (declining refuses the changes not yet started${tail})` : ` (your own decision is recorded and the changes not yet started are refused${tail})`;
}
