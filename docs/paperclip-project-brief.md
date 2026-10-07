# NimbleNewt — project goals and execution hold

**Planning only. Not authorized to start.** Rob authorized project registration, goal documentation and a task outline on October 7, 2026. No agent research, implementation, review runs, dispatch, publication or deployment is authorized by this import. Keep all issues unassigned in Backlog and outside automatic scheduling until Rob explicitly selects work. Do not remove the activation dependency automatically.

## Purpose

Build a persistent, conversational team of AI agents for one human owner. Agents coordinate across projects, keep durable context, and resume work after interruptions or restarts. Work includes development, QA, operations, research, support, marketing, graphics and user/developer documentation.

## Goals

1. Let the owner plan and direct work through conversation, with decisions taking precedence over agent votes.
2. Preserve task context, assignments and effects through Pause, Suspend, explicit release, Stop and restart; never silently duplicate external actions.
3. Coordinate agents through scoped messages, supervisors, events and scheduled or urgent meetings, with summaries, full transcripts and reasoned votes.
4. Provide configurable difficulty-based models and ordered fallback routes, respecting provider exclusions, budgets and data permissions.
5. Give agents independent desks and environments, protected system tools and a reviewed shared toolbox, with enforced access boundaries.
6. Detect stalled or looping work and enable bounded supervisor recovery without losing context or bypassing human holds.
7. Work across existing repositories and services without polluting target repositories; support macOS, Linux and Windows.
8. Make work inspectable and independently reviewable; balance delivery with capacity improvement. Ship under MIT with portable public defaults and controlled updates.

## Current evidence and open decisions

The repository contains design documentation, mascot assets and limited offline harness experiments. Pi Durable is the selected initial runtime direction; it is not yet qualified for the full product. Existing recovery experiments were run on macOS and do not establish Linux/Windows, reboot, isolation or provider-failover behavior.

Worker topology, storage/transport, OS support details, numerical budgets and the first useful release remain decisions to make. The sequence below is a proposed implementation outline, not an approved MVP or execution schedule. Optional self-development of NimbleNewt is separate from normal product use.

## Sources

- Repository: https://github.com/rkcth/NimbleNewt
- Current local source: `/Volumes/RobsExternalDrive/Programming/AIImageMaker/NimbleNewt`
- Design: `docs/nimblenewt/README.md`, `design-decisions.md`, `operational-contracts.md`, `pitfalls-and-safeguards.md`, and supporting documents.
- The planning issue holds a snapshot of current design documents, including local uncommitted supervisor-recovery requirements. Remote GitHub content may lag this snapshot. No execution workspace or server clone is provisioned by this import.

## Activation

Rob must explicitly authorize scope before N00 is completed. The team can then select eligible tasks, assign owners and register only authorized work with the scheduler. No agent is assigned during onboarding. Project status alone is not an execution lock; unassigned backlog state, the human gate and exclusion from scheduler authorization enforce the current hold.

## Paperclip registration

- [Project](http://192.168.2.10:3100/AII/projects/nimblenewt) — Backlog, no lead agent.
- [Planning documents and human activation gate](http://192.168.2.10:3100/AII/issues/AII-250).
- Work outline: AII-251 through AII-269, all unassigned Backlog and outside scheduler authorization.
- Registered October 7, 2026; no execution workspace provisioned and no implementation started by onboarding.
