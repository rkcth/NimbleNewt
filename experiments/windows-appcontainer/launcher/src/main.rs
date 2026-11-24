// NimbleNewt experiment (not product code): run one program inside a low-privilege AppContainer, inside a Job Object.
// Every Win32 call is listed in ../README.md. The launcher FAILS CLOSED: if the container, a required grant, the job or the
// attribute list cannot be made, nothing is started, and it never falls back to an unconfined child.
// One JSON line goes to standard output. It holds no secrets: no environment values, no file contents, no account name.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(not(windows))]
fn main() {
    println!("{{\"tool\":\"nn-appc-launcher\",\"ok\":false,\"stage\":\"platform\",\"error\":\"Windows only\"}}");
    std::process::exit(125);
}

#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    win::main();
}
