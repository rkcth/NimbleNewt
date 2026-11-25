# Releasing nn-launcher.exe

Nothing here has been run for a real release yet. The steps are written so a release is boring and checkable; a step that needs something only the owner has (the signing certificate) is marked.

## 1. Build (locked, pinned, no timestamps)

Inputs that decide the output: the source commit, `Cargo.lock` (every dependency version and checksum), the toolchain pinned in `rust-toolchain.toml` (an exact version, not "stable"), and the flags below. No cargo feature is enabled in a release (`--features` is never passed).

```
rustup toolchain install 1.99.1 --profile minimal       # the version in rust-toolchain.toml
cd native/nn-launcher
set RUSTFLAGS=--remap-path-prefix=%CD%=/nn-launcher --remap-path-prefix=%USERPROFILE%\.cargo=/cargo -C link-arg=/Brepro
cargo build --release --locked
```

- `--locked` fails the build if `Cargo.lock` would change: no dependency moves silently.
- `--remap-path-prefix` removes the build machine's folder names from the file; `/Brepro` makes the linker write no timestamp. (`.cargo/config.toml` sets `/Brepro` already for the MSVC target; setting `RUSTFLAGS` replaces that file's flags, which is why the line above repeats it.)
- The profile is `opt-level = "s"`, `codegen-units = 1`, no debug info, `panic = "unwind"` (the unwinding is what lets the grant bookkeeping revoke on a panic).
- Expected: two builds of the same commit on the same toolchain give the same SHA-256, also when the second build runs from a different folder (the remap makes the folder irrelevant). One hosted measurement shows it for one pair of folders on one runner image (2026-11-25, run 45674333399: both SHA-256 e7ac4337…cf902, 284,160 bytes); it is NOT yet shown more widely, and nothing here claims more: see "Is the build reproducible?" below for what is measured and what is not. A difference is a release blocker until explained.

### Is the build reproducible? (measured by the hosted job: identical once, for one pair of folders; not shown more widely)

The hosted job's step "Product launcher reproducibility" builds the same source a second time in another folder (another path and another folder name, outside the checkout, its own `target` folder), with the same pinned toolchain, `--locked`, the same flags and a remap naming the second folder, and compares the two files. It is a report, not a gate: a difference gives a `::warning::` and the run goes on. The uploaded artifact `windows-appcontainer-hosted` holds, under `repro/`, both files, `nn-launcher.repro.txt` (the printed comparison) and `nn-launcher.repro.json` (the same in machine-readable form: both SHA-256 values, the differing byte ranges mapped to the PE header time stamp, checksum, debug directory entries and PDB path, and to each section, the section layout, and whether either file holds the commit, a time or a build folder name). `scripts/pe-diff.mjs` is the comparison program; it can also be run by hand on any two files: `node scripts/pe-diff.mjs A.exe B.exe --json report.json`.

- Measured so far: one hosted run (2026-11-25, run 45674333399, commit d332d628, windows-latest, Rust 1.99.1): the two builds, from two differently named folders, gave the SAME SHA-256 `e7ac4337c77d57a093d615a7906d37bc2452754df24ca9bb08b47ef4322cf902` (284,160 bytes each). Neither file names either build folder, the cargo home or the commit; the PE time stamp is the `/Brepro` content hash value, not a time. The program and its parser are also tested offline on small synthetic files; the step's shape is pinned by tests.
- Not measured: whether it holds on a second run, a second runner image, a second day or a second toolchain install, which could change the result; whether the build is the same on the owner's own machine; whether the linker's time stamp (with `/Brepro` a content hash, not a time) and the PDB path in the debug directory stay free of the build folder. The comparison also looks for the commit and for both build folder names in each file and reports them.
- Reproducibility is NOT claimed beyond the one measurement above: the first release needs it repeated (another day, another image) and shown on the release commit, and a signed release needs the unsigned/signed tie below. Until then it stays a first-release blocker. A `DIFFERENT` result is read from the `why` lines: header bookkeeping only (time stamp, checksum, debug entries) points at the linker or the debug directory; a difference in `.text`, `.rdata` or `.rsrc` points at an input (a path, a crate hash, a flag).

