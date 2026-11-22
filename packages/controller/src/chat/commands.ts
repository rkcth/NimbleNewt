import { OPERATION_BY_NAME } from "../api/operations.js";
import { quoted as quotedText } from "../status/explain.js";
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
  readonly revision?: "task" | "project" | "agent" | "assignment" | "contract" | "agenda" | "standup" | "grant" | "decision" | "notifications" | "difficulty-profiles" | "retention" | "catalog-policy" | "standing-proposal" | "profile-suggestion" | "concern" | "responsibility" | "doc-obligation" | "database-transfer" | "defect" | "observation" | "lesson" | "experiment";
  /** The project the command is about is needed, and comes from the conversation's focus when the owner does not name it. */
  readonly needsProject?: boolean;
  /** The command hands a task to someone: it carries an explicit project and repository (checkout) and is always a proposal. */
  readonly dispatch?: boolean;
}

/** Operations whose project argument is named `project`, not `projectId`. */
export const PROJECT_AS_PROJECT: ReadonlySet<string> = new Set(["integration.set", "project.branches.set", "project.branches.change", "wip.backup.set", "wip.backup.restore"]);

export const CHAT_OPS: Readonly<Record<string, ChatOp>> = {
  "project.create": { verb: "Create project", mode: "propose" },
  "project.update": { verb: "Change project", mode: "apply", revision: "project", needsProject: true },
  "task.create": { verb: "Create task", mode: "profile", needsProject: true },
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
  "catalog.revoke": { verb: "Revoke tool version (runningCalls: finish, cancel or pause; the choice also reaches calls running in another controller process on the same store, within seconds)", mode: "propose" },
  // The standing answer for running calls when a revoke names none (card T02c): shown first (provisional); the revision is read for the owner.
  "catalog.policy.change": { verb: "Change what happens to running tool calls when a version is revoked (runningCalls: finish, cancel or pause; null for the default)", mode: "propose", revision: "catalog-policy" },
  // The shared toolbox (card T08): who a shared tool is for, setting a version aside and going back to an earlier one. Always shown first: each changes which agents can find and run a tool, or which version runs.
  // Giving or taking back the maintainer right is grant.create / grant.revoke with the action toolbox.manage.
  "toolbox.audience.set": { verb: "Change who a shared tool is for (name: the tool; all: true for every agent, or roles, teams and projects by the owner's own names)", mode: "propose" },
  "toolbox.deprecate": { verb: "Set a shared tool version aside (no longer chosen by default; work pinned to it keeps it)", mode: "propose" },
  "toolbox.rollback": { verb: "Return a shared tool to an earlier version", mode: "propose" },
  // Which version of a shared tool an agent stays on (card T08): agents keep the version of their first run until they opt in; the owner may move one agent or everyone. Shown first: it changes what their calls run.
  "toolbox.optin": { verb: "Move an agent (agentName, the agent's name) or everyone (everyone: true) to a version of a shared tool (name; version, default the one in use now)", mode: "propose" },
  // Decisions on agents' toolbox proposals (card T08): accept (optionally releasing a version), ask for changes, defer, reject or reopen. Shown first: an acceptance with a version publishes it.
  "toolbox.proposal.decide": { verb: "Decide an agent's toolbox proposal (proposalId from the toolbox_proposals status; decision accept, request_changes, defer, reject or reopen; reason; version to release when accepting)", mode: "propose" },
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
  // A rerun of a replay (card U09b) changes nothing: it is a walk through the recorded steps in an isolated scope, so it applies at once. Saying a step was wrong (replaces true) changes how every later replay shows it, so it is first shown.
  "activity.replay.simulate": { verb: "Rerun a task's replay as a simulation (nothing is run, sent or changed; failAt injects a provider failure at a step)", mode: "apply" },
  // Simulation scopes (card P07): a stand-in of the services where the effect ledger refuses any real write, send or spend, so opening one, trying an action in it and closing it change nothing real: they apply at once. Real access is granted separately (grant.create, always shown first).
  "simulation.open": { verb: "Open a simulation scope for a task: a stand-in of its services (layout: services, their resources, each with state and dependents) to try actions in before any real access; nothing real is written, sent or spent", mode: "apply" },
  "simulation.operate": { verb: "Try one action (set fields or restart) on a resource in a simulation scope; the result is simulated (inject refuse, lose-answer, corrupt or leak to see how a failure is handled)", mode: "apply" },
  "simulation.close": { verb: "Close a simulation scope (nothing more runs in it; what it recorded stays readable)", mode: "apply" },
  "activity.correct": { verb: "Correct a step of a task's activity; replaces true says the step was wrong, so the replay shows it as replaced", mode: "propose" },
  "thinking.collection.set": { verb: "Turn collecting the model's thinking off or on (enabled true or false); what was kept stays until retention removes it", mode: "apply" },
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
  // A daily cap on the reviewing agents' model calls: too low and reviews stop running (every resume waits for the owner), so it is shown first in every profile (T2). null removes the cap. The chat itself is never stopped by it.
  "chat.budget.set": { verb: "Set or remove the daily token cap on the reviewing agents' model calls", mode: "propose" },
  "agreed.limits.change": { verb: "Change the limits on agreed raises and grants", mode: "propose" },
  // How long a stalled resume is retried before the owner is told is a work-and-spend decision: shown first in every profile.
  // The coverage-lapse alert is off by default and only tells the owner; turning it on or off, or changing its period, is reversible and applies at once (provisional, see the notes).
  // Retention (card K06): settings are shown first (they decide what may be deleted and how much room is kept back); a deletion, a run, an archive and a restore always are. Reading and checking is not a command.
  "retention.settings.set": { verb: "Change the retention, quota and reserve settings (how many days to keep each kind of old record, such as summaries, model replies, finished checks, stall concerns, stall progress records and speeds, saved full texts of cut notes of finished tasks, an agent's private scratch of finished tasks (archive first, then remove), the owner's words in old chat turns, how long stored model thinking is kept and whether it is removed by itself, retired responsibilities' history and incidents, whether retention runs by itself, backup counts and the age limit in days after which a backup is deleted, storage quotas)", mode: "propose", revision: "retention" },
  "retention.run": { verb: "Run retention (by default only a preview of what the rules would remove; with dryRun false it deletes what they expire, and the chat fills in the digest of a preview it makes just now)", mode: "propose" },
  "retention.delete": { verb: "Delete a record and what was made from it (a record that only a finished task's replay cites is deleted too when the owner says to release the replay hold)", mode: "propose" },
  "retention.archive": { verb: "Archive a finished task's records", mode: "propose" },
  "retention.restore": { verb: "Restore a task's archived records", mode: "propose" },
  // Retirement (card P06): always shown first with what it would release; the chat fills in the confirmation from a preview it makes just now. A plan with live assignments is refused with what to release first.
  "retirement.agent": { verb: "Retire an agent (its leases are released, its grants and credential revoked and its identity disabled; refused while it still has unfinished tasks or answers for active responsibilities; its records stay and its ID is never reused)", mode: "propose" },
  "retirement.project": { verb: "Archive a project (its responsibilities are retired, its leases released, resource bindings unbound and the execution grants made for it revoked (read-only grants stay); refused while it has assigned unfinished tasks; everything stays readable and it can be restored)", mode: "propose", needsProject: true },
  "retirement.project.restore": { verb: "Restore an archived project to active (what archiving released is not brought back by itself)", mode: "propose", needsProject: true },
  "coverage.settings.set": { verb: "Change the coverage-lapse alert", mode: "apply" },
  // Whether a due responsibility check may start agent work, and how many such tasks may be open at once in a project: reversible, and a check that is not taken stays owed (shown as not observed), so it applies at once (provisional).
  // Card P04i: an HTTP probe makes NimbleNewt itself ask an address the owner names, so it is always shown first (the owner's word is the approval of that reach); the address must be in the owner's own words. Clearing it is shown first too. The verb is kept within the 80 characters a shown line keeps of it (second review); what setting means is said by `probeMeaning`.
  "responsibility.probe.set": { verb: "Set or clear (url null) the health address NimbleNewt itself asks at due checks", mode: "propose", needsProject: true },
  "check.settings.set": { verb: "Turn on or off giving due responsibility checks to the agent that answers for them as small tasks, or change how many such check tasks may be open at once in one project", mode: "apply" },
  // Letting a task go on after a resume check found changes that matter to it: shown first in every profile, because the owner is accepting that the work continues on changed inputs.
  "resume.approve": { verb: "Let a task go on after a resume check found changes that matter to it", mode: "propose" },
  // Not letting it go on: the task is released (nothing works on it until it is assigned again). Shown first as well: it ends the task's waiting attempt.
  "resume.decline": { verb: "Stop a task a resume check held for changes that matter to it (the task is released)", mode: "propose" },
  "resume.settings.set": { verb: "Change how many blocked rounds a resume retries", mode: "propose" },
  // What happens when a host stops reporting is where work runs and when it moves: shown first in every profile (owner decision 2026-10-30).
  // Moving a host's work re-plays running attempts, so it is shown first too, whatever words the owner used to ask: no wording makes it apply on its own.
  // Signing a browser out of the web chat only narrows who is in (card U07b): it applies at once, which is what a lost phone needs. It signs nobody out of the terminal chat.
  "web.access.revoke": { verb: "Sign a browser out of the web chat (browser: the owner's words for it, such as iPhone) or every browser (all true: a lost phone)", mode: "apply" },
  "host.quiet.change": { verb: "Change what happens when a host stops reporting", mode: "propose" },
  "host.move-work": { verb: "Move the work off a host", mode: "propose" },
  "credential.issue": { verb: "Issue a credential to an agent (kind agent, agentId) or a host (kind host, name); it is shown once to you and never stored or logged", mode: "propose" },
  "credential.revoke": { verb: "Take an agent's or a host's credential away (kind agent, agentId, or kind host, name)", mode: "propose" },
  "host.local.set": { verb: "Turn on or off the worker host NimbleNewt starts on this computer so agents can run here (enabled true or false); it counts from the next start", mode: "propose" },
  // Reviewing and deciding on a deliverable (card Q01): the owner's decision on the work. Accepting or rejecting is first shown in every profile (provisional: it lets dependent work go on); starting a review changes nothing else.
  "deliverable.review.start": { verb: "Start reviewing a deliverable", mode: "apply" },
  "deliverable.accept": { verb: "Accept a deliverable", mode: "propose" },
  "deliverable.reject": { verb: "Reject a deliverable", mode: "propose" },
  // Defects (card Q04): recording a finding, or a repair, adds a record and changes no decision, so it applies at once; judging a repair and the owner's override decide whether work goes on, so they are shown first in every profile
  // and pinned to the defect's revision when shown (a repair checked or repaired again in between, now in another version, makes the proposal stale).
  "defect.report": { verb: "Record a defect found in a version of a deliverable (finding in the owner's words, severity critical, major or minor)", mode: "apply" },
  "defect.repair": { verb: "Say which newer version of the deliverable repairs a defect", mode: "apply" },
  "defect.review": { verb: "Judge the repair of a defect (verdict fixed or not-fixed, with what is still wrong)", mode: "propose", revision: "defect" },
  "defect.withdraw": { verb: "Take a defect report back as mistaken (reason in the owner's words: wrong version, a duplicate, a misreading); the report and its checks stay on the record", mode: "propose", revision: "defect" },
  "defect.override": { verb: "Decide a defect yourself (outcome accept-as-is, keeping the finding on the record, or repair-again, keeping the cycle count; reason in the owner's words)", mode: "propose", revision: "defect" },
  // QA evidence (card Q02): invalidating evidence whose criteria or owner decisions changed, and scheduling its re-check, only applies what the records already say; it applies at once.
  "qa.evidence.check": { verb: "Check whether a task's QA evidence still holds (its acceptance criteria and the owner decisions it was judged against unchanged); evidence that no longer holds is invalidated and a re-check is scheduled", mode: "apply" },
  // Documentation obligations (card Q03): each names an agent who gets update tasks or record IDs the interpreter picked from the docs view, so each is shown first. A replacement or a verification is pinned to the obligation's revision.
  "doc.obligation.record": { verb: "Record which document must be kept true to which work (title, where it lives, audience user, developer, support or promotional, the agent keeping it, the version it applies to, the tasks it describes, and any capability it claims with the task behind it); or, with obligationId, replace one", mode: "propose", revision: "doc-obligation", needsProject: true },
  "doc.obligation.verify": { verb: "Mark a document as checked against tested work (the docs role's document change made since it was flagged, and for every task it describes code whose QA gate passes; what the owner leaves out is filled from the records the docs view shows, and the owner is asked when several document changes fit)", mode: "propose", revision: "doc-obligation" },
  "doc.obligation.retire": { verb: "Take a document away when it is no longer kept (removed, or merged into another): it leaves the docs view and every check, and its update tasks not yet started are cancelled; the reason in the owner's words", mode: "propose", revision: "doc-obligation" },
  "doc.impact.check": { verb: "Find the documents a task's new tested code affects; each affected or unverified document gets an update task assigned to the agent keeping it", mode: "propose" },
  "doc.release.check": { verb: "Flag every document (user and developer docs, support guidance, promotional assets) that applies to another version than the release, each with an update task for the agent keeping it", mode: "propose", needsProject: true },
  // Guided setup (card U14): a provider decides where the team's data may go and what it may spend, so it is shown first in every profile. Only the NAME of a credential is ever in the chat; the key goes into the secret store on the machine.
  "routing.provider.add": { verb: "Add or replace model providers (each: name, location local or cloud, endpoint address, models, contextTokens, paid, kind = what the model server is: llama-cpp, vllm, radiance, strata, openai, openai-compatible, claude or generic, which decides how a route's reply limit and reasoning cap are sent; credentialName = the NAME of a secret, never a key); the team needs at least two routes on two different servers", mode: "propose" },
  "workers.limits.change": { verb: "Change the limits for local agents", mode: "propose" },
  "workers.limits.besteffort": { verb: "Allow or forbid local agents to start when a limit cannot be fully enforced on this system (enable or disable best effort)", mode: "propose" },
  // Whether each model call is recorded against its generation and a late reply held back (card L05b): neither is a limit; both are on unless the owner turns them off.
  "generation.stream.change": { verb: "Turn recording of the model stream, holding back a late reply, failing closed when the store cannot answer, recording a paused task's model call (recordPaused), refusing a tool call of a corrected generation at the bridge (checkBridge) or one no generation recorded (requireRecorded) on or off, requiring a tool call's name and arguments to match the bridge operation it asks for (bindCall), admitting a bridge write as an effect of its generation (admitCall), refusing the calls of a remote worker that never reports its model stream (requireStream), or set their limits", mode: "propose" },
  // How many attempts may run at once for one project, one agent or one supervisor is a resource decision: shown first in every profile; all caps are off unless the owner turns them on.
  "capacity.limits.change": { verb: "Change the capacity caps (per project, per agent, fan-in)", mode: "propose" },
  // The host and global quotas and the limits on spawning child tasks (card H10) are resource decisions too: shown first in every profile.
  "capacity.quotas.change": { verb: "Change the host and global quotas: attempts running at once in total (productive) and on one host (perHost), places kept for stopping, review and questions (control), the waiting queue, or a host's CPUs and memory (hosts)", mode: "propose" },
  "swarm.limits.change": { verb: "Change the limits on child tasks: how many levels deep (depth), how many unfinished children one task may have at once (liveChildren), how many children in all report back to one task (totalChildren, the fan-in)", mode: "propose" },
  // How long an attempt may run and how many attempts are admitted are resource decisions: shown first in every profile (provisional). Both limits are off unless the owner turns them on.
  // Whether a task moving to another model route has its context checked first, and what is counted for a route nobody has measured (card C07f): both on unless the owner turns them off.
  // Network access for a task (card H12i): a sandbox has no network and a task reaches only the destinations it holds a grant for (the default is none). Giving access widens what a task can reach, so it is shown first in every profile; taking it away only narrows and applies at once.
  "network.grant": { verb: "Give a task network access to ONE destination: host and port written exactly (no wildcard or range), for example research on a website, or a test against a named server; allowPrivate true for a service on this computer or the local network (a local port); reason in the owner's words. The task reaches nothing else, every connection is logged, and the grant ends with the task", mode: "propose" },
  "network.decide": { verb: "Approve or refuse a task's request for network access to a destination (verdict approve or deny; name the task, host and port)", mode: "propose" },
  "network.revoke": { verb: "Take network access away from a task: one destination (task, host and port) or all of the task's access (the task alone); connections that are open end at once", mode: "apply" },
  "context.start-size.change": { verb: "Change when the owner is alerted that a task's starting size keeps rising over its hand-offs, or is close to its route's limit", mode: "apply" },
  "context.route.change": { verb: "Turn on or off the goal anchor (the short block of a task's goal, acceptance criteria and plan that opens each attempt's first prompt and is put back at the top of the agent's memory every time its conversation is cut; that summary is a plain extract of the start and the end of what was cut, written without a model, so details from the middle may be missing) or set its size cap, turn the agent's memory tool (task.recall: it reads back the agent's own goal, plan, notes, hand-off facts and cut-note text from the controller's records) on or off or set how many times an attempt may use it, turn the check of a task's context when it moves to another model route (and the rebuilt context put in its first prompt) on or off, or set the size counted for an unmeasured route", mode: "propose" },
  "dispatch.limits.change": { verb: "Change the dispatcher's time and attempt limits", mode: "propose" },
  // Whether the controller may remove an ended attempt's scratch workspace is a data-keeping decision: shown first in every profile (owner decision 2026-10-30; default after-handoff).
  "cleanup.settings.change": { verb: "Change whether an ended attempt's scratch workspace is removed", mode: "propose" },
  // Whether a reconnected worker takes its attempt up again by itself, and the owner's decision on one that waits, are authority over running work: shown first in every profile (card H09b, provisional).
  // Standing-rule proposals and the profile question (cards A07b, A07c; U08). Making a standing grant, or moving the installation to the derived profile, widens what runs without asking: shown first in every profile; nothing is accepted from an interpreter's words alone.
  // Turning a proposal down, and having the controller look for repeated approvals, only keep the owner's choice and change no right, so they apply at once. The reason is the owner's own words.
  "approval.proposal.accept": { verb: "Accept a standing-rule proposal (an expiring approval grant for what you kept approving: days 1, 7, 30 or 90, or statedDays / oneOff from your words), or answer it by moving to the derived profile (switchProfile permanent or trial)", mode: "propose", revision: "standing-proposal" },
  "approval.proposal.dismiss": { verb: "Turn a standing-rule proposal down", mode: "apply", revision: "standing-proposal" },
  "approval.proposals.check": { verb: "Look now for approvals you keep repeating and open a standing-rule proposal for each", mode: "apply" },
  "approval.suggestion.answer": { verb: "Answer the question whether to move to the derived profile (switch, trial, not-now, or after a trial keep, extend or revert)", mode: "propose", revision: "profile-suggestion" },
  "reconnect.settings.set": { verb: "Change whether reconnected workers take their attempts up again by themselves", mode: "propose" },
  "reconnect.reaccept": { verb: "Decide on a reconnected worker's attempt", mode: "propose" },
  // Proving a backup unlock method still works reads a secret file on the host and changes nothing but the record of the proof; it carries no secret in the chat (card K01b).
  // The configurable backup system (card K01c). Reading and testing change nothing that matters and apply at once. A new schedule, a new place copies go to (an authority: backups leave the main folder) and any deletion of a backup are always shown first.
  "backup.config.set": { verb: "Change the backup schedule (how often, at which hour UTC, how often a backup is test-restored)", mode: "propose" },
  "backup.target.add": { verb: "Add a place backups are also copied to (a folder, another disk or an off-machine store; a credential is named, never given)", mode: "propose" },
  "backup.target.test": { verb: "Test a backup target (can it be reached and written to)", mode: "apply" },
  "backup.target.remove": { verb: "Stop copying backups to a target (copies already there stay)", mode: "propose" },
  "backup.purge": { verb: "Delete named backups from every target before they expire (the last good backup needs a separate yes)", mode: "propose" },
  "backup.verify.run": { verb: "Test-restore a backup now to prove it can be used", mode: "apply" },
  "backup.encryption.verify": { verb: "Check that a backup unlock method still works", mode: "apply" },
  // Approving a new backup key decides who can read every later backup: always a proposal, shown first in every profile.
  "backup.encryption.rekey": { verb: "Approve a new backup key", mode: "propose" },
  // Switching backup encryption off, or narrowing what it covers, makes later backups less protected; switching it on is the safe direction, but one command does both, so it is always a proposal shown first (card K01b3).
  "backup.encryption.set": { verb: "Switch backup encryption on or off, or choose what it covers: secrets only (the default when first on) or everything (off writes plain backups)", mode: "propose" },
  // Leaving bulk records out of later backups means a restore from them is not a full copy: always shown first (card K01d).
  "backup.scope.set": { verb: "Choose which bulk records backups leave out (private scratch of finished tasks, old chat words, delivered message records) by age, or turn that off", mode: "propose" },
  // A new signing key changes who the owner trusts to have made a backup: shown first.
  "backup.signing.rotate": { verb: "Make a new backup signing key", mode: "propose" },
  // A restore replaces everything with an older copy: always a proposal with the exact preview (backup.restore.preview) shown first, never applied from an interpreter's words, in every profile (card K01h).
  "backup.restore.apply": { verb: "Restore a backup (replaces all current data)", mode: "propose" },
  // Withdrawing a prepared restore only puts things back as they were: the safe direction.
  // Moving the controller database fences the current one and needs a restart: always a proposal with the exact preview shown first, never applied from an interpreter's words, in every profile (card F04e). Rolling it back is a proposal too.
  "database.transfer.apply": { verb: "Move the controller database (fences the current one; needs a restart)", mode: "propose" },
  "database.transfer.rollback": { verb: "Roll back a database transfer", mode: "propose" },
  // Removing the copy an unfinished move left at a destination is a deletion: shown first in every profile, with what is there. The settings turn moves on or off and the host's automatic restart after one (card F04m).
  "database.transfer.wipe": { verb: "Remove the copy a database move that did not finish left at a destination", mode: "propose" },
  "database.transfer.set": { verb: "Change whether the database may be moved (enabled) and whether the host restarts the controller by itself after a move or rollback (restart)", mode: "propose", revision: "database-transfer" },
  "backup.restore.cancel": { verb: "Withdraw a prepared restore", mode: "apply" },
  // Release staging and activation (card K02). Staging copies verified files and changes nothing running, so it applies at once. Activating and rolling back change what runs: always shown first, the owner's word is the confirmation.
  // Requiring an approved candidate narrows and applies at once; dropping the requirement and any other setting change widens or is shown first (provisional, see the notes).
  "release.stage": { verb: "Stage a release", mode: "apply" },
  "release.activate": { verb: "Activate a staged release", mode: "propose" },
  // A maintenance window (card K07) is a standing word to activate one exact release at a stated time: always shown first. Cancelling one only stops it: the safe direction, applied at once.
  "release.window.set": { verb: "Set a maintenance window that activates a staged release at a stated time", mode: "propose" },
  "release.window.cancel": { verb: "Cancel a maintenance window", mode: "apply" },
  "release.stage.remove": { verb: "Remove a staged release", mode: "propose" },
  "release.activation.resolve": { verb: "Resolve an interrupted release switch", mode: "propose" },
  "release.rollback": { verb: "Roll back to the previous release", mode: "propose" },
  // Marking the current release as the last known good decides where a failed start falls back to: shown first (card K02, second slice).
  "release.confirm": { verb: "Confirm the current release as the last known good", mode: "propose" },
  // The trust root decides which signatures count (card K02b): trusting a key, withdrawing one and changing whether a signature is needed are shown first. Attaching a signature changes nothing that runs and only keeps one that verified against the root.
  "release.trust.add": { verb: "Trust a release signing key", mode: "propose" },
  "release.trust.remove": { verb: "Stop trusting a release signing key", mode: "propose" },
  "release.trust.require": { verb: "Change whether releases must be signed", mode: "propose" },
  "release.signature.attach": { verb: "Attach a signature to a release candidate", mode: "apply" },
  // The owner saying they have seen a failed start or fall-back only closes a notice: it changes no release and no setting (card K02f).
  // Migration recovery and rollback limits (card K03): the policy and the approval for destructive migrations change what can be undone, so they are shown first; so is stopping a rollout, which removes the automatic way back. Withdrawing an approval only narrows and applies at once.
  "migration.policy.set": { verb: "Change the rollback period, or how a newly activated release is watched and when its failures send the installation back to the release before it", mode: "propose" },
  "migration.contract.approve": { verb: "Allow destructive database migrations to run at the next start (after this the previous release cannot come back)", mode: "propose" },
  "migration.contract.withdraw": { verb: "Take back an approval for destructive database migrations that has not run yet", mode: "apply" },
  "release.rollout.stop": { verb: "Stop the rollout of the current release: end its watch (its failures no longer send the installation back), leaving it running", mode: "propose" },
  "release.start.acknowledge": { verb: "Acknowledge that a release failed to start or fell back", mode: "apply" },
  "release.staging.settings.set": { verb: "Change the release staging settings", mode: "propose" },
  "release.approval.enable": { verb: "Require an approved release for activation", mode: "apply" },
  "release.approval.disable": { verb: "Stop requiring an approved release for activation", mode: "propose" },
  "placement.change": { verb: "Change where local-only data may go", mode: "propose" },
  // Changing a task's checkout on the host that holds it (card H12m): carrying its work into the shared workspace, landing it, refreshing it to the shared head, quarantining it (its attempt is stopped) or committing
  // reviewed work. Each changes files or stops an agent, so it is shown first in every profile (provisional); the operation is a fixed choice, the reason must be the owner's own words.
  // Kept short: the proposal line the owner confirms is this verb followed by the operation, the task and the reason, and it is cut at CHAT_LIMITS.line.
  "workspace.request": { verb: "Change a task's checkout on its host (operation: integration shares its work, landing lands its commits, refresh moves it to the shared head, quarantine moves it aside for the owner and stops its attempt, release commits its work in the task's own checkout; a landing lands the task's queued approved submission when it is the oldest in the landing queue, and only when the project's required checks pass on that tree; on a project with a landing branch an integration needs a live integrator lease and an empty landing queue; submissionId (release only): the approved submission to commit, exactly as reviewed and once; reason: the owner's words)", mode: "propose" },
  // How finished work lands (card P08b): where work reaches the codebase is authority, so it is shown first in every profile. The record and the rules are the same as through the API.
  // Ending an integrator lease by force (card P10): the owner names the project's branch; shown first because it stops the integrator's landing at once.
  // Taking a task's approved submission out of the landing queue (card P10): it changes what lands next, so it is shown first.
  "landing.queue.remove": { verb: "Take a task's approved work out of the landing queue so it does not land next (reason: the owner's words)", mode: "propose" },
  "integrator.lease.release": { verb: "End the integrator lease of a landing branch by force (the holder's landing stops; branch: the branch's name)", mode: "propose", needsProject: true },
  "integration.set": { verb: "Change how finished work lands", mode: "propose", needsProject: true },
  "integration.default.set": { verb: "Change how new projects land finished work", mode: "propose" },
  // Project resources, plan and responsibilities (card P01). A read-only bind of a location the owner typed in their own words follows the profile like other explicit orders; write access, an acknowledged overlap and anything quoted are shown first.
  "resource.bind": { verb: "Bind resource", mode: "profile", needsProject: true },
  "project.plan": { verb: "Plan project", mode: "apply", revision: "project", needsProject: true },
  "responsibility.create": { verb: "Create responsibility", mode: "propose", needsProject: true },
  // Maintenance leases on a managed resource (card P04). Taking one only reserves the resource for the agent and is undone by releasing it, so it applies at once; releasing another agent's lease by force, or ending one with a failed validation (a rollback or an escalation), acts on a resource or opens an incident: shown first.
  // Changing a responsibility (card P04): pausing it stops new checks without stopping the managed service, resuming restarts them, retiring is final and releases its resources, and a new answerable agent or escalation target changes who answers: shown first in every profile. The revision is read for the owner.
  "responsibility.update": { verb: "Change a responsibility (pause, resume, retire it, or change its agent, schedule or escalation)", mode: "propose", revision: "responsibility", needsProject: true },
  // Resolving an incident records the owner's evidence that it is over and changes nothing else; the owner's explicit order follows the profile.
  "incident.resolve": { verb: "Resolve an incident", mode: "profile", needsProject: true },
  "lease.acquire": { verb: "Take the maintenance lease on a resource", mode: "apply", needsProject: true },
  "lease.release": { verb: "Release a maintenance lease (with the result of validating the change, or by force)", mode: "propose", needsProject: true },
  // Topics for a later stand-up (card M03). Capturing and correcting are reversible edits of a saved topic and apply at once, shown back to the owner; a topic that records an instruction or a decision for the team is first shown (see `proposalReason`).
  "agenda.capture": { verb: "Add agenda item", mode: "apply", needsProject: true },
  "agenda.correct": { verb: "Correct agenda item", mode: "apply", revision: "agenda", needsProject: true },
  // Card B02: settling an observation (promoted to an improvement proposal, dismissed, resolved, or open again) changes no work; the revision is read for the owner.
  "observation.dispose": { verb: "Settle an observation (observationId from the observations status; to promoted with improvementId, dismissed or resolved with the owner's reason, or open; owner optional)", mode: "apply", revision: "observation" },
  // Card B03: the owner proposes a lesson (it is only a candidate until evaluated) and evaluates one; neither changes work or grants anything, and a decision can be reviewed again, so both apply at once. The revision is read for the owner.
  "lesson.propose": { verb: "Propose a lesson (title, statement and applicability in the owner's words; evidence from the observations status or other records; dependsOn, revises, supersedes, contradicts only when the owner names lessons)", mode: "apply", needsProject: true },
  // Card B04: the owner proposes a bounded experiment and pins its criteria, concludes it or withdraws it; none of these spends or launches anything (the runs are reported by the proposer), so they apply at once. A budget raise allows more spending later, so it is always a proposal the owner confirms.
  "experiment.propose": { verb: "Propose an experiment (title, the proposal's problem, affectedWork, change, effort, runningCost, benefit, evaluation and stoppingCondition, and a short affectedKey, all in the owner's words)", mode: "apply", needsProject: true },
  "experiment.pin": { verb: "Pin an experiment's criteria and start it (experimentId from the experiments status; baseline and evaluator label, ref and SHA-256 digest, the separate evaluation cases, the baseline's numbers, the budget; only values the owner gave)", mode: "apply", revision: "experiment" },
  "experiment.budget": { verb: "Raise an experiment's budget (experimentId; maxRuns, maxCost and the reason in the owner's words)", mode: "propose", revision: "experiment" },
  "experiment.conclude": { verb: "Conclude an experiment with the owner's finding (experimentId from the experiments status; the controller decides the verdict from the runs)", mode: "apply", revision: "experiment" },
  "experiment.withdraw": { verb: "Withdraw an experiment that has not started (experimentId, with the owner's reason)", mode: "apply", revision: "experiment" },
  "lesson.decide": { verb: "Evaluate or review a lesson (lessonId from the lessons status; to evaluating, accepted, rejected, inconclusive or needs-review, with the owner's finding)", mode: "apply", revision: "lesson" },
  // Stand-ups (card M03g). Pausing or renaming one follows the profile like other explicit orders; ending (cannot be undone) and resuming are always shown first; a change of who attends or when it is held is shown first (see `proposalReason`). Setting one up wakes agents on a schedule, so it is always shown first. Delivering outcomes only puts decisions back where they came from.
  "standup.update": { verb: "Change stand-up", mode: "profile", revision: "standup", needsProject: true },
  "standup.configure": { verb: "Set up stand-up", mode: "propose", needsProject: true },
  "standup.deliver": { verb: "Deliver stand-up outcomes", mode: "apply", needsProject: true },
  // Running a stand-up and leaving a note for an agent from the chat (card M03h). Preparing notifies the agents of a stand-up now instead of at its usual time, and a note goes into an agent's brief, so both are shown first and the owner can reword them before they run. Reading a brief is a status question.
  "standup.prepare": { verb: "Prepare a stand-up now", mode: "propose", needsProject: true },
  "standup.add-statement": { verb: "Add a note to an agent's stand-up brief", mode: "propose", needsProject: true },
  // The owner's answer to a question a stand-up asked (card M03h): the owner's own words, applied at once like the answer to an agent's question; it is shown first only when no question was clearly named.
  "standup.answer-question": { verb: "Answer a stand-up's question", mode: "apply", needsProject: true },
  // The owner's answer to an adopted meeting decision that waits for them (card M02h): agree (the remaining changes are carried out), decline, or an alternative in the owner's own words. It is found by its wording or topic, never by an ID the owner would have to know, and it is always shown first: agreeing lets changes that widen what agents may do go ahead, and neither answer can be taken back.
  "meeting.record.owner-respond": { verb: "Answer a meeting decision", mode: "propose" },
  // The owner's controls of a meeting that is running (card M05): ask one agent, speak to the team, open or end an inquiry, change what matters most. Words only: a question or a message of the owner's own is recorded and applies at once, like the owner's
  // other words to the team; more time or spend, a change of the meeting's settings, starting a run and ending the meeting (it cannot be taken back) are shown first.
  "meeting.floor.start": { verb: "Start the facilitated run of a meeting", mode: "propose" },
  "meeting.floor.ask": { verb: "Ask a meeting member a question", mode: "apply" },
  "meeting.floor.address": { verb: "Speak to the whole meeting", mode: "apply" },
  "meeting.floor.inquiry-open": { verb: "Open an inquiry in a meeting", mode: "apply" },
  "meeting.floor.inquiry-end": { verb: "End the inquiry (done with questions)", mode: "apply" },
  "meeting.floor.priorities": { verb: "Change what matters most in a meeting", mode: "apply", needsProject: true },
  "meeting.floor.extend": { verb: "Give a meeting more time or model spend", mode: "propose" },
  "meeting.floor.configure": { verb: "Change how one meeting runs", mode: "propose" },
  "meeting.floor.end": { verb: "End a meeting that is being facilitated", mode: "propose" },
  "meeting.floor.follow-ups": { verb: "Turn what a meeting left open into follow-up tasks", mode: "apply" },
  // The owner's other meeting controls (card M02h): opening and closing the vote on a motion, tabling it, ending a meeting and carrying out a decision's agreed changes again. Each is found by the owner's words, never an ID, and always
  // shown first: a vote that is opened or counted turns into a decision the team carries out, tabling and ending cannot be taken back, and applying carries out changes the owner agreed to (or the vote carried).
  "meeting.record.open-vote": { verb: "Open the vote on a motion", mode: "propose" },
  "meeting.record.close-vote": { verb: "Count the vote on a motion and close it", mode: "propose" },
  "meeting.record.table": { verb: "Table a motion", mode: "propose" },
  "meeting.record.finish": { verb: "End a meeting", mode: "propose" },
  "meeting.record.apply": { verb: "Carry out a meeting decision's remaining changes", mode: "propose" },
  // Handing a meeting's outcomes back to the conversations they came from, and (card M05) asking the owner about each decision the meeting deferred. Found by the owner's words about the meeting; shown first, because it settles agenda topics and may put questions in the owner's own inbox.
  "meeting.record.outcomes": { verb: "Hand a meeting's outcomes back", mode: "propose" },
  // The meeting procedure's owner controls (card M06): ruling on the objections or requests for research that hold a vote, overruling a tabling (the vote goes ahead anyway) and writing to a meeting. Each is found by the owner's words, never an ID, and shown first:
  // a ruling decides whether a vote is held, a tabling cannot be taken back except by this very overrule, and a message goes to every member who speaks after it.
  "meeting.proc.rule": { verb: "Rule on the objections to a motion", mode: "propose" },
  "meeting.proc.untable": { verb: "Overrule a tabling and put the motion to a vote", mode: "propose" },
  "meeting.proc.owner-message": { verb: "Write to a meeting", mode: "propose" },
  // The procedure is the one service that runs a motion (cards M05 and M06): the owner starts it and moves it a step by words, and overrules a challenged chair question.
  "meeting.proc.begin": { verb: "Start the procedure for a motion", mode: "propose" },
  "meeting.proc.advance": { verb: "Move a motion's procedure one step", mode: "propose" },
  "meeting.floor.cq-rule": { verb: "Rule on a challenged chair question", mode: "propose" },
  // A decision the owner states (card C08b): recorded from this very turn, with the owner's own words as the wording. The version it is based on is read from the records, not said.
  "decision.record": { verb: "Record decision", mode: "apply", revision: "decision", needsProject: true },
  // An answer to a question an agent put to the owner (card U12e): the answer is the owner's own words; the question is named by its words or, when only one waits, needs no name.
  "owner.answer": { verb: "Answer question", mode: "apply" },
  // Answering an item of the Needs-you list where it stands (card U11d): a review only the owner decides and a blocker only the owner resolves have no other command, and every kind can be answered this way. Shown first, with the item.
  "needs-you.answer": { verb: "Answer an item in your Needs-you list", mode: "propose" },
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
  // Waking a stopped agent for one meeting and ending that wake (card M04h). Waking runs an agent the owner stopped, so it follows the profile like the invitation; ending it only returns the agent to rest, so it applies at once.
  "meeting.attend.wake": { verb: "Wake a stopped agent for a meeting", mode: "profile", needsProject: true },
  "meeting.attend.wake-stop": { verb: "Stop the wake of an agent for a meeting", mode: "apply", needsProject: true },
  // How notifications reach the owner (card U11b): digest times, quiet hours, the hours before an unanswered item is escalated, and the channel. It only changes how the owner is told, can be set back by saying so, and applies from the next notification, so an explicit order applies at once. The settings revision is read, not quoted.
  // The critical path (card U11d, "U11f"): what the owner marks decides what is listed first and what pages them, so marking or unmarking is always shown first. The task is named by its title (taskTitle) and the project by its name (projectName).
  "critical.mark": { verb: "Mark or unmark the critical path (kind task, goal or project; marked false takes the mark off)", mode: "propose" },
  "notifications.configure": { verb: "Change how notifications reach you", mode: "profile", revision: "notifications" },
  // Money (card chat-gaps). Spending more, opening or ending a budget, and a cap on all spending are decisions about money: shown first in every profile. The aggregate cap is optional and off until set; turning it off is also shown first (it lifts a limit).
  "budget.decide": { verb: "Decide a request for more budget", mode: "propose" },
  "budget.open": { verb: "Open a budget for task", mode: "propose", needsProject: true },
  "budget.raise": { verb: "Add to the budget of task", mode: "propose", needsProject: true },
  "budget.close": { verb: "Close the budget of task", mode: "propose", needsProject: true },
  "budget.aggregate.set": { verb: "Set the overall spending cap", mode: "propose" },
  // Which branches are protected is authority (a push or merge that touches one stays the owner's decision): shown first, both the replacing form and the merging form the chat prefers.
  "project.branches.set": { verb: "Set the protected branches of project", mode: "propose", needsProject: true },
  "project.branches.change": { verb: "Change the protected branches of project", mode: "propose", needsProject: true },
  // The work-in-progress backup pushes a project's unfinished work to a remote the owner names: turning it on (or pointing it at another remote) is an authority and is shown first; turning it off only stops it and applies at once.
  "wip.backup.set": { verb: "Turn the work-in-progress backup of project on or off, or change its remote or interval (remote: the address or folder, copied exactly)", mode: "propose", needsProject: true },
  // A restore writes files on the owner's computer from a remote branch: shown first, with the task named.
  "wip.backup.restore": { verb: "Restore a task's workspace of project from its work-in-progress backup (taskId: the task)", mode: "propose", needsProject: true },
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
  // How long a route's replies may be and how much of them may go on reasoning (card W07): it changes every later model call of the route, and a reply cut at the limit is continued with a nudge, so it is shown first in every profile.
  "routing.budget.set": { verb: "Limit a model route's replies (maxTokens) and reasoning (reasoningTokens), in tokens; null removes a limit", mode: "propose" },
  // Jobs (card T07b): stopping one follows the approval profile like other reversible controls of running work; a restart decision and settling an outcome-unknown job with evidence are shown first in every profile (provisional), since they record how work ended.
  "job.cancel": { verb: "Stop a long-running job (a tool an agent started, a remote job or an MCP operation) by its job ID from the jobs status; force true is the Force Stop (at once, or when a stop was not obeyed)", mode: "profile" },
  "job.decide": { verb: "Decide what becomes of a job that was live when the controller restarted: complete (exit needed), cancel, restart from its checkpoint, or keep it as a tracked exception (tracker needed)", mode: "propose" },
  "job.reconcile": { verb: "Settle an outcome-unknown job as completed, failed or cancelled, with the evidence the owner gives", mode: "propose" },
  // How tasks are matched to model profiles decides what they cost and where they run: the profiles are shown first; a task's own difficulty follows the profile.
  "difficulty.set-profiles": { verb: "Replace the difficulty profiles", mode: "propose", revision: "difficulty-profiles" },
  // Release testing (card X09b). Starting a destructive test on a host is shown first (provisional); cancelling is the safe direction and applies at once (an ended attempt is never a pass). Who besides the owner may start or cancel is a widening
  // when turned on (shown first) and a narrowing when turned off (applies at once).
  // Submitting a candidate (card X09b finish) records what is to be tested and nothing else, but the platforms it lists decide what approval requires (one left out is never tested), so it is shown first with its platforms.
  "release.submit": { verb: "Submit a release candidate for testing", mode: "propose" },
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
  "maintenance.settings.set": { verb: "Change the environment-change settings (who may decide which kinds, who the administrators for host policy and the shared base are, request caps, how long an application may run, how often they are handled)", mode: "propose" },
  "maintenance.settings.enable": { verb: "Turn on environment change requests, supervisor decisions or automatic rules", mode: "propose" },
  "maintenance.settings.disable": { verb: "Turn off environment change requests, supervisor decisions or automatic rules", mode: "apply" },
  "maintenance.site.set": { verb: "Set the rule for a network site", mode: "propose" },
  "maintenance.catalogue.add": { verb: "Preapprove a package", mode: "propose" },
  "maintenance.catalogue.remove": { verb: "Remove a package from the preapproved list", mode: "apply" },
};

