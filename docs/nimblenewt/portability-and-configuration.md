# Standalone distribution and configuration

NimbleNewt is intended to become an independent open-source application. This standalone repository contains the design and harness experiments extracted from the original incubation project. A new user must be able to install and configure it without the original project's code, services, private documentation, accounts, or host layout. This is an accepted product requirement; the mechanisms below are proposed design, not implemented functionality.

**NimbleNewt must work on macOS, Linux, and Windows.** All three are required product targets, not optional future ports. Current experimental evidence covers macOS only.

Each installation is under one human owner's control and supports both project work and ongoing responsibilities. A developer's development machine is an important installation setting; support their existing checkouts, tools, and organizational contribution process without requiring coworkers to use NimbleNewt. Server maintenance and other ongoing work must declare their availability needs: continuous agent response requires an always-available execution host, while an intermittently running installation must show coverage gaps and reconcile on return. Local execution is the baseline; remote model services remain configurable, and multi-host agent workers are a separate pending proposal. See [the developer workflow](organization-and-workers.md#developer-workflow-within-an-organization).

## Separate the product from its installation

Keep the durable controller, agent/task records, lifecycle, meetings, permissions, and routing contracts in the reusable core. The public product does not require or enable a team that modifies NimbleNewt itself; our [development workflow](development-workflow.md) is installation-specific. Official-release installation and rollback are separate public capabilities, described in [maintenance and updates](maintenance-and-updates.md). Harnesses, model providers, execution environments, and external services connect through explicit adapters with declared capabilities. Adapters may require their own dependencies, but unrelated integrations must remain optional.

Deployment configuration supplies endpoints, credential references, model IDs, filesystem locations, resource limits, and selected adapters. Local coders, Strata, vLLM, OpenRouter, or any named cloud model are optional choices. Neither difficulty nor an agent role hardcodes a model, machine, provider, or route. Do not assume a GPU or access to a particular cloud account. Examples must be visibly illustrative and must not silently activate paid services.

Keep deployment data outside both NimbleNewt's source checkout and the repositories agents work on. Use configurable data/configuration directories and logical workspace bindings rather than personal absolute paths. On another host, rebind missing paths and secrets explicitly. Report unqualified or unavailable adapter capabilities accurately while providing a supported path for core operation on each required operating system.

## Required operating-system support

The controller, UI, conversational interface, configuration, and at least one qualified agent execution path must work on each OS. Core use on Windows must not depend on the user converting the installation into a Linux deployment. Containers, virtual machines, WSL, and remote workers may be execution-backend options with disclosed prerequisites; they are not substitutes for qualifying the Windows product. The UI may be browser-based; this requirement does not select a desktop framework.

Keep platform behavior behind explicit adapters and preserve the same user-visible contracts:

| Area | Required design and validation |
| --- | --- |
| Installation and updates | Document and test clean installation, dependency setup, upgrades, rollback, and uninstallation on each OS. Avoid mandatory Bash, Homebrew, systemd, or other single-platform tooling in common setup. |
| Paths and workspace access | Use path APIs and argument arrays; test spaces, Unicode, drive/volume roots, case differences, long paths, symlinks, and Windows junctions. Protect backing Git metadata through every supported access route. |
| Processes and jobs | Adapt launch, cancellation, process-tree cleanup, and forced termination to each OS. Do not equate a POSIX signal number with a portable lifecycle operation. Track child and remote jobs independently of terminal sessions. |
| Persistence and recovery | Validate locks, atomic updates, flush behavior, and restoration on supported filesystems. Preserve assignments, pending decisions, and Pause state after process termination and host restart. Do not infer power-loss safety from a process-kill test. |
| Isolation and credentials | Provide qualified execution boundaries and secret-store integration per platform. Do not silently replace enforcement with prompts or assume Unix permissions apply everywhere. |
| Tools and environments | Declare script interpreters, platform requirements, and dependencies in tool/environment manifests. Offer a compatible execution backend or a clear unavailable state for optional tools. |
| Background operation | Support the chosen application/service launch modes on each OS. Distinguish user logout, sleep/wake, worker failure, and planned system shutdown when recovering jobs and missed events. |

Define minimum OS versions, Linux distributions, CPU architectures, and supported filesystems before release qualification. macOS Apple Silicon/Intel and Windows/Linux architecture coverage require an explicit support matrix; testing one architecture is not evidence for another. These version and architecture choices remain open, but none of the three OS families may be omitted.

Use CI on macOS, Linux, and Windows for shared code and adapter tests, plus installation and recovery acceptance tests on each supported target. Gate platform-support claims on results. Where a test mechanism is OS-specific, implement an equivalent mechanism with the same behavioral assertions; do not skip required recovery or isolation behavior to obtain a green matrix. Optional integration tests may be capability-gated and must report why they did not run.

## UI-managed settings

Normal setup and administration must not require source edits. Provide UI controls for:

| Area | User-adjustable values |
| --- | --- |
| Providers and endpoints | Adapter, service URL, account/credential reference, enabled state, and capability/connection checks. |
| Models and routing | Model IDs, supported reasoning options, resource/cost limits, and ordered fallback lists; show why a route is unavailable. |
| Difficulty profiles | User-defined profiles and mappings for simple, medium, and demanding tasks; no locality or provider implied by a tier. |
| Agents and teams | Roles, hierarchy, default execution profile, permitted overrides, and environment selection. |
| Environments and repositories | Harness, execution backend, workspace bindings, data locations, shared resources, and limits supported by that backend. |
| Tools and extensions | Catalog entries, permissions, approved versions, installation/restart status, and rollback choices. |
| Shared toolbox | Scoped maintainer assignments, role/team/all-agent audiences, read-only source inspection, personal forks, improvement proposals and diffs, published versions, compatibility, revocation, and rollback. |
| Quality assurance | Own-work, assigned-review, and project/team scope; reviewer assignments, triggers, evidence requirements, independent-review gates, and escalation rules. |
| Operations | Meeting schedules and timezone, notifications, budgets, retention, and lifecycle preparation limits. |
| P/PC planning | Production/capacity task categories, allocation window and accounting basis, protected shares, spending/concurrency ceilings, maximum waiting time, and expiring exceptions. |
| Project improvement backlog | Problems and proposals about the user's own projects/tooling, evidence, meeting links, owners, dispositions, linked work, and evaluated results. Our NimbleNewt-source backlog is an optional configured use. |
| Maintenance and releases | Window/timezone, target scope, exact released version, delegated release authority, preparation and health deadlines, status, rollback eligibility, and failure history. |

Show the effective setting and where it comes from. Proposed precedence is installation defaults, team/agent settings, then explicit task overrides, all constrained by authorization, budgets, capabilities, and current user decisions. Some policies are restrictions rather than defaults: a task override cannot re-enable a globally disabled provider or grant itself broader authority. The UI should distinguish editable, inherited, and administratively locked values.

The UI, conversational controls, and any CLI/API must use the same configuration service, validation, and permission checks. For example, reordering a fallback list in the UI and asking the supervisor to reorder it should produce the same durable routing revision. A headless deployment should remain operable through the same service contracts.

## Safe configuration changes

Store schema-versioned configuration and apply validated changes atomically, with an actor, revision, and readable change history. Validate endpoint and adapter fields, missing routes, fallback cycles, and permission/capability conflicts. Separate draft settings from applied settings; do not report a failed update as active. Concurrent edits must not silently overwrite one another.

Explain when changes take effect: next request, after the current operation, or after Suspend and restart. Global provider exclusions take effect at dispatch under the existing routing contract, including retries and helper calls. Pin environment/tool versions for work that is already running and use the existing approved upgrade/rollback process where needed. Reloading configuration must preserve Pause, task ownership, and pending decisions.

Credentials belong in a secret store; ordinary configuration contains references. The UI can add or replace a secret without returning its stored value. Export/import should preserve useful profiles and references while excluding secret values, transcripts, private host details, and deployment history by default. Provide a preview of what will be shared and a mapping step for environment-specific fields. Configuration export and full recovery backup are separate operations.

If no eligible model is configured, NimbleNewt can still expose deterministic setup and administration. It must not invent a fallback, contact a sample endpoint, or select a paid provider automatically. Switching local work to a cloud route still requires the task's existing data-sharing authorization.

## Standalone repository boundary

Keep NimbleNewt-owned code, documentation, schemas, examples, and tests self-contained. Give the future repository its own dependency manifests, lockfiles, build/test commands, CI, and installation guide. It must not import application internals from the current image-maker project or rely on its environment files, personal agent instructions, or services. Integrations with existing orchestration must remain optional.

The current extraction set is `docs/nimblenewt/` and `benchmarks/nimblenewt-harness/`; add future NimbleNewt code explicitly. Move that set together and update relative links and commands for the chosen layout. Historical experiment versions and platform observations remain evidence, not product platform requirements. Existing crash probes rely on POSIX SIGKILL, a `-9` exit-code assertion, and shell-specific setup. They have been run only on macOS and are not Windows-ready qualification tests. Replace those assumptions with platform-aware termination and setup before using them for the required cross-platform matrix; retain equivalent crash/recovery assertions on all three platforms.

Use public example configuration with placeholders and credential-free fake adapters for baseline tests. Private installation profiles stay outside the public repository. Before publishing, choose the project license, record dependency/extension licenses and required notices, add contribution/security-reporting guidance, and review the extracted files for private data. Do not copy the parent repository's full history or deployment configuration as a shortcut to extraction. Publication and license selection are not implied by documenting this requirement.

## Acceptance evidence

- Install and exercise the core product on macOS, Linux, and Windows. Validate configuration through the UI, task execution, Pause, Suspend, Suspend and Release, graceful/forced Stop, and recovery on each.
- Test paths containing spaces and Unicode, platform-specific link/permission behavior, process-tree termination, host restart, and sleep/wake without changing the required ownership or recovery semantics.
- Copy only the NimbleNewt extraction set into a clean workspace; documentation and tests must not depend on files left behind.
- Install and configure a deployment through the UI without editing source or creating NimbleNewt files in a target repository.
- Exercise local-only, cloud-only, and mixed routing configurations. Fake routes suffice for baseline CI; live adapters require separate compatibility tests.
- Change model assignments and fallback order, restart the controller, and verify the effective settings and preserved Pause state.
- Apply a provider exclusion and verify that task overrides, queued retries, and helper calls cannot bypass it.
- Export a sanitized profile and import it into another installation with different paths and credentials; verify that no original private values or service dependencies are required.
- Run dependency, link, and configuration checks from the standalone repository with no original project services available.

These requirements guide architecture and extraction; they do not select phases or an MVP.
