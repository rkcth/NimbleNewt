// The pure rules both launcher builds share (card A03b, Session 0 fix): the private window station and desktop each run gets, and the DACL entry builder it uses. Kept apart from the Win32 calls
// (privdesk.rs) so they are tested on every platform. Nothing here touches the system.
//
// Why a private station: a Windows service runs in session 0 on a non-interactive window station (`Service-0x0-<logon id>$`, desktop `Default`). A child in an AppContainer that is given no
// window station of its own takes that one, and the container's SID has no access to it, so every child that loads user32 dies with 0xC0000142 (own-hardware run 45650543163, build 26200).
// The same child works when it has access to a window station AND a desktop; the cleanest way found is objects made for the run (the experiment's `new-station`: node, cmd, powershell and
// hostname ran in about 50 ms with the service's own objects untouched). An entry on the station alone or the desktop alone failed.

/// The access the container gets on its private window station: WINSTA_ALL_ACCESS (0x37F) plus READ_CONTROL, the mask the experiment applied (131967) and measured as sufficient.
pub(crate) const STATION_RIGHTS: u32 = 0x0002_037F;
/// The access the container gets on its private desktop: every DESKTOP_* right (0x1FF) plus READ_CONTROL, as measured (131583).
pub(crate) const DESKTOP_RIGHTS: u32 = 0x0002_01FF;
/// CWF_CREATE_ONLY (winuser.h; not in windows-sys 0.59), the dwFlags of CreateWindowStationW: "If this parameter is CWF_CREATE_ONLY and the window station already exists, the call fails.
/// If this flag is not specified and the window station already exists, the function succeeds and returns a new handle to the existing window station" (Microsoft Learn). Without it a
/// station someone else made under the same name would be opened, and Microsoft does not document ERROR_ALREADY_EXISTS for that case, so the flag (not the error code) is what refuses it.
pub(crate) const STATION_CREATE_ONLY: u32 = 0x0000_0001;
/// The desktop's name inside the private station (the station's name is the unique part).
pub(crate) const DESKTOP_NAME: &str = "nn-d";

/// The names of one run's private window station and desktop. The station name carries 64 random bits (taken from the OS-seeded hasher in privdesk.rs), so two runs, two launchers or a
/// stale object never share a name; a name that already exists is refused, never adopted.
pub(crate) fn private_names(seed: u64) -> (String, String) { (format!("nn-ws-{seed:016x}"), DESKTOP_NAME.to_string()) }

/// The text for STARTUPINFO.lpDesktop: `station\desktop`.
pub(crate) fn desktop_path(station: &str, desktop: &str) -> String { format!("{station}\\{desktop}") }

/// Which window objects a run's container gets (card A03b, home case, plan 12.5). `Private`: a window station of the run's own with a desktop in it (needs a launcher that may NAME a window
/// station: an administrator's elevated token). `HomeDesktop`: ONE private desktop on the user's own interactive window station WinSta0, made with its final access list, no write to the station's
/// access list, `lpDesktop` `WinSta0\<name>` (the non-elevated user's case, where naming a station is refused with error 5). There is NO third mode: the inherited desktop is never used.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WindowMode { Private, HomeDesktop }
impl WindowMode {
    /// The word the launcher's JSON line and the backend use (`windowStation`).
    pub(crate) fn name(self) -> &'static str { match self { WindowMode::Private => "private", WindowMode::HomeDesktop => "home-desktop" } }
}

/// ERROR_ACCESS_DENIED: what CreateWindowStationW returned to the owner's non-elevated user (measured, build 26200) and what Microsoft documents for a non-administrator naming a station.
pub(crate) const ERROR_STATION_REFUSED: u32 = 5;
/// The interactive window station of a signed-in session, the only one the home desktop is made on.
pub(crate) const INTERACTIVE_STATION: &str = "WinSta0";

/// After the NAMED private window station failed with this error: does the launcher try the home desktop? Only for a launcher KNOWN to be not elevated (`elevation` is the process token's
/// TokenElevation: Some(false); None when it could not be read) and only for the refusal (error 5) that Microsoft documents for a non-administrator. Any other error, an elevated launcher that
/// was refused, and a launcher whose elevation is unknown stay failures: the home desktop is not a general fallback, and nothing ever inherits a desktop.
pub(crate) fn try_home_desktop(elevation: Option<bool>, station_error: u32) -> bool { elevation == Some(false) && station_error == ERROR_STATION_REFUSED }