/** Names the owner may use in place of an ID; each is resolved from records and an unclear match asks. */
export const TITLE_KEYS: Readonly<Record<string, string>> = { taskTitle: "taskId", prerequisiteTitle: "prerequisiteId" };

/** The argument names the operation takes (from the API's own table, so they cannot drift), plus the chat-only names and the revision the chat fills in. */

const DURATION_NUMBERS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, next: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty-four": 24, thirty: 30, forty: 40, "forty-five": 45, "forty five": 45, fifty: 50, sixty: 60, ninety: 90 };
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
  // A number in words is apart from its unit ("an hour", "two-day"): run together it is another word ("and" is not "an d", "am" not "a m", "ah" not "a h").
  const re = new RegExp(`(?:^|[^0-9a-z.])(?<![0-9],)(\\d+(?:\\.\\d+)?|(?:${Object.keys(DURATION_NUMBERS).sort((x, y) => y.length - x.length).join("|")})(?=[ -]))[ -]?(${units})\\b`, "g");
  for (const m of t.matchAll(re)) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : DURATION_NUMBERS[m[1]!]!;
    if (Math.round(n * DURATION_UNITS[m[2]!]!) === seconds) return true;
  }
  return false;
}

/** Month names, so the day after one (`Nov 3`, `3rd of November`) is not read as a time of day or a length. */
const MONTH_NAMES = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/**
 * The owner's message made ready for reading numbers: curly quotes straightened, lowercased, and the numbers that are not lengths, sizes or times of day blanked so their digits are never read as
 * one: record IDs (anything shaped like `rcn-...`), days (`2026-11-21`, `21/11/2026`, `11/21`, `21.11.2026`, `Nov 3`, `3rd of November`) and versions (`2.1.3`, `v2.1`).
 */
