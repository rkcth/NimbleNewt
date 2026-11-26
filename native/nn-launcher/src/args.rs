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

use crate::profile;

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

/// Round 5 (EXPERIMENT only): which window station and desktop the child is attached to, and what the launcher does to make the container able to use them. The default, `inherit`, is the
/// MEASURED BASELINE that fails from a service (lpDesktop NULL: the child takes the launcher's own window station and desktop; 0xC0000142). The PRODUCT build does not read this option: it always
/// uses `private` (a window station and desktop made for the run, the same code as `--desktop private` here). Every value is refused by the product build.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub(crate) enum DesktopMode { #[default] Inherit, Empty, Winsta0, GrantRead, GrantFull, GrantStation, GrantDesktop, NewDesktop, NewStation, Private, HomeDesktop, HomeStationRead, HomeStationFull }

impl DesktopMode {
    pub(crate) const ALL: [(&'static str, DesktopMode); 13] = [("inherit", DesktopMode::Inherit), ("empty", DesktopMode::Empty), ("winsta0", DesktopMode::Winsta0), ("grant-read", DesktopMode::GrantRead), ("grant-full", DesktopMode::GrantFull),
        ("grant-station", DesktopMode::GrantStation), ("grant-desktop", DesktopMode::GrantDesktop), ("new-desktop", DesktopMode::NewDesktop), ("new-station", DesktopMode::NewStation), ("private", DesktopMode::Private),
        ("home-desktop", DesktopMode::HomeDesktop), ("home-desktop-station-read", DesktopMode::HomeStationRead), ("home-desktop-station-full", DesktopMode::HomeStationFull)];
    pub(crate) fn parse(s: &str) -> Option<DesktopMode> { Self::ALL.iter().find(|(n, _)| *n == s).map(|(_, m)| *m) }
    #[cfg_attr(not(feature = "experiment"), allow(dead_code))]
    pub(crate) fn name(self) -> &'static str { Self::ALL.iter().find(|(_, m)| *m == self).map(|(n, _)| *n).unwrap_or("inherit") }
}

/// The "home" modes (the common one-account PC, not elevated; EXPERIMENT only): `home-desktop` makes ONE desktop on the launcher's CURRENT window station (WinSta0 in a signed-in session) with its final
/// access list (the launcher's own account, SYSTEM, the container) and writes nothing to the station; the two `home-desktop-station-*` modes add ONE temporary entry for the container on that station
/// (read level, or the full level the private station measured) and remove it again. Never read by the product build.
impl DesktopMode {
    #[cfg_attr(not(feature = "experiment"), allow(dead_code))]
    pub(crate) fn is_home(self) -> bool { matches!(self, DesktopMode::HomeDesktop | DesktopMode::HomeStationRead | DesktopMode::HomeStationFull) }
}

/// Round 5 (EXPERIMENT only): the process creation flag that decides how a console is given to the child. `no-window` (CREATE_NO_WINDOW) is the product's behaviour.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub(crate) enum Creation { #[default] NoWindow, Detached, NoFlag, NewConsole }

impl Creation {
    pub(crate) const ALL: [(&'static str, Creation); 4] = [("no-window", Creation::NoWindow), ("detached", Creation::Detached), ("none", Creation::NoFlag), ("new-console", Creation::NewConsole)];
    pub(crate) fn parse(s: &str) -> Option<Creation> { Self::ALL.iter().find(|(n, _)| *n == s).map(|(_, m)| *m) }
    #[cfg_attr(not(feature = "experiment"), allow(dead_code))]
    pub(crate) fn name(self) -> &'static str { Self::ALL.iter().find(|(_, m)| *m == self).map(|(n, _)| *n).unwrap_or("no-window") }
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
    pub(crate) desktop: DesktopMode, // round 5, experiment only
    pub(crate) creation: Creation,   // round 5, experiment only
    pub(crate) steps: Vec<String>, // home-probe: only these steps (repeatable, or a comma list); experiment only
    pub(crate) force_station_entry: bool, // home-probe: also run the modes that write a temporary entry on the window station, even when the desktop alone worked; experiment only
    pub(crate) dump: Vec<String>, // paths whose DACL is printed as SDDL after the grants are applied and again after the child ended (repeatable --dump)
    pub(crate) sid: Option<String>, // check, revoke, delete-profile: the SID the backend expects for --name (a cross-check, never a selection: the SID is always derived from the name)
    pub(crate) profile_record: Option<String>, // run, info, delete-profile with a per-run profile name: the record file of the profile in the supervisor's control folder (see profile.rs)
}

pub(crate) fn parse_args(raw: &[String]) -> Result<Args, String> {
    // The experiment's default profile name stays as it was; the product has NO default name: every command needs an explicit per-run name (profile.rs).
    let mut a = Args { name: if EXPERIMENT { "NimbleNewtExperiment".into() } else { String::new() }, kill_on_close: true, timeout_ms: 120_000, stdin: "nul".into(), ..Default::default() };
    let mut it = raw.iter().skip(1);
    a.command = it.next().cloned().ok_or("no command (run, info, revoke, check, delete-profile)")?;
    while let Some(flag) = it.next() {
        let mut value = |what: &str| -> Result<String, String> { it.next().cloned().ok_or(format!("{what} needs a value")) };
        match flag.as_str() {
            "--name" => a.name = value("--name")?,
            "--sid" => { let v = value("--sid")?; if !profile::is_app_sid_text(&v) { return Err("--sid is not an AppContainer SID (S-1-15-2 and seven more parts)".into()); } a.sid = Some(v); }
            "--profile-record" => { let v = value("--profile-record")?; if v.is_empty() { return Err("--profile-record is empty".into()); } a.profile_record = Some(v); }
            "--win32k-off" | "--no-kill-on-close" | "--keep-profile" | "--stdout-pipe" | "--stderr-pipe" | "--stdout-nul-rw" | "--stderr-nul-rw" | "--dump" | "--desktop" | "--creation" if !EXPERIMENT => return Err(format!("{flag} is an experiment option and is not in this build")),
            "--steps" | "--force-station-entry" if !EXPERIMENT => return Err(format!("{flag} is an experiment option and is not in this build")),
            "--steps" => { for part in value("--steps")?.split(',') { let p = part.trim(); if p.is_empty() { return Err("--steps has an empty name".into()); } a.steps.push(p.to_string()); } }
            "--force-station-entry" => a.force_station_entry = true,
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
            "--desktop" => a.desktop = DesktopMode::parse(&value("--desktop")?).ok_or("--desktop: inherit, empty, winsta0, grant-read, grant-full, grant-station, grant-desktop, new-desktop, new-station, private, home-desktop, home-desktop-station-read or home-desktop-station-full")?,
            "--creation" => a.creation = Creation::parse(&value("--creation")?).ok_or("--creation: no-window, detached, none or new-console")?,
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
    if !EXPERIMENT && !matches!(a.command.as_str(), "run" | "check" | "revoke" | "info" | "delete-profile") { return Err(format!("command {} is not in this build (run, check, revoke, info, delete-profile)", a.command)); }
    // Per-run profiles (card A03b): the product's only container name is NimbleNewtRun-<16 lower-case hex digits>; there is no shared, default or administrator-chosen name any more.
    if !EXPERIMENT && !profile::is_run_name(&a.name) { return Err(format!("--name must be {}<{} lower-case hex digits> in this build", profile::RUN_PREFIX, profile::RUN_HEX_LEN)); }
    // home-revoke (experiment only) writes to the user's own window station, so it takes the same proof as delete-profile: a per-run name and the record this launcher wrote for it.
    if a.command == "home-revoke" && !profile::is_run_name(&a.name) { return Err(format!("home-revoke needs --name {}<{} lower-case hex digits> (the name on the ATTEMPT line)", profile::RUN_PREFIX, profile::RUN_HEX_LEN)); }
    if profile::is_run_name(&a.name) {
        let needs_record = matches!(a.command.as_str(), "run" | "info" | "delete-profile" | "home-revoke");
        if needs_record && a.profile_record.is_none() { return Err(format!("{} with a per-run profile needs --profile-record", a.command)); }
        if !needs_record && a.profile_record.is_some() { return Err(format!("--profile-record is only for run, info, delete-profile and home-revoke, not {}", a.command)); }
        if a.command == "delete-profile" && a.sid.is_none() { return Err("delete-profile needs --sid (the SID the supervisor recorded for the profile)".into()); }
        if !matches!(a.command.as_str(), "check" | "revoke" | "delete-profile") && a.sid.is_some() { return Err(format!("--sid is only for check, revoke and delete-profile, not {}", a.command)); }
    }
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

/// The child's environment block: only what --env named (nothing is inherited), sorted by name (case-insensitively) as Windows expects, each entry `NAME=VALUE` as UTF-16 ending in one NUL,
/// the whole block ended by one more NUL (an empty environment is two NULs). The process is started with CREATE_UNICODE_ENVIRONMENT, so the block must be UTF-16.
pub(crate) fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_uppercase());
    let mut b: Vec<u16> = Vec::new();
    for (k, v) in sorted {
        b.extend(format!("{k}={v}").encode_utf16());
        b.push(0);
    }
    if b.is_empty() { b.push(0); }
    b.push(0);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_entries(b: &[u16]) -> Vec<String> { b.split(|c| *c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect() }
    #[test]
    fn the_environment_block_is_utf16_sorted_and_ended_by_a_double_nul() {
        let env = vec![("windir".to_string(), "C:\\Windows".to_string()), ("PATH".into(), "C:\\a;C:\\b".into()), ("SystemRoot".into(), "C:\\Windows".into()), ("LOCALAPPDATA".into(), "C:\\w".into()), ("Temp".into(), "C:\\w\\\u{e9}".into())];
        let b = env_block(&env);
        assert_eq!(&b[b.len() - 2..], &[0, 0], "ended by two NULs");
        assert!(b[..b.len() - 1].iter().rposition(|c| *c == 0) == Some(b.len() - 2) && b[b.len() - 3] != 0, "exactly one NUL ends the last entry");
        let e = block_entries(&b);
        assert_eq!(e, vec!["LOCALAPPDATA=C:\\w", "PATH=C:\\a;C:\\b", "SystemRoot=C:\\Windows", "Temp=C:\\w\\\u{e9}", "windir=C:\\Windows"], "sorted by upper-cased name; non-ASCII kept as UTF-16");
        assert!(e.iter().any(|x| x.starts_with("SystemRoot=")));
        assert_eq!(env_block(&[]), vec![0, 0], "an empty environment is two NULs");
        assert_eq!(env_block(&[("A".into(), String::new())]), vec![65, 61, 0, 0], "an empty value is `A=` then the double NUL");
    }

    fn argv(parts: &[&str]) -> Vec<String> { std::iter::once("nn-launcher").chain(parts.iter().copied()).map(String::from).collect() }
    fn parse(parts: &[&str]) -> Result<Args, String> { parse_args(&argv(parts)) }
    /// The argument list the worker's backend sends (windows-native-plan.ts launcherArgs), LPAC form.
    const NAME: &str = "NimbleNewtRun-0123456789abcdef";
    const SID: &str = "S-1-15-2-1-2-3-4-5-6-7";
    fn product_run() -> Vec<&'static str> {
        vec!["run", "--name", NAME, "--profile-record", "C:\\c\\p.sid", "--grant", "modify-root:C:\\w", "--grant", "seal:C:\\w\\.git", "--grant-soft", "rx:C:\\node", "--aap-policy", "optout",
             "--capability", "registryRead", "--capability", "lpacCom", "--memory-mb", "2048", "--active-processes", "64", "--ui-limits", "--timeout-ms", "600000",
             "--stdin", "file:C:\\c\\in", "--stdout", "C:\\c\\out", "--stderr", "C:\\c\\err", "--cwd", "C:\\w", "--env", "PATH=C:\\node", "--exe", "C:\\node\\node.exe", "--cmdline", "node x.js"]
    }
    const EXPERIMENT_FLAGS: [&str; 8] = ["--win32k-off", "--no-kill-on-close", "--keep-profile", "--stdout-pipe", "--stderr-pipe", "--stdout-nul-rw", "--stderr-nul-rw", "--dump"];
    /// Round 5 options that take a value: each is refused by the product build, whatever the value.
    const ROUND5_OPTIONS: [(&str, &str); 2] = [("--desktop", "grant-full"), ("--creation", "detached")];
    /// The home-case options (one account, not elevated): refused by the product build too, with and without a value.
    const HOME_OPTIONS: [(&str, Option<&str>); 5] = [("--steps", Some("desktop-cmd")), ("--force-station-entry", None), ("--desktop", Some("home-desktop")), ("--desktop", Some("home-desktop-station-read")), ("--desktop", Some("home-desktop-station-full"))];

    #[test]
    fn the_backends_own_argument_list_is_accepted_by_every_build() {
        let a = parse(&product_run()).expect("the backend's run line");
        assert_eq!(a.command, "run");
        assert_eq!(a.grants.len(), 3);
        assert!(a.grants[2].soft);
        assert_eq!(a.aap, Some(AAP_OPT_OUT));
        assert!(a.kill_on_close, "kill-on-close is on unless an experiment option turns it off");
        assert_eq!(a.stdin, "file:C:\\c\\in");
        for command in ["check", "revoke"] { assert!(parse(&[command, "--name", NAME, "--grant", "seal:C:\\w\\.git"]).is_ok(), "{command}"); }
        assert!(parse(&["info", "--name", NAME, "--profile-record", "C:\\c\\p.sid"]).is_ok());
        assert!(parse(&["delete-profile", "--name", NAME, "--sid", SID, "--profile-record", "C:\\c\\p.sid"]).is_ok());
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
        for (flag, value) in ROUND5_OPTIONS {
            let mut v = product_run();
            v.extend([flag, value]);
            assert!(parse(&v).unwrap_err().contains("not in this build"), "{flag}");
            let mut inherit = product_run();
            inherit.extend([flag, if flag == "--desktop" { "inherit" } else { "no-window" }]);
            assert!(parse(&inherit).unwrap_err().contains("not in this build"), "{flag} even with the product's own value");
        }
        for stdin in ["nul", "nul-rw", "pipe", "pipe-open", "NUL", "", "File:C:\\x"] {
            let e = parse(&["run", "--stdin", stdin]).err().unwrap_or_else(|| panic!("--stdin {stdin} was accepted"));
            assert!(e.contains("only file:PATH"), "{stdin}: {e}");
        }
        for command in ["grant", "dump", "open-test", "context", "desktop-revoke", "home-probe", "home-revoke", "ui-test", "deelevate", "Run", "RUN", "help", ""] {
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
        assert!(parse(&["check", "--name", NAME, "--grant", "seal:C:\\w\\.git"]).is_ok() && parse(&["revoke", "--name", NAME, "--grant", "rx:C:\\n"]).is_ok(), "check and revoke take no limits");
        // the refusal does not depend on where the option stands or on what follows it
        let mut v = product_run();
        v.extend(["--keep-profile"]);
        assert!(parse(&v).unwrap_err().contains("not in this build"));
        assert!(parse(&[]).is_err(), "no command");
    }


    #[cfg(not(feature = "experiment"))]
    #[test]
    fn the_product_accepts_only_per_run_profile_names_and_no_default_name() {
        // no name at all: every command needs one (the experiment's default name is not the product's)
        for command in ["run", "info", "check", "revoke", "delete-profile"] {
            let e = parse(&[command]).unwrap_err();
            assert!(e.contains("--name must be NimbleNewtRun-"), "{command}: {e}");
        }
        // the old shared names and every near miss are refused, for every command
        for name in ["NimbleNewtAgent", "NimbleNewtExperiment", "NimbleNewtRun-", "NimbleNewtRun-0123456789ABCDEF", "NimbleNewtRun-0123456789abcde", "NimbleNewtRun-0123456789abcdef0", "Microsoft.Windows.Cortana", ""] {
            for command in ["check", "revoke"] {
                let e = parse(&[command, "--name", name]).err().unwrap_or_else(|| panic!("{command} --name {name:?} was accepted"));
                assert!(e.contains("--name must be NimbleNewtRun-"), "{name:?}: {e}");
            }
            let mut v = product_run();
            let i = v.iter().position(|x| *x == "--name").unwrap();
            v[i + 1] = name;
            assert!(parse(&v).unwrap_err().contains("--name must be"), "run --name {name:?}");
        }
        // the last --name wins, as for every option: it is validated too
        assert!(parse(&["check", "--name", NAME, "--name", "NimbleNewtAgent"]).is_err());
    }

    #[test]
    fn the_record_and_sid_options_are_only_where_they_are_used() {
        // run, info and delete-profile need the record file; check and revoke take none
        for command in ["run", "info", "delete-profile"] {
            let mut v = vec![command, "--name", NAME];
            if command == "delete-profile" { v.extend(["--sid", SID]); }
            assert!(parse(&v).unwrap_err().contains("needs --profile-record"), "{command}");
        }
        for command in ["check", "revoke"] {
            assert!(parse(&[command, "--name", NAME, "--profile-record", "C:\\c\\p.sid"]).unwrap_err().contains("--profile-record is only for"), "{command}");
        }
        assert!(parse(&["check", "--name", NAME, "--profile-record"]).unwrap_err().ends_with("needs a value"));
        assert!(parse(&["check", "--name", NAME, "--profile-record", ""]).unwrap_err().contains("empty"));
        // delete-profile needs the SID the supervisor recorded; check and revoke may carry it as a cross-check; run and info never
        assert!(parse(&["delete-profile", "--name", NAME, "--profile-record", "C:\\c\\p.sid"]).unwrap_err().contains("needs --sid"));
        for command in ["check", "revoke"] { assert!(parse(&[command, "--name", NAME, "--sid", SID]).is_ok(), "{command}"); }
        let mut v = product_run();
        v.extend(["--sid", SID]);
        assert!(parse(&v).unwrap_err().contains("--sid is only for"));
        assert!(parse(&["info", "--name", NAME, "--profile-record", "C:\\c\\p.sid", "--sid", SID]).unwrap_err().contains("--sid is only for"));
        // a SID that is not an AppContainer SID is refused whatever the command
        for bad in ["S-1-5-18", "S-1-15-2-1", "S-1-15-2-1-2-3-4-5-6-7-8", "", "x", "S-1-15-3-1-2-3-4-5-6-7"] {
            assert!(parse(&["check", "--name", NAME, "--sid", bad]).unwrap_err().contains("not an AppContainer SID"), "{bad:?}");
        }
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
        for command in ["grant", "dump", "delete-profile", "context", "desktop-revoke"] { assert!(parse(&[command]).is_ok(), "{command}"); }
    }

    #[test]
    fn the_experiment_defaults_stay_the_measured_baseline() {
        let a = parse(&product_run()).expect("the backend's run line");
        assert_eq!(a.desktop, DesktopMode::Inherit, "the experiment's own default stays the measured baseline; the product build does not read it (win.rs private_wanted)");
        assert_eq!(a.creation, Creation::NoWindow, "CREATE_NO_WINDOW stays on");
    }

    #[cfg(feature = "experiment")]
    #[test]
    fn round_5_options_take_exactly_their_named_values() {
        for (name, mode) in DesktopMode::ALL {
            let a = parse(&["run", "--desktop", name]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(a.desktop, mode);
            assert_eq!(mode.name(), name);
        }
        for (name, mode) in Creation::ALL {
            let a = parse(&["run", "--creation", name]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(a.creation, mode);
            assert_eq!(mode.name(), name);
        }
        for bad in ["Inherit", "GRANT-FULL", "grant", "", "winsta0\\default", "new_station"] { assert!(parse(&["run", "--desktop", bad]).is_err(), "--desktop {bad:?}"); }
        for bad in ["No-Window", "detach", "", "CREATE_NO_WINDOW"] { assert!(parse(&["run", "--creation", bad]).is_err(), "--creation {bad:?}"); }
        assert!(parse(&["run", "--desktop"]).unwrap_err().ends_with("needs a value"));
    }

    #[cfg(not(feature = "experiment"))]
    #[test]
    fn the_product_build_refuses_the_home_case_options_and_commands() {
        for (flag, value) in HOME_OPTIONS {
            let mut v = product_run();
            v.push(flag);
            if let Some(x) = value { v.push(x); }
            assert!(parse(&v).unwrap_err().contains("not in this build"), "{flag} {value:?}");
        }
        for command in ["home-probe", "home-revoke", "ui-test", "deelevate"] {
            for extra in [vec![], vec!["--name", NAME], vec!["--steps", "context"]] {
                let mut v = vec![command];
                v.extend(extra);
                assert!(parse(&v).unwrap_err().contains("not in this build"), "{command}");
            }
        }
    }

    #[cfg(feature = "experiment")]
    #[test]
    fn the_home_case_options_take_exactly_their_values() {
        let a = parse(&["home-probe", "--steps", "context,desktop-cmd", "--steps", "inherit", "--force-station-entry", "--aap-policy", "optout"]).expect("home-probe");
        assert_eq!(a.steps, ["context", "desktop-cmd", "inherit"]);
        assert!(a.force_station_entry);
        assert_eq!(a.aap, Some(AAP_OPT_OUT));
        for (name, mode) in [("home-desktop", DesktopMode::HomeDesktop), ("home-desktop-station-read", DesktopMode::HomeStationRead), ("home-desktop-station-full", DesktopMode::HomeStationFull)] {
            let a = parse(&["run", "--desktop", name]).unwrap();
            assert_eq!((a.desktop, a.desktop.is_home(), a.desktop.name()), (mode, true, name));
        }
        for other in DesktopMode::ALL.iter().filter(|(n, _)| !n.starts_with("home-")) { assert!(!other.1.is_home(), "{}", other.0); }
        for bad in ["", "context,", ",context", "a,,b"] { assert!(parse(&["home-probe", "--steps", bad]).is_err(), "--steps {bad:?}"); }
        assert!(parse(&["home-probe", "--steps"]).unwrap_err().ends_with("needs a value"));
        assert!(!parse(&["home-probe"]).unwrap().force_station_entry && parse(&["home-probe"]).unwrap().steps.is_empty());
        for command in ["home-probe", "ui-test"] { assert!(parse(&[command]).is_ok(), "{command}"); }
        // home-revoke: a per-run name and its record, as delete-profile
        assert!(parse(&["home-revoke"]).unwrap_err().contains("home-revoke needs --name NimbleNewtRun-"));
        assert!(parse(&["home-revoke", "--name", "NimbleNewtExperiment"]).unwrap_err().contains("home-revoke needs --name"));
        assert!(parse(&["home-revoke", "--name", NAME]).unwrap_err().contains("needs --profile-record"));
        assert!(parse(&["home-revoke", "--name", NAME, "--profile-record", "C:\\c\\p.sid"]).is_ok());
    }
}
