// NimbleNewt native Windows launcher (card A03b). Starts one program inside a low-privilege AppContainer and a Job Object, grants and revokes ACL entries for the container,
// and prints ONE JSON line to standard output. It FAILS CLOSED: if the container, a required grant, the job or the attribute list cannot be made, nothing is started and the
// program never falls back to an unconfined child. The line holds no secrets: no environment values, no file contents, no account name.
// The contract with the TypeScript side (packages/worker/src/sandbox/windows-native-plan.ts) is pinned by a test, windows-native-contract.test.ts.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

mod args;
// Round 5 (experiment build and tests only): the pure rules for the window-object entries; not in the product binary.
#[cfg(any(test, feature = "experiment"))]
mod deskrules;
#[cfg(windows)]
mod win;

/// The whole program. Windows only: elsewhere it prints one failing JSON line and exits with the launcher-failed code (125).
#[cfg(not(windows))]
pub fn run_main() {
    println!("{{\"tool\":\"nn-appc-launcher\",\"ok\":false,\"stage\":\"platform\",\"error\":\"Windows only\"}}");
    std::process::exit(125);
}

#[cfg(windows)]
pub fn run_main() {
    win::main();
}
