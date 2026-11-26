// The "home case" measurement (EXPERIMENT build and tests only; not compiled into the product launcher): the pure rules of `home-probe`, `home-revoke`, `deelevate` and `ui-test` (home.rs), kept apart
// from the Win32 calls so they are tested on every platform. Nothing here touches the system.
//
// The question: the common home PC has ONE account, usually an administrator running with UAC, so the worker runs as that user in the normal (not elevated, medium integrity) desktop session. The
// product's per-run PRIVATE WINDOW STATION cannot be made by such a process (measured by the owner on build 26200: error 5, Microsoft documents that only Administrators may name a window
// station). These rules plan the steps that measure the alternatives on the user's OWN window station: a private DESKTOP on it, with and without a temporary entry for the container on the station.
use crate::args::DesktopMode;
use crate::winobj::{acl_entries, sid_text, ACE_ALLOWED, ACE_DENIED};

/// Mandatory-label RID of a medium-integrity token (SECURITY_MANDATORY_MEDIUM_RID): what a de-elevated child of an elevated administrator has.
pub(crate) const MEDIUM_INTEGRITY_RID: u32 = 0x2000;
/// SE_GROUP_ENABLED, SE_GROUP_USE_FOR_DENY_ONLY in SID_AND_ATTRIBUTES.Attributes.
pub(crate) const SE_GROUP_ENABLED: u32 = 0x4;
pub(crate) const SE_GROUP_DENY_ONLY: u32 = 0x10;

/// The groups a de-elevated (UAC-filtered style) token holds as deny-only: Administrators and the operator groups that carry administrative rights. Matching is by exact SID text.
pub(crate) const ADMIN_LIKE_GROUPS: [&str; 6] = ["S-1-5-32-544", "S-1-5-32-548", "S-1-5-32-549", "S-1-5-32-550", "S-1-5-32-551", "S-1-5-32-556"];
pub(crate) fn is_admin_like(sid: &str) -> bool { ADMIN_LIKE_GROUPS.contains(&sid) }

/// What the Administrators group is in a token: `absent`, `enabled`, `deny-only` (what a UAC-filtered token has) or `disabled`.
pub(crate) fn admin_group_state(groups: &[(String, u32)]) -> &'static str {
    match groups.iter().find(|(s, _)| s == "S-1-5-32-544") {
        None => "absent",
        Some((_, a)) if a & SE_GROUP_DENY_ONLY != 0 => "deny-only",
        Some((_, a)) if a & SE_GROUP_ENABLED != 0 => "enabled",
        Some(_) => "disabled",
    }
}

pub(crate) fn integrity_name(rid: i64) -> &'static str {
    match rid { 0x0000 => "untrusted", 0x1000 => "low", 0x2000 => "medium", 0x2100 => "medium-plus", 0x3000 => "high", 0x4000 => "system", _ => "unknown" }
}

/// TOKEN_ELEVATION_TYPE: 1 default (no split: UAC off, or a standard user), 2 full (elevated), 3 limited (filtered).
pub(crate) fn elevation_type_name(t: i64) -> &'static str { match t { 1 => "default", 2 => "full", 3 => "limited", _ => "unknown" } }

/// A SID text with the account-specific parts replaced: a domain or machine account `S-1-5-21-a-b-c-RID` keeps only the RID, a logon-session SID `S-1-5-5-x-y` keeps no number. Well-known SIDs and
/// the throw-away container's own SID (it names no account) stay as they are.
pub(crate) fn redact_sid(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("S-1-5-21-") {
        let parts: Vec<&str> = rest.split('-').collect();
        if parts.len() == 4 { return format!("S-1-5-21-<machine>-{}", parts[3]); }
        return "S-1-5-21-<machine>".into();
    }
    if s.starts_with("S-1-5-5-") { return "S-1-5-5-<logon session>".into(); }
    s.to_string()
}