/// May the home desktop be made on this window station? Only the interactive WinSta0 with WSF_VISIBLE set (`flags` is USEROBJECTFLAGS.dwFlags, -1 when unreadable), in a signed-in user's
/// session (`session` is the launcher's session id, -1 when unreadable; session 0 is the services' session, which has a WinSta0 of its own but no signed-in user). A service's station
/// (`Service-0x0-<logon id>$`), session 0, an unreadable name, flag word or session fail closed: those cases were never measured, and the owner's supported configuration is a signed-in user.
pub(crate) fn may_make_home_desktop(station: &str, flags: i64, session: i64) -> Result<(), String> {
    if !station.eq_ignore_ascii_case(INTERACTIVE_STATION) { return Err(format!("refused: the launcher's window station is {station}, not the interactive {INTERACTIVE_STATION}; the home desktop is made only there")); }
    if flags < 0 { return Err("refused: the flags of the launcher's window station could not be read, so it is not known to be the visible station".into()); }
    if flags & 1 == 0 { return Err("refused: the launcher's window station is not marked visible (WSF_VISIBLE clear), so this is not a signed-in session's station".into()); }
    if session < 0 { return Err("refused: the launcher's session could not be read, so it is not known to be a signed-in user's session".into()); }
    if session == 0 { return Err("refused: the launcher runs in session 0 (the services' session, no signed-in user); the home desktop is made only in a signed-in user's session".into()); }
    Ok(())
}

/// The home desktop shares the user's window station (clipboard, atoms), so a run on it must have the job's UI limits on: without `--ui-limits` the run is refused (the backend always passes it). Err: the message.
pub(crate) fn home_needs_ui_limits(mode: WindowMode, ui_limits: bool) -> Result<(), String> {
    if mode == WindowMode::HomeDesktop && !ui_limits { return Err("window objects: refused: a run on the home desktop needs the job's UI limits (--ui-limits)".into()); }
    Ok(())
}

/// The name of one run's home desktop: 64 random bits, so two runs never share one; a name that already exists is refused, never adopted.
pub(crate) fn home_desktop_name(seed: u64) -> String { format!("nn-hd-{seed:016x}") }

/// A SID in its text form (S-1-<authority>-<sub-authorities>), or None when the bytes are not a SID.
pub(crate) fn sid_text(sid: &[u8]) -> Option<String> {
    if !sid_ok(sid) { return None; }
    let authority = u64::from_be_bytes([0, 0, sid[2], sid[3], sid[4], sid[5], sid[6], sid[7]]);
    let mut s = format!("S-1-{authority}");
    for i in 0..sid[1] as usize { s.push_str(&format!("-{}", u32::from_le_bytes([sid[8 + 4 * i], sid[9 + 4 * i], sid[10 + 4 * i], sid[11 + 4 * i]]))); }
    Some(s)
}

/// Groups that must never hold an allow entry on a private window object: Everyone, Anonymous, Network, Interactive, Authenticated Users, Guests, Users, and the two package groups.
const BROAD_SIDS: [&str; 9] = ["S-1-1-0", "S-1-5-7", "S-1-5-2", "S-1-5-4", "S-1-5-11", "S-1-5-32-546", "S-1-5-32-545", "S-1-15-2-1", "S-1-15-2-2"];

/// The principals besides the container that may hold an allow entry on a private window object whoever runs the launcher: SYSTEM, Administrators and OWNER RIGHTS (accounts that already
/// control the machine or the object). The launcher's own token user and owner are added by the caller. A logon-session SID (S-1-5-5-X-Y) is NOT accepted: the DACL the launcher gives the
/// objects at creation (`private_dacl`) holds none, and one of another logon session would let that session's processes in.
const ALWAYS_TRUSTED: [&str; 3] = ["S-1-5-18", "S-1-5-32-544", "S-1-3-4"];

/// Everything the launcher's own account and SYSTEM get on the private objects: the specific rights of the type plus STANDARD_RIGHTS_REQUIRED (DELETE, READ_CONTROL, WRITE_DAC, WRITE_OWNER),
/// no generic bits (so nothing is mapped when the descriptor is stored, and what is read back is what was written). A superset of the container's mask: an AppContainer's access is what both its
/// user and groups AND its package SID are granted, so the account's entry must cover the container's.
pub(crate) const STATION_FULL: u32 = 0x000F_037F;
pub(crate) const DESKTOP_FULL: u32 = 0x000F_01FF;

fn allow_ace(mask: u32, sid: &[u8]) -> Vec<u8> {
    let mut ace = vec![ACE_ALLOWED, 0];
    ace.extend(((8 + sid.len()) as u16).to_le_bytes());
    ace.extend(mask.to_le_bytes());
    ace.extend_from_slice(sid);
    ace
}

