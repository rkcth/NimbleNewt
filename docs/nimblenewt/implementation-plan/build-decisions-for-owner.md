# Decisions made while building, for the owner to review

Written during the long coding session of 2026-10-22. By the guiding principle the building session decides what it can and does not interrupt the owner; every decision below was made by an AI session on the evidence in the card and the code, is recorded here, and is open to change. Each item names the card, the choice made and the alternative.

## C01b (shared working notes)
- **Project member means holding `desk.read` in the project.** Principals with a `*` grant (supervisors, services) therefore read every shared note. Alternative: a dedicated notes grant.
- **The chair read uses the stand-in action `notes.chair.read`.** M05b is to grant it to the meeting chair (or replace it); it is not meant to stay a permanent separate action unless M05b keeps it.
- **Promotion records the request only** (against the revision and digest, with an optional `reviewId` that must be the same agent's review in the same project). Nothing yet links a decided review back to the promotion, and nothing writes the file; the card that wires the promotion workflow (T08 and P02) closes that loop.
- **Private notes are closed to `desk.scratch.read` holders** (only the agent and the owner read them), unlike private desk scratch.
- **A deleted note vanishes for everyone but the owner**, who sees an empty marker.
- **No limit on the number of notes per agent** for now.
- **Redaction now also catches Google API keys, Stripe keys and npm tokens**, and the named-assignment pattern still refuses prose such as `token: refreshed`.

## H06b (idle event subscriptions)
- **The owner's idle setting is a ceiling.** A subscriber may ask for a shorter idle time, never a longer one; there is no per-subscription owner override.
- **Expiry of a critical (host or service) subscription always files a Notice**, even with nothing pending (a host disappeared); a non-critical one files a Notice only when events were waiting for it.
- **Any publish that sees an idle critical watcher expires it**, so a producer's call writes the record about someone else's subscription; the Notice is left to the sweep so slow channels never slow producers.
- **Only the owner and service principals may run the sweep** (`expireIdle`), not hosts or agents. Nothing calls it on a schedule yet; the dispatcher or an S08 timer must.

## F04i and F04j (filesystem and prerequisite checks)
- **A SQLite data directory on a network filesystem can be started with the override** (the owner said "error, and allow an override"), even though sharing a SQLite file over a network can corrupt it; the refusal says so.
- **A supported start writes the host and distribution once as an `environment.host` audit record** and prints nothing.
- **A missing systemd user session stays overridable** (weaker limit fallbacks exist and the launch record reports them); missing git, sandbox tools and database libraries cannot be overridden.
- **Sandbox and limits tools are required at start only when the start options name those features.**
- **A network or unsupported filesystem under a workspace root is refused too**, not only under the data directory.
- **The git floor is 2.38.1**, derived from the `protocol.file.allow` flag the workspace bridge sets.

## C05 (context branches)
- **Only the branch owner and the installation owner can view or command a branch.** A branch's return destination and a delegated child must be a task of the same project. `resume` ends a branch (no discard operation). Other writers are not blocked while a branch is suspended; restore reports what they wrote.

## V01 (stall detection)
- **Provisional thresholds** (minutes request/silence, repeat counts for actions and errors): trivial 2/5, 4, 3; easy 5/10, 5, 4; medium 10/20, 6, 5; hard 20/40, 8, 6; expert 45/90, 10, 8. A dismissal silences a concern for 6 hours. All are settings.
- **A task's own owner never decides its own concern**, even with `assignment.manage`; concerns go to the agent's active supervisor, else the owner.
- **A stale timestamp never permits a takeover**; a takeover may be proposed only when the worker is silent and its host is revoked or stale.