const numbersOf = (text: string): string => text.replace(/[‘’]/g, "'").toLowerCase()
  .replace(/\b[a-z]+-[a-z0-9-]*\d[a-z0-9-]*/g, " ")
  .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}\/\d{1,2}\b/g, " ")
  .replace(/\bv\d+(?:\.\d+)*\b|\b\d+\.\d+\.\d+\b/g, " ")
  .replace(new RegExp(`\\b(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_NAMES})\\b`, "g"), " ");
const NUMBER_WORDS = (): string => Object.keys(DURATION_NUMBERS).sort((x, y) => y.length - x.length).join("|");
const numberOf = (word: string): number => (/^\d/.test(word) ? Number(word) : DURATION_NUMBERS[word]!);
/** The hours of the clock in words ("from two to four am"). */
const HOUR_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** A time of day as people write it: `4`, `4:30`, `4.30`, `4am`, `4 p.m.`, `four`, `half past 4`, `quarter to five`, `midnight`, `noon`. Not one when a unit follows (`4 hours`, `5 GB`, `one of`). */
const CLOCK = (() => {
  const hour = `(?:\\d{1,2}|${Object.keys(HOUR_WORDS).sort((x, y) => y.length - x.length).join("|")})`;
  const units = [...Object.keys(DURATION_UNITS), "kb", "mb", "gb", "tb", "kib", "mib", "gib", "tib", "gig", "gigs", "meg", "megs", "bytes?", "percent", "of"].sort((x, y) => y.length - x.length).join("|");
  return `(?<![0-9a-z.:,])(?:midnight|noon|midday|(?:half|quarter)\\s+(?:past|to)\\s+${hour}|${hour}(?:[:.]\\d{2}|\\s+o'?clock)?)(?:\\s*[ap]\\.?m\\b\\.?)?(?![0-9a-z:%]|\\.\\d|\\s*(?:${units})\\b|\\s*%)`;
})();
const WEEKDAYS = "mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
/** Words before a bare hour that say it is a time of day ("at 2", "from 2", "tonight 2 to 4", "Saturday 2-4"); after a comma or at the start of the message one needs none. */
const TIME_BEFORE = `from|between|at|after|around|about|tonight|today|tomorrow|morning|night|evening|afternoon|overnight|${WEEKDAYS}|it|window|downtime|outage|maintenance|starting|start|starts|begin|begins|do|run|say`;
/** Words after a bare hour that say it is a time of day ("2 to 4 London time", "until 4 in the morning", "between 2 and 3 tonight"); a following thing counted ("2 to 3 hosts") says it is not. */
const TIME_AFTER = `to|through|thru|until|till|til|and|or|then|end|ends|ending|finish|finishes|finishing|stop|stops|stopping|done|wrap|with|in|on|tonight|today|tomorrow|this|next|for|so|but|if|when|o'?clock|oclock|sharp|ish|local|utc|gmt|bst|cet|cest|[ecmp][sd]?t|eastern|central|mountain|pacific|(?:[a-z]+\\s+){0,2}time|${WEEKDAYS}|morning|night|evening|afternoon|overnight|at\\s+night|please|is|works|would|should|will|ok|okay|fine|thanks`;
/** The minutes after midnight a time of day written as `CLOCK` may mean: one marked am or pm, or past 12, is read that way only; one without is read both ways round the clock. */
function clockTimes(written: string): number[] {
  const x = written.trim().replace(/\s+o'?clock$/, "");
  if (x === "midnight") return [0];
  if (x === "noon" || x === "midday") return [720];
  const m = /^(?:(half|quarter)\s+(past|to)\s+)?(\d{1,2}|[a-z]+)(?:[:.](\d{2}))?(?:\s*([ap])\.?m\b\.?)?$/.exec(x);
  if (m === null) return [];
  const h = /^\d/.test(m[3]!) ? Number(m[3]) : HOUR_WORDS[m[3]!];
  if (h === undefined || (m[1] !== undefined && m[4] !== undefined) || (m[1] === "half" && m[2] === "to")) return [];
  const mm = m[4] === undefined ? 0 : Number(m[4]);
  if (mm > 59) return [];
  let hours: number[];
  if (m[5] !== undefined) {
    if (h < 1 || h > 12) return [];
    hours = [(h % 12) + (m[5] === "p" ? 12 : 0)];
  } else if (h === 24) {
    if (mm !== 0 || m[1] !== undefined) return [];
    hours = [0];
  } else if (h > 24) return [];
  else hours = h === 0 || h > 12 ? [h] : [h, (h + 12) % 24];
  const shift = m[1] === "half" ? 30 : m[1] === "quarter" ? (m[2] === "past" ? 15 : -15) : 0;
  return hours.map((hh) => (hh * 60 + mm + shift + 1440) % 1440);
}

/**
 * Whether the owner's own words give this length of a maintenance window in minutes (card K07): a length said outright ("for 90 minutes", "an hour", "2 hrs", "half an hour"), hours and minutes
 * together ("an hour and a half", "two and a half hours", "2 hours and 30 minutes", "1h30m", "an hour and a quarter"), or an end time after the start the proposal shows, with that start written too
 * ("from 2 to 4am", "3am until 4:30", "between 2 and 3", "2-4am", "at 11pm, done by 1am", "from 10pm till midnight"). An end time written without am or pm is read both ways round the clock; the length
 * the window would be set with is still shown on the proposal for the owner to confirm. A length said as when the window starts or how early to prepare ("in 2 hours", "30 minutes before", "the next
 * day") is not its length. A number the model chose is not the owner's, so a length found nowhere in the words is asked for instead of proposed.
 */
export function windowLengthInWords(minutes: number, start: unknown, text: string): boolean {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return false;
  const n = NUMBER_WORDS();
  const amount = `(?:\\d+(?:\\.\\d+)?|half\\s+an?|${n})[ -]?(?:${Object.keys(DURATION_UNITS).sort((x, y) => y.length - x.length).join("|")})\\b`;
  // Lengths that say when the window starts or when to prepare, not how long it lasts.
  const t = numbersOf(text)
    .replace(new RegExp(`(?<!\\b(?:done|finished|over|complete|completed)\\s)\\b(?:in|within)\\s+(?:the\\s+next\\s+)?${amount}`, "g"), " ")
    .replace(new RegExp(`${amount}\\s+(?:before|ahead|early|earlier|beforehand|prior|in\\s+advance|ago)\\b`, "g"), " ")
    .replace(new RegExp(`\\b(?:every|each)\\s+${amount}`, "g"), " ")
    .replace(/\b(?:the\s+)?(?:next|following)\s+day\b|\ba\s+day\s+(?:after|later)\b/g, " ");
  if (durationInWords(minutes * 60, t)) return true;
  // Hours and minutes said together, and halves and quarters of an hour.
  // As in `durationInWords`, a number in words is apart from its unit ("ah am I late" is not an hour and a minute).
  for (const m of t.matchAll(new RegExp(`(?:^|[^0-9a-z.,])(\\d+|(?:${n})(?=[ -]))[ -]?(?:hours?|hrs?|h)(?:,?\\s*and)?\\s*(\\d+|(?:${n})(?=[ -]))[ -]?(?:minutes?|mins?|m)\\b`, "g"))) if (numberOf(m[1]!) * 60 + numberOf(m[2]!) === minutes) return true;
  for (const m of t.matchAll(new RegExp(`(?:^|[^0-9a-z.,])(\\d+|${n})\\s+(?:hours?\\s+and\\s+a\\s+(half|quarter)|and\\s+a\\s+(half|quarter)\\s+hours?)\\b`, "g"))) if (numberOf(m[1]!) * 60 + ((m[2] ?? m[3]) === "half" ? 30 : 15) === minutes) return true;
  if (minutes === 15 && /\b(?:a\s+)?quarter\s+of\s+an\s+hour\b/.test(t)) return true;
  if (minutes === 45 && /\bthree\s+quarters\s+of\s+an\s+hour\b/.test(t)) return true;
  // An end time after the start the proposal shows: the start must be written too, so a start the model chose cannot make a length out of an end time.
  const at = typeof start === "string" ? /^(\d{2}):(\d{2})$/.exec(start) : null;
  if (at === null) return false;
  const from = Number(at[1]) * 60 + Number(at[2]);
  const fits = (end: number): boolean => (end - from + 1440) % 1440 === minutes;
  const isStart = (written: string): boolean => clockTimes(written).includes(from);
  // A bare hour ("2", "four") is a time of day only where a time is spoken of: not "2 to 3 hosts", "scale from 2 to 4 workers", "release 2-3 tonight" or "version 2 through 4 are broken". One marked
  // am or pm, written with minutes, or midnight or noon needs no such check.
  const bare = (x: string): boolean => /^\s*(?:\d{1,2}|[a-z]+)\s*$/.test(x) && !/midnight|noon|midday/.test(x);
  const before = (at: number): boolean => new RegExp(`(?:^|[^\\sa-z0-9'])\\s*$|\\b(?:${TIME_BEFORE})\\s+$`).test(t.slice(Math.max(0, at - 40), at));
  const after = (at: number): boolean => new RegExp(`^(?:\\s*$|\\s*[^\\sa-z0-9']|\\s+(?:${TIME_AFTER})\\b)`).test(t.slice(at, at + 60));
  // A range with both ends written: "from 2 to 4am", "2-4am", "between 2 and 3", "10pm till midnight".
  for (const m of t.matchAll(new RegExp(`(${CLOCK})\\s*(?:to|through|thru|until|till|til|-|–|—)\\s*(${CLOCK})|\\bbetween\\s+(${CLOCK})\\s+and\\s+(${CLOCK})`, "dg"))) {
    const [si, ei] = m[1] !== undefined ? [1, 2] : [3, 4];
    const [s, e] = [m[si]!, m[ei]!];
    // `11-03` is a day, not a range: a dash range's end is not written with a leading zero.
    if (/^\s*[-–—]/.test(m[0].slice(s.length)) && /^0\d$/.test(e.trim())) continue;
    if (bare(s) && bare(e) && !(before(m.indices![si]![0]) && after(m.indices![ei]![1]))) continue;
    if (isStart(s) && clockTimes(e).some(fits)) return true;
  }
  // An end time said alone ("at 2 ... until 4", "at 11pm, done by 1am"), with the start written elsewhere in the words as a time of day. A bare "to 4" or "by 4" says an end only when marked
  // am or pm, written with minutes, or midnight or noon ("rollback to 2", "up to 2 hours" are not end times); "until 4", "done by 4" and "ending at 4" always do.
  const written = [...t.matchAll(new RegExp(CLOCK, "g"))].map((m) => ({ at: m.index, text: m[0] })).filter((w) => !bare(w.text) || (before(w.at) && after(w.at + w.text.length)));
  const marked = (e: string): boolean => /[ap]\.?m|:|midnight|noon|midday/.test(e);
  for (const m of t.matchAll(new RegExp(`(\\b(?:until|till|til|(?:done|finished|over|complete|completed|back|wrapped\\s+up|wrap\\s+up)\\s+by|(?:end|ends|ending|finish|finishes|finishing|stop|stops|stopping)(?:\\s+at)?)\\s+(?:about\\s+|around\\s+)?|\\b(?:to|through|thru|by)\\s+)(${CLOCK})`, "g"))) {
    const e = m[2]!;
    if (/^(?:to|through|thru|by)\s/.test(m[1]!) && !marked(e)) continue;
    const endAt = m.index + m[1]!.length;
    if (bare(e) && !after(endAt + e.length)) continue;
    if (written.some((w) => w.at !== endAt && isStart(w.text)) && clockTimes(e).some(fits)) return true;
  }
  return false;
}

/** Whether the owner's own words give this preparation lead in minutes (card K07): a length said outright, or none at all ("0 minutes", "no lead time", "no preparation lead"). */
export function leadInWords(minutes: number, text: string): boolean {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return false;
  if (minutes === 0) return /(?:^|[^0-9.])(?:0|zero)\s*(?:minutes?|mins?|m)\b|\bno\s+(?:preparation\s+)?lead\b/.test(numbersOf(text));
  // A length said as how long ago something happened ("5 minutes ago") is not a lead.
  return durationInWords(minutes * 60, numbersOf(text).replace(/\b(?:\d+(?:\.\d+)?|[a-z-]+)\s*(?:minutes?|mins?|m|hours?|hrs?|h)\s+ago\b/g, " "));
}

const SIZE_UNITS: Readonly<Record<string, readonly number[]>> = {
  b: [1], byte: [1], bytes: [1],
  kb: [1e3, 1024], kilobyte: [1e3, 1024], kilobytes: [1e3, 1024], kib: [1024],
  mb: [1e6, 1024 ** 2], megabyte: [1e6, 1024 ** 2], megabytes: [1e6, 1024 ** 2], mib: [1024 ** 2], meg: [1e6, 1024 ** 2], megs: [1e6, 1024 ** 2],
  gb: [1e9, 1024 ** 3], gigabyte: [1e9, 1024 ** 3], gigabytes: [1e9, 1024 ** 3], gib: [1024 ** 3], gig: [1e9, 1024 ** 3], gigs: [1e9, 1024 ** 3], g: [1e9, 1024 ** 3],
  tb: [1e12, 1024 ** 4], terabyte: [1e12, 1024 ** 4], terabytes: [1e12, 1024 ** 4], tib: [1024 ** 4],
};
/**
 * Whether the owner's own words give this amount of free space in bytes (card K07, a window's `minFreeBytes`): "5 GB", "2 gigabytes", "500 MiB", "1.5 TB", "a gigabyte", "0 bytes". A size in
 * gigabytes and the like may be read in powers of ten or of 1024 (people mean either); the exact number of bytes is shown on the proposal for the owner to confirm.
 */
export function sizeInWords(bytes: number, text: string): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
  const t = numbersOf(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const units = Object.keys(SIZE_UNITS).sort((x, y) => y.length - x.length).join("|");
  for (const m of t.matchAll(new RegExp(`(?:^|[^0-9a-z.])(?<![0-9],)(\\d+(?:\\.\\d+)?|(?:${NUMBER_WORDS()}|zero)(?=[ -]))[ -]?(${units})\\b`, "g"))) {
    const n = m[1] === "zero" ? 0 : numberOf(m[1]!);
    if (SIZE_UNITS[m[2]!]!.some((u) => Math.round(n * u) === bytes)) return true;
  }
  return false;
}

/** The month names an owner may write for a date, abbreviations included because people write `Nov 30`. */
const MONTH_WORDS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
/** The two times of a right. They are checked by `grantDateInWords` (a day the owner named, not the exact characters of an ISO moment), so `foreignValue` is told to leave them alone. */
export const GRANT_DATE_KEYS: ReadonlySet<string> = new Set(["notBefore", "expiresAt"]);
/**
 * A bundle of rights (card D01): `bundle: "roles"` on grant.create asks for every right the named agent's own roles stand for (the role templates), in the one project named, so an owner can say
 * "let Ann work on Garden" instead of naming each right. It is a fixed choice, not words the owner has to say; the rights it expands to are shown one per line before anything is given.
 */
export const GRANT_BUNDLES: ReadonlySet<string> = new Set(["roles"]);
/** What `foreignValue` leaves alone on grant.create: the two times (checked by `grantDateInWords`) and the bundle (a fixed choice, checked by the chat). */
export const GRANT_EXEMPT: ReadonlySet<string> = new Set([...GRANT_DATE_KEYS, "bundle"]);
/** The most rights one bundle may propose at once: each is a line of the proposal, and a proposal shows at most 40 lines. */
export const GRANT_BUNDLE_LIMIT = 30;

/**
 * The moment a right starts or ends, when the owner's own words give that day (card U03e). What counts as their day: the moment as written (what `foreignValue` looks for in every other text of a
 * command), an ISO day `2026-11-30` (alone or with a time after it), a slashed `30/11/2026` or `11/30/26` — both readings of the pair count, and the moment the proposal shows settles which one the
 * owner meant — or a written day and month (`30 November`, `November 30th`, `the 30th of Nov 2026`), with the year they wrote when they wrote one. "the end of the month", "a few more days" and "when
 * the audit is done" name no day the controller can check, so they give no date: the day would be the model's, and the right is not drawn up. The time of day is the interpreter's reading of the day
 * the owner named and is shown on the proposal line the owner confirms. Returns the moment in the UTC form the state API records, or undefined when the words do not give it.
 */
export function grantDateInWords(value: unknown, ownText: string): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const when = new Date(ms);
  const iso = when.toISOString();
  const own = ` ${ownText.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim()} `;
  // What the interpreter wrote, standing in the owner's message: the search `foreignValue` makes for every other text of a command. Only a moment that carries a calendar date is searched for, so a
  // value like "0" cannot be "said" by any message that happens to hold the digit.
  const given = value.toLowerCase().trim();
  if (/\d{4}-\d{2}-\d{2}/.test(given) && own.includes(given)) return iso;
  // The day is the one on the calendar where the moment was written: an end of "Nov 30" written as 2026-11-30T23:59-08:00 is Dec 1 in UTC, and the owner's day is still the 30th. The UTC day is
  // accepted too (a moment written in UTC, or one the owner wrote that way). The moment recorded and shown is the same either way.
  const written = /^(\d{4})-(\d{2})-(\d{2})(?:[t ]|$)/.exec(given);
  const days: { year: number; month: number; day: number; text: string }[] = [{ year: when.getUTCFullYear(), month: when.getUTCMonth() + 1, day: when.getUTCDate(), text: iso.slice(0, 10) }];
  if (written !== null && written[0].slice(0, 10) !== iso.slice(0, 10)) days.push({ year: Number(written[1]), month: Number(written[2]), day: Number(written[3]), text: written[0].slice(0, 10) });
  return days.some((d) => dayInWords(d, own)) ? iso : undefined;
}

