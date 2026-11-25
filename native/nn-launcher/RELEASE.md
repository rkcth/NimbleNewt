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
- Expected: two builds of the same commit on the same toolchain give the same SHA-256. This is NOT yet shown: the first release must build twice on clean machines (or two runners) and compare. A difference is a release blocker until explained.

## 2. Record the hash

```
node scripts/native-launcher.mjs record --file native/nn-launcher/target/release/nn-launcher.exe --commit <the 40-character commit> --out nn-launcher.record.json
```

The record names the file's SHA-256 and size, the commit, the pinned toolchain and the hash of `Cargo.lock`, and no time, path or user name. Publish it next to the file. `node scripts/native-launcher.mjs verify --file nn-launcher.exe --record nn-launcher.record.json` fails unless a file is exactly the recorded one. Record the hash of the file BEFORE signing and, separately, of the signed file (signing changes the bytes); the installer is given the hash of the file it installs.

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

The hand-started workflow `.github/workflows/windows-appcontainer-experiment.yml` builds the crate with `cargo build --release --locked` on `windows-latest` and runs `info` ("Product launcher" step); the ten containment cases then run through the backend with that very file. `cargo check --target x86_64-pc-windows-gnu --locked --offline` type-checks it from Linux. `scripts/native-launcher.test.mjs` and `windows-native-contract.test.ts` test the record and the names across the boundary.
