# Pi completion bench (card W01)

Measures how often a Pi agent finishes its work. Each run replays a merged card: a fresh repository at the card's base
commit, the card's own tests held back, Pi given the task, and only after Pi has ended are the held-back tests copied in
and run: first the task's **acceptance suite** (the score), then the card's **shipped test files** (for information).
The run's ending is then classified from Pi's JSON log.

## What changed on 2026-11-10, and why (the first baseline is invalid)

The first baseline (43 of 54 runs, batches of 2026-11-09/10) scored no finish at all, and an audit of every run found
that it measured the gap between the prompts and the hidden tests rather than Pi: in 38 of the 43 runs a hidden test
demanded exact wording, a field name or a signature the prompt never stated (whole sentences later review rounds settled
on; a callback type for c07n; the overview shape for m03h-1); 25 runs had a genuine defect too (all but the 5 quote-lines
runs together with such mismatches); and 9 `stopped-early` labels were classifier misses (reports opening "All boxes
ticked; tree clean. Report:" or ending with a scoped "Remaining risk / not done:" note). Its data is kept, unchanged
except for the re-labelling below, in `eval-results/baseline-1-invalid/` (see its README); do not read rates from it.

What changed:

1. **Classifier.** A final report given with every PLAN.md box ticked, a clean tree and a green last self-test (the
   agent's own last `--test` run that printed counts) is a done claim whatever its words; "All boxes ticked", "all ten
   steps are committed", "tree clean" are done words; a scoped caveat note at the end ("Remaining risk / not done:",
   "Out of scope and left alone:", "Known limitations:") makes it `done-with-caveats`, still a done claim (records carry
   `doneClaim`). A new outcome **interface-mismatch**: the agent said it was done and the build failed only in the
   held-back files, i.e. the tests do not type-check against its code; it is a non-finish but not a false done.
   `rescore.mjs` re-labelled the saved runs of the first baseline (43 runs, smoke runs aside):

   | outcome | before | after |
   |---|---|---|
   | stopped-early | 9 | 0 |
   | wrong | 32 | 28 |
   | interface-mismatch | 0 | 13 |
   | timeout | 2 | 2 |
   | verified-finish | 0 | 0 |
2. **Task design.** Each task's prompt ends with a **CONTRACT** block naming every exported name, type field, signature,
   operation and message meaning the scored tests use, without the solution's code; contradictions were fixed
   (grant-proposals' `only in "<name>"`, c07n's "positive finite" is now "positive integer"). The score is an
   **acceptance suite** per task (`acceptance/<id>/`): bench-owned tests derived from the card's shipped tests, written
   into the checkout at fresh `w01-acceptance-*` paths (calibration checks they exist at neither the base nor the
   solution, so they never collide with an agent's own tests), that assert behaviour and meaning (`/main by itself/`,
   `/no human step/`, `/gate.*(differ|chang).*confirm/i`) rather than whole sentences. The shipped test files, which also
   carry later review wording no prompt states, still run after it and are reported as **matches shipped wording**
   (informational: not part of finish, false done or the gates).
3. **Spec fit** in `--calibrate` (`lib/specfit.mjs`): every string literal (and fixed template part), regex, property
   name (`.x` and object keys) inside an acceptance assertion (its message argument aside), and every name imported from
   a relative module, must appear in the prompt, in the base commit's source and docs, or in the test's own fixtures.
   Anything else is listed, and calibration fails until the task's `acceptance.json` `allow` gives it a reason.
4. **Control runs** (`--agent`, `--label`, `compare.mjs`, below).
5. **Leftover processes.** Every command of a run carries `PI_EVAL_RUN_DIR=<checkout>`; after the agent, after each
   suite and at the end, any process working in the checkout, carrying that mark, or descending from one is killed.
   An embedded PostgreSQL works in its own `/tmp` data directory, so the working-directory test alone missed it (checked
   by hand on a real embedded server: postmaster and its five helpers stopped; tested with stand-ins in `runner.test.mjs`).

## The one command

```sh
node scripts/pi-eval/run.mjs
```

runs every task in `taskset.json`, variants A and B, the task set's repeats (3), one run at a time, and prints the
report. Narrow it with `--tasks quote-lines,c07n`, `--variants A`, `--repeats 1`, `--concurrency 2` (at most 3).
`--dry-run` prints what would run. `node scripts/pi-eval/run.mjs --help` lists every option.

**On the shared Radiance server (added 2026-11-17).** With the task set on the `radiance` provider the bench guards the
server for every agent: the Pi agent, named with `--agent` or not, and any wrapper (only the bench's own Claude control
agent under `agents/` and `stub-agent.mjs`, which never reach Radiance, are left out). The guard is
`lib/radiance-gate.mjs`, the approach of the G10 bench and the M00 prototype: it reads `GET /stats` and `GET /v1/models`
with the key from Pi's own `~/.pi/agent/models.json` (only ever in the Authorization header; never printed, logged or
written) and lets a run go only when nothing is in flight, running or waiting and the pinned model is already served (a
model list it could not read is no confirmation). It asks before preparing the checkout and again right before the agent
starts, since preparing, the setup build and a test-slot wait can take minutes; a run refused at that second check
started nothing and is not recorded. A busy or unreadable server is polled each minute for at most
`--idle-wait-minutes` (default 30); past that, or when the model is not served, the batch stops starting runs (the
bench never loads, unloads, switches or restarts a model). With the gate on, runs go one at a time, so the bench adds at
most one request to the server at any moment (`--concurrency` above 1 is refused); `--no-radiance-gate` turns it off for
a server nobody else uses. The gate cannot reserve the server: another client can start in the seconds between the
second check and the agent's first request, so it keeps the bench from adding to a busy server, not others from joining.
Each record carries `server` (the counters the agent started on and those after the run).
`--token-budget N` stops starting runs once the batch's finished runs used N input+output tokens (cache reads not
counted); a run already started is never cut short, and a run whose agent started but whose token use is unknown stops
the batch too (a log with no model reply, or a reply without token counts, is unknown use, not 0 tokens). `--test-slot CMD` (or `PI_EVAL_TEST_SLOT`) holds a slot of a machine-wide test-slot command (on this
machine `/tmp/nn-slot.sh`) for the bench's own setup build and grading suites only; the agent's own test runs are part
of what is measured and never wait for it. Do not start `run.mjs` itself through that slot command while giving it
`--test-slot`: it would hold one slot and wait for another (with a single slot, forever). A stopped batch is noted in
`batches.jsonl` and at the end of its report. The report also counts timeouts whose acceptance tests pass at the limit
(the work was done, the agent did not end) and warns when variant B mixes runs from before card W06 (PLAN.md and a
commit per step) with the W06 rules.