pub(crate) fn well_known_name(s: &str) -> &'static str {
    match s {
        "S-1-1-0" => "Everyone", "S-1-5-4" => "INTERACTIVE", "S-1-5-11" => "Authenticated Users", "S-1-5-18" => "SYSTEM", "S-1-5-32-544" => "Administrators", "S-1-5-32-545" => "Users",
        "S-1-3-4" => "OWNER RIGHTS", "S-1-15-2-1" => "ALL APPLICATION PACKAGES", "S-1-15-2-2" => "ALL RESTRICTED APPLICATION PACKAGES", "S-1-5-12" => "RESTRICTED", "S-1-5-5-0-0" => "",
        _ if s.starts_with("S-1-5-5-") => "logon session", _ => "",
    }
}

// ---------------------------------------------------------------------------------------------------------------- access lists

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AceInfo { pub(crate) kind: u8, pub(crate) flags: u8, pub(crate) mask: u32, pub(crate) sid: String }

/// The plain allow and deny entries of a DACL with their SIDs (None: a malformed ACL; any other entry type is listed with kind 255 and no SID).
pub(crate) fn ace_infos(acl: &[u8]) -> Option<Vec<AceInfo>> {
    let (_, entries) = acl_entries(acl)?;
    let mut out = Vec::new();
    for e in entries {
        if (e[0] != ACE_ALLOWED && e[0] != ACE_DENIED) || e.len() < 8 + 8 { out.push(AceInfo { kind: 255, flags: e[1], mask: 0, sid: String::new() }); continue; }
        let sid = &e[8..];
        let n = (8 + 4 * sid[1].min(15) as usize).min(sid.len());
        let text = sid_text(&sid[..n]).unwrap_or_default();
        out.push(AceInfo { kind: e[0], flags: e[1], mask: u32::from_le_bytes([e[4], e[5], e[6], e[7]]), sid: text });
    }
    Some(out)
}

const WINSTA_RIGHTS: [(u32, &str); 9] = [(0x1, "ENUMDESKTOPS"), (0x2, "READATTRIBUTES"), (0x4, "ACCESSCLIPBOARD"), (0x8, "CREATEDESKTOP"), (0x10, "WRITEATTRIBUTES"), (0x20, "ACCESSGLOBALATOMS"),
    (0x40, "EXITWINDOWS"), (0x100, "ENUMERATE"), (0x200, "READSCREEN")];
const DESKTOP_RIGHTS_NAMES: [(u32, &str); 9] = [(0x1, "READOBJECTS"), (0x2, "CREATEWINDOW"), (0x4, "CREATEMENU"), (0x8, "HOOKCONTROL"), (0x10, "JOURNALRECORD"), (0x20, "JOURNALPLAYBACK"),
    (0x40, "ENUMERATE"), (0x80, "WRITEOBJECTS"), (0x100, "SWITCHDESKTOP")];