/** Whether the owner's words (lowercased, padded) name this calendar day: see `grantDateInWords`. */
function dayInWords({ year, month, day, text }: { year: number; month: number; day: number; text: string }, own: string): boolean {
  // 2026-11-30, on its own or followed by a time (`wholeWord` will not match a day running straight into a `T`).
  if (wholeWord(own, text) || new RegExp(`${text}[t ]\\d{1,2}:\\d{2}`, "i").test(own)) return true;
  // A slashed or dashed numeric day, read either way round; the shown moment is what the owner confirms.
  for (const m of own.matchAll(/(?:^|[^0-9])(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:[^0-9]|$)/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]) !== year) continue;
    if ((a === day && b === month) || (a === month && b === day)) return true;
  }
  // A written month with a day, in either order, with the year when the owner wrote one (26 and 2026 both count as their own spelling).
  const names = Object.keys(MONTH_WORDS).sort((x, y) => y.length - x.length).join("|");
  const ordinal = "(?:st|nd|rd|th)?";
  const yearSaid = "(?:,?\\s+(?<year>\\d{4}|\\d{2}))?";
  const sameYear = (m: RegExpMatchArray): boolean => {
    const written = m.groups?.["year"];
    if (written === undefined) return true;
    const n = written.length === 2 ? (Number(written) < 70 ? 2000 + Number(written) : 1900 + Number(written)) : Number(written);
    return n === year;
  };
  const dayFirst = new RegExp(`(?:^|[^0-9])(\\d{1,2})${ordinal}(?:\\s+of)?\\s+(${names})${yearSaid}(?:[^0-9a-z]|$)`, "g");
  const monthFirst = new RegExp(`(?:^|[^a-z])(${names})\\s+(\\d{1,2})${ordinal}${yearSaid}(?:[^0-9a-z]|$)`, "g");
  for (const m of own.matchAll(dayFirst)) if (Number(m[1]) === day && MONTH_WORDS[m[2]!] === month && sameYear(m)) return true;
  for (const m of own.matchAll(monthFirst)) if (Number(m[2]) === day && MONTH_WORDS[m[1]!] === month && sameYear(m)) return true;
  return false;
}

