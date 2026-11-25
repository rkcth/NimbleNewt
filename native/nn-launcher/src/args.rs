// The launcher's command line: what each build accepts. Platform-neutral (no Win32 call), so it is compiled and unit-tested on every operating system, with and without the
// cargo feature `experiment` (`cargo test` and `cargo test --features experiment`). The PRODUCT build (no feature) refuses every experiment-only option, grant mode, standard
// input form and command here, before anything is made; win.rs then never sees them.

/// True only in the experiment's build (experiments/windows-appcontainer/launcher turns the feature on); a release is built with no feature.
pub(crate) const EXPERIMENT: bool = cfg!(feature = "experiment");
// PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT / _OPT_IN
pub(crate) const AAP_OPT_OUT: u32 = 0x1;
pub(crate) const AAP_OPT_IN: u32 = 0x0;
/// The capabilities the PRODUCT build accepts (the backend's LPAC_CAPABILITIES in windows-native-plan.ts); the contract test pins the two lists to each other.
pub(crate) const PRODUCT_CAPABILITIES: [&str; 2] = ["registryRead", "lpacCom"];

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Mode { Ro, Rx, Modify, DenyWrite, DenyStrong, Seal, ModifyRoot }

impl Mode {
    pub(crate) fn parse(s: &str) -> Option<Mode> {
        match s { "ro" => Some(Mode::Ro), "rx" => Some(Mode::Rx), "modify" => Some(Mode::Modify), "deny-write" => Some(Mode::DenyWrite), "deny-strong" => Some(Mode::DenyStrong), "seal" => Some(Mode::Seal), "modify-root" => Some(Mode::ModifyRoot), _ => None }
    }
    pub(crate) fn name(self) -> &'static str {
        match self { Mode::Ro => "ro", Mode::Rx => "rx", Mode::Modify => "modify", Mode::DenyWrite => "deny-write", Mode::DenyStrong => "deny-strong", Mode::Seal => "seal", Mode::ModifyRoot => "modify-root" }
    }
    /// A mode that only takes rights away (a deny entry) rather than granting them.
    pub(crate) fn is_deny(self) -> bool { matches!(self, Mode::DenyWrite | Mode::DenyStrong) }
}

#[derive(Clone, Debug)]
pub(crate) struct GrantSpec { pub(crate) mode: Mode, pub(crate) path: String, pub(crate) soft: bool }

#[derive(Default, Debug)]
pub(crate) struct Args {
    pub(crate) command: String,
    pub(crate) name: String,
    pub(crate) exe: Option<String>,
    pub(crate) cmdline: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) stdout: Option<String>,
    pub(crate) stderr: Option<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) grants: Vec<GrantSpec>,
    pub(crate) aap: Option<u32>, // None: the policy attribute is not set at all
    pub(crate) win32k_off: bool,
    pub(crate) kill_on_close: bool,
    pub(crate) memory_mb: u64,
    pub(crate) active_processes: u32,
    pub(crate) ui_limits: bool,
    pub(crate) timeout_ms: u32,
    pub(crate) keep_profile: bool,
    pub(crate) stdin: String, // nul (read-only NUL, the default), nul-rw, file:PATH, pipe (an empty pipe: end of input at once), pipe-open (a pipe whose write end stays open until the child ends)
    pub(crate) stdout_pipe: bool, // the child's output goes through an anonymous pipe that the launcher copies into the file
    pub(crate) stderr_pipe: bool,
    pub(crate) stdout_nul: bool, // the child's standard output is the NUL device opened for reading and writing by the launcher (nothing is captured)
    pub(crate) stderr_nul: bool,
    pub(crate) capabilities: Vec<String>, // names or SID strings, in the order given (repeatable --capability)
    pub(crate) dump: Vec<String>, // paths whose DACL is printed as SDDL after the grants are applied and again after the child ended (repeatable --dump)
}