/// The DACL a private window station (`full` STATION_FULL, `mask` STATION_RIGHTS) or desktop (DESKTOP_FULL, DESKTOP_RIGHTS) is CREATED with: the launcher's own token user and SYSTEM with
/// `full`, the container with `mask`, all explicit, no inheritance flags, nothing else. Given in the SECURITY_ATTRIBUTES of the creating call, so there is no moment at which the object exists
/// with a default descriptor (Microsoft documents two different defaults for a NULL one: "grants GENERIC_ALL access to all users" on the CreateWindowStation page, "come from the primary or
/// impersonation token of the creator" on the window-station security page) and no DACL is written afterwards. None: a malformed SID, a container SID that is not one profile's, or a user that is
/// a broad group or a container.
pub(crate) fn private_dacl(user: &[u8], container: &[u8], mask: u32, full: u32) -> Option<Vec<u8>> {
    if !sid_ok(user) || mask & !full != 0 { return None; }
    let me = sid_text(container)?;
    let who = sid_text(user)?;
    if !is_profile_sid(&me) || BROAD_SIDS.contains(&who.as_str()) || who.starts_with("S-1-15-") { return None; }
    let system: [u8; 12] = [1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
    let mut entries = vec![allow_ace(full, user)];
    if user != system { entries.push(allow_ace(full, &system)); }
    entries.push(allow_ace(mask, container));
    let refs: Vec<&[u8]> = entries.iter().map(|e| &e[..]).collect();
    build_acl(2, &refs)
}

/// Is this the DACL a private window object may have? It is read back after the object was made, and the run does not start unless it passes. It is an ALLOW LIST: every entry is a plain allow or
/// deny entry (anything else, an object, callback, audit or label entry, is not understood, so refused; a deny entry can only take access away, so it is passed over); the container's SID holds
/// exactly ONE allow entry, with no flags at all (not inherited, not inherit-only, not inheritable) and exactly the expected mask; every other allow entry names SYSTEM, Administrators, OWNER
/// RIGHTS or one of `own` (the launcher's token user and owner). Anything else (Everyone, LOCAL, Domain Users, SERVICE, a logon session, another container or capability, another account) is
/// refused and named. A NULL DACL never reaches here (it is refused where the DACL is read).
pub(crate) fn private_acl_ok(acl: &[u8], container: &[u8], mask: u32, own: &[Vec<u8>]) -> Result<(), String> {
    let me = sid_text(container).ok_or("the container SID is not well formed")?;
    let (_, entries) = acl_entries(acl).ok_or("the DACL is not a well-formed ACL")?;
    let mut found = 0;
    for e in entries {
        if e[0] != ACE_ALLOWED && e[0] != ACE_DENIED { return Err(format!("an entry of type {} is not understood", e[0])); }
        if e.len() < 8 + 8 { return Err("an entry is too short to hold a SID".into()); }
        let sid = &e[8..];
        let sid = &sid[..(8 + 4 * sid[1].min(15) as usize).min(sid.len())];
        let text = sid_text(sid).ok_or("an entry holds a malformed SID")?;
        if e[0] == ACE_DENIED { continue; }
        if text == me {
            if e[1] != 0 || u32::from_le_bytes([e[4], e[5], e[6], e[7]]) != mask { return Err("the container's allow entry has flags (inherited or inheritance) or another mask".into()); }
            found += 1;
            continue;
        }
        // A broad group or another container is refused even when it is the launcher's own owner (it would not be "the launcher's own account" then).
        if BROAD_SIDS.contains(&text.as_str()) { return Err(format!("{text} holds an allow entry")); }
        if text.starts_with("S-1-15-") { return Err(format!("{text} (another container or capability) holds an allow entry")); }
        if ALWAYS_TRUSTED.contains(&text.as_str()) || own.iter().any(|o| o.as_slice() == sid) { continue; }
        return Err(format!("{text} holds an allow entry (only the container, the launcher's own account, SYSTEM, Administrators and OWNER RIGHTS may)"));
    }
    match found { 1 => Ok(()), 0 => Err("the container's entry is missing".into()), _ => Err("the container holds more than one allow entry".into()) }
}

/// Is this the SID string of one AppContainer profile (S-1-15-2 followed by exactly seven sub-authorities, the form DeriveAppContainerSidFromAppContainerName returns)? Not the group SIDs
/// ALL APPLICATION PACKAGES (S-1-15-2-1) or ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2), not a capability (S-1-15-3-...), not an account or a well-known group.
pub(crate) fn is_profile_sid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-15-2-") else { return false };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() == 7 && parts.iter().all(|p| !p.is_empty() && p.len() <= 10 && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u64>().is_ok_and(|v| v <= u32::MAX as u64))
}