The report alone, over everything recorded so far or one batch:

```sh
node scripts/pi-eval/report.mjs [--batch batch-20261109T201108] [--variants A,B] [--strict]
```

Check that the tasks are sound (no agent, no GPU; about 1 to 4 minutes per task, 21 minutes for all nine on 2026-11-10): the acceptance tests must fail at the
base and pass at the solution, the spec fit must find nothing unexplained, and the shipped suites are run at the
solution for the record (`--no-shipped` skips that part).

```sh
node scripts/pi-eval/run.mjs --calibrate [--tasks id,id]
```

## The agent's isolation (added 2026-11-17, after an agent tried to push)

In batch `batch-20261117T064116` the agent of run `grant-proposals-B-r1-20261117T094724`, told "Do NOT push", added a
GitHub remote to its throwaway checkout, ran `git push origin HEAD:main` twice (GitHub refused only because the checkout
was behind), tried a dry-run push with the owner's deploy key, and listed `~/.git-credentials` and `~/.ssh`. The bench ran
it with the owner's home, keys and network. Since then every agent the bench starts (`lib/isolation.mjs`) gets:

- **A home of its own.** `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` and
  `TMPDIR` point into a fresh temporary folder (`<tmp>/pi-eval-iso-*`), removed at the end of the run whatever `--keep`
  says (also on Ctrl-C). It holds only a `.gitconfig` and, when the owner's Pi configuration has the task set's provider,
  `.pi/agent/models.json` (mode 0600) with that one provider entry, its key and any header fields left out.
