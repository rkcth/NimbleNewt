# Our NimbleNewt development deployment

This document describes an optional deployment-specific workflow for the team developing NimbleNewt. It is not a required public-product feature or an enabled-by-default self-modification loop. Public users primarily improve their own projects, tools, skills, and workflows.

## Use ordinary product capabilities

Register the NimbleNewt source repository as an ordinary project. Configure its team, roles, model routes, PC budget, review rules, build tools, and candidate-release permissions outside the public source defaults. Use the same tasks, desks, stand-ups, improvement proposals, tool catalog, and permission checks available to other deployments. NimbleNewt's name must not trigger special execution authority in the core.

The source checkout and test environments are separate from the running installation, controller state, release credentials, and updater. A coding agent may be authorized to change source and run isolated tests without being authorized to publish a release or deploy it. Our private endpoints, host paths, secrets, and deployment policy are not public defaults or examples containing real values.

## From observation to an evaluated change

1. An agent records a concrete problem when it occurs or raises it at stand-up. Include affected tasks, shareable evidence, impact, and a possible change if known. An observation is useful even without a proposed solution.
2. A facilitator groups duplicates while retaining independent reports. Record investigation, acceptance for planning, deferral, or rejection with a reason and owner. Use a project improvement backlog, not a privileged global queue.
3. Authorized work gets a task contract, budget, acceptance criteria, and P/PC classification. Improving our development tooling is PC. Delivering a scheduled NimbleNewt feature may be P; being a change to NimbleNewt does not automatically make it PC. Urgent incident work follows the incident policy.
4. Agents investigate and prepare patches in isolated checkouts. Independent review checks the artifact against the task contract and current human decisions. A stand-up vote helps prioritize; it does not authorize merging, publishing, or deploying beyond existing delegation.
5. A controlled build produces an immutable candidate tied to reviewed source, dependencies, tests, and migrations. Optional deployment tooling submits its exact identity to the authorized release process.
6. If eligible under our maintenance policy, the candidate goes through the same [activation and rollback protocol](maintenance-and-updates.md) used to install other authorized releases. Agents do not edit live code or replace the updater.
7. Link the result back to the proposal and report it in a later stand-up. Evaluate whether the reported friction improved and whether other roles regressed. Retain deferred proposals with reasons; do not require daily suggestions or adopt unsuccessful experiments merely to show activity.

## Public/private boundary

The public product includes generic project improvement records and P/PC planning. It may install verified official releases under user-controlled maintenance settings. It must not require a NimbleNewt development team, access to NimbleNewt's upstream repository, a compiler for building NimbleNewt, or permission to submit upstream changes merely to operate.

Our candidate-build pipeline, team configuration, development release channel, and standing deployment authority are optional installation tooling. They may later be published as sanitized examples or integrations, but they are not dependencies of a normal installation. A user who intentionally develops a fork can configure an equivalent workflow without changing core policy.

Reading documentation, discovering a bug, or voting for an improvement does not automatically send telemetry, open a public issue, create a PR, or expose private task records. Any external contribution or report requires its ordinary scoped authorization and deliberate selection of shareable evidence.

## Validation

Verify that a clean public installation works with all development integrations absent. Verify that our agents can produce a candidate but cannot modify the active installation or updater. Exercise proposal-to-task tracking, independent review, exact-artifact authorization, failed activation, rollback, and post-adoption feedback without granting authority through a project name or meeting vote.