export function acceptedArgs(op: string): readonly string[] | undefined {
  const operation = OPERATION_BY_NAME.get(op);
  if (operation === undefined || operation.kind !== "command") return undefined;
  // `agendaTopic` names an agenda item by its words; the chat resolves it to the item (exactly one open item of the project, else it asks).
  return [...Object.keys(operation.args).map((k) => k.replace(/\?$/, "")).filter((k) => k !== "commandId" && !(op === "meeting.record.owner-respond" && k === "alternative") && !(op === "meeting.record.open-vote" && k === "limitMinutes")), ...Object.keys(TITLE_KEYS), "projectName", ...(op === "agenda.correct" ? ["agendaTopic"] : []), ...(op === "standup.update" ? ["standupTitle"] : []), ...(op === "responsibility.update" || op === "responsibility.probe.set" ? ["responsibilityTitle"] : []), ...(op === "incident.resolve" ? ["responsibilityTitle", "incidentSignature"] : []), ...(op === "lease.acquire" || op === "lease.release" ? ["resourceLabel"] : []), ...(op === "release.cancel" ? ["candidateId"] : []), ...(op === "retirement.agent" ? ["agentName"] : []), ...(op === "owner.answer" || op === "standup.answer-question" ? ["questionTopic"] : []), ...(op === "needs-you.answer" ? ["itemTopic"] : []), ...(op === "meeting.invite-direct" || op === "meeting.attend.wake" || op === "meeting.attend.wake-stop" || op === "standup.add-statement" ? ["meetingTopic", "agentName"] : []), ...(op === "standup.prepare" ? ["meetingTopic"] : []), ...(op === "meeting.record.owner-respond" ? ["decisionTopic", "alternativeStatement", "alternativeTopic"] : []), ...(MOTION_CONTROLS.has(op) || op === "meeting.proc.rule" || op === "meeting.proc.untable" || op === "meeting.proc.begin" || op === "meeting.proc.advance" ? ["motionTopic"] : []), ...(FLOOR_CONTROLS.has(op) ? ["meetingTopic"] : []), ...(op === "meeting.floor.ask" || op === "meeting.floor.address" ? ["agentName"] : []), ...(op === "meeting.floor.priorities" ? ["agendaTopic", "urgency"] : []), ...(op === "meeting.proc.owner-message" ? ["meetingTopic"] : []), ...(op === "meeting.record.finish" || op === "meeting.record.outcomes" ? ["meetingTopic"] : []), ...(op === "meeting.record.apply" ? ["decisionTopic"] : []), ...(op === "watch.create" ? ["watchedTaskTitle", "watchedTaskId", "watchProject"] : []), ...(op === "watch.cancel" ? ["taskId", "watchId"] : []), ...(op === "handoff.prepare" || op === "handoff.takeover" ? ["toAgentName"] : []), ...(op === "task.assign" || op === "task.transfer" || op === "grant.create" || op === "toolbox.optin" ? ["agentName"] : []), ...(op === "grant.create" ? ["bundle"] : []), ...(op === "handoff.complete" || op === "handoff.cancel" || op === "resume.retry" || op === "resume.cancel" ? ["taskId"] : [])];
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
  "handoff.complete": ["acceptGaps", "reassignResponsibilities", "moveIntegratorLease"],
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
  // Card U14c review: a notification change follows the profile, except two moves that are more than how the owner is told. An external channel sends notifications out of the installation (where data
  // goes), and switching the security detectors off silences the security reports; a boolean is not a word the owner's-words check can see, so a model could add it to an unrelated order. Both are shown first in every profile.
  if (op === "notifications.configure" && (args["channel"] === "external" || args["channelName"] !== undefined)) return "it sends your notifications outside this installation, so it is shown first";
  if (op === "notifications.configure" && args["securityDetectors"] === false) return "it stops the controller's security reports, so it is shown first";
  if (op === "notifications.configure" && args["controllerDownNotice"] === false) return "it keeps back the notice that the controller was down, so it is shown first";
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
  // How finished work lands decides whether anything reaches main without a person (card P08b, redone): it is shown first in every
  // profile, the proposal line says in plain words what the landing does, and the owner's confirmation of that shown proposal is the
  // consent. No wording of theirs is scanned for a phrase, so nothing here asks them to say anything in particular.
  if (spec.mode === "propose" && (op === "integration.set" || op === "integration.default.set")) return landingOf(args) === "main-automatic" ? "finished work would go to main by itself with no human step, so this is shown first for you to confirm" : "how finished work lands is shown first";
  if (spec.mode === "propose" && op === "project.create" && landingOf(args) === "main-automatic") return "a new project is drafted first, and its finished work would go to main by itself with no human step";
  // The owner's words to a meeting apply at once, but words that amend the motion change what is voted on and restart its round and vote (card M05): shown first.
  if (op === "meeting.floor.address" && args["amend"] !== undefined) return "it changes the motion's wording, and a fresh round and vote follow, so it is shown first";
  // Forbidding best effort is the narrowing direction (a stricter launch rule): it applies at once when the owner's words say it. Allowing it is shown first.
  if (spec.mode === "propose" && !(op === "workers.limits.besteffort" && args["enabled"] === false) && !(op === "wip.backup.set" && args["enabled"] === false && args["remote"] === undefined) && !(op === "maintenance.site.set" && args["rule"] === "deny")) return op.startsWith("maintenance.") ? "an environment change or a rule for one is shown first" : op === "project.create" ? "a new project is drafted first" : op.startsWith("grant.") ? "a right is shown first" : op.startsWith("capacity.") ? "how many attempts may run at once is shown first" : op.startsWith("placement.") ? "where your local-only data may go is shown first" : op === "catalog.policy.change" ? "what happens to running tool calls when a version is revoked is shown first" : op.startsWith("catalog.") ? "withdrawing a tool version is shown first, with the calls it would reach" : op.startsWith("events.") ? "which event sources wake your agents is shown first" : op.startsWith("budget.") ? "money and spending limits are shown first" : op === "routing.budget.set" ? "a route's reply limit and reasoning cap apply from its next model call, and a reply cut off at the limit is continued with a nudge to stop deliberating and act, so the change is shown first" : op.startsWith("routing.") ? "which models work may reach is shown first" : op.startsWith("difficulty.") ? "how tasks are matched to models is shown first" : op === "credential.issue" ? "a new credential replaces the old one at once and is shown only once, so it is shown first" : op === "credential.revoke" ? "taking a credential away stops that agent or host at once, so it is shown first" : op === "host.local.set" ? "running agents on this computer decides where work and code run, so it is shown first" : op === "host.move-work" ? "moving the work off a host re-places what is running on it, so it is shown first" : op.startsWith("host.quiet") ? "what happens to the work of a host that stops reporting is shown first" : op === "critical.mark" ? "the critical path decides what comes first for you and what pages you, so a change to it is shown first" : op.startsWith("project.branches.") ? "which branches are protected is shown first" : op === "meeting.record.open-vote" ? "opening a vote starts the clock on a decision the team will carry out, so it is shown first" : op === "meeting.record.close-vote" ? "counting the vote now settles the motion and an adopted decision is carried out, so it is shown first" : op === "meeting.record.table" ? "tabling a motion ends it without a vote and cannot be taken back, so it is shown first" : op === "meeting.proc.rule" ? "a ruling on the objections decides whether the vote is held and what is recorded as dissent, so it is shown first" : op === "meeting.proc.untable" ? "overruling a tabling puts a motion the meeting set aside to a vote, so it is shown first" : op === "meeting.proc.begin" ? "starting the procedure asks the members to comment and puts the motion on the way to a vote, so it is shown first" : op === "meeting.proc.advance" ? "a step of the procedure asks a member for a turn of its model, so it is shown first" : op === "meeting.floor.cq-rule" ? "a ruling on a challenged chair question decides whether the question is asked of the member, so it is shown first" : op === "meeting.proc.owner-message" ? "a message to a meeting is read by every member who speaks after it, so it is shown first" : op === "meeting.record.outcomes" ? (args["askOwner"] === true ? "handing outcomes back settles agenda topics and puts a question to you for each decision the meeting left open, so it is shown first" : "handing outcomes back settles agenda topics in the conversations they came from, so it is shown first") : op === "meeting.record.finish" ? "ending a meeting cannot be taken back and motions not concluded are voided, so it is shown first" : op === "meeting.record.apply" ? "it carries out changes to your project that a vote or your answer agreed, so it is shown first" : op === "meeting.record.owner-respond" ? "your answer to a meeting decision is shown first: it is final (a decision cannot be answered twice), and agreeing lets its changes go ahead" : op === "standup.prepare" ? "preparing a stand-up now tells its agents and builds their briefs before the usual time, so it is shown first" : op === "standup.add-statement" ? "a note goes into an agent's brief for the stand-up, so it is shown first" : op === "workspace.request" ? "changing a task's checkout (integrating, landing, refreshing, quarantining or committing it) is shown first" : op === "handoff.takeover" ? "a takeover by force stops the agent's work on the task at once, so it is shown first" : op.startsWith("release.") ? "a release action is shown first" : "a role's capabilities are shown first";
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
const EXEMPT = new Set(["section", "taskId", "projectId", "project", "prerequisiteId", "agentId", "supervisorId", "teamId", "parentTeamId", "repositoryId", "resourceId", "responsibilityId", "ownerId", "managed", "access", "landing", "integrator", "requiredChecks", "integration", "refreshRounds", "expectedRevision", "expectedVersion", "requestId", "currency", "level", "to", "state", "workClass", "difficulty", "recovery", "kind", "priority", "itemId", "inquiryId", "occurrenceId", "watchedTaskId", "watchId", "returnAt", "sourceTurnId", "intent", "urgency", "category", "participants", "fingerprint", "attemptId", "sessionId", "waitingSince", "decision", "reaccept", "patienceHours", "who", "os", "arch", "osVersion", "verdict", "rule", "what", "specDigest", "concernId", "proposalId", "profileAnswer", "switchProfile"]);

/**
 * `generation.stream.change` names the switches it turns on or off (`enable`, `disable`) from a fixed list the service checks (card L05d): the owner says what they want in their own words ("stop checking that a tool call is the one the model wrote"),
 * the interpreter chooses the switch, and the proposal shows the names before anything is applied. The names are not words an owner has to say, so they are not searched for in the message (an unknown name is refused by the service).
 */
export const STREAM_SWITCH_EXEMPT: ReadonlySet<string> = new Set(["enable", "disable"]);
/**
 * `context.route.change` names the settings it turns on, off or back to their defaults (`enable`, `disable`, `unset`) from a fixed list the service checks (`check`, `floorChars`, `anchor`, `anchorChars`, `recall`, `recallCalls`; cards W12, W13): the owner says
 * "stop reminding the agents of their goal when their memory is cut", the interpreter chooses `anchor`, and the proposal shows the name before anything is applied. The names are not words an owner has to say; an unknown one is refused by the service.
 */
/**
 * The defect commands (card Q04) name a defect or a deliverable by the ID the `defects` status view showed the owner, and the outcome and severity from a fixed list the service checks: the owner says
 * "ship the guide as it is" or "that is a big problem", the interpreter chooses the ID and the value, and the service refuses an unknown or unreadable one. The finding and the reason are still the owner's own words.
 */
export const DEFECT_EXEMPT: ReadonlySet<string> = new Set(["id", "deliverableId", "outcome", "severity"]);
/**
 * The documentation commands (card Q03) name records the docs and overview views showed the owner (the obligation, the agent keeping a document, the tasks it describes, the document and code submissions)
 * and the audience from a fixed list the service checks. The title, where the document lives, the versions and the claims are still the owner's own words.
 */
export const DOC_EXEMPT: ReadonlySet<string> = new Set(["obligationId", "owner", "implementationRefs", "audience", "documentSubmissionId", "evidence", "submissionId"]);
export const ROUTE_SETTING_EXEMPT: ReadonlySet<string> = new Set(["enable", "disable", "unset"]);
/** Release-test IDs are not record references the owner picked: for the release commands they must be in the owner's own words (cancel applies at once, so a model must not choose which test). */
export const RELEASE_ID_KEYS: ReadonlySet<string> = new Set(["attemptId", "candidateId", "windowId"]);
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
 * True if `address` is written out whole in `text`, exactly as given (card P04i first review): the address a probe makes NimbleNewt ask must be one the owner wrote, not a part of a longer one (a host cut short, a path cut
 * off) and not one changed in letter case. Each run of the text between spaces is compared, once as it is and once without the quotes, brackets or sentence punctuation around it.
 */
export function addressWritten(text: string, address: string): boolean {
  if (address.length === 0) return false;
  return text.split(/\s+/).some((t) => t === address || t.replace(/^[<(\["'`*]+/, "").replace(/[>)\]"'`*.,;:!]+$/, "") === address);
}

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
export const WHOLE_WORD_KEYS: ReadonlySet<string> = new Set(["hostId", "administrators"]);

/** The first text value of a command's arguments that is not the owner's own words (and not a record reference or fixed choice), or undefined. */
/** The owner's meeting controls that act on one motion, found by the owner's words (card M02h). */
export const MOTION_CONTROLS: ReadonlySet<string> = new Set(["meeting.record.open-vote", "meeting.record.close-vote", "meeting.record.table"]);
/** Every meeting control of that card; the chat resolves each to the motion, meeting or decision the owner's words fit. */
export const FLOOR_CONTROLS: ReadonlySet<string> = new Set(["meeting.floor.start", "meeting.floor.ask", "meeting.floor.address", "meeting.floor.inquiry-open", "meeting.floor.inquiry-end", "meeting.floor.priorities", "meeting.floor.extend", "meeting.floor.configure", "meeting.floor.end", "meeting.floor.follow-ups", "meeting.floor.cq-rule"]);
export const MEETING_CONTROLS: ReadonlySet<string> = new Set([...MOTION_CONTROLS, ...FLOOR_CONTROLS, "meeting.record.finish", "meeting.record.apply", "meeting.record.outcomes", "meeting.proc.rule", "meeting.proc.untable", "meeting.proc.owner-message", "meeting.proc.begin", "meeting.proc.advance"]);
/** Record references picked from the owner's own question, for these commands only (the chat checks each is one of the listed records). */
export const MEETING_CONTROL_EXEMPT: ReadonlySet<string> = new Set(["motionId", "recordId", "decisionId", "ruling", "addressed", "questionId"]);

/** Fixed choices and record references of one command only: `response` is one of three choices and `decisionId` is checked against the decisions waiting for the owner (card M02h). */
export const OWNER_RESPOND_EXEMPT: ReadonlySet<string> = new Set(["response", "decisionId"]);
/** The fixed choices an item of the Needs-you list offers (card U11d): an answer that is one of them need not be spelled out in the owner's words ("yes, go ahead" is allow); any other answer is the owner's own words and must be in the message. */
export const NEED_CHOICES: ReadonlySet<string> = new Set(["allow", "deny", "agree", "decline", "approve", "done", "accept-as-is", "repair-again"]);
/** A recovery step's `action` is one of six fixed rungs (and the step is always shown first); its `text` must still be the owner's own words (card V02c). */
export const RECOVERY_STEP_EXEMPT: ReadonlySet<string> = new Set(["action"]);
/**
 * A simulation scope's controls (card P07) change nothing real: the scope is a record reference the service checks (owner only), the service and resource are names in the scope's own stand-in (an unknown one is refused),
 * and the action type and injected failure are fixed choices. Texts the owner gives as state (a field's value) must still be the owner's own words.
 */
export const SIMULATION_EXEMPT: ReadonlySet<string> = new Set(["scopeId", "service", "resource", "type", "inject"]);
/**
 * A workspace request's `operation` is one of five fixed choices (and the request is always shown first); its `reason` must still be the owner's own words (card H12m). Its `submissionId` is a record the
 * service checks (a code submission of that very task; for a release, approved, and not only by its author) and the proposal shows it (card H12o sixth slice second review). The interpreter sees no earlier
 * answer, so it cannot look the ID up: the prompt has it copy the ID from the owner's message ("commit submission sbm-… of the parser fix") and ask for it when it is missing (card D01 fifth slice).
 */
export const WORKSPACE_REQUEST_EXEMPT: ReadonlySet<string> = new Set(["operation", "submissionId"]);

/** A defined event source (card H13f): its kind is a fixed choice, its name one the assistant may choose (or the one it names), and a single time is worked out from the owner's words (like a hand-off's return time); the definition is always shown first. What it looks at (`path`) or asks (`url`) must still be the owner's own words. */
export const EVENT_SOURCE_EXEMPT: ReadonlySet<string> = new Set(["type", "sourceId", "at"]);

/**
 * Fixed choices of the guided setup that the owner need not spell out in these words: where a provider runs (`local` or `cloud`) and what kind of server it is (`kind`, one of the known backends), both of routing.provider.add and which forge hosts a repository
 * (`github`, `gitlab`, `self-hosted`, `none`, project.create and project.update). Every other text (names, addresses, models) must be the owner's own. The exemption goes by key name at any
 * depth, so each operation exempts only its own choice: `location` on a project is a repository's folder or address, which must be the owner's words.
 */
export const SETUP_EXEMPT: Readonly<Record<string, ReadonlySet<string>>> = { "routing.provider.add": new Set(["location", "kind"]), "project.create": new Set(["host"]), "project.update": new Set(["host"]) };

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

/**
 * Characters that could break a proposal line or disguise it: line breaks become a space, and controls, separators, invisible format characters (bidirectional overrides, zero-width characters, tags) and half surrogate pairs are written as escapes, so a value (model text above all) can never start a second line or reorder what the owner reads.
 * `short` is the escaping helper for a value shown bare (`landing=main-automatic`) and `quotedText` (card U09, `status/explain.ts`) the one for text shown between quotes (a record's name, the owner's own alternative); every text a proposal line prints goes through exactly one of them, never raw and never both.
 */
const UNSHOWN = /^(?:[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]|\p{Cf})$/u;
/** How much of a name from the records one proposal line shows, after escaping: as much as the whole line has room for, because the chat builds some labels out of several fields of a record (a maintenance request names its package, version, site and source in that order) and what it put first must not be hidden by the quotation's own bound. The line's own cut is what trims. */
const NAME_LIMIT = CHAT_LIMITS.line;
/** How much of the owner's own alternative, and of its topic, the line shows: the same bounds the chat accepts them within, so what is shown whole is what would be recorded. */
const ALTERNATIVE_LIMIT = 150;
const ALTERNATIVE_TOPIC_LIMIT = 80;
/** An escape the helpers below write (`\u{202e}` from `short`, `‮`, `\"` or `\\` from `quotedText`), read left to right so an escaped backslash is one escape. */
const ESCAPE = /\\(?:u\{[0-9a-f]+\}|u[0-9a-f]{4}|["\\/bfnrt])/g;
/** Cut to at most `max` UTF-16 units without splitting a surrogate pair or an escape, so a cut never leaves half a character, or half of the escape that shows one, on the line. */
/** The escape `short` writes, read where it starts. */
const BRACED = /\\u\{[0-9a-f]+\}/y;
const cutAt = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = max;
  // `short` leaves a backslash of the value itself bare, so read left to right a bare backslash just before one of its `\u{...}` escapes pairs with the escape's own backslash and hides it:
  // a `\u{...}` that starts before the cut and ends after it also moves the cut, and both are checked again until neither moves it (each move only shortens the line, so this ends).
  for (;;) {
    let next = end;
    for (const m of text.matchAll(ESCAPE)) {
      if (m.index >= next) break;
      if (m.index + m[0].length > next) { next = m.index; break; }
    }
    // The longest `\u{...}` (`\u{10ffff}`) is ten units, so only one starting in the last ten before the cut can reach past it; escapes hold no backslash, so the nearest is the only candidate.
    for (let i = next - 1; i >= Math.max(0, next - 10); i--) {
      if (!text.startsWith("\\u{", i)) continue;
      BRACED.lastIndex = i;
      const m = BRACED.exec(text);
      if (m !== null && i + m[0].length > next) next = i;
      break;
    }
    if (next === end) break;
    end = next;
  }
  return text.slice(0, /[\ud800-\udbff]/.test(text.charAt(end - 1)) ? end - 1 : end);
};
const short = (value: unknown): string => {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/[\r\n\u0085\u2028\u2029]+/g, " ");
  // Escaped one code point at a time and cut only between whole parts, so a cut never splits a character or an escape.
  const parts = Array.from(text, (c) => (UNSHOWN.test(c) ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c));
  if (parts.reduce((n, p) => n + p.length, 0) <= 80) return parts.join("");
  let body = "";
  for (const p of parts) { if (body.length + p.length > 77) break; body += p; }
  return `${body}...`;
};

/**
 * What each landing does to the owner's work, in plain words (the same sentences the project-creation question shows, card P08b).
 * A landing change is a proposal that carries this, so the owner reads the consequence before they confirm it; nothing here judges
 * how they phrased their message — their confirmation of the shown proposal is what consents to it.
 */
export const LANDING_MEANS: Readonly<Record<string, string>> = {
  "integration-branch": "finished work is merged onto a separate integration branch; nothing reaches main until you or an integrator promotes it",
  "human-promotes": "finished work waits for a person to promote it",
  "main-automatic": "finished work goes to main by itself once its required checks pass, with no human step",
};

/** The landing a command would set (`project.create` carries it inside its `integration` section), or undefined when it sets none. */
export function landingOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const section = args["integration"];
  const value = args["landing"] ?? (section !== null && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>)["landing"] : undefined);
  return typeof value === "string" ? value : undefined;
}

/** What a landing change means for the owner's work, said on the proposal line before the fields it sets. The sentences are the controller's own; only an unknown landing name is foreign, and it is escaped. */
function landingMeaning(op: string, args: Readonly<Record<string, unknown>>): string {
  const landing = landingOf(args);
  if (landing === undefined) return "";
  const means = LANDING_MEANS[landing] ?? short(landing);
  if (op === "project.create") return ` (this project's ${means})`;
  if (op === "integration.default.set") return ` (every new project starts this way: ${means})`;
  return ` (from now on, ${means})`;
}

/** What a release candidate holds, in one escaped line: the platforms come first because approval needs every one of them. */
export function manifestSummary(m: Readonly<Record<string, unknown>>): string {
  const cells = Array.isArray(m["matrix"]) ? (m["matrix"] as unknown[]).map((c) => { const o = c !== null && typeof c === "object" ? (c as Record<string, unknown>) : {}; return `${short(o["os"])} ${short(o["arch"])}${o["osVersion"] === undefined ? "" : ` ${short(o["osVersion"])}`}`; }) : [];
  const count = (v: unknown): number => (v !== null && typeof v === "object" ? Object.keys(v).length : 0);
  // The installations it may go to and a migration plan bind what may later be staged, so they are on the line too when the candidate names them.
  const targets = Array.isArray(m["targets"]) ? `; only for ${(m["targets"] as unknown[]).map(short).join(", ")}` : "";
  const plan = m["migrationPlan"] === undefined ? "" : `; migration plan ${short(m["migrationPlan"])}`;
  return `must pass on ${cells.length === 0 ? "no platform" : cells.join(" and ")}; commit ${short(m["sourceCommit"])}, suite ${short(m["suiteRevision"])}, ${count(m["artifacts"])} artifact hash(es), ${count(m["dependencyLocks"])} lock hash(es)${targets}${plan}`;
}

/**
 * One plain line saying what a command will do, for the owner to read before it happens. Built from the typed command, never from model text.
 * Everything on it that someone else wrote — a label from a record (a task's title, a project's or stand-up's name, an agent's name, a decision's wording, a maintenance request's description, all of them text an agent wrote when it made the record),
 * an alternative in the owner's words the interpreter carried, an end time, even an argument's own name and an unknown operation — is shown through an escaping helper (`short` bare, `quotedText` between quotes), so no newline, line or paragraph separator,
 * C0/C1 control, invisible format character or lone surrogate in that text can start a second line, reorder what is read, or close a quotation. Nothing is escaped twice: a name is escaped here, once, and nowhere else on its way to the owner.
 */
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
    // A candidate is shown as what it holds, with every platform it must pass on, so a cut line can never hide a platform that was left out or added.
    if (op === "release.submit" && key === "manifest" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      parts.push(manifestSummary(value as Record<string, unknown>));
      continue;
    }
    // The owner's own alternative is shown as the words they will have recorded and the topic they go under, never as the record's fields. Both are quoted, so neither can carry the line into a second one; an alternative missing either is refused long before this line is drawn up.
    if (op === "meeting.record.owner-respond" && key === "alternative" && value !== null && typeof value === "object") {
      const alt = value as Record<string, unknown>;
      parts.push(`alternative=${quotedText(String(alt["statement"] ?? ""), ALTERNATIVE_LIMIT)} on topic ${quotedText(String(alt["topic"] ?? ""), ALTERNATIVE_TOPIC_LIMIT)}`);
      continue;
    }
    // A new project's integration section is shown as the settings it holds, not as a JSON blob the owner has to decode.
    if (op === "project.create" && key === "integration" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      parts.push(Object.entries(value as Record<string, unknown>).map(([k, v]) => `${short(k)}=${short(Array.isArray(v) ? v.map((x) => String(x)).join("+") : v)}`).join(", "));
      continue;
    }
    // A probe's address is shown whole, never cut (second review): it is the reach the owner approves, and two addresses alike in their first 77 characters must not look the same.
    if (op === "responsibility.probe.set" && key === "url" && typeof value === "string") { parts.push(`url=${Array.from(value, (c) => (UNSHOWN.test(c) ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c)).join("")}`); continue; }
    // A label is a record's own text (an agent wrote it when it made the record), so it is quoted the way a status answer quotes it; the argument's name is the interpreter's word and is escaped the same way.
    const label = typeof value === "string" ? labels[value] : undefined;
    parts.push(`${short(key)}=${label === undefined ? short(value) : quotedText(label, NAME_LIMIT)}`);
  }
  // What the exception means is said before the details, so a long topic can never push it off the line.
  // A right's end (or that it has none) is said before the long basis and terms, so truncating the line can never drop it.
  const meaning = op === "responsibility.probe.set" ? probeMeaning(args) : op === "chat.budget.set" ? chatBudgetMeaning(args) : op === "meeting.record.owner-respond" ? ownerRespondMeaning(args, labels) : op === "meeting.record.open-vote" ? " (members can vote from now on; the vote closes after its time, or when you count it)" : op === "meeting.record.close-vote" ? " (the ballots cast so far are counted; if it is adopted its changes are carried out or wait for your answer, as the policy says)" : op === "meeting.record.table" ? " (the motion ends with no vote and is not taken up again)" : op === "meeting.proc.begin" ? " (the comment rounds, the objection check and the vote follow; members are asked to speak)" : op === "meeting.proc.advance" ? " (one step: one member's turn, answer or ballot)" : op === "meeting.floor.cq-rule" ? " (dismissed lets the chair's question stand; upheld withdraws it)" : op === "meeting.proc.rule" ? " (a ruling on the objections that hold the vote: going ahead records them as dissent, tabling ends the motion with no vote and makes follow-up tasks, upholding asks for a clarification or an amendment and runs the objection check again)" : op === "meeting.proc.untable" ? " (the tabled motion stays on record; its wording is moved again and put to a vote after the objection check)" : op === "meeting.proc.owner-message" ? " (everyone who speaks in the meeting after it sees these words; nobody gets the floor by it)" : op === "meeting.record.finish" ? " (the meeting ends for good; motions not concluded are voided)" : op === "meeting.record.outcomes" ? (args["askOwner"] === true ? " (each outcome goes back to the conversation it came from, and every decision the meeting deferred also puts a question to you, which you answer in chat)" : " (each outcome goes back to the conversation it came from; nothing is asked of you)") : op === "meeting.record.apply" ? " (only changes already agreed that were not carried out; each is checked again against the rights and state it relies on)" : op === "meeting.invite-direct" || op === "meeting.attend.wake" ? " (this meeting only, then the agent is back as it was; no long-running work in it)" : op === "grant.create" ? grantMeaning(args, labels) : op === "integration.set" || op === "integration.default.set" || op === "project.create" ? landingMeaning(op, args) : "";
  // The verb is this file's own wording; an operation the table does not know is whoever called this saying an operation name, so even that is escaped.
  const line = `${short(spec?.verb ?? op)}${meaning}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
  // An answer to a held meeting decision carries the decision, the owner's alternative in full (150 characters) and its topic (80), which the usual line would cut: the line has room for all of them.
  const room = op === "meeting.record.owner-respond" ? 700 : op === "responsibility.probe.set" ? PROBE_LINE : CHAT_LIMITS.line;
  return line.length > room ? `${cutAt(line, room - 3)}...` : line;
}

/** The room of a probe's line: what it means, the whole address (at most 500 characters; the chat refuses a longer one or one with characters that would be escaped before it is proposed) and the rest. */
const PROBE_LINE = 1400;
/**
 * What setting a probe does, said before the address (second review): NimbleNewt itself makes the request, from the machine it runs on, to whatever address is written, with nothing in between; and what comes of it.
 */
function probeMeaning(args: Readonly<Record<string, unknown>>): string {
  if (args["url"] === null) return " (removes it: NimbleNewt stops asking the address, and each due check goes to the responsibility's agent again)";
  if (typeof args["url"] !== "string") return "";
  return " (NimbleNewt itself, from the machine it runs on, will request this exact address each time a check of the responsibility comes due, with no agent; any address is asked as written, this machine's own and your private network's included; only the status of the answer is kept, a wrong one or none is an incident, and the address is shown to you alone)";
}

/**
 * What a chat.budget.set does, in plain words and with the number grouped so a digit too many or too few is seen (T2 review): the raw `maxTokensPerDay=` value is shown as well, so the
 * owner reads exactly the number that is applied. `null` is said as removing the cap, never as a cap of nothing. A value the service will refuse is shown as it is and refused at apply.
 */
function chatBudgetMeaning(args: Readonly<Record<string, unknown>>): string {
  const cap = args["maxTokensPerDay"];
  if (cap === null) return " (removes the cap: the reviewing agents' model calls have no daily limit)";
  if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) return ` (the reviewing agents' model calls may use at most ${String(cap).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens a UTC day, then stop until the next day; this chat is never stopped by it)`;
  return "";
}

/**
 * When a right is alive and how far it reaches, said before the names so a cut line still shows them. Neither is read out of the owner's wording: the two times are the ones their own words gave
 * (`grantDateInWords`, checked in the chat) or none, and with none the line says the right never runs out. A date is the owner's own text and goes through `short`, once, like every other value here.
 */
function grantMeaning(args: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, string>>): string {
  const idle = typeof args["idleDays"] === "number" ? `; lapses once unused for ${args["idleDays"]} day${args["idleDays"] === 1 ? "" : "s"}, each use renews it` : "";
  const end = (typeof args["expiresAt"] === "string" ? `ends ${short(args["expiresAt"])}` : typeof args["idleDays"] === "number" ? "no end date" : "no end: it never runs out and stays until you revoke it") + idle;
  const start = typeof args["notBefore"] === "string" ? `; starts ${short(args["notBefore"])}` : "";
  const scope = args["project"];
  const reach = scope === "*" ? "; everywhere: it covers every project, including ones made later" : typeof scope === "string" ? `; only in ${labels[scope] === undefined ? short(scope) : quotedText(labels[scope], 60)}` : "";
  return ` (${end}${start}${reach})`;
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