fn names(mask: u32, table: &[(u32, &'static str)], prefix: &str) -> Vec<String> {
    let mut v: Vec<String> = table.iter().filter(|(bit, _)| mask & bit != 0).map(|(_, n)| format!("{prefix}{n}")).collect();
    for (bit, n) in [(0x0001_0000u32, "DELETE"), (0x0002_0000, "READ_CONTROL"), (0x0004_0000, "WRITE_DAC"), (0x0008_0000, "WRITE_OWNER")] { if mask & bit != 0 { v.push(n.to_string()); } }
    v
}
/// The WINSTA_* (and standard) right names in a window-station mask.
pub(crate) fn station_right_names(mask: u32) -> Vec<String> { names(mask, &WINSTA_RIGHTS, "WINSTA_") }
/// The DESKTOP_* (and standard) right names in a desktop mask.
pub(crate) fn desktop_right_names(mask: u32) -> Vec<String> { names(mask, &DESKTOP_RIGHTS_NAMES, "DESKTOP_") }

/// What ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2) hold as allow entries on an object: the masks, in the order of the list. A regular AppContainer carries
/// the first group in its token; a LPAC (`--aap-policy optout`) does not, which is why an entry of that group cannot be what lets an LPAC use a window object.
#[derive(Debug, PartialEq, Default)]
pub(crate) struct PackageGroups { pub(crate) all_app_packages: Vec<u32>, pub(crate) all_restricted: Vec<u32> }
pub(crate) fn package_groups(infos: &[AceInfo]) -> PackageGroups {
    let mut p = PackageGroups::default();
    for i in infos.iter().filter(|i| i.kind == ACE_ALLOWED) {
        if i.sid == "S-1-15-2-1" { p.all_app_packages.push(i.mask); }
        if i.sid == "S-1-15-2-2" { p.all_restricted.push(i.mask); }
    }
    p
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
    }
    o.push('"');
    o
}

/// The entries as a JSON array (raw text): type, flags, mask in hex, redacted SID, a name for the well-known ones, and the right names (`station`: window-station names, else desktop names).
pub(crate) fn aces_json(infos: &[AceInfo], station: bool) -> String {
    let items: Vec<String> = infos.iter().map(|i| {
        let rights = if station { station_right_names(i.mask) } else { desktop_right_names(i.mask) };
        let kind = match i.kind { ACE_ALLOWED => "allow", ACE_DENIED => "deny", _ => "other" };
        format!("{{\"type\":{},\"flags\":\"0x{:x}\",\"mask\":\"0x{:x}\",\"sid\":{},\"name\":{},\"rights\":[{}]}}", json_str(kind), i.flags, i.mask, json_str(&redact_sid(&i.sid)), json_str(well_known_name(&i.sid)),
            rights.iter().map(|r| json_str(r)).collect::<Vec<_>>().join(","))
    }).collect();
    format!("[{}]", items.join(","))
}

pub(crate) fn masks_json(masks: &[u32]) -> String { format!("[{}]", masks.iter().map(|m| format!("\"0x{m:x}\"")).collect::<Vec<_>>().join(",")) }

// ---------------------------------------------------------------------------------------------------------------- the rules for writing

/// The container's entry on the CURRENT window station, by mode: the read level (what a non-interactive station's GENERIC_READ maps to, READ_CONTROL | ENUMDESKTOPS | READATTRIBUTES | ENUMERATE) or the
/// full level the private station measured (READ_CONTROL | WINSTA_ALL_ACCESS, 131967). None: the mode writes nothing to the station.
pub(crate) const HOME_STATION_READ: u32 = 0x0002_0103;
pub(crate) const HOME_STATION_FULL: u32 = 0x0002_037F;
pub(crate) fn home_station_mask(mode: DesktopMode) -> Option<u32> {
    match mode { DesktopMode::HomeStationRead => Some(HOME_STATION_READ), DesktopMode::HomeStationFull => Some(HOME_STATION_FULL), _ => None }
}

/// May a desktop be made on this window station? Any named station the launcher runs in; not an unreadable name.
pub(crate) fn may_make_home_desktop(station: &str) -> Result<(), String> {
    if station.is_empty() || station == "?" { return Err("refused: the name of the launcher's window station could not be read".into()); }
    Ok(())
}

/// May ONE temporary entry for a container be written to this window station? Only the interactive one (named WinSta0, WSF_VISIBLE set, flags readable): the measurement is about the user's own
/// station, and any other station is a service's (the `grant-*` modes' business, with their own rule).
pub(crate) fn may_write_interactive_station(station: &str, flags: i64) -> Result<(), String> {
    if !station.eq_ignore_ascii_case("winsta0") { return Err(format!("refused: the window station is {station}, not the interactive WinSta0; the home modes write only there")); }
    if flags < 0 { return Err("refused: the flags of WinSta0 could not be read, so it is not known to be the visible station".into()); }
    if flags & 1 == 0 { return Err("refused: WinSta0 is not marked visible (WSF_VISIBLE clear), so this is not a signed-in session's station".into()); }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------- the steps

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) enum Group { None, Inherit, Desktop, StationRead, StationFull }
impl Group {
    pub(crate) fn name(self) -> &'static str { match self { Group::None => "", Group::Inherit => "inherit", Group::Desktop => "desktop", Group::StationRead => "station-read", Group::StationFull => "station-full" } }
    pub(crate) fn mode(self) -> DesktopMode {
        match self { Group::Desktop => DesktopMode::HomeDesktop, Group::StationRead => DesktopMode::HomeStationRead, Group::StationFull => DesktopMode::HomeStationFull, _ => DesktopMode::Inherit }
    }
}
pub(crate) const GROUPS: [Group; 4] = [Group::Inherit, Group::Desktop, Group::StationRead, Group::StationFull];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Prog { Cmd, Hostname, Node, UiTest }
impl Prog {
    pub(crate) fn name(self) -> &'static str { match self { Prog::Cmd => "cmd", Prog::Hostname => "hostname", Prog::Node => "node", Prog::UiTest => "ui-test" } }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind { Context, StationAccess, Profile, Run { prog: Prog, limits: bool } }

#[derive(Clone, Debug)]
pub(crate) struct Step { pub(crate) id: String, pub(crate) group: Group, pub(crate) kind: Kind }

/// Every step, in the order they run: the three read-only or throw-away ones, then for each group the programs (with and without the job's UI limits). A group that writes to the window station
/// comes after the ones that do not.
pub(crate) fn all_steps() -> Vec<Step> {
    let mut v = vec![
        Step { id: "context".into(), group: Group::None, kind: Kind::Context },
        Step { id: "station-access".into(), group: Group::None, kind: Kind::StationAccess },
        Step { id: "profile".into(), group: Group::None, kind: Kind::Profile },
    ];
    for g in GROUPS {
        for (prog, limits) in [(Prog::UiTest, false), (Prog::Cmd, false), (Prog::Hostname, false), (Prog::Node, false), (Prog::UiTest, true), (Prog::Cmd, true), (Prog::Node, true)] {
            v.push(Step { id: format!("{}-{}{}", g.name(), prog.name(), if limits { "-limits" } else { "" }), group: g, kind: Kind::Run { prog, limits } });
        }
    }
    v
}

/// The steps a `--steps` list names: each entry is a step id or a group name (every step of the group). An unknown name is an error that lists the valid ones; the order stays the plan's own.
pub(crate) fn select_steps(all: Vec<Step>, wanted: &[String]) -> Result<Vec<Step>, String> {
    if wanted.is_empty() { return Ok(all); }
    for w in wanted {
        if !all.iter().any(|s| s.id == *w || (!s.group.name().is_empty() && s.group.name() == w)) {
            return Err(format!("--steps: unknown step or group {w:?} (steps: {})", all.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    Ok(all.into_iter().filter(|s| wanted.iter().any(|w| s.id == *w || (!s.group.name().is_empty() && s.group.name() == w))).collect())
}

/// How a group came out: `Works` (the user32-loading program, and node when it was found, ran and exited 0), `Fails`, or `NotRun`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict { Works, Fails, NotRun }
impl Verdict {
    pub(crate) fn name(self) -> &'static str { match self { Verdict::Works => "works", Verdict::Fails => "fails", Verdict::NotRun => "not-run" } }
}

/// Is this step one the group's verdict rests on? The plain `ui-test` (a program that loads user32, the thing 0xC0000142 broke) and node; cmd and hostname are console programs that do not need the desktop.
pub(crate) fn decides_verdict(step: &Step) -> bool { matches!(step.kind, Kind::Run { prog: Prog::UiTest | Prog::Node, limits: false }) }

/// Whether a step that writes a temporary entry to the window station runs. With `--steps` the user chose, so everything named runs; otherwise the station-read group runs only when the desktop alone
/// failed (or with `--force-station-entry`), and the station-full group only when the read level failed. The reason is reported either way.
pub(crate) fn station_decision(group: Group, chose_steps: bool, force: bool, verdicts: &[(Group, Verdict)]) -> Result<(), String> {
    if !matches!(group, Group::StationRead | Group::StationFull) || chose_steps || force { return Ok(()); }
    let before = |g: Group| verdicts.iter().find(|(x, _)| *x == g).map(|(_, v)| *v).unwrap_or(Verdict::NotRun);
    match group {
        Group::StationRead => if before(Group::Desktop) == Verdict::Fails { Ok(()) } else { Err(format!("skipped: no entry on the window station is written unless the desktop alone failed (it {}); --force-station-entry runs it anyway", before(Group::Desktop).name())) },
        _ => if before(Group::StationRead) == Verdict::Fails { Ok(()) } else { Err(format!("skipped: the full level is tried only when the read level failed (it {}); --force-station-entry runs it anyway", before(Group::StationRead).name())) },
    }
}

/// `deelevate [--exe PATH] -- ARGS` or `deelevate [--exe PATH] ARGS`: the program to run (None: this executable) and its arguments. `--exe` must come first.
pub(crate) fn split_deelevate_args(rest: &[String]) -> Result<(Option<String>, Vec<String>), String> {
    let (exe, tail) = if rest.first().map(String::as_str) == Some("--exe") {
        match rest.get(1) { Some(p) if !p.is_empty() => (Some(p.clone()), &rest[2..]), _ => return Err("--exe needs a path".into()) }
    } else { (None, rest) };
    let tail = if tail.first().map(String::as_str) == Some("--") { &tail[1..] } else { tail };
    if tail.is_empty() && exe.is_none() { return Err("deelevate needs the arguments of the program to run".into()); }
    Ok((exe, tail.to_vec()))
}

/// One argument quoted for a Windows command line (CommandLineToArgvW rules: backslashes before a quote are doubled, the quote is escaped, the whole is wrapped when it holds a space, tab or quote or is empty).
pub(crate) fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c == ' ' || c == '\t' || c == '"') { return a.to_string(); }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in a.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => { out.push_str(&"\\".repeat(backslashes * 2 + 1)); out.push('"'); backslashes = 0; }
            c => { out.push_str(&"\\".repeat(backslashes)); backslashes = 0; out.push(c); }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(auth: u8, subs: &[u32]) -> Vec<u8> {
        let mut v = vec![1, subs.len() as u8, 0, 0, 0, 0, 0, auth];
        for s in subs { v.extend(s.to_le_bytes()); }
        v
    }
    fn ace(kind: u8, flags: u8, mask: u32, s: &[u8]) -> Vec<u8> {
        let mut v = vec![kind, flags];
        v.extend(((8 + s.len()) as u16).to_le_bytes());
        v.extend(mask.to_le_bytes());
        v.extend_from_slice(s);
        v
    }
    fn acl(entries: &[Vec<u8>]) -> Vec<u8> {
        let refs: Vec<&[u8]> = entries.iter().map(|e| &e[..]).collect();
        crate::winobj::build_acl(2, &refs).unwrap()
    }

    #[test]
    fn the_plan_lists_three_single_steps_then_seven_per_group_with_unique_ids() {
        let all = all_steps();
        assert_eq!(all.len(), 3 + 4 * 7);
        let ids: std::collections::HashSet<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), all.len());
        assert_eq!(&all[..3].iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), &["context", "station-access", "profile"]);
        assert!(ids.contains("desktop-ui-test") && ids.contains("station-read-node-limits") && ids.contains("inherit-hostname"));
        // the groups that write to the window station come last
        let first_station = all.iter().position(|s| matches!(s.group, Group::StationRead)).unwrap();
        assert!(all[..first_station].iter().all(|s| !matches!(s.group, Group::StationRead | Group::StationFull)));
        assert!(all[first_station..].iter().all(|s| matches!(s.group, Group::StationRead | Group::StationFull)));
    }

    #[test]
    fn a_selection_takes_step_ids_or_group_names_and_refuses_unknown_ones() {
        assert_eq!(select_steps(all_steps(), &[]).unwrap().len(), 31);
        let one = select_steps(all_steps(), &["desktop-cmd".to_string()]).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(select_steps(all_steps(), &["desktop".to_string()]).unwrap().len(), 7);
        let mixed = select_steps(all_steps(), &["inherit-ui-test".to_string(), "context".to_string()]).unwrap();
        assert_eq!(mixed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["context", "inherit-ui-test"], "the plan's own order");
        for bad in ["Desktop", "desktop-", "nope", "station", ""] { assert!(select_steps(all_steps(), &[bad.to_string()]).unwrap_err().contains("unknown step or group"), "{bad:?}"); }
    }

    #[test]
    fn a_window_station_entry_is_written_only_when_it_is_needed_or_asked_for() {
        let v = |d: Verdict, r: Verdict| vec![(Group::Desktop, d), (Group::StationRead, r)];
        // the desktop alone works: no station entry at all
        assert!(station_decision(Group::StationRead, false, false, &v(Verdict::Works, Verdict::NotRun)).unwrap_err().starts_with("skipped:"));
        assert!(station_decision(Group::StationFull, false, false, &v(Verdict::Works, Verdict::NotRun)).is_err());
        // the desktop alone failed: the read level runs, the full level only after the read level failed
        assert!(station_decision(Group::StationRead, false, false, &v(Verdict::Fails, Verdict::NotRun)).is_ok());
        assert!(station_decision(Group::StationFull, false, false, &v(Verdict::Fails, Verdict::NotRun)).is_err());
        assert!(station_decision(Group::StationFull, false, false, &v(Verdict::Fails, Verdict::Fails)).is_ok());
        assert!(station_decision(Group::StationFull, false, false, &v(Verdict::Fails, Verdict::Works)).is_err());
        // not measured is not "failed"
        assert!(station_decision(Group::StationRead, false, false, &[]).is_err());
        // the user's own choices
        assert!(station_decision(Group::StationRead, true, false, &[]).is_ok());
        assert!(station_decision(Group::StationFull, false, true, &[]).is_ok());
        // the groups that write nothing are never gated
        for g in [Group::Inherit, Group::Desktop, Group::None] { assert!(station_decision(g, false, false, &[]).is_ok()); }
    }

    #[test]
    fn only_the_programs_that_load_user32_decide_a_groups_verdict() {
        let steps = all_steps();
        let deciding: Vec<&str> = steps.iter().filter(|s| s.group == Group::Desktop && decides_verdict(s)).map(|s| s.id.as_str()).collect();
        assert_eq!(deciding, ["desktop-ui-test", "desktop-node"]);
        assert!(steps.iter().filter(|s| s.group == Group::Inherit).all(|s| !(decides_verdict(s) && matches!(s.kind, Kind::Run { prog: Prog::Cmd | Prog::Hostname, .. }))));
    }

    #[test]
    fn the_station_entry_levels_and_the_interactive_station_rule() {
        assert_eq!(home_station_mask(DesktopMode::HomeDesktop), None, "the desktop alone writes nothing to the station");
        assert_eq!(home_station_mask(DesktopMode::HomeStationRead), Some(0x2_0000 | 0x1 | 0x2 | 0x100));
        assert_eq!(home_station_mask(DesktopMode::HomeStationFull), Some(0x2_0000 | 0x37F), "the measured 131967");
        assert_eq!(HOME_STATION_FULL, 131967);
        for m in [DesktopMode::Inherit, DesktopMode::Private, DesktopMode::GrantFull, DesktopMode::NewDesktop] { assert_eq!(home_station_mask(m), None); }
        assert!(may_write_interactive_station("WinSta0", 1).is_ok() && may_write_interactive_station("winsta0", 3).is_ok());
        for (name, flags) in [("WinSta0", 0), ("WinSta0", -1), ("Service-0x0-3e7$", 1), ("nn-ws-0123", 1), ("", 1), ("WinSta00", 1)] { assert!(may_write_interactive_station(name, flags).unwrap_err().starts_with("refused:"), "{name} {flags}"); }
        assert!(may_make_home_desktop("WinSta0").is_ok() && may_make_home_desktop("Service-0x0-3e7$").is_ok());
        assert!(may_make_home_desktop("?").is_err() && may_make_home_desktop("").is_err());
    }

    #[test]
    fn the_access_list_summary_names_the_package_groups_and_the_rights() {
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let aap = sid(15, &[2, 1]);
        let restricted = sid(15, &[2, 2]);
        let raw = acl(&[ace(0, 0, 0x2_037F, &user), ace(0, 0, 0x2_0002, &aap), ace(0, 0, 0x2_0100, &aap), ace(1, 0, 0x8, &restricted), ace(0, 0, 0x1, &restricted), ace(0, 0, 0xF_037F, &sid(5, &[18]))]);
        let infos = ace_infos(&raw).unwrap();
        assert_eq!(infos.len(), 6);
        assert_eq!(infos[0].sid, "S-1-5-21-1-2-3-1001");
        let p = package_groups(&infos);
        assert_eq!(p.all_app_packages, vec![0x2_0002, 0x2_0100]);
        assert_eq!(p.all_restricted, vec![0x1], "a deny entry is not an allow entry");
        assert_eq!(station_right_names(0x2_0102), ["WINSTA_READATTRIBUTES", "WINSTA_ENUMERATE", "READ_CONTROL"]);
        assert!(desktop_right_names(0x1FF).contains(&"DESKTOP_SWITCHDESKTOP".to_string()));
        let json = aces_json(&infos, true);
        assert!(json.contains("\"name\":\"ALL APPLICATION PACKAGES\"") && json.contains("\"sid\":\"S-1-5-21-<machine>-1001\"") && !json.contains("S-1-5-21-1-2-3"), "{json}");
        assert!(ace_infos(&[2, 0, 8]).is_none());
        assert_eq!(masks_json(&[0x2_0002]), "[\"0x20002\"]");
    }

    #[test]
    fn account_specific_sids_are_redacted_and_well_known_ones_are_not() {
        assert_eq!(redact_sid("S-1-5-21-111-222-333-1001"), "S-1-5-21-<machine>-1001");
        assert_eq!(redact_sid("S-1-5-5-0-123456"), "S-1-5-5-<logon session>");
        for keep in ["S-1-5-18", "S-1-5-32-544", "S-1-15-2-1", "S-1-15-2-3-4-5-6-7-8-9", "S-1-1-0", "S-1-16-8192"] { assert_eq!(redact_sid(keep), keep); }
        assert_eq!(well_known_name("S-1-5-5-0-77"), "logon session");
        assert_eq!(well_known_name("S-1-5-21-1-2-3-500"), "");
    }

    #[test]
    fn the_token_facts_are_named_as_windows_documents_them() {
        let groups = |a: u32| vec![("S-1-5-21-1-2-3-513".to_string(), 7u32), ("S-1-5-32-544".to_string(), a)];
        assert_eq!(admin_group_state(&groups(SE_GROUP_ENABLED | 3)), "enabled");
        assert_eq!(admin_group_state(&groups(SE_GROUP_DENY_ONLY | SE_GROUP_ENABLED)), "deny-only", "deny-only wins even when the enabled bit is set");
        assert_eq!(admin_group_state(&groups(0)), "disabled");
        assert_eq!(admin_group_state(&[]), "absent");
        assert_eq!((integrity_name(0x1000), integrity_name(0x2000), integrity_name(0x3000), integrity_name(0x4000), integrity_name(7)), ("low", "medium", "high", "system", "unknown"));
        assert_eq!((elevation_type_name(1), elevation_type_name(2), elevation_type_name(3), elevation_type_name(0)), ("default", "full", "limited", "unknown"));
        assert_eq!(MEDIUM_INTEGRITY_RID, 0x2000);
        assert!(is_admin_like("S-1-5-32-544") && is_admin_like("S-1-5-32-551"));
        for not in ["S-1-5-32-545", "S-1-5-18", "S-1-1-0", "S-1-5-32-5440"] { assert!(!is_admin_like(not), "{not}"); }
    }

    #[test]
    fn deelevate_takes_an_optional_program_then_its_arguments() {
        let v = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(split_deelevate_args(&v(&["home-probe", "--steps", "context"])).unwrap(), (None, v(&["home-probe", "--steps", "context"])));
        assert_eq!(split_deelevate_args(&v(&["--", "info", "--name", "x"])).unwrap(), (None, v(&["info", "--name", "x"])));
        assert_eq!(split_deelevate_args(&v(&["--exe", "C:\\p\\nn-launcher.exe", "info"])).unwrap(), (Some("C:\\p\\nn-launcher.exe".into()), v(&["info"])));
        assert_eq!(split_deelevate_args(&v(&["--exe", "a.exe", "--", "info"])).unwrap().1, v(&["info"]));
        for bad in [v(&[]), v(&["--exe"]), v(&["--exe", ""]), v(&["--"])] { assert!(split_deelevate_args(&bad).is_err(), "{bad:?}"); }
        assert_eq!(split_deelevate_args(&v(&["a", "--exe", "b"])).unwrap().1, v(&["a", "--exe", "b"]), "--exe only counts first");
    }

    #[test]
    fn arguments_are_quoted_for_a_windows_command_line() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quote_arg("C:\\Program Files\\x\\"), "\"C:\\Program Files\\x\\\\\"");
        assert_eq!(quote_arg("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote_arg("C:\\nospace\\"), "C:\\nospace\\", "backslashes alone need no quoting");
    }
}