/// The entries of a raw ACL (8-byte header: revision, Sbz1, AclSize, AceCount, Sbz2; each entry starts with type, flags and its size as a little-endian u16). None when the bytes are not a
/// well-formed ACL. Only the entries count; the slack after them (AclSize can be larger than what the entries use) does not.
pub(crate) fn acl_entries(acl: &[u8]) -> Option<(u8, Vec<&[u8]>)> {
    if acl.len() < 8 { return None; }
    let size = u16::from_le_bytes([acl[2], acl[3]]) as usize;
    let count = u16::from_le_bytes([acl[4], acl[5]]) as usize;
    if size < 8 || size > acl.len() { return None; }
    let mut at = 8;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if at + 4 > size { return None; }
        let len = u16::from_le_bytes([acl[at + 2], acl[at + 3]]) as usize;
        if len < 4 || at + len > size { return None; }
        out.push(&acl[at..at + len]);
        at += len;
    }
    Some((acl[0], out))
}

pub(crate) const ACE_ALLOWED: u8 = 0; // ACCESS_ALLOWED_ACE_TYPE
pub(crate) const ACE_DENIED: u8 = 1; // ACCESS_DENIED_ACE_TYPE
#[cfg(any(test, feature = "experiment"))] // the experiment's entry builder; the product creates its objects with their final DACL
pub(crate) const ACE_INHERITED: u8 = 0x10; // INHERITED_ACE
/// The largest ACL: AclSize is a 16-bit count of bytes and an ACL is a whole number of DWORDs.
pub(crate) const ACL_MAX: usize = 0xFFFC;

/// A SID in binary form (revision 1, at most 15 sub-authorities, 8 bytes plus 4 per sub-authority, exactly).
pub(crate) fn sid_ok(sid: &[u8]) -> bool { sid.len() >= 8 && sid[0] == 1 && sid[1] <= 15 && sid.len() == 8 + 4 * sid[1] as usize }

/// An ACL built from a revision and its entries, with no slack (None: too large, or an entry whose size is not a whole number of DWORDs).
pub(crate) fn build_acl(revision: u8, entries: &[&[u8]]) -> Option<Vec<u8>> {
    let size = 8 + entries.iter().map(|e| e.len()).sum::<usize>();
    if size > ACL_MAX || entries.len() > u16::MAX as usize || entries.iter().any(|e| e.len() % 4 != 0) { return None; }
    let mut v = Vec::with_capacity(size);
    v.extend([revision, 0]);
    v.extend((size as u16).to_le_bytes());
    v.extend((entries.len() as u16).to_le_bytes());
    v.extend([0, 0]);
    for e in entries { v.extend_from_slice(e); }
    Some(v)
}

/// Is this entry an explicit (not inherited) allow or deny entry for exactly this SID? (ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE: header, mask, then the SID at byte 8.)
#[cfg(any(test, feature = "experiment"))] // the experiment's entry builder; the product creates its objects with their final DACL
pub(crate) fn names_sid_explicitly(entry: &[u8], sid: &[u8]) -> bool {
    (entry[0] == ACE_ALLOWED || entry[0] == ACE_DENIED) && entry[1] & ACE_INHERITED == 0 && entry.len() >= 8 + sid.len() && &entry[8..8 + sid.len()] == sid
}