## 2. Record the hash

```
node scripts/native-launcher.mjs record --file native/nn-launcher/target/release/nn-launcher.exe --commit <the 40-character commit> --out nn-launcher.record.json
```

The record names the file's SHA-256 and size, the commit, the pinned toolchain and the hash of `Cargo.lock`, and no time, path or user name. Publish it next to the file. `node scripts/native-launcher.mjs verify --file nn-launcher.exe --record nn-launcher.record.json` fails unless a file is exactly the recorded one. Record the hash of the file BEFORE signing and, separately, of the signed file (signing changes the bytes); the installer is given the hash of the file it installs.

How the two hashes relate (read this before a release). Reproducibility is a statement about the UNSIGNED file: anyone who rebuilds the commit gets the unsigned hash, so the unsigned record (made right after the build) is what a reviewer rebuilds and compares. Signing appends an Authenticode signature to the file (and changes the optional header's checksum and its certificate-table entry), so the SIGNED file has a different SHA-256 that nobody can rebuild without the certificate. The release therefore has two records made with the same command: `nn-launcher.record.json` from the unsigned file and `nn-launcher.signed.record.json` from the signed file (same source commit, different `sha256` and `size`). The installer is given the signed file's hash (the one in the signed record). To check that the signed file is the unsigned one plus a signature, compare them with `node scripts/pe-diff.mjs nn-launcher.exe nn-launcher.signed.exe`: only the optional header checksum, the certificate-table entry of the optional header and bytes after the last section may differ, and nothing in a section. This tie between the two records is a manual check: `scripts/native-launcher.mjs` does not link them, the record has no field for the unsigned hash of a signed file, and no signed file has been made yet. A build that cannot be reproduced to its unsigned hash gives a signed file that cannot be traced to its source, which is why reproducibility blocks the first release.

## 3. Sign (needs a certificate only the owner can supply)

An Authenticode signature lets Windows (and the installer, and a reviewer) tell the owner's launcher from any other file with the same name. Nothing secret is stored in the repository, a workflow or this document.

1. The owner obtains a code-signing certificate (an OV or EV certificate from a certificate authority, or an Azure Trusted Signing account). The private key stays on the owner's hardware token or in the signing service; it is never copied to a runner, a repository or a chat.
2. Sign on the owner's machine: `signtool sign /fd SHA256 /tr <the authority's RFC 3161 timestamp URL> /td SHA256 /a nn-launcher.exe` (or the signing service's own tool). The timestamp lets the signature outlive the certificate.
3. Check: `signtool verify /pa /v nn-launcher.exe`, and `Get-AuthenticodeSignature .\nn-launcher.exe` must say `Valid`.
4. Record the signed file's hash (step 2 again) and publish both files.

Unsigned builds. A build from the hosted CI or from your own machine is not signed. It may be installed only on the machine that built it or on your own hardware, and only with the explicit flag `-AllowUnsigned` of the installer, which prints a warning and relies on the SHA-256 you give it. The installer refuses an unsigned file without that flag. Never ship an unsigned launcher to anyone else.

## 4. Install and update

Give the installer the signed file and its recorded hash (`native/install/README.md`). An update is the same: a new file, a new hash, a rerun of the installer (it replaces the file only when the hash differs and re-hashes after copying).

## Checks that run without a release

The hand-started workflow `.github/workflows/windows-appcontainer-experiment.yml` builds the crate with `cargo build --release --locked` on `windows-latest` and runs `info` ("Product launcher" step); the ten containment cases then run through the backend with that very file. `cargo check --target x86_64-pc-windows-gnu --locked --offline` type-checks it from Linux. `scripts/native-launcher.test.mjs` and `windows-native-contract.test.ts` test the record and the names across the boundary. The same workflow's step "Product launcher reproducibility" builds twice from two folders and compares (see above); `scripts/pe-diff.test.mjs` tests the comparison program offline.