pub(crate) fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut a = Args { name: "NimbleNewtExperiment".into(), kill_on_close: true, timeout_ms: 120_000, stdin: "nul".into(), ..Default::default() };
    let mut it = raw.iter().skip(1);
    a.command = it.next().cloned().ok_or("no command (run, info, revoke, check, delete-profile)")?;
    while let Some(flag) = it.next() {
        let mut value = |what: &str| -> Result<String, String> { it.next().cloned().ok_or(format!("{what} needs a value")) };
        match flag.as_str() {
            "--name" => a.name = value("--name")?,
            "--win32k-off" | "--no-kill-on-close" | "--keep-profile" | "--stdout-pipe" | "--stderr-pipe" | "--stdout-nul-rw" | "--stderr-nul-rw" | "--dump" if !EXPERIMENT => return Err(format!("{flag} is an experiment option and is not in this build")),
            "--exe" => a.exe = Some(value("--exe")?),
            "--cmdline" => a.cmdline = Some(value("--cmdline")?),
            "--cwd" => a.cwd = Some(value("--cwd")?),
            "--stdout" => a.stdout = Some(value("--stdout")?),
            "--stderr" => a.stderr = Some(value("--stderr")?),
            "--env" => {
                let kv = value("--env")?;
                let (k, v) = kv.split_once('=').ok_or("--env needs NAME=VALUE")?;
                if k.is_empty() { return Err("--env name is empty".into()); }
                a.env.push((k.to_string(), v.to_string()));
            }
            "--grant" | "--grant-soft" => {
                let spec = value("--grant")?;
                let (m, p) = spec.split_once(':').ok_or("--grant needs MODE:PATH")?;
                let mode = Mode::parse(m).ok_or("grant mode must be ro, rx, modify, deny-write, deny-strong, seal or modify-root")?;
                if !EXPERIMENT && matches!(mode, Mode::DenyWrite | Mode::DenyStrong) { return Err(format!("grant mode {} is an experiment option and is not in this build", mode.name())); }
                a.grants.push(GrantSpec { mode, path: p.to_string(), soft: flag == "--grant-soft" });
            }
            // none: no attribute (a plain AppContainer). optout: the LPAC form. optin: the attribute present with the default value.
            "--aap-policy" => a.aap = match value("--aap-policy")?.as_str() { "none" => None, "optout" => Some(AAP_OPT_OUT), "optin" if EXPERIMENT => Some(AAP_OPT_IN), "optin" => return Err("--aap-policy optin is an experiment option and is not in this build".into()), _ => return Err("--aap-policy: none, optout or optin".into()) },
            "--win32k-off" => a.win32k_off = true,
            "--no-kill-on-close" => a.kill_on_close = false,
            "--memory-mb" => a.memory_mb = value("--memory-mb")?.parse().map_err(|_| "--memory-mb is not a number")?,
            "--active-processes" => a.active_processes = value("--active-processes")?.parse().map_err(|_| "--active-processes is not a number")?,
            "--ui-limits" => a.ui_limits = true,
            "--timeout-ms" => a.timeout_ms = value("--timeout-ms")?.parse().map_err(|_| "--timeout-ms is not a number")?,
            "--keep-profile" => a.keep_profile = true,
            "--stdin" => { let v = value("--stdin")?; if !EXPERIMENT && !v.starts_with("file:") { return Err("--stdin: only file:PATH is in this build (the NUL device is refused to the container and pipes made for it hang)".into()); } if !(matches!(v.as_str(), "nul" | "nul-rw" | "pipe" | "pipe-open") || v.starts_with("file:")) { return Err("--stdin: nul, nul-rw, file:PATH, pipe or pipe-open".into()); } a.stdin = v; }
            "--stdout-pipe" => a.stdout_pipe = true,
            "--stderr-pipe" => a.stderr_pipe = true,
            "--stdout-nul-rw" => a.stdout_nul = true,
            "--stderr-nul-rw" => a.stderr_nul = true,
            "--dump" => a.dump.push(value("--dump")?),
            "--capability" => {
                let c = value("--capability")?;
                if c.is_empty() { return Err("--capability is empty".into()); }
                // The product container is the LPAC with exactly these two capabilities (card A03b): never a network capability (internetClient and the like), a SID or any other name.
                if !EXPERIMENT && !PRODUCT_CAPABILITIES.contains(&c.as_str()) { return Err(format!("capability {c} is not in this build (only {})", PRODUCT_CAPABILITIES.join(", "))); }
                a.capabilities.push(c);
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    if !EXPERIMENT && !matches!(a.command.as_str(), "run" | "check" | "revoke" | "info") { return Err(format!("command {} is not in this build (run, check, revoke, info)", a.command)); }
    if !EXPERIMENT {
        // The plain AppContainer (the fallback) has no capability at all; the two LPAC capabilities come only with the LPAC policy.
        if !a.capabilities.is_empty() && a.aap != Some(AAP_OPT_OUT) { return Err("--capability is only in this build with --aap-policy optout (the LPAC); the plain AppContainer has none".into()); }
        // A run always has the job's limits: 0 would mean no memory or process limit, and u32::MAX is INFINITE (no timeout).
        if a.command == "run" && (a.memory_mb == 0 || a.active_processes == 0 || a.timeout_ms == 0 || a.timeout_ms == u32::MAX) {
            return Err("run needs --memory-mb, --active-processes and --timeout-ms above 0 (and a finite timeout) in this build".into());
        }
    }
    Ok(a)
}

// ---- end of parse_args

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> { std::iter::once("nn-launcher").chain(parts.iter().copied()).map(String::from).collect() }
    fn parse(parts: &[&str]) -> Result<Args, String> { parse_args(&argv(parts)) }
    /// The argument list the worker's backend sends (windows-native-plan.ts launcherArgs), LPAC form.
    fn product_run() -> Vec<&'static str> {
        vec!["run", "--name", "NimbleNewtAgent", "--grant", "modify-root:C:\\w", "--grant", "seal:C:\\w\\.git", "--grant-soft", "rx:C:\\node", "--aap-policy", "optout",
             "--capability", "registryRead", "--capability", "lpacCom", "--memory-mb", "2048", "--active-processes", "64", "--ui-limits", "--timeout-ms", "600000",
             "--stdin", "file:C:\\c\\in", "--stdout", "C:\\c\\out", "--stderr", "C:\\c\\err", "--cwd", "C:\\w", "--env", "PATH=C:\\node", "--exe", "C:\\node\\node.exe", "--cmdline", "node x.js"]
    }
    const EXPERIMENT_FLAGS: [&str; 8] = ["--win32k-off", "--no-kill-on-close", "--keep-profile", "--stdout-pipe", "--stderr-pipe", "--stdout-nul-rw", "--stderr-nul-rw", "--dump"];

    #[test]
    fn the_backends_own_argument_list_is_accepted_by_every_build() {
        let a = parse(&product_run()).expect("the backend's run line");
        assert_eq!(a.command, "run");
        assert_eq!(a.grants.len(), 3);
        assert!(a.grants[2].soft);
        assert_eq!(a.aap, Some(AAP_OPT_OUT));
        assert!(a.kill_on_close, "kill-on-close is on unless an experiment option turns it off");
        assert_eq!(a.stdin, "file:C:\\c\\in");
        for command in ["check", "revoke", "info"] { assert!(parse(&[command, "--grant", "seal:C:\\w\\.git"]).is_ok(), "{command}"); }
    }

    #[test]
    fn misspelled_abbreviated_or_joined_options_are_unknown_in_every_build() {
        for flag in ["--Dump", "--DUMP", "-dump", "--dum", "--dump=C:\\x", "--stdout-pip", "--win32k", "--", "-", "@args.txt", "/dump", "--no-kill-on-close=1", "—dump"] {
            let mut v = product_run();
            v.push(flag);
            let e = parse(&v).err().unwrap_or_else(|| panic!("{flag} was accepted"));
            assert!(e.starts_with("unknown option") || e.ends_with("needs a value"), "{flag}: {e}");
        }
        assert!(parse(&["run", "--grant", "Seal:C:\\x"]).is_err(), "grant modes are exact and lower case");
        assert!(parse(&["run", "--grant", "deny-write:"]).is_err() || EXPERIMENT);
    }

    #[cfg(not(feature = "experiment"))]
    #[test]
    fn the_product_build_refuses_every_experiment_option_mode_input_and_command() {
        assert!(!EXPERIMENT);
        for flag in EXPERIMENT_FLAGS {
            let mut v = product_run();
            v.insert(1, flag);
            if flag == "--dump" { v.insert(2, "C:\\x"); }
            let e = parse(&v).err().unwrap_or_else(|| panic!("{flag} was accepted"));
            assert!(e.contains("not in this build"), "{flag}: {e}");
        }
        for mode in ["deny-write", "deny-strong"] {
            for flag in ["--grant", "--grant-soft"] {
                let spec = format!("{mode}:C:\\x");
                let e = parse(&["revoke", flag, &spec]).err().unwrap_or_else(|| panic!("{flag} {mode} was accepted"));
                assert!(e.contains("not in this build"), "{mode}: {e}");
            }
        }
        for stdin in ["nul", "nul-rw", "pipe", "pipe-open", "NUL", "", "File:C:\\x"] {
            let e = parse(&["run", "--stdin", stdin]).err().unwrap_or_else(|| panic!("--stdin {stdin} was accepted"));
            assert!(e.contains("only file:PATH"), "{stdin}: {e}");
        }
        for command in ["grant", "dump", "delete-profile", "open-test", "Run", "RUN", "help", ""] {
            let e = parse(&[command]).err().unwrap_or_else(|| panic!("command {command:?} was accepted"));
            assert!(e.contains("not in this build"), "{command}: {e}");
        }
        // only the two LPAC capabilities, exactly spelled, and only with the LPAC policy; no network capability, no SID, no other name
        for cap in ["internetClient", "internetClientServer", "privateNetworkClientServer", "S-1-15-3-1", "S-1-15-3-2", "registryread", "RegistryRead", "lpaccom", "lpacCom ", "documentsLibrary"] {
            let mut v = product_run();
            v.extend(["--capability", cap]);
            let e = parse(&v).err().unwrap_or_else(|| panic!("--capability {cap:?} was accepted"));
            assert!(e.contains("not in this build"), "{cap}: {e}");
        }
        for policy in ["none", "optin"] {
            let v: Vec<&str> = product_run().into_iter().map(|x| if x == "optout" { policy } else { x }).collect();
            assert!(parse(&v).is_err(), "capabilities with --aap-policy {policy}");
        }
        let without_policy: Vec<&str> = { let mut v = product_run(); let i = v.iter().position(|x| *x == "--aap-policy").unwrap(); v.drain(i..i + 2); v };
        assert!(parse(&without_policy).is_err(), "capabilities without any --aap-policy");
        // the plain AppContainer fallback: no policy attribute, no capability
        let fallback: Vec<&str> = { let mut v = product_run(); for _ in 0..2 { let i = v.iter().position(|x| *x == "--capability").unwrap(); v.drain(i..i + 2); } v.into_iter().map(|x| if x == "optout" { "none" } else { x }).collect() };
        assert!(parse(&fallback).is_ok(), "the plain AppContainer fallback line");
        assert!(parse(&["run", "--aap-policy", "optin"]).unwrap_err().contains("not in this build"));
        // a run keeps the job's limits: no 0 (no limit) and no INFINITE timeout
        for (flag, value) in [("--memory-mb", "0"), ("--active-processes", "0"), ("--timeout-ms", "0"), ("--timeout-ms", "4294967295")] {
            let mut v = product_run();
            v.extend([flag, value]);
            assert!(parse(&v).unwrap_err().contains("above 0"), "{flag} {value}");
        }
        let mut no_limits = product_run();
        let i = no_limits.iter().position(|x| *x == "--memory-mb").unwrap();
        no_limits.drain(i..i + 2);
        assert!(parse(&no_limits).is_err(), "a run without --memory-mb");
        assert!(parse(&["check", "--grant", "seal:C:\\w\\.git"]).is_ok() && parse(&["revoke", "--grant", "rx:C:\\n"]).is_ok(), "check and revoke take no limits");
        // the refusal does not depend on where the option stands or on what follows it
        let mut v = product_run();
        v.extend(["--keep-profile"]);
        assert!(parse(&v).unwrap_err().contains("not in this build"));
        assert!(parse(&[]).is_err(), "no command");
    }

    #[cfg(feature = "experiment")]
    #[test]
    fn the_experiment_build_accepts_its_measuring_options() {
        assert!(EXPERIMENT);
        let mut v = product_run();
        for flag in EXPERIMENT_FLAGS { v.push(flag); if flag == "--dump" { v.push("C:\\x"); } }
        let a = parse(&v).expect("every experiment option");
        assert!(!a.kill_on_close && a.win32k_off && a.keep_profile && a.stdout_pipe && a.stderr_nul && a.dump.len() == 1);
        assert!(parse(&["grant", "--grant", "deny-strong:C:\\x"]).is_ok());
        assert!(parse(&["run", "--stdin", "pipe-open"]).is_ok());
        assert!(parse(&["run", "--capability", "internetClient", "--aap-policy", "optin"]).is_ok(), "the experiment measures other capabilities and policies");
        for command in ["grant", "dump", "delete-profile"] { assert!(parse(&[command]).is_ok(), "{command}"); }
    }
}
