# User guide: running your NimbleNewt team by talking to it

Written 2026-11-17 (card D01). This guide is for the **owner**: the person who installs NimbleNewt and tells the team what to do. You do not need to be a programmer. You type what you want in plain words, NimbleNewt shows you what it is about to do, and nothing important happens until you say yes.

NimbleNewt is still under development. This guide only shows things that work today, and it says plainly where something is not finished. The example conversation below is run by an automatic test on every change (see [How this guide is kept true](#how-this-guide-is-kept-true)), so the words you see NimbleNewt say here are what it really says.

## What you need

- A computer running **Linux**. (NimbleNewt itself runs on macOS and Windows too, but agents can only *work* on Linux for now. See [Where agents run](#where-agents-run-and-what-the-sandbox-protects).)
- **Node.js 22.19 or newer**, installed in a folder of its own (for example from the Node.js website or a version manager), not the copy some Linux systems put under `/usr`.
- **git**.
- **bubblewrap**, the program that keeps each agent in a sealed box. On Ubuntu or Debian: `sudo apt install bubblewrap`.
- **Two model servers.** NimbleNewt's agents and its chat are run by AI models. You need at least two, on two different servers, so that losing one does not stop the team: for example a model running on your own machine and one free cloud route as a backup.

## Install

Open a terminal and run these lines one at a time:

<!-- d01:install -->
```
git clone https://github.com/rkcth/NimbleNewt.git
cd NimbleNewt
npm ci
npx tsc --build
```

`npm ci` downloads what NimbleNewt needs and `npx tsc --build` prepares it to run. Both take a few minutes the first time.

The address in the first line is where the project is kept today. Whether it is open to everyone is decided at publication (card D03), which has not happened yet: until then it works only for people who have been given access, and if you were given another address or a downloaded copy, use that instead.

Now tell NimbleNewt about your two model servers. Change the addresses and model names to your own:

<!-- d01:install -->
```
node scripts/nimblenewt.mjs init --model-endpoint http://127.0.0.1:8000/v1 --model my-local-model \
     --backup-endpoint https://free-route.example.org/v1 --backup-model free-model --backup-key-secret backup-key
node scripts/nimblenewt.mjs secret set backup-key
```

- `init` writes a settings file in `~/.nimblenewt`. It never holds a password or key.
- If a model server needs a key, give it a **name** (here `backup-key`) with `--backup-key-secret` or `--model-key-secret`, then run `secret set` with that name. It asks for the key without showing what you type and puts it in your computer's own secret store (the Linux Secret Service, the macOS Keychain or Windows' protected storage). A Linux computer without the Secret Service, such as a server with no desktop, gets files under `~/.nimblenewt/secrets` that only your user account can read instead; `start` says which one it uses ("Secrets are kept in: ..."). Anyone who can sign in as your user account can read either kind.

## Start, and talk

<!-- d01:install -->
```
node scripts/nimblenewt.mjs start
```

The first time, this makes **you the owner** (your sign-in is kept in the same secret store, never in the settings file), shows a list of what is set up and what is still open, and opens the chat in your terminal. Each line of the list starts with `[x]` (done), `[-]` (a default that works) or `[ ]` (still open). To stop, press **Ctrl-D**; start again any time with the same command and you carry on where you left off.

From here you set everything up by chatting. Here is a whole first conversation, from an empty installation to a first task handed to an agent. "You" is what you type; "NimbleNewt" is part of what it answers ("..." marks words left out).

<!-- d01:conversation -->
```
You: help me get started
NimbleNewt: Not ready for a first agent yet: the first required step still open is A project.
NimbleNewt: Next to ask: How much should the team ask you before it acts? A new installation starts in strict, which asks at every consequential step.

You: Stay on strict for now
NimbleNewt: Proposed, nothing has changed yet ... Keep the installation in the strict profile, as your answer.

You: yes, keep it
NimbleNewt: Done. Keep the installation in the strict profile ...
NimbleNewt: Next step in the setup: What is your first project: its name, what it is for, and where its git repository is

You: My project is called Garden. Its code is in /home/me/garden and we keep it on our own Gitea server with Woodpecker CI.
NimbleNewt: Proposed, nothing has happened yet (a new project is drafted first). ... Create project: name=Garden ... Apply it, or discard it?

You: yes, make it
NimbleNewt: Applied proposal
NimbleNewt: Next step in the setup: Which machine runs the agents? This computer is the usual first choice.

You: Run the agents on this computer
NimbleNewt: Proposed, nothing has happened yet (running agents on this computer decides where work and code run, so it is shown first).

You: yes, do that
NimbleNewt: Applied proposal

You: Add an agent called Ann as an author
NimbleNewt: Proposed, nothing has happened yet (it changes what someone may do or where work is done). ... Create agent: friendlyName=Ann, roles=["author"].

You: yes, add her
NimbleNewt: Applied proposal

You: Let Ann work on Garden
NimbleNewt: Proposed, nothing has happened yet (a right is shown first). ... Grant right (no end: it never runs out and stays until you revoke it; only in "Garden"): action=attempt.work ... These are the rights the role author of "Ann" stands for, each only in "Garden".

You: yes, give them
NimbleNewt: Applied proposal

You: Add a task to Garden: Add a greeting to the README
NimbleNewt: Proposed, nothing has happened yet (the strict profile shows this first). ... Create task: title=Add a greeting to the README

You: yes, add it
NimbleNewt: Applied proposal

You: Add a greeting to the README is ready for work, give it to Ann
NimbleNewt: Done: task.transition.
NimbleNewt: Proposed, nothing has happened yet (the strict profile shows this first). ... Assign task: taskId="Add a greeting to the README"

You: yes, go ahead
NimbleNewt: Applied proposal

You: What is waiting for me?
NimbleNewt: Nothing is waiting for you.
```

What to notice:

- **You use your own words.** There are no special phrases to learn; the lines above are just one way to say it. A model reads what you mean, so if it gets you wrong, nothing has happened yet: discard the proposal and say it differently.
- **Everything that matters is shown first.** NimbleNewt answers "Proposed, nothing has happened yet" and waits. Say yes (in any words) to go ahead, or say you do not want it to drop it. Small changes that are easy to undo, such as marking a task ready, are done at once ("Done: ...").
- **The setup list tells you what is next** after each step, so you are never left guessing. Say "help me get started" at any time to see the whole list again.
- **Giving an agent what it needs is one sentence.** An agent can do nothing until you give it rights in a project. "Let Ann work on Garden" gives Ann every right her role (author) stands for, only in Garden, and lists each one before you say yes; rights she already has there are left out. To give fewer or other rights, say no and name them instead ("give Ann the rights task.read and desk.read in Garden").

### After the conversation: the work starts

Running agents on this computer counts from the **next start**. Press Ctrl-D and run `node scripts/nimblenewt.mjs start` again. The start-up messages then say that the worker host on this computer is running agents in a sandbox, the setup list shows the host as done, and Ann begins the task by herself. Ask "what is waiting for me?", or about one task with its project and title ("in Garden, how is Add a greeting to the README going?"), whenever you like.

If something is not right, `node scripts/nimblenewt.mjs status` prints the setup list and stops, and the [troubleshooting guide](troubleshooting.md) lists the common problems.

## Handing a task to another agent

Sometimes a task should move to another agent: the first one is away, busy with something more urgent, or not the right fit. A **hand-off** moves the task together with a **package**, which is what the next agent needs to carry on: the task's description and acceptance criteria, the work done so far and what is left, the next step, shared drafts, what the task holds locked, and the duties the first agent answers for. The package holds only what the new agent may see; never private scratch notes or keys.

Continuing the example: Ann will be away, so Bob, a second author, takes over her task. Bob needs rights in Garden first, or the hand-off is refused (an agent with no right to work in the project cannot take a task there).

<!-- d01:handoff -->
```
You: Add an agent called Bob as an author
NimbleNewt: Proposed, nothing has happened yet ... Create agent: friendlyName=Bob, roles=["author"].

You: yes, add him
NimbleNewt: Applied proposal

You: Let Bob work on Garden
NimbleNewt: Proposed, nothing has happened yet (a right is shown first). ... These are the rights the role author of "Bob" stands for, each only in "Garden".

You: yes, give them
NimbleNewt: Applied proposal

You: Hand Add a greeting to the README over to Bob, Ann is away this week
NimbleNewt: Done: handoff.prepare.

You: In Garden, how is the hand-off of Add a greeting to the README going?
NimbleNewt: Now focused on project ...
NimbleNewt: Hand-off from ... to ..., prepared: ready. ... "Ann is away this week"
NimbleNewt: The package is missing: acceptanceCriteria, unfinishedWork, nextAction.

You: Finish handing over Add a greeting to the README, gaps and all
NimbleNewt: Proposed, nothing has happened yet ... Complete hand-off of task: acceptGaps=true

You: yes, hand it over
NimbleNewt: Applied proposal
```

What happens at each step:

- **Asking for the hand-off moves nothing yet.** It is done at once ("Done: handoff.prepare."), because it only gets the task ready to move: Ann's work on the task is brought to a safe stop and the package is put together. The task stays Ann's until the hand-off is finished. Your reason ("Ann is away this week") is kept with the hand-off; NimbleNewt only takes a reason that is in your own words.
- **Name the task by its title.** For anything that changes a task, the chat checks that the task's title appears in what you wrote. A question can name the project too ("In Garden, ..."); NimbleNewt then keeps that project in focus for later questions.
- **The answer tells you what the package lacks.** Here it lacks the acceptance criteria (the example task was given none) and the unfinished work and next step, which come from the progress NimbleNewt saves while an agent works (Ann has not started yet). NimbleNewt does not make up what it does not have. The answer names agents by their IDs (`agt-...`); `/nimblenewt.agent-list {}` shows which ID is whose.
- **Finishing with gaps is always shown first.** Handing over a package with something missing is your decision, so it is shown before anything moves; "gaps and all" says you accept them, and they are recorded with the hand-off. If the package is complete, finishing works like any other step of your profile (on strict it is shown first too).
- **After the yes, the task is Bob's.** It stays ready for work, and the move is written in the task's record.

Three more things you can say about a hand-off, continuing from there (the task is now Bob's):

<!-- d01:handoff-more -->
```
You: Hand Add a greeting to the README back to Ann, Bob is needed elsewhere
NimbleNewt: Done: handoff.prepare.

You: Cancel the hand-off of Add a greeting to the README
NimbleNewt: Done: handoff.cancel.

You: Let Ann cover Add a greeting to the README until Friday, Bob is needed elsewhere
NimbleNewt: Proposed, nothing has happened yet ... Prepare hand-off of task: ... returnAt=

You: no, drop that
NimbleNewt: Proposal ... discarded.

You: Take Add a greeting to the README over for Ann, Bob is not answering
NimbleNewt: Proposed, nothing has happened yet (a takeover by force stops the agent's work on the task at once, so it is shown first). ... Take task over by force

You: yes, take it over
NimbleNewt: Applied proposal
```

- **Cancelling** a hand-off that is not finished moves nothing: the task stays where it was (here, with Bob).
- **Covering for a while** is a hand-off with a time to give the task back. That time is always shown first, as an exact date and time in UTC, world standard time (for example "returnAt=2026-11-27T17:00:00.000Z"; the Z at the end means UTC, so 17:00 there is noon in New York in winter): the assistant works it out from your words ("until Friday"), so check it before you say yes, and say the time you mean if it is wrong. It must be at most 30 days ahead. Once you have said yes and finished the hand-off, the task goes back by itself at that time, as long as whoever asked for the cover may still control the task, the task is still with the agent covering it, and the first agent can still take it (not retired, still with rights in the project). If not, the task stays with the agent covering it and the task's record says why.
- **Taking a task over by force** is for when the agent holding it cannot get it ready (for example it has stopped answering). It is always shown first. It force-stops that agent's work on the task at once, takes whatever package exists without waiting, and records the move as a forced one.

## Checking on finished work: submissions, QA, defects, documents and landing

When an agent finishes a piece of work it does not just say "done". It **submits** it, other agents check it, and it **lands** on the project's landing branch only once the checks the project requires have passed. You can look at every step by asking in your own words; the assistant picks the right view. Nothing below needs a magic phrase, and the example sentences are only examples. Each view is read-only, so asking never changes anything.

<!-- d01:status-kinds -->
```
submissions       "What has been submitted on Add a greeting to the README?"
qa                "What did QA check on Add a greeting to the README?"
qa_project        "What is waiting for QA in Garden?"
defects           "Were any defects found in Add a greeting to the README?"
defect_risks      "Which defects are still unfinished in Garden?"
task_docs         "Which documents are still due for Add a greeting to the README?"
landing_queue     "What is waiting to land in Garden?"
landing_settings  "What checks does Garden require before its work lands?"
```

- **Submissions** (one task). The code submitted on the task, newest first. For each: who submitted it, whether a reviewer has approved it (or says it needs a new submission; or that no review was needed because no other agent of the project could review it), and whether a director has signed it off. An approval counts at landing only while the change itself stays the one that was approved. You also see the reviews, QA reports, document changes and sign-offs that were submitted.
- **QA** (one task) and **what waits for QA** (a project). QA means an independent check of the work against the task's contract: which checks passed, failed, were blocked or were not run, in what environment, and whether the result still holds. Work that nobody independent has checked yet fails the QA gate; the author's own check never makes it pass. If you change what the work must be (its acceptance criteria, expected result, checks or required evidence), earlier QA results no longer count: they are marked as no longer holding, with the reason, a re-check is scheduled for whoever recorded them, and you get a notice. A change of priority or budget does not do this.
- **Defects** (one task) and **unfinished defects** (a project). A defect is a problem found in submitted work, reported by you or by a reviewer, QA or director agent that did not work on that version. The agent responsible repairs it and the repair is checked again. Each repair check that fails uses one repair round, and there is a limit (3 unless you set `review.repairCycles`). When that many checks have failed the defect is **escalated to you**: it appears on your list of things that need you ("what is waiting for me?"), and you decide.
- **Documents of a task.** The documents that describe the task, each shown as verified or flagged (and why), with what would verify it, or that no document describes it. Every flagged document that describes the task counts as due for it, even when the flag came from another task the same document describes; so does a verified document whose check rested on code of this task that no longer passes QA. When the project's landing requires the documentation check, the task does not land until each due document is verified again.
- **The landing queue** (a project). Approved work waiting to land on the landing branch, oldest first; only the first lands next. The view also tells you when a place is stuck, in plain words: a task whose author had to refresh its work as often as the project allows keeps its turn, a **reserved place**, and while that place is first and has no approved work, nothing else lands until it lands or is taken out; the controller ends a reservation that has had no approved work for twelve hours, but only when a landing queued behind it is asked for, never on a clock; and when a task (with approved work or a reserved place) has been first for four hours without landing, the next landing refused behind it tells the director and sends you a notice (one that needs you if no director can be told); this too happens only then, not on a clock.
- **Landing settings** (a project; only you can read them). How a project's finished work lands: where it lands, who integrates (an agent or a person), the checks the project requires before work lands, how many times an author refreshes onto a moved landing branch before its place in the queue is reserved, and whether the settings are the project's own or were copied from the installation default or the approval profile when the project's settings were first made (a later change of the default does not change an existing project). Name the project in your words, the same way you do to change them ("what checks does Garden require before its work lands?").

### What you decide, and what happens by itself

- **An escalated defect.** It appears on your list of things that need you, with two answers: **accept it as is** (the defect is closed, but its failed checks stay failed on the record) or **let the repair go on** (it goes back to waiting for a repair; the rounds used so far are kept, so the next failure escalates again). Say which, in any words, and give your reason if you have one; it is shown to you first and applied when you say yes. Name the defect by a few words of its finding, written as the list shows them, or by its ID (the assistant matches those words against the list; if they fit no waiting defect it says so and nothing changes). For example, for a defect whose finding is "Typo in the greeting": "Accept the typo in the greeting as it is, it does not matter", or "Let the repair of the typo in the greeting go on".
- **A defect reported by mistake.** You can **withdraw** it with a reason. The agent that reported it can too, but only while no repair check of it has failed and only if it did none of the repair work; after a failed check (and so once it is escalated) only you can. Name the defect by its ID, as the defects view shows it (it starts with dft-); for example: "Withdraw defect dft-…, it was reported against the wrong version." The report stays on the record, marked as withdrawn and by whom, and it leaves your unfinished and needs-you lists. A defect that is already fixed, accepted as it is or withdrawn cannot be withdrawn.
- **A director's check before landing.** A project can require a director's sign-off before work lands (the landing check `director`; the other checks a project can require are tests, review, QA and documents). Change the checks by asking (naming the project when it is not the one you are working in), naming every check the project should require, because the list you give replaces the old one; the change is shown first. The newest sign-off must say approve, for the same change that lands. No sign-off yet, or a decline, stops the landing, and the reason says which. Sign-offs are given by agents with the director role in the project, never on their own work; you cannot sign off yourself, and the check only reads the sign-offs that were submitted. So a project that requires this check but has no director agent lands nothing until you add one or drop the check.
- **No unfinished defects before landing.** A project can also require the landing check `defects`: a task lands only while none of the defects reported against its deliverables is still open, waiting for a check or escalated to you. A defect that was repaired and found fixed, one you accepted as it is, and one that was withdrawn as a mistake do not stop it. Ask in any words ("don't land anything while it still has open defects"), naming every check the project should require, since the list you give replaces the old one; the change is shown first. The reason a landing was refused names the unfinished defects; an escalated one waits for your answer on the Needs-you list.
- **Release after a reviewer's approval.** When a reviewer approves a code submission, the controller asks for its **release** itself (the step that commits the approved code in the task's own working folder, so that it can land), as it would if you asked, so approved work does not wait for someone to type the request. It does this only for a reviewer's approval (work that needed no reviewer, because no other agent could review it, is not released this way), and not while the task has a live attempt running or is paused (nor yet for work on a remote computer); the next approval, or your own request in chat, does it then. Landing on the project's landing branch is still decided by the project's landing setting and its required checks.

Everything is read from the project's own records: if a view says nothing is waiting, nothing is, unless the view also says it looked at only part of the records.

## How much the team may do on its own

Three things decide what happens without asking you.

**1. The approval profile** (for the whole installation):

| Profile | What it means |
| --- | --- |
| **strict** (where every new installation starts) | The team asks you at every step that matters: a new task, an assignment, a new right, a change of setting. Safe, but you will be asked often. |
| **derived** | What you ask for counts as permission for what it reasonably needs: building, fixing what fails, merging into the work-in-progress branch, deploying to development and test. It still asks about anything wider, such as a live customer environment, new outside access or spending more than estimated. |
| **autonomous** | The team acts within the rights you have given, without asking again, except for the things listed just below. |

Change it by saying so, for example "switch to the derived profile". That change is itself shown first. While you stay on strict, NimbleNewt offers derived from time to time (after every third approval); "no" keeps strict.

Whatever the profile, these are **always shown to you first**: anything that decides where your data or code goes, who may do what (a new right, a new agent's role), sending notifications outside the installation, a health address NimbleNewt itself will contact from the machine it runs on when a responsibility's check comes due (any address you write, including this machine and your own network; only the answer's status is kept, and only you see the address), switching off security reports, deploying to a live customer environment, spending more than the estimate, anything an agent does that cannot be undone, and pushes or merges into a protected branch (`main` and `master` unless you change them). The agents' actions in this list (deploying, spending, what cannot be undone, protected branches) can be let through only by a choice of your own that names them exactly: a right that names that action (and the live environment or the branch), a task you approved that names it, or a project you set so that finished work goes to `main` by itself once its checks pass. That choice is itself shown to you first; after it, those actions are no longer shown to you one by one.

**2. Rights** (per agent, per project). A new agent has no rights at all. Each right you give works only in the project you name, and lasts until you take it back unless you said when it ends. To see them, type `/nimblenewt.grant-list {}` in the chat; to take one back, use the two lines under "Take back a right" in [the recovery section](#when-the-assistant-is-down-stopping-and-recovering-without-the-model). An agent can never give itself more than you gave it, approve its own work, or change these rules. (Agents in a meeting can agree that one of them needs a new right; that comes to you, unless you have yourself chosen to let such rights through without asking you.)

**3. Where your code goes.** Agents send the task and the parts of your code they work on to the **model servers you named**. A model on your own machine keeps it there; a cloud route sends it to that provider. If that matters, use local models only. Keys are never sent to the agents themselves.

## Where agents run, and what the sandbox protects

When you say "run the agents on this computer", NimbleNewt starts a **worker host** on this machine. Each agent's programs then run inside a **sandbox** made with bubblewrap:

- An agent can change only its own copy of the task's files, not the rest of your computer.
- It cannot see your home folder, your other projects, or your keys and passwords.
- Its programs have **no network connection of their own**. Its model calls go through the worker host, and any other outside access only through the route NimbleNewt controls, where you decide site by site.
- If the sandbox cannot be set up properly, NimbleNewt does not run agents there at all. It never quietly runs them without the box.

What the sandbox does **not** do, so you can judge how much to trust a machine:

- **The host computer itself is trusted.** The sandbox protects your computer from what an agent runs; it does not protect the agents' work from the computer. Anyone with an administrator account on that machine, or any program running under your user, can read and change the task files, the model traffic and NimbleNewt's records. Run agents only on a computer you control and keep up to date.
- **The worker host program runs as you, outside the box**, because it has to start the boxes. Only the agents' own programs are confined.
- **Unconfined ("trusted-host") running is not offered.** The settings file has an option for it, which requires a named person and a reason, but the worker host that NimbleNewt starts does not use it: agents on this computer always run in the sandbox.
- **Linux only, for now.** On macOS and Windows NimbleNewt says so at start-up, and tasks wait until a Linux machine can run them. The macOS sandbox exists but is not switched on yet, and the Windows one is not finished.
- **Another machine is a separate decision.** Letting another computer run agents takes more than this guide covers: a credential for it (you can ask the chat for one), rights for it, and the worker set up on that machine ([getting started, step 6](getting-started.md#step-6-hosts-and-workers)). That machine is trusted in the same way: it sees the work you send it.
- **No outside security audit has been done yet.** See the [security guide](security-guide.md) for the full list of known limits.

## When the assistant is down: stopping and recovering without the model

The chat understands plain words by asking a model. If every model server is down, or the chat starts answering strangely, you can still **stop, pause and take back rights**. These orders do not use the model at all; you type them exactly as written. They work in the terminal chat and in the phone web chat.

When the model is not reachable, a normal message gets this answer, and nothing is done:

<!-- d01:model-down -->
```
NimbleNewt: The assistant that reads free-form messages is unavailable right now. Nothing was done
```

**Pause or resume all work.** Pausing stops new steps from starting; work that is already running in the background may finish. Resume lifts it again.

<!-- d01:recovery -->
```
/nimblenewt.lifecycle-pause {"scope": {"kind": "installation", "id": "installation"}, "reason": "stop everything for now"}
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
/nimblenewt.lifecycle-resume {"scope": {"kind": "installation", "id": "installation"}, "reason": "carry on"}
```

**Stop one task or one agent.** First list them to find the ID (it looks like `task-...` or `agt-...`), then put it where the example says TASK-ID or AGENT-ID. `stop` ends the task's running work but keeps the task and its assignment, so it can be resumed later. If something will not stop, Force Stop ends it at once and reports what may need cleaning up.

<!-- d01:recovery -->
```
/nimblenewt.task-list {}
/nimblenewt.agent-list {}
/nimblenewt.lifecycle-pause {"scope": {"kind": "agent", "id": "AGENT-ID"}, "reason": "check what Ann is doing"}
/nimblenewt.lifecycle-stop {"scope": {"kind": "task", "id": "TASK-ID"}, "mode": "stop", "reason": "wrong approach"}
/nimblenewt.lifecycle-force {"scope": {"kind": "task", "id": "TASK-ID"}, "reason": "it will not stop"}
/nimblenewt.lifecycle-resume {"scope": {"kind": "agent", "id": "AGENT-ID"}, "reason": "all fine"}
```

Each stop answer says how far it got: `Received`, `Accepted`, and whether it has taken effect yet.

**Take back a right.** List the rights, then use the grant's ID and its revision number from the list:

<!-- d01:recovery -->
```
/nimblenewt.grant-list {}
/nimblenewt.grant-revoke {"grantId": "GRANT-ID", "expectedRevision": 1, "reason": "no longer needed"}
```

**Stop using a model provider** (for example when an account has run out of credit or a provider misbehaves). The short form below is not run directly: NimbleNewt answers with the full line, and you send that line to run it. Running work is left to finish; new work no longer goes there. The last line allows the provider again.

<!-- d01:recovery -->
```
/exclude provider PROVIDER-NAME the account is out of credit
/nimblenewt.routing-disable {"level":"provider","name":"PROVIDER-NAME","reason":"the account is out of credit"}
/nimblenewt.routing-reenable {"level": "provider", "name": "PROVIDER-NAME", "reason": "credit topped up"}
```

On the phone web chat ([private web chat](private-web-chat.md)) the **Recovery** tab has **Pause everything** and **Resume** buttons that send the same orders.

Other things that keep working without a model: `node scripts/nimblenewt.mjs status` (the setup list), and every proposal you already have (you can still apply or discard it from the phone page).

## Keys and passwords

Never type a key or password into the chat. If you do, NimbleNewt refuses the whole message before any model sees it, keeps it nowhere, and tells you what to do instead:

<!-- d01:key-refusal -->
```
NimbleNewt: That did not go through: text: looks like a credential or key; it was not read, sent to any model or recorded. Keep keys out of the chat: put one in the secret store with `node scripts/nimblenewt.mjs secret set NAME`
```

Then tell the chat only the **name** you gave the key ("use the free route; its key is backup-key").

## What is not finished yet

- **Agents run on Linux only.** macOS and Windows machines can host the controller and the chat, but not agents yet.
- **No installer.** You run NimbleNewt from the downloaded folder with `node scripts/nimblenewt.mjs`, and starting it automatically with the computer is a manual step ([maintenance and updates](maintenance-and-updates.md)).
- **A second model server is required**, even for a first try.
- **Notifications stay inside NimbleNewt.** You see them in the chat and the phone page; no email or messaging channel is built in.
- **No real-world testing on users' own machines yet**, and no outside security audit. Those are part of the release checks still to come.

The [getting-started guide](getting-started.md) lists every step in more detail, including how to do each one by script, and its table of [what is not built yet](getting-started.md#what-is-not-built-yet) is kept up to date.

## Where to read more

- [Getting started](getting-started.md): the same first run, step by step, with every setting explained.
- [Private web chat](private-web-chat.md): reaching NimbleNewt from your phone.
- [Troubleshooting](troubleshooting.md): what an error means and what to do.
- [Security guide](security-guide.md): the security model and its known limits.
- [Maintenance and updates](maintenance-and-updates.md): backups, updates and running NimbleNewt as a service.

## How this guide is kept true

`packages/integration/src/d01-user-guide.test.ts` runs this guide: it starts NimbleNewt from an empty folder, sends every "You" line of the example conversation to the real chat (a scripted stand-in plays the model, so no model is called), and fails if a step does not happen as shown or a quoted answer is not what NimbleNewt really prints. The two hand-off conversations of [Handing a task to another agent](#handing-a-task-to-another-agent) are run the same way, starting from where the first conversation ends, and the test checks what the guide says about each step: nothing moves when a hand-off is asked for or cancelled, the gaps quoted are the ones accepted, the task ends with Bob and then, after the takeover, with Ann. The views of [Checking on finished work](#checking-on-finished-work-submissions-qa-defects-documents-and-landing) are asked in the words the guide shows, through the same chat, and the test fails if a listed view is not a real status kind, the chat's answer is not that view's own text (the task found by its title, the project by its name), or a view or owner control that section has to describe is no longer described (it does not run the escalated-defect answers, the withdrawal or the release by approval: the sentences about them are checked against the code and the implementation notes by hand). It also runs every typed order of [the recovery section](#when-the-assistant-is-down-stopping-and-recovering-without-the-model) with the model servers switched off, and checks the key refusal. The install lines are run too: `init` with exactly the options shown, into a fresh folder, must write settings the launcher accepts (only `secret set` is not run, because it would write to the real secret store of the machine running the test). `scripts/d02-docs.test.mjs` checks that every command, path, option and link written in the text of this guide exists. What a test cannot show is whether a real model understands your own wording; the scripted stand-in only proves that the steps exist and work once understood.