- **No model key.** The per-run Pi configuration points at a proxy the bench runs for the length of the run (a unix
  socket in the run's folder, reached through the sandbox's bridge; 127.0.0.1 and a random port without a sandbox;
  closed with the run; the socket is mode 0600 in the run's 0700 folder). Bodies over 64 MB answer 413, at most 32
  connections, a fresh connection upstream per request, answers asked for uncompressed (a compressed one answers 502),
  and the key is cut out of every answer (headers and body) in case the model server echoes request headers. A client
  that half-closes after its request still gets the answer. The bridge forwards only to that one socket, at most 64
  connections at once. It forwards only `POST <api>/chat/completions` and `GET <api>/models`
  (the exact path, no query, redirects passed back and never followed), only when the request carries the run's own
  random token as its key (`pi-eval-local-proxy-<48 hex digits>`, in the per-run configuration), and puts the real key in
  the Authorization header instead; anything else answers 404 or 401 and is not forwarded. The key is read by the bench
  from `~/.pi/agent/models.json` and is never written into the agent's home, printed or logged, so an agent that prints its
  configuration prints no key, and another local process or another run cannot borrow the key through the proxy. (The
  agent itself can still send model requests through it.)
- **An environment from an allowlist.** `PATH` (with the run's `bin` first), locale, terminal, `USER`/`LOGNAME`,
  `NODE_OPTIONS`/`NODE_ENV`/`CI`, and names starting `PI_EVAL_`, `STUB_AGENT_`, `CLAUDE_AGENT_`, `FAKE_CLAUDE_`,
  `NIMBLENEWT_`, `LC_` (on Windows also the system names); never a name containing KEY, TOKEN, SECRET, PASSW, CREDENTIAL,
  COOKIE or PRIVATE. So no `SSH_AUTH_SOCK`, `GIT_*` of the operator, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`,
  `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`. The bench's own settings for the agent (provider, model, run mark,
  `--agent`'s mode variables) are added after.
- **git that cannot push out.** `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` name the run's settings (the same text is
  `~/.gitconfig`): `core.sshCommand=/bin/false`, every GitHub address form (https, http, `git@github.com:`, ssh, git)
  rewritten (`insteadOf` and `pushInsteadOf`) to `http://127.0.0.1:9/pushing-is-disabled/`, `protocol.allow=never` with
  `protocol.file.allow=always` (local folders still clone and fetch), an empty `credential.helper`, `push.default=nothing`,
  and the bench's identity. A `git` wrapper first on `PATH` (`lib/git-guard.mjs`) refuses, with "pushing is disabled in
  this environment": a push unless every destination is a local repository inside the run's own folders (its checkout or
  its temporary folder, where NimbleNewt's own tests make bare repositories); `remote add`/`set-url` to an address that is
  not a local folder; and a setting that would loosen the above, given with `-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`
  or `GIT_CONFIG_COUNT`, or written with `git config` in any scope. An alias (written, or given with `-c alias.x=...`) is
  judged as what it stands for, and a push's remotes are read with the call's own `-C`, `--git-dir` and `-c`. It runs the
  real git without `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND` or askpass programs, and with the run's own
  settings (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` set back, `GIT_CONFIG_NOSYSTEM` dropped). Each refusal is logged (its
  kind only) to `git-guard.log` in the run's artifacts.
- **The owner's folders hidden, no network, nothing writable outside the run (Linux, bubblewrap).** Second review,
  2026-11-17. The agent runs under `bwrap` with: the whole file system read-only (`--ro-bind / /`), except the run's
  checkout, its temporary folder and its artifacts, bound back writable; these hidden behind empty folders (more with
  `--hide a,b`): the owner's home folder, `/srv/ai`, `/srv/code/team` (its `secrets` holds SSH deploy and server keys),
  `/srv/code/test-postgres` (the test database's credentials), and in what stays readable (`/srv/code`, the reference
  repositories, the work root's parent) every file named like a key or login (`.env` and `.env.*` but not `.example`,
  `*.pem`, `*.key`, `id_rsa`/`id_ed25519` and the like, `.netrc`, `.git-credentials`, `.npmrc`, `.pgpass`,
  `credentials`, `credentials.json`, `secrets.json`, `*-token`, ...), every folder named `.ssh`, `.gnupg`, `.aws`,
  `secrets`, `credentials`, ..., and every folder only its owner may open (mode 0700), found by a walk five levels deep
  at each run's start (well under a second here; not into `node_modules`, `.git`, `dist`; the record says how many,
  `hiddenByName`); `/tmp`, `/var/tmp`, `/run`, `/dev/shm` and `/var/log` private (empty and its own: not the container
  engine's socket, ssh-agent's, gpg-agent's, the keyring's, D-Bus, tailscale or the database servers', no other
  program's scratch file, no shared memory, no system log, and a script the owner runs later such as `/tmp/nn-slot.sh`
  cannot be rewritten); every unix socket and everything only one of the user's supplementary groups may read in the
  system's folders (`/etc`, `/var`, `/opt`, `/srv`, `/mnt`, `/media`, `/usr/local`, `/boot`, six levels deep; here a
  snap's root service socket under `/var/snap` and the `adm`/`dip` files in `/etc`; the record lists them,
  `hiddenSystem`) and in the readable trees hidden too; a minimal `/dev` of its own; its own process list and `/proc`.
  The user's supplementary groups (adm, docker, sudo, ...) show as `nogroup` inside but still open what they open (a user
  namespace cannot drop them): that is why /var/log is private and group-only places are hidden; a place opened through
  a group only by an ACL entry (not by its mode bits) outside `/var/log` would not be found. And **a network namespace of its own** with only a loopback device: the
  host's loopback services (the team's Paperclip database, whose login is the package's built-in one, Hermes, the
  model server itself), the tailnet, the internet and the host's abstract sockets are out of reach. The one way out is
  the model route: `lib/net-bridge.mjs` runs first inside the sandbox, listens on a loopback port there and forwards to
  the bench's key proxy, which listens on a unix socket in the run's folder; then it starts the agent and ends with it.
  The run's git settings and wrapper are read-only. Where bubblewrap cannot run (macOS, Windows, a Linux without user
  namespaces) **no agent is started** unless `--allow-visible-home` is given; then the agent still gets the fresh home,
  environment and git settings, but can read the owner's files by their full path and reach the network (the proxy
  then listens on 127.0.0.1). `--dry-run` says which applies.
- **Detection as well as blocking.** A run is flagged `contaminated` when its tool calls show a push, a remote added or
  changed to an address that is not a local folder, or a path or socket of the owner's keys and logins (`~/.ssh`,
  `.git-credentials`, `id_rsa`/`id_ed25519` and the like, `.netrc`, the gh token, `SSH_AUTH_SOCK`, Pi's own
  `.pi/agent`, the container engine, the team's key folder; in a code search with grep, rg or git grep only such a path
  under a home folder counts, since code may name `.ssh`), or when the git wrapper refused anything.
  Records carry `credentialAttempts` (the kinds seen), `guardRefusals` and `isolation` (what applied to the run). File
  content the agent writes is not searched (code may talk about pushing). A contaminated run is left out of the report's
  table and gates (`report.mjs`, the batch's own report) and is never a verified finish; the report names them and their
  kinds, and `compare.mjs` shows them as `C`.

What the agent can still do, said plainly (in the sandbox): read what the user can read outside the hidden places
(`/srv/code`, including the reference checkout and other worktrees holding merged solutions, which `contaminated`
already looks for; system files such as `/etc` that everyone may read; Node's and Pi's installs); a credential kept under
a name or in a folder the walk does not know, or deeper than five levels (six in the system's folders), would be
readable too, and so would a socket deeper than that, so add such a place with `--hide`;
send model requests through the proxy (as it could with the key); run the real git by its full path past the wrapper
(it then meets the run's settings and has no network); push into a repository inside its own folders. It cannot reach
any network address but the model route, write outside its own folders, or see the host's `/tmp`, `/run`, `/dev/shm`
or `/var/log`. If the bench itself is killed with SIGKILL, the run's folder (its git settings and Pi configuration, never
the key) stays in the temporary folder. A `NODE_OPTIONS` naming a file in a hidden or private place stops the agent's
Node from starting. Inside the sandbox the agent cannot start a nested bubblewrap (AppArmor here refuses nested user
namespaces), so its own runs of the worker's and integration's real-sandbox tests skip (or fail under
`NIMBLENEWT_REQUIRE_SANDBOX=1`); every current task's tests are controller tests, which use no real sandbox, and the
bench's grading runs outside with its own environment. Runs that overlap (`--concurrency` up to 3 without the Radiance
gate) each have their own token, socket and namespace.

`isolation.test.mjs` tests it with a fake agent (`test-agents/incident-agent.mjs`) that repeats the incident and ways
around it against a decoy home with planted fake keys, and with the real Pi program (when installed) against a stand-in
model server on loopback: its shell tool runs the incident's commands inside the sandbox.

## A control run (another agent on the same tasks)

To tell a hard task from a weak agent, run one repeat per task with another agent and compare. Any program works that
takes `<checkout> <prompt-file> <log-file>`, works in the checkout and writes a Pi-style JSON event log (`session`,
`agent_start`, `message_end` with the assistant's reply, tool events, `agent_end`; see `stub-agent.mjs`, which is the
smallest one). For a Claude control, a wrapper that runs Claude Code non-interactively in the checkout and converts its
stream to these events is enough: that is `agents/claude-agent.mjs`.

`agents/claude-agent.mjs` runs `claude -p --output-format stream-json --verbose --permission-mode acceptEdits
--allowedTools Bash,Read,Edit,Write,Glob,Grep --disallowedTools WebFetch,WebSearch --strict-mcp-config` in the checkout
with the prompt on stdin, and converts each stream line to the Pi events above (a stream that ends without Claude's
`result` has no `agent_end`, so it is not a finish; a `result` that is an error, such as the turn limit, ends on an
`error` reply). `CLAUDE_AGENT_BIN` picks the CLI (default `claude` on PATH), `CLAUDE_AGENT_MODEL` adds `--model`.
Claude's stderr goes to `claude-stderr.log` beside the log. It does not use Radiance. Since the isolation above it runs
with a fresh home like every agent, so the Claude Code login of the user who runs it is NOT available to it and a real
control run cannot log in; giving it a credential is a decision not yet taken (the bench passes none). `claude-agent.test.mjs` tests it
against a fake CLI (`agents/fake-claude.mjs`) only; it has never been run against the real CLI, so check the first
run's `agent.jsonl` by hand. One control repeat per task, then the comparison:

```sh
node scripts/pi-eval/run.mjs --agent scripts/pi-eval/agents/claude-agent.mjs --label claude-control --repeats 1 --variants A
node scripts/pi-eval/compare.mjs --results /srv/code/worktrees-pi/eval-results
```

Run it from the repository root (the agent path is resolved from the current directory). The Claude run is isolated like
Pi's (above), which also means it runs as the same user outside the hidden folders, so read its log for paths outside the
checkout before trusting a finish. Bash is allowed without
a restriction (only Edit and Write are limited to the checkout by `acceptEdits`), so a Bash command can read and write
anything that user can, including the reference checkouts and other worktrees; run it only when nothing else is working
in them. A full control pass (9 tasks, one repeat) is up to 9 runs of 60 to 180 minutes on the account's quota.

`compare.mjs` groups records by their agent label (`--label`, else the agent's path) and shows per task and variant
each agent's finishes and outcomes, then per agent: finishes, false done, interface mismatches, other endings and the
shipped-wording score. `runner.test.mjs` runs exactly this with two stand-in agents.

## When to run it

Radiance is shared with the Paperclip coders, and Pi runs at most 3 agents at once there. A full baseline is
9 tasks x 2 variants x 3 repeats = 54 runs, at 30 to 180 minutes each: roughly 20 GPU hours at concurrency 1. Run it at
a quiet time (overnight), with `--concurrency 2` or `3` only when nothing else is using Radiance, and in the background
(`nohup node scripts/pi-eval/run.mjs > /srv/code/worktrees-pi/eval-results/nohup.log 2>&1 &`).
Each run also builds the repository twice and runs the hidden test files (a few minutes of CPU).

## Where results go

Not in the repository. By default `/srv/code/worktrees-pi/eval-results/` (or `--results DIR` / `PI_EVAL_RESULTS`):

- `results.jsonl`: one line per run: task, size, variant, repeat, base and solution commits, the bench's own commit, route
  (provider, model, thinking), start and end time, wall time, exit code, timeout, **outcome** and the reason, the end kind,
  the last stop reason and visible characters, turns, tool calls, tokens, nudges (0 until W04), PLAN.md progress, commits
  ahead of the base, the diff stat, the hidden test counts, and whether a tool call named another checkout or tried to push or reach the owner's keys (contaminated; `credentialAttempts`, `guardRefusals` and `isolation` say more).
- `runs/<runId>/`: the prompt given, Pi's whole JSON log (`agent.jsonl`, stdout only), Pi's stderr (`pi-stderr.log`), the
  setup, the acceptance run (`hidden-setup.log`, `hidden-tests.log`), the shipped suites (`shipped-setup.log`,
  `shipped-tests.log`), the diff stat. The record's `hidden` is the acceptance result (with `interfaceMismatch` and
  `typeErrorFiles`), `shipped` the informational one, `doneClaim` and `selfTest` what the classifier read.
- `<batchId>-report.md`: the report for that batch. `calibration.jsonl` and `calibration/<task>/`: calibration runs
  (with the spec-fit result).
- `baseline-1-invalid/`: the first baseline, kept as data only (see above).

Throwaway checkouts are `/srv/code/worktrees-pi/eval-work/eval-<runId>` (`--work-root` / `PI_EVAL_WORK_ROOT`), in a
directory of their own so the agent's parent directory is not the one holding the merged worktrees. Each is removed after
its run, and on Ctrl-C (`--keep` keeps them; calibration checkouts are `eval-calibrate-<task>-<pid>`). On Linux, any
process left over when the agent ends, after each suite, when the run ends or when Ctrl-C arrives (Pi starts its bash
tools in their own process groups, so a hung test or a background server survives the group stop) is killed first: one
working inside the checkout, one carrying the run's `PI_EVAL_RUN_DIR` mark, or a descendant of either (never the bench
itself or its parents). A process that both left the checkout and dropped or replaced its environment, and does not
descend from one that is seen, is missed; on other systems only the agent's own process group is stopped.

## What a run does

1. `git init` a new directory and fetch **only the base commit** from this repository, so neither the solution commit nor
   any later commit is in its object store (`git log --all`, `git show <solution>` cannot reach it). The run refuses to
   start if the solution is reachable or a hidden file already holds the solution's content. `node_modules` (root and
   per package) are copied from this checkout, and the repository is built (`tsc --build --force`).
2. The prompt is the variant's template (`prompts/variant-a.md`, `prompts/variant-b.md`) with the task text
   (`tasks/<id>.md`) and, for B to D, the completion rules (see Variants) put in; it is saved beside the log, outside the checkout.
3. The agent (`pi-agent.mjs`: `pi -p --no-session --no-approve --provider radiance --model qwen3.8-flash-next-iq4r
   --thinking medium --mode json`, the same flags as `~/.local/pi-cli/runcard.sh`) runs in the checkout under the task's
   wall-clock limit (S 60, M 120, L 180 minutes); at the limit its process group is stopped.
4. PLAN.md progress and the diff are read; the acceptance suite is written in (its bench files, and any `support` files
   from the solution), the repository is built again and the acceptance tests are run (`node --test`, offline guard,
   `NIMBLENEWT_REQUIRE_SANDBOX=1`). Then the solution's version of every shipped test file is written in, built and run
   for the informational score. (A task without an acceptance suite is scored on its shipped files, as before.)
5. The ending is classified (`lib/classify.mjs`), in this order:
   - **timeout**: stopped at the wall-clock limit.
   - **error**: no Pi session, a reply that ended in `error`/`aborted`, a non-zero exit before the run ended, or a bench
     error (a failed checkout, a leak).
   - **verified-finish**: the repository builds (`tsc --build` exits 0 with the acceptance files in) and the acceptance
     tests pass on a worktree the agent changed. tsc emits despite type errors, so a passing test run on a failed build is not a
     finish. (Passing on an unchanged worktree is an error: the task is not calibrated.)
   - **length**: the last reply stopped on `length`.
   - **empty**: no visible text, and either no work at all (no tool call) or "No response requested".
   - **stopped-early**: the agent stopped while working: unchecked PLAN.md steps, a thinking-only reply after tool calls,
     an announced next step, a reply that does not claim to be done, or a log that ends without `agent_end`.
   - **interface-mismatch**: the last reply says it is done (see `wrong`) and the build failed only in the acceptance
     files: they do not type-check against the agent's code. It counts in the false-done gate: the CONTRACT pins every name
     and signature, so a mismatch means the agent ignored it (decision of the lead, 2026-11-10).
   - **wrong** (false done): the last reply says it is done and the acceptance tests fail. A report given with every
     PLAN.md box ticked, a clean tree and a green last self-test is a done claim whatever its words; a closing caveat
     note ("Remaining risk / not done: ...") keeps it one (`doneClaim: done-with-caveats`). A report that says what is not
     done ("could not complete", "still fails", "remaining work", "incomplete", "mostly done", "I'm blocked") is not a
     done claim ("no remaining failures", "nothing left to do" do not count as saying so), and neither is one whose first
     stated result is partial or blocked (card W06: variant B asks the report to start with its result): an opening
     "Partial." / "Blocked by ..." / "## Blocked" / "⚠️ Partial:", or a result label at the start of a line ("Result:
     partial", "**Result**: blocked", "Status: partial", "The result is partial", "Result (done, partial or blocked):
     partial"); a long report that states none in its first 600 characters is read for such a label in its last 600.
     Only the first stated result counts, and a word not used as a result ("Blocked users are refused", "Status: blocked
     requests get 403") states none. A result stated as done ("Done.", "Result: done", "Done, but ...") is a done claim
     whatever not-done words follow it (`done-with-caveats` when there are some), so a false done is never hidden as a
     stop; an opening "Done:" that may only head a list of what was done does not override them. Without a stated
     result, a report that describes the old state with a negation ("the tests were not passing before") also reads as
     not done, so `wrong` can undercount; a closing "Let me know ..." is a sign-off, not an announced step. Only the
     first and last 600 characters of the report (before any closing caveat note) are read for these words.
   - **unclassified**: anything the rules above do not cover; the gate requires none.

## Variants

- **A** the plain prompt (task, rules, build and test commands, "end with a short report").
- **B** A plus the completion rules every NimbleNewt Pi agent has in its system prompt (card W06), word for word: a
  PLAN.md with a checkbox per small step, no commit (the checkout is scored as it stands), done only when every step is
  done and checked, blocked or partial with a reason otherwise, never an ending in prose alone. The template has the
  placeholder `{{COMPLETION_RULES}}`; the runner fills it from this checkout's built pi-adapter
  (`packages/pi-adapter/dist/prompt-layout.js`, `COMPLETION_RULES`; build first) and records the text's digest and size in
  the result (`completionRules: { sha256, chars }`). A short note in front says what differs on the Pi command line: no
  `nimblenewt__work-end` tool (end with a report that starts with the result instead) and nothing checks the checkout.
  Until W06, B was "tick and commit after each step"; results of earlier batches carry no `completionRules`.
- **C** B (the same prompt, with the completion rules) plus the bounded continuation of W04, and **D** C plus a relaunch that reuses the stored session
  (`PI_EVAL_SESSION_ID` makes `pi-agent.mjs` pass `--session-id`). Both are refused with "needs W04" until W04 lands.

## The release gates

Per variant: verified finish at least **90 %** of S runs, **85 %** of M runs, **70 %** of L runs; false done (`wrong`) at
most **5 %** of all runs; **zero** unclassified runs (every non-finish is named). Interface mismatches count as
non-finishes only. The shipped-wording score is printed per variant and gates nothing. The report shows each rate with its
Wilson 95 % interval and says when a rate that meets its gate still has an interval reaching below it (too few runs to be
sure), then a PASS/FAIL line per variant and one RESULT line.

## The task set (`taskset.json`)

Nine merged cards, base = the merge's first parent, solution = the merge commit, hidden files = the test files the merge
added or changed (plus test suites they use). Sizes by non-test source lines changed (S under 100, M 100 to 250, L over
250 or several subsystems):

| id | size | merge | what |
|---|---|---|---|
| quote-lines | S | 081248b7 | proposal lines quote every borrowed name |
| flaky-proposal | S | 212db814 | a flaky release approval is a shown proposal |
| grant-proposals | S | eac67f71 | grants with no limit or no end are shown proposals |
| landing-proposal | M | 0e84a1b9 | landing on main is a confirmed proposal |
| c07n | M | b3851601 | a route of unknown window is checked or refused |
| phrase-hints | M | 9bb923b4 | dated rights, host moves as proposals, refusals that ask |
| m03h-1 | L | e78581b6 | stand-ups status view and chat reach |
| l02e-2 | L | 1c8816fe | wider Stops walk swarm children; sweep not starved; stop view |
| c07m | L | eb19ba95 | the first call names the hand-off, the note and the blockers |

The task texts are the prompts Pi was actually given for these cards (`~/.local/pi-cli/runs/*.prompt`), without their
process steps (the variant supplies those), plus an "acceptance details" part, and since 2026-11-10 a CONTRACT block that
pins everything the acceptance suite checks. `hiddenFiles`/`testFiles` in `taskset.json` are the shipped test files (the
informational score); the scored suite of each task is `acceptance/<id>/acceptance.json` (`files`: checkout path to
bench file; `support`: helper files taken from the solution; `testFiles`; optional `testNamePatterns`; `allow`: the
spec-fit allowlist, item to reason).

## Tests

```sh
node --test "scripts/pi-eval/*.test.mjs"
```

The classifier on logs trimmed from real Pi runs (`fixtures/`: the smoke run's report-then-failing-test = wrong, c07p ended thinking-only mid-work = stopped-early,
x09b-fix3 = length, capacity-view-pi "No response requested" = empty, flaky-confirm = a report, finish or false done
depending on the hidden tests), the aggregation and gates, and the runner end to end on a tiny repository with
`stub-agent.mjs`: the deliberately broken agent that stops after its first turn is scored **stopped-early, never
finished**; a thinking-only stop, a false done, a crash, a hang (timeout) and an honest solver (verified finish) are scored
as such; the agent's checkout holds no hidden file and cannot reach the solution commit; calibration passes. Since
2026-11-10 also: the baseline's misread endings (fixtures `c07n-all-steps-committed`, `flaky-report-no-done-word`,
`phrase-hints-done-with-caveats`), done-with-caveats and interface mismatch; an acceptance suite scored with the shipped
tests beside it; calibration's spec fit flagging an unstated regex until it is allowlisted or stated; leftover processes
outside the checkout (a marked server in /tmp and its unmarked helper) stopped; a control run with two stand-in agents
recorded and compared (`specfit.test.mjs` tests the extraction itself); the Claude control wrapper against a fake CLI
(`claude-agent.test.mjs`). These are not part of `npm test` (which runs
`scripts/*.test.mjs` only). Since 2026-11-17 also the agent's isolation (`isolation.test.mjs`, see "The agent's
isolation"); its sandboxed cases are skipped where bubblewrap cannot run, unless `NIMBLENEWT_REQUIRE_SANDBOX=1`.

## Smoke run (2026-11-09)

One run of variant A on `quote-lines` (S), bench commit 4abd2e0d, route radiance / qwen3.8-flash-next-iq4r / thinking
medium, `node scripts/pi-eval/run.mjs --tasks quote-lines --variants A --repeats 1`:

- First attempt (batch-20261109T201108): **error**. Radiance answered the first request with "the engine stopped on an
  error and is not serving (device error)" and the run ended after 4 s. The bench scored it as an error with that reason.
  Nothing was restarted; Radiance was answering again 10 minutes later.
- Second attempt (batch-20261109T202130): Pi worked 30.5 minutes (100 turns, 110 tool calls, about 0.57M input + 8.4M
  cached tokens, 72k output), made 1 commit (6 files, +222 -10), and ended on a 3332-character report that opens with
  "Done.". Hidden tests: **153 of 154 pass**. The one failure is `a long name is cut between whole characters and whole
  escapes, at its own bound and at the line's` (`chat/commands-one-line.test.ts`). Outcome: **wrong** (a false done).
  The first score was stopped-early, because the classifier read only the last 600 characters for a done claim. That was
  fixed (it now reads both ends of the report; fixture `quote-lines-smoke-false-done.jsonl`), and `rescore.mjs --write`
  re-scored the record.

The pipeline works end to end: a fresh checkout without the solution, Pi pinned to Radiance, the time limit, PLAN/diff
capture, hidden tests copied in and run, classification and the report. One run says nothing about rates.

`node scripts/pi-eval/rescore.mjs [--write]` re-scores recorded runs from their saved logs after a classifier change.

## Not done yet

- **The baseline.** W01's acceptance asks for a recorded baseline of variants A and B over the whole set. The first one
  (2026-11-09/10) is invalid (see the top); a new one on the acceptance suites has not been run. Run
  `node scripts/pi-eval/run.mjs` at a quiet time and record the batch (its commit, route, model and per-run results are in
  `results.jsonl`) in the implementation notes.
- **A control run** (one repeat per task by Claude, `--agent scripts/pi-eval/agents/claude-agent.mjs --label
  claude-control`) is supported and its wrapper is tested against a fake CLI, but it has not been run.
- **Variants C and D** wait for W04 (and D for a session the runner can relaunch).
- **Spec fit is lexical.** It sees literals, regexes, property names and imports inside assertions; it does not see a
  demand built at run time (a helper that compares against a computed string), the order or count of outputs, or the
  types an acceptance file relies on beyond its imports. A literal kept in a constant outside the assertions
  (`const MARK = "..."; ... assert.ok(x.includes(MARK))`) is read as the test's own fixture, so it is never flagged:
  check such constants by hand (on 2026-11-10 a search found each one to be a fixture input, a negative check, or text in the prompt or the base source). The CONTRACT blocks were written by reading each acceptance file;
  an interface mismatch in a new run still points at a gap there.
- **Isolation hides the owner's folders and cuts the network, not every readable file.** Since 2026-11-17 (above, "The
  agent's isolation") the owner's home, keys, sockets and `/srv/ai` are hidden, the network is the model route only and
  nothing outside the run is writable, but Pi still runs as the same user and can read what that user can elsewhere: the other worktrees under `/srv/code/worktrees-pi` (several
  hold these very cards' merged solutions), the reference checkout, earlier runs' artifacts, and a concurrent run's
  checkout after its hidden tests were copied in. Hiding those too is not done (they sit beside the bench's own folders
  under `/srv/code`, which `--hide` could cover case by case). What exists for them is detection: a run is
  flagged `contaminated` (and `foreignPaths` lists up to 20) when a tool call's arguments name an absolute path under
  the reference checkout, any directory holding a checkout, the results, or the home directory (except Pi's install),
  or the solution's short SHA. It does not see a relative walk (`cat ../c07m/...`), a path built at run time, or a
  search from `/`. Read flagged runs, and spot-check some unflagged finishes, before trusting a rate.
- **Nudges and the W02 end kinds** come from the worker once W02/W04 exist; the bench reads the CLI log only, so
  `nudges` is 0 and `endKind` is the bench's own reading.
- **Windows.** The runner and classifier are plain Node (no shell, `node:path`, `child.kill` where there are no process
  groups), but it has only been run on Linux, and the default Pi location is `~/.local/pi-cli`.
