# Compatibility and support

What NimbleNewt claims to work on, what it refuses to start on, how long an interface stays stable, and how to get an unsupported setup running at your own risk. The environment list below is read from one place in the code (`SUPPORTED_ENVIRONMENT` in `packages/controller/src/environment/supported.ts`); if this page and that file disagree, the file is right and this page has a bug.

NimbleNewt is under development and has **no stable release yet**. "Supported" means "the project's own CI or QA ran it", not "someone promises to fix it for you".

## Environments

| Part | Supported | Evidence |
| --- | --- | --- |
| Node.js | 22.19.0 or newer | 22.19.0 passes the CI run on every push (Linux); 22.19.0 and 24.21.0 pass the exhaustive and QA runs on Linux, macOS and Windows, which are started by hand or by a release tag |
| Linux | x64 (kernel with unprivileged user namespaces for the sandbox) | GitHub-hosted Ubuntu runner and the development server |
| macOS | Apple silicon, macOS 26 (Darwin 25) or newer | GitHub-hosted macOS runner |
| Windows | x64, Windows 11 24H2 / Server 2025 (build 26100) or newer | GitHub-hosted Windows runner |
| PostgreSQL (optional) | 17 and 18 | Full suites on Linux, macOS and Windows ([F04g record](implementation-plan/f04g-postgres-versions.md)); 14 to 16 also passed but are not claimed |
| SQLite | the library inside Node.js (`node:sqlite`) | Every CI cell |
| Data directory file systems | Linux: ext4, xfs, btrfs. macOS: APFS. Windows: NTFS | ext4, APFS and NTFS on CI; xfs and btrfs are on the list by decision and are not exercised by CI |
| Git | 2.38.1 or newer | Checked at start |

Not supported: 32-bit systems, Linux on ARM, Intel Macs, Windows on ARM, and **network or user-space file systems** for the data directory (NFS, SMB, FUSE, sshfs and similar cannot be trusted to flush; see [durability-and-flush](durability-and-flush.md)).

### Sandbox for agents' tools

Today **Linux with bubblewrap** only (it needs the `bwrap` program and unprivileged user namespaces for the service user). A macOS sandbox using `sandbox-exec` is part of the supported-environment check but the launcher does not run agents' tools on macOS or Windows yet; on those systems tasks wait for a host that can confine them. See [getting-started](getting-started.md).

## What happens on an unsupported environment

At every start the controller checks the machine and **refuses to start** when something is outside the list, printing every problem and how to fix it. Some missing things cannot be overridden (the feature cannot run without them: git, bubblewrap when a sandbox is wanted, the SQLite library). For the rest, if you have verified your own setup, start with `--allow-unsupported-environment` (or set `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`). The override is recorded and printed at every start, and the project will not be able to help with a problem that only your environment has.

## Interfaces and how long they stay stable

| Interface | Version today | Rule |
| --- | --- | --- |
| The state API ([api-v1](api-v1.md), [api-guide](api-guide.md)) | `v: 1` | Within version 1 operations and fields are only **added**; an existing argument or result field keeps its meaning. A breaking change would be a new `v`; a request with another `v` is refused, so an old client fails loudly rather than misbehaving. The reference is generated from the code and a test fails if it drifts. |
| The conversation listener routes (`/v1/...`) | `v1` in the path | Same rule. Message text and IDs are opaque strings; do not parse them. |
| The MCP door | MCP revisions 2025-06-18 and 2025-03-26 | A client that asks for another revision is told the newest one the door speaks. The tool names and arguments follow the additions-only rule. |
| The configuration file | `configVersion: 1` | Older files are migrated forward by the loader (`packages/config`); a file from a newer version is refused untouched. |
| The controller database | journaled schema migrations | Migrations that only add are applied automatically. A destructive one waits for the owner's approval after the rollback period. A database newer than the build is refused untouched. See [migration-recovery](migration-recovery.md). |
| The agent runtime (Pi Durable) | pinned to exactly 1.3.0 | The adapter refuses any other release at start. History written by an older layout is upgraded by the adapter, and the upgrade keeps thread IDs, cursors and audit history. |

Internal TypeScript APIs (everything a package exports that is not listed above) are **not** stable; the packages are private and versioned `0.0.0`.

## Upgrades and going back

- Upgrade through the launcher's release handling ([maintenance-and-updates](maintenance-and-updates.md)): a pre-upgrade snapshot is taken, additive migrations run, and the new release must start healthy before it counts as confirmed.
- Going back to the previous release is possible while the rollback period is open (default 14 days) and only over additive migrations, to a release that has already run healthy on this schema. After a destructive migration the way back is the snapshot.
- Do not downgrade by copying old files over a newer installation.

## How to ask for help

Bugs and questions go to the project's public issue tracker; **security problems do not**, see [SECURITY.md](../../SECURITY.md). Say which operating system, version and architecture you run, your Node.js version, SQLite or PostgreSQL, and what you expected. Redact credentials and private paths. [troubleshooting](troubleshooting.md) covers the common first steps.