/// The ACL with ONE allow entry (no flags) for the SID added and nothing else changed: every existing entry keeps its bytes and its place relative to the others. The new entry goes where
/// SetEntriesInAclW documents that it puts a new allow entry, just before the first existing allow entry (so after the deny entries that lead the list), or last when there is none.
/// Unlike SetEntriesInAclW, nothing is merged, re-sorted or rewritten, so removing the entry again (`without_explicit_entries`) gives back exactly the entries that were there, whoever
/// removes it (this launcher at its end, or `desktop-revoke` after this launcher was killed). None: a malformed ACL or SID, an entry for the SID already present, or no room.
#[cfg(any(test, feature = "experiment"))] // the experiment's entry builder; the product creates its objects with their final DACL
pub(crate) fn with_allow_entry(acl: &[u8], sid: &[u8], mask: u32) -> Option<Vec<u8>> {
    if !sid_ok(sid) { return None; }
    let (revision, entries) = acl_entries(acl)?;
    if entries.iter().any(|e| names_sid_explicitly(e, sid)) { return None; }
    let mut ace = vec![ACE_ALLOWED, 0];
    ace.extend(((8 + sid.len()) as u16).to_le_bytes());
    ace.extend(mask.to_le_bytes());
    ace.extend_from_slice(sid);
    let at = entries.iter().position(|e| e[0] == ACE_ALLOWED).unwrap_or(entries.len());
    let mut out: Vec<&[u8]> = entries.clone();
    out.insert(at, &ace);
    build_acl(revision, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(auth: u8, subs: &[u32]) -> Vec<u8> {
        let mut v = vec![1, subs.len() as u8, 0, 0, 0, 0, 0, auth];
        for s in subs { v.extend(s.to_le_bytes()); }
        v
    }
    fn ace(kind: u8, flags: u8, mask: u32, sid: &[u8]) -> Vec<u8> {
        let mut v = vec![kind, flags];
        v.extend(((8 + sid.len()) as u16).to_le_bytes());
        v.extend(mask.to_le_bytes());
        v.extend_from_slice(sid);
        v
    }
    fn acl(entries: &[Vec<u8>]) -> Vec<u8> {
        let refs: Vec<&[u8]> = entries.iter().map(|e| &e[..]).collect();
        build_acl(2, &refs).unwrap()
    }
    fn container() -> Vec<u8> { sid(15, &[2, 11, 12, 13, 14, 15, 16, 17]) }

    #[test]
    fn the_masks_are_the_measured_ones_and_the_names_are_unique_and_plain() {
        assert_eq!(STATION_RIGHTS, 131967);
        assert_eq!(DESKTOP_RIGHTS, 131583);
        let (s, d) = private_names(0xdead_beef_0123_4567);
        assert_eq!((s.as_str(), d.as_str()), ("nn-ws-deadbeef01234567", "nn-d"));
        assert_ne!(private_names(1).0, private_names(2).0);
        assert_eq!(private_names(0).0, "nn-ws-0000000000000000", "always sixteen digits");
        assert_eq!(desktop_path(&s, &d), "nn-ws-deadbeef01234567\\nn-d");
        assert!(!desktop_path(&s, &d).to_ascii_lowercase().contains("winsta0"), "never the interactive station");
        for name in [&s, &d] { assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')); }
    }

    #[test]
    fn the_mode_names_are_the_ones_the_backend_reads() {
        assert_eq!(WindowMode::Private.name(), "private");
        assert_eq!(WindowMode::HomeDesktop.name(), "home-desktop");
    }

    #[test]
    fn the_home_desktop_is_tried_only_for_a_non_elevated_launcher_refused_with_error_5() {
        assert!(try_home_desktop(Some(false), 5), "the owner's measured case");
        assert!(!try_home_desktop(Some(true), 5), "an elevated launcher that was refused is a failure, not a reason to change mode");
        assert!(!try_home_desktop(None, 5), "a launcher whose elevation could not be read is not known to be non-elevated: no change of mode");
        for other in [0u32, 1, 2, 6, 87, 1314, 0x2000_0006] { assert!(!try_home_desktop(Some(false), other), "error {other} is not the documented refusal"); }
        assert_eq!(ERROR_STATION_REFUSED, 5);
    }

    #[test]
    fn the_home_desktop_is_made_only_on_the_visible_interactive_station() {
        assert_eq!(may_make_home_desktop("WinSta0", 1, 1), Ok(()));
        assert_eq!(may_make_home_desktop("winsta0", 1, 1), Ok(()), "the name is not case sensitive");
        assert_eq!(may_make_home_desktop("WinSta0", 0x3, 2), Ok(()), "other flag bits and another signed-in session do not matter");
        for (station, flags) in [("Service-0x0-3e7$", 1), ("nn-ws-0000000000000000", 1), ("?", 1), ("", 1), ("WinSta1", 1), ("WinSta0x", 1), ("WinSta0\\Default", 1), ("WinSta0\0", 1)] {
            assert!(may_make_home_desktop(station, flags, 1).unwrap_err().contains("not the interactive"), "{station}");
        }
        assert!(may_make_home_desktop("WinSta0", -1, 1).unwrap_err().contains("could not be read"));
        assert!(may_make_home_desktop("WinSta0", 0, 1).unwrap_err().contains("not marked visible"));
        assert!(may_make_home_desktop("WinSta0", 2, 1).unwrap_err().contains("not marked visible"));
        assert!(may_make_home_desktop("WinSta0", 1, 0).unwrap_err().contains("session 0"), "the services' session has a visible WinSta0 but no signed-in user");
        assert!(may_make_home_desktop("WinSta0", 1, -1).unwrap_err().contains("session could not be read"));
    }

    #[test]
    fn a_home_desktop_run_needs_the_ui_limits_and_a_private_station_run_is_as_before() {
        assert!(home_needs_ui_limits(WindowMode::HomeDesktop, false).unwrap_err().contains("--ui-limits"));
        assert_eq!(home_needs_ui_limits(WindowMode::HomeDesktop, true), Ok(()));
        assert_eq!(home_needs_ui_limits(WindowMode::Private, false), Ok(()), "the named-station path is unchanged");
        assert_eq!(home_needs_ui_limits(WindowMode::Private, true), Ok(()));
    }

    #[test]
    fn the_home_desktop_name_is_unique_plain_and_never_the_users_own_desktop() {
        assert_eq!(home_desktop_name(0xdead_beef_0123_4567), "nn-hd-deadbeef01234567");
        assert_eq!(home_desktop_name(0), "nn-hd-0000000000000000");
        assert_ne!(home_desktop_name(1), home_desktop_name(2));
        assert!(!home_desktop_name(7).eq_ignore_ascii_case("default"));
        let lp = desktop_path(INTERACTIVE_STATION, &home_desktop_name(0xab));
        assert_eq!(lp, "WinSta0\\nn-hd-00000000000000ab");
    }

    #[test]
    fn the_home_desktop_takes_the_same_creation_list_and_read_back_as_the_private_desktop() {
        let me = container();
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let d = private_dacl(&user, &me, DESKTOP_RIGHTS, DESKTOP_FULL).unwrap();
        assert_eq!(private_acl_ok(&d, &me, DESKTOP_RIGHTS, &[user.clone()]), Ok(()));
        // a Default-desktop style entry (ALL APPLICATION PACKAGES holding 0xf00ff) is NOT acceptable on a made object: nothing inherits it
        let mut tainted = acl_entries(&d).unwrap().1.iter().map(|e| e.to_vec()).collect::<Vec<_>>();
        tainted.push(ace(0, 0, 0xf00ff, &sid(15, &[2, 1])));
        assert!(private_acl_ok(&acl(&tainted), &me, DESKTOP_RIGHTS, &[user]).unwrap_err().contains("S-1-15-2-1"));
    }

    #[test]
    fn a_sid_is_written_as_text_the_way_windows_does() {
        assert_eq!(sid_text(&sid(1, &[0])).unwrap(), "S-1-1-0");
        assert_eq!(sid_text(&sid(5, &[32, 545])).unwrap(), "S-1-5-32-545");
        assert_eq!(sid_text(&container()).unwrap(), "S-1-15-2-11-12-13-14-15-16-17");
        assert_eq!(sid_text(&sid(5, &[18])).unwrap(), "S-1-5-18");
        assert!(is_profile_sid(&sid_text(&container()).unwrap()), "the same text the profile check takes");
        assert!(sid_text(&[1, 2, 0, 0, 0, 0, 0, 5, 1, 0, 0, 0]).is_none(), "shorter than its sub-authority count");
        assert!(sid_text(&[]).is_none());
        let mut v = sid(5, &[18]); v[0] = 2;
        assert!(sid_text(&v).is_none(), "revision");
    }

    #[test]
    fn the_private_dacl_is_the_creators_own_entries_plus_the_container_with_the_exact_mask_and_nothing_broad() {
        let me = container();
        let system = sid(5, &[18]);
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let own = vec![user.clone()];
        let mine = ace(0, 0, STATION_RIGHTS, &me);
        let base = [ace(0, 0, 0x37f, &system), ace(0, 0, 0x37f, &user)];
        let good: Vec<Vec<u8>> = std::iter::once(mine.clone()).chain(base.iter().cloned()).collect();
        assert_eq!(private_acl_ok(&acl(&good), &me, STATION_RIGHTS, &own), Ok(()));
        // a deny entry for a broad group is not an allow
        let mut with_deny = good.clone(); with_deny.push(ace(1, 0, 1, &sid(1, &[0])));
        assert_eq!(private_acl_ok(&acl(&with_deny), &me, STATION_RIGHTS, &own), Ok(()));
        // the container entry is required, with exactly the measured mask, and explicit
        assert!(private_acl_ok(&acl(&base), &me, STATION_RIGHTS, &own).is_err(), "no entry for the container");
        assert!(private_acl_ok(&acl(&good), &me, DESKTOP_RIGHTS, &own).is_err(), "another mask");
        let inherited = [ace(0, 0x10, STATION_RIGHTS, &me), base[0].clone()];
        assert!(private_acl_ok(&acl(&inherited), &me, STATION_RIGHTS, &own).is_err(), "an inherited entry is not the launcher's");
        // broad groups, other containers and capabilities: refused
        for (name, broad) in [("Everyone", sid(1, &[0])), ("Anonymous", sid(5, &[7])), ("Network", sid(5, &[2])), ("Interactive", sid(5, &[4])), ("Authenticated Users", sid(5, &[11])), ("Guests", sid(5, &[32, 546])),
            ("Users", sid(5, &[32, 545])), ("ALL APPLICATION PACKAGES", sid(15, &[2, 1])), ("ALL RESTRICTED APPLICATION PACKAGES", sid(15, &[2, 2])),
            ("another container", sid(15, &[2, 11, 12, 13, 14, 15, 16, 18])), ("a capability", sid(15, &[3, 1024, 1, 2, 3, 4, 5, 6]))] {
            let mut bad = good.clone(); bad.push(ace(0, 0, 1, &broad));
            let e = private_acl_ok(&acl(&bad), &me, STATION_RIGHTS, &own).expect_err(name);
            assert!(e.contains("allow entry"), "{name}: {e}");
        }
        // an entry kind this code does not understand (a callback or object entry), a malformed list, a malformed SID, a short entry
        let mut odd = good.clone(); odd.push(ace(9, 0, 1, &system));
        assert!(private_acl_ok(&acl(&odd), &me, STATION_RIGHTS, &own).unwrap_err().contains("type 9"));
        assert!(private_acl_ok(&[2, 0, 8], &me, STATION_RIGHTS, &own).is_err());
        assert!(private_acl_ok(&acl(&good), &[1, 1, 0], STATION_RIGHTS, &own).is_err());
        let mut short = good.clone(); short.push(vec![0, 0, 8, 0, 1, 0, 0, 0]);
        assert!(private_acl_ok(&acl(&short), &me, STATION_RIGHTS, &own).is_err());
        let mut badsid = good.clone(); badsid.push(ace(0, 0, 1, &[1, 3, 0, 0, 0, 0, 0, 5, 1, 0, 0, 0, 1, 0, 0, 0]));
        assert!(private_acl_ok(&acl(&badsid), &me, STATION_RIGHTS, &own).is_err());
    }

    #[test]
    fn the_read_back_is_an_allow_list_of_the_launchers_own_principals() {
        let me = container();
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let own = vec![user.clone()];
        let mine = ace(0, 0, STATION_RIGHTS, &me);
        let with = |extra: Vec<u8>| acl(&[mine.clone(), ace(0, 0, 0x37f, &sid(5, &[18])), extra]);
        // what default token DACLs hold: the account itself, SYSTEM, Administrators, OWNER RIGHTS, the logon session
        for (name, ok) in [("own user", user.clone()), ("Administrators", sid(5, &[32, 544])), ("OWNER RIGHTS", sid(3, &[4]))] {
            assert_eq!(private_acl_ok(&with(ace(0, 0, 0xa0000000, &ok)), &me, STATION_RIGHTS, &own), Ok(()), "{name}");
        }
        // groups a deny list easily misses, and any other account: refused and named
        for (name, other) in [("LOCAL", sid(2, &[0])), ("CONSOLE LOGON", sid(2, &[1])), ("SERVICE", sid(5, &[6])), ("BATCH", sid(5, &[3])), ("Domain Users", sid(5, &[21, 1, 2, 3, 513])),
            ("another account", sid(5, &[21, 1, 2, 3, 1002])), ("ALL SERVICES", sid(5, &[80, 0])), ("NTLM authentication", sid(5, &[64, 10])), ("a logon SID of another shape", sid(5, &[5, 1])),
            ("a logon session (the creation DACL holds none; another session's would let it in)", sid(5, &[5, 0, 5814400]))] {
            let e = private_acl_ok(&with(ace(0, 0, 1, &other)), &me, STATION_RIGHTS, &own).expect_err(name);
            assert!(e.contains(&sid_text(&other).unwrap()) && e.contains("allow entry"), "{name}: {e}");
        }
        // with no own principal given, the account's entry is not trusted either
        assert!(private_acl_ok(&with(ace(0, 0, 1, &user)), &me, STATION_RIGHTS, &[]).is_err());
        // a broad group stays refused even when it is passed as the launcher's own (an owner that is Everyone is not "the launcher's own account")
        assert!(private_acl_ok(&with(ace(0, 0, 1, &sid(1, &[0]))), &me, STATION_RIGHTS, &[sid(1, &[0])]).is_err());
        // exactly one entry for the container: a second one (another mask, or the same) is refused
        assert!(private_acl_ok(&with(ace(0, 0, 0x10000000, &me)), &me, STATION_RIGHTS, &own).unwrap_err().contains("flags (inherited or inheritance) or another mask"));
        // the container's entry carries no flags at all: inherit-only (it would not apply to the object), object or container inherit (it would spread to desktops made later)
        for flags in [0x08u8, 0x01, 0x02, 0x04, 0x03] {
            let e = private_acl_ok(&acl(&[ace(0, flags, STATION_RIGHTS, &me), ace(0, 0, 0x37f, &sid(5, &[18]))]), &me, STATION_RIGHTS, &own).expect_err("flags");
            assert!(e.contains("flags"), "{flags:#x}: {e}");
        }
        assert!(private_acl_ok(&with(mine.clone()), &me, STATION_RIGHTS, &own).unwrap_err().contains("more than one"));
        // the creation flag that refuses an existing station
        assert_eq!(STATION_CREATE_ONLY, 1);
    }

    #[test]
    fn the_creation_dacl_is_the_account_system_and_the_container_and_passes_its_own_check() {
        let me = container();
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let system = sid(5, &[18]);
        for (mask, full) in [(STATION_RIGHTS, STATION_FULL), (DESKTOP_RIGHTS, DESKTOP_FULL)] {
            let d = private_dacl(&user, &me, mask, full).unwrap();
            assert_eq!(d, acl(&[ace(0, 0, full, &user), ace(0, 0, full, &system), ace(0, 0, mask, &me)]), "byte for byte");
            assert_eq!(private_acl_ok(&d, &me, mask, &[user.clone()]), Ok(()));
            assert!(private_acl_ok(&d, &me, mask, &[]).is_err(), "the account's own entry needs the account passed in");
            assert_eq!(mask & !full, 0, "the account's entry covers the container's (an AppContainer gets what both are granted)");
            assert_eq!(full & 0xF000_0000, 0, "no generic bits: nothing is mapped when stored");
        }
        assert_eq!((STATION_FULL, DESKTOP_FULL), (0xF037F, 0xF01FF));
        // run as LocalSystem: the account is SYSTEM, one entry for it, not two
        let d = private_dacl(&system, &me, STATION_RIGHTS, STATION_FULL).unwrap();
        assert_eq!(acl_entries(&d).unwrap().1.len(), 2);
        assert_eq!(private_acl_ok(&d, &me, STATION_RIGHTS, &[system.clone()]), Ok(()));
        // refused: a container SID that is not a profile's, a broad or container account, a malformed SID, a container mask wider than the account's
        assert!(private_dacl(&user, &sid(15, &[2, 1]), STATION_RIGHTS, STATION_FULL).is_none());
        assert!(private_dacl(&user, &user, STATION_RIGHTS, STATION_FULL).is_none());
        for bad in [sid(1, &[0]), sid(5, &[11]), sid(15, &[2, 11, 12, 13, 14, 15, 16, 18]), vec![1, 2, 0]] {
            assert!(private_dacl(&bad, &me, STATION_RIGHTS, STATION_FULL).is_none(), "{bad:?}");
        }
        assert!(private_dacl(&user, &me, STATION_RIGHTS | 0x1000_0000, STATION_FULL).is_none());
    }

    #[test]
    fn the_entry_the_launcher_adds_passes_the_check_on_a_creator_only_dacl() {
        let me = container();
        let system = sid(5, &[18]);
        let user = sid(5, &[21, 1, 2, 3, 1001]);
        let own = vec![user.clone()];
        let before = acl(&[ace(0, 0, 0x37f, &system), ace(0, 0, 0x37f, &user)]);
        let after = with_allow_entry(&before, &me, STATION_RIGHTS).unwrap();
        assert_eq!(private_acl_ok(&after, &me, STATION_RIGHTS, &own), Ok(()));
        assert_eq!(acl_entries(&after).unwrap().1.len(), 3);
        // the same entry cannot be added twice, and an Everyone entry already in the default DACL is caught by the check, not hidden by the add
        assert!(with_allow_entry(&after, &me, STATION_RIGHTS).is_none());
        let everyone = with_allow_entry(&acl(&[ace(0, 0, 0x37f, &sid(1, &[0]))]), &me, STATION_RIGHTS).unwrap();
        assert!(private_acl_ok(&everyone, &me, STATION_RIGHTS, &own).is_err());
    }
}
