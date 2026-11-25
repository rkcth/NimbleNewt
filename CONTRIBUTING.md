# Contributing to NimbleNewt

Thank you for wanting to help. NimbleNewt is built mostly by AI agents under one owner's direction, with people welcome to join; the rules below are the same for everyone, and they are there because the project protects other people's code, machines and credentials. If a rule gets in your way, say so in the issue or pull request instead of working around it.

Before anything else: **a suspected security problem is not reported in an issue or pull request**. See [SECURITY.md](SECURITY.md).

## Get set up

You need Node.js **22.19.0 or newer** and git 2.38.1 or newer. Linux, macOS and Windows are all development platforms ([compatibility and support](docs/nimblenewt/compatibility-and-support.md)).

```
npm ci
npx tsc --build
```

`npm ci` installs exactly what the lockfile says, with install scripts disabled (`.npmrc`). Build before you run anything: the programs and tests run the compiled output in each package's `dist` folder. Do not symlink `node_modules` between working copies.

## The commands

| Command | What it does |
| --- | --- |
| `npx tsc --build` | Compile every package (use `npm run clean` first after deleting or renaming source files, so old compiled files and tests do not linger) |
| `npm run check:deps` | Package boundary rules, and no SQL or database driver outside the storage folders |
| `npm run licenses:check` | Every dependency's license is on the allow-list and [license-inventory.md](docs/nimblenewt/implementation-plan/license-inventory.md) is current (`npm run licenses:write` regenerates it) |
| `npm run api:docs:write` | Regenerate [api-v1.md](docs/nimblenewt/api-v1.md) from the operation table. Run it **after** a build. Never edit that file by hand |
| `npm run roadmap:check` | The README roadmap matches `task-plan.json` (do not hand-edit the roadmap; card status is the owner's to change) |
| `npm run test:changed` | The typical tier: build, rules, then only the packages your change touches and those that depend on them, on the reference store and SQLite. For the edit-and-check loop |
| `npm run test:fast` | Everything except the long qualification files |
| `npm test` | The full suite: all four storage backends and the long runs. This is what counts as evidence |
| `npm run test:shard -- 1/3` | One slice of the full suite (CI runs three) |

One test file, from the repository root: `node --import ./scripts/offline-guard.mjs --test packages/controller/dist/api/d02-guidance.test.js`. Tests do not use the real network (the offline guard fails any), do not call a model, and start their own disposable embedded PostgreSQL; never point a test at a database or server you care about.

The long files can be slow on a busy machine. Wait for a run to finish rather than interrupting it, and do not judge a change by a run that was cut short.

## Making a change

1. **Start from a task.** Work belongs to a card in the [task plan](docs/nimblenewt/implementation-plan/task-plan.md). If there is none for what you want, open an issue first. Small fixes and documentation are fine without one.
2. **Keep it small and complete.** One slice that works end to end, with tests, beats a large unfinished one.
3. **Test it for real.** A test that would still pass if your change were removed proves nothing. After writing tests, break your own code on purpose (a *mutation check*), see a test fail, and put the code back. Anything that touches storage is tested on **all four** storage implementations (`backends` in `packages/controller/src/domain/testing/backends.ts`).
4. **Write down what you did and what you did not do** in `docs/nimblenewt/implementation-plan/implementation-notes.md`: what is done, what is not, and any decision you made yourself as a line starting `ASSUMPTION:` so a reviewer can overrule it. Do not claim more than was tested.
5. **Document what users and developers see.** A new setting or operation is described in the interpreter's prompt so the owner can reach it by ordinary wording in chat (no magic phrases), is shown first when it needs agreement, and appears in the generated API reference.
6. **Be kind to every platform.** CI runs Linux, macOS and Windows. No POSIX-only paths, signals or file-name assumptions; no waiting a fixed time for a result (wait on a condition); tests that need a sandbox skip where none exists; do not assume a fast machine.
7. **Commit.** A short message that says why. Do not commit credentials, personal data, generated output or large binaries. Never force-push a shared branch.
8. **Review.** The author of a change is never its reviewer. A different reviewer checks the exact commit against the task and the rules here, and may send it back with reasons. AI agents contribute under the same rule: an agent may not review or approve its own work, widen its own permissions, or edit the gates that check it.

## Dependencies

Adding one is a decision, not a convenience. It must:

- have a license on the allow-list (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense), and `npm run licenses:write` must be run and its result committed ([notices](docs/nimblenewt/notices.md));
- be pinned to an exact version in the lockfile, with install scripts staying disabled (a package that needs one is a separate, reviewed change);
- be allowed for that package by `scripts/package-boundaries.mjs` (`config`, `contracts`, `registry`, `api` and `ui` may have no runtime dependencies at all);
- justify itself against writing the dozen lines yourself.

## A component that is not TypeScript

TypeScript is the default language for the controller, adapter, API, worker and UI, so that one language, one toolchain and Pi Durable's own TypeScript package can be used directly ([design-decisions](docs/nimblenewt/design-decisions.md)). A component in another language (Rust is the usual candidate) is accepted only when **all three** of these are recorded **before** the code is merged, in an issue or pull request and in `implementation-notes.md`:

1. **Justification.** A specific, demonstrated need that TypeScript cannot meet well, with evidence (a measurement, a missing capability), not a preference. A rewrite of an existing component, or of Pi Durable, needs evidence that it helps, and none is assumed.
2. **A bounded interface.** What crosses the boundary: a small, versioned, documented contract (a process with defined input and output, or a narrow library interface), tested from the TypeScript side. The component sees nothing it does not need: no database, no credentials, no repository access by default.
3. **A maintenance plan.** Who owns it, how it is built and tested on Linux, macOS **and** Windows in CI, how its dependencies are inventoried and license-checked, how it is shipped and updated, and what happens if it cannot be built on a platform (the core must still run, with the feature reported unavailable).

The reviewer rejects a change that adds a non-TypeScript component without these. Today the product contains two, both for Windows only and both recorded below: the native launcher (Rust) and its one-time administrator installer (PowerShell).

### The native Windows launcher (Rust, `native/nn-launcher/`)

Files: `native/nn-launcher/Cargo.toml`, `native/nn-launcher/src/lib.rs`, `native/nn-launcher/src/main.rs`, `native/nn-launcher/src/args.rs` (the command line: platform-neutral, with Rust unit tests for the product build and the experiment build), `native/nn-launcher/src/win.rs`, `native/nn-launcher/src/desk.rs` (window-station and desktop access for the Session 0 diagnostic round: compiled into the experiment build only), `native/nn-launcher/src/deskrules.rs` (its platform-neutral rules, with Rust unit tests). One dependency, `windows-sys` (MIT OR Apache-2.0), locked in `native/nn-launcher/Cargo.lock`; its crates and their licenses are listed in `native/nn-launcher/cargo-licenses.json` and checked by `npm run licenses:check`. It is built by `cargo build --release --locked` with the toolchain pinned in `native/nn-launcher/rust-toolchain.toml` (steps and the release record: `native/nn-launcher/RELEASE.md`), is not built by `npm run build`, and is not part of any npm package.

1. **Justification.** Creating an AppContainer profile, granting and revoking ACL entries for its SID and starting a process inside a Job Object are native Windows calls that Node.js cannot make. Without them the Windows backend (card A03b) cannot confine an agent without a virtual machine. The measurements that showed this are in `experiments/windows-appcontainer/README.md` and `implementation-notes.md` (hosted run 45602464992: the ten containment cases pass through the backend that starts this launcher).
2. **A bounded interface.** A command-line process with four commands (`run`, `check`, `revoke`, `info`) that prints one JSON line (`tool`, `ok`, `stage`, `error`, the child's exit and the per-grant read-back). The only caller is the worker's backend (`packages/worker/src/sandbox/windows-native-plan.ts`); the names that cross the boundary are pinned from both sides by `packages/worker/src/sandbox/windows-native-contract.test.ts`. It receives paths and a command line and sees no database, credentials or repository, and prints no environment value. The experiment's measuring options are behind a cargo feature that a release never enables (the experiment's own crate, `experiments/windows-appcontainer/launcher/src/main.rs`, is the only one that turns it on).
3. **A maintenance plan.** The owner of card A03b owns it. Linux and macOS build nothing of it (the library prints one "Windows only" line there, and the worker reports the Windows backend unavailable on those systems, so the core runs without it). On Windows it is type-checked and built `--locked` in the hand-started workflow `.github/workflows/windows-appcontainer-experiment.yml` (job `hosted`, step "Product launcher"), and judged by the ten containment cases through the product backend; the contract test runs on every operating system, and the argument tests (`cargo test --locked` and `cargo test --locked --features experiment`, which pin that the product build refuses every experiment-only option) run wherever a Rust toolchain is installed, including that step. Its dependency inventory is `native/nn-launcher/cargo-licenses.json`. It is shipped as one file (`nn-launcher.exe`) placed by an administrator, signed in a release and recorded by `scripts/native-launcher.mjs` (`native/nn-launcher/RELEASE.md`); an update is a new release record and a rerun of the installer. If it cannot be built or is not installed, the Windows backend has no capacity and says why, and nothing runs unconfined.

### The native launcher's installer (PowerShell, `native/install/Install-NimbleNewtLauncher.ps1`)

1. **Justification.** Making a local account, setting account rights and writing admin-only access lists need an administrator once and cannot be done from Node.js without a native helper; PowerShell is on every Windows installation and is the form an administrator can read before running.
2. **A bounded interface.** Three actions (`Verify`, `Install`, `Uninstall`) with `-WhatIf`; it takes a file and its SHA-256, writes only the folders, the account and the worker environment file it lists, and stores no secret. Its design, every access-list line and what is not proven are in `native/install/README.md`.
3. **A maintenance plan.** The owner of card A03b owns it. Tests on every operating system read the script (`scripts/native-launcher.test.mjs`); the hand-started Windows workflow parses it and runs `-WhatIf` and `Verify` on a hosted runner (which changes nothing). It has not been run to install on a real machine: that, and the service-account launch, stay listed as unproven in `implementation-notes.md`. A machine without Windows needs nothing of it.

Outside the product there are the Node.js scripts in `scripts/` (JavaScript on the same runtime, tested with `node --test`), the experiment's harness and its Rust build (`experiments/windows-appcontainer/`, `experiments/windows-appcontainer/launcher/src/main.rs`, built only by hand), and two development-only Python programs that are never shipped or run by the product: `scripts/generate_task_plan.py` (writes the task plan) and the benchmark probes in `benchmarks/nimblenewt-harness/`.

## Documentation

Write for a person who has not seen the code: say what happens, and say plainly what is **not** built. Examples must be real: the ones in [api-guide](docs/nimblenewt/api-guide.md) and [conversation-and-mcp-protocol](docs/nimblenewt/conversation-and-mcp-protocol.md) are run by tests, so change them and the code together. Generated files (`api-v1.md`, `license-inventory.md`, the README roadmap) are regenerated with the commands above, never edited. Where to start reading: [architecture](docs/nimblenewt/architecture.md), then [troubleshooting](docs/nimblenewt/troubleshooting.md).

## Licensing of your contribution

NimbleNewt is under the [MIT License](LICENSE). By submitting a contribution you confirm that you wrote it, or have the right to submit it, and that it is offered under that license. Do not paste in code or text copied from elsewhere unless its license is on the allow-list and you say where it came from.

## Behaviour

Be respectful and specific. Disagree with a design, not a person. Do not post other people's private information. A maintainer may close a discussion that is not constructive.
