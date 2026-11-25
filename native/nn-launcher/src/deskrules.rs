// Round 5 of the Windows AppContainer experiment (EXPERIMENT build and tests only; not compiled into the product launcher): the pure rules desk.rs follows before and after it writes the DACL
// of a window station or desktop. They are kept apart from the Win32 calls so they are tested on every platform.

/// WSF_VISIBLE in USEROBJECTFLAGS.dwFlags: only the interactive window station has it.
pub(crate) const WSF_VISIBLE: i64 = 1;

/// May the launcher add an entry to the DACL of the window station it runs in (and of that station's desktop)? Only a non-interactive station whose flags could be read and that is not WinSta0:
/// the interactive station belongs to the signed-in user's session, and nothing in this experiment needs to change it.
pub(crate) fn may_change_launcher_objects(station: &str, flags: i64) -> Result<(), String> {
    if station.eq_ignore_ascii_case("winsta0") { return Err(format!("refused: the launcher runs in the interactive window station {station}; entries are added only to a non-interactive (service) station")); }
    if flags < 0 { return Err(format!("refused: the flags of the window station {station} could not be read, so it is not known to be non-interactive")); }
    if flags & WSF_VISIBLE != 0 { return Err(format!("refused: the window station {station} is visible (interactive); entries are added only to a non-interactive (service) station")); }
    if station.is_empty() || station == "?" { return Err("refused: the name of the launcher's window station could not be read".into()); }
    Ok(())
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

const ACE_ALLOWED: u8 = 0; // ACCESS_ALLOWED_ACE_TYPE
const ACE_DENIED: u8 = 1; // ACCESS_DENIED_ACE_TYPE
const ACE_INHERITED: u8 = 0x10; // INHERITED_ACE
/// The largest ACL: AclSize is a 16-bit count of bytes and an ACL is a whole number of DWORDs.
const ACL_MAX: usize = 0xFFFC;

/// A SID in binary form (revision 1, at most 15 sub-authorities, 8 bytes plus 4 per sub-authority, exactly).
pub(crate) fn sid_ok(sid: &[u8]) -> bool { sid.len() >= 8 && sid[0] == 1 && sid[1] <= 15 && sid.len() == 8 + 4 * sid[1] as usize }

/// An ACL built from a revision and its entries, with no slack (None: too large, or an entry whose size is not a whole number of DWORDs).
fn build_acl(revision: u8, entries: &[&[u8]]) -> Option<Vec<u8>> {
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
fn names_sid_explicitly(entry: &[u8], sid: &[u8]) -> bool {
    (entry[0] == ACE_ALLOWED || entry[0] == ACE_DENIED) && entry[1] & ACE_INHERITED == 0 && entry.len() >= 8 + sid.len() && &entry[8..8 + sid.len()] == sid
}

/// The ACL with ONE allow entry (no flags) for the SID added and nothing else changed: every existing entry keeps its bytes and its place relative to the others. The new entry goes where
/// SetEntriesInAclW documents that it puts a new allow entry, just before the first existing allow entry (so after the deny entries that lead the list), or last when there is none.
/// Unlike SetEntriesInAclW, nothing is merged, re-sorted or rewritten, so removing the entry again (`without_explicit_entries`) gives back exactly the entries that were there, whoever
/// removes it (this launcher at its end, or `desktop-revoke` after this launcher was killed). None: a malformed ACL or SID, an entry for the SID already present, or no room.
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

/// The ACL without any explicit allow or deny entry for the SID (inherited ones and every other entry kept in order), and how many were taken out. None: a malformed ACL or SID.
pub(crate) fn without_explicit_entries(acl: &[u8], sid: &[u8]) -> Option<(Vec<u8>, usize)> {
    if !sid_ok(sid) { return None; }
    let (revision, entries) = acl_entries(acl)?;
    let kept: Vec<&[u8]> = entries.iter().copied().filter(|e| !names_sid_explicitly(e, sid)).collect();
    let removed = entries.len() - kept.len();
    Some((build_acl(revision, &kept)?, removed))
}

/// How the DACL after the revoke compares with the one read before the grant. Nothing is ever written back from the copy: the result is reported only.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum AclCompare {
    /// The same entries in the same order.
    Same,
    /// The same entries in another order (something else rewrote the DACL meanwhile; this launcher's own insert and removal keep the order). Reported, not written.
    Reordered,
    /// Entries differ (someone else changed the DACL meanwhile, or an entry was not removed): reported, not written.
    Different,
}

pub(crate) fn compare_acls(before: &[u8], after: &[u8]) -> AclCompare {
    let (Some((rb, eb)), Some((ra, ea))) = (acl_entries(before), acl_entries(after)) else { return AclCompare::Different };
    if rb != ra || eb.len() != ea.len() { return AclCompare::Different; }
    if eb == ea { return AclCompare::Same; }
    let mut sb = eb.clone();
    let mut sa = ea.clone();
    sb.sort();
    sa.sort();
    if sb == sa { AclCompare::Reordered } else { AclCompare::Different }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ace(kind: u8, flags: u8, mask: u32, sid_tail: u8) -> Vec<u8> {
        // header (4) + mask (4) + a SID of revision 1, one sub-authority (12 bytes)
        let mut v = vec![kind, flags, 20, 0];
        v.extend(mask.to_le_bytes());
        v.extend([1, 1, 0, 0, 0, 0, 0, 5, sid_tail, 0, 0, 0]);
        v
    }
    fn acl(entries: &[Vec<u8>], slack: usize) -> Vec<u8> {
        let used: usize = 8 + entries.iter().map(Vec::len).sum::<usize>();
        let size = used + slack;
        let mut v = vec![2, 0];
        v.extend((size as u16).to_le_bytes());
        v.extend((entries.len() as u16).to_le_bytes());
        v.extend([0, 0]);
        for e in entries { v.extend(e); }
        v.resize(size, 0xEE);
        v
    }

    #[test]
    fn only_a_non_interactive_station_whose_flags_were_read_may_be_changed() {
        assert!(may_change_launcher_objects("Service-0x0-3e7$", 0).is_ok());
        assert!(may_change_launcher_objects("Service-0x0-3e4$", 0).is_ok());
        for (name, flags) in [("WinSta0", 0), ("winsta0", 0), ("WINSTA0", 1), ("Service-0x0-3e7$", 1), ("Service-0x0-3e7$", 3), ("Service-0x0-3e7$", -1), ("Service-0x0-3e7$", -2), ("?", 0), ("", 0)] {
            let e = may_change_launcher_objects(name, flags).expect_err(name);
            assert!(e.starts_with("refused:"), "{name} {flags}: {e}");
        }
    }

    #[test]
    fn only_the_sid_of_one_profile_is_accepted() {
        assert!(is_profile_sid("S-1-15-2-1234567890-1-2-3-4-5-4294967295"));
        for bad in ["S-1-15-2-1", "S-1-15-2-2", "S-1-1-0", "S-1-5-32-545", "S-1-5-18", "S-1-15-3-1024-1-2-3-4-5-6", "S-1-5-21-1-2-3-1001", "S-1-15-2-1-2-3-4-5-6", "S-1-15-2-1-2-3-4-5-6-7-8",
            "S-1-15-2-1-2-3-4-5-6-x", "S-1-15-2-1-2-3-4-5-6-", "S-1-15-2-1-2-3-4-5-6-4294967296", "s-1-15-2-1-2-3-4-5-6-7", ""] {
            assert!(!is_profile_sid(bad), "{bad}");
        }
    }

    #[test]
    fn acl_entries_reads_the_entries_and_ignores_the_slack() {
        let a = ace(0, 0, 0x37f, 7);
        let b = ace(0, 0, 0x2_0000, 18);
        let raw = acl(&[a.clone(), b.clone()], 16);
        let (rev, e) = acl_entries(&raw).unwrap();
        assert_eq!(rev, 2);
        assert_eq!(e, vec![&a[..], &b[..]]);
        assert_eq!(acl_entries(&acl(&[], 0)).unwrap().1.len(), 0);
        // malformed: too short, a size larger than the buffer, an entry that runs past the end, an entry size below its header
        assert!(acl_entries(&[2, 0, 8]).is_none());
        let mut big = raw.clone(); big[2] = 0xFF; big[3] = 0xFF;
        assert!(acl_entries(&big).is_none());
        let mut count = raw.clone(); count[4] = 9;
        assert!(acl_entries(&count).is_none());
        let mut tiny = raw.clone(); tiny[8 + 2] = 2; tiny[8 + 3] = 0;
        assert!(acl_entries(&tiny).is_none());
    }

    #[test]
    fn the_dacl_after_the_revoke_is_compared_entry_by_entry_with_the_one_before() {
        let sy = ace(0, 0, 0x37f, 18);
        let logon = ace(0, 0, 0x37f, 5);
        let deny = ace(1, 0, 0x40, 9);
        let inherit_only = ace(0, 0x0B, 0x1ff, 18);
        let before = acl(&[sy.clone(), logon.clone(), inherit_only.clone()], 0);
        assert_eq!(compare_acls(&before, &before), AclCompare::Same);
        assert_eq!(compare_acls(&before, &acl(&[sy.clone(), logon.clone(), inherit_only.clone()], 40)), AclCompare::Same, "only the slack differs");
        assert_eq!(compare_acls(&before, &acl(&[logon.clone(), sy.clone(), inherit_only.clone()], 0)), AclCompare::Reordered);
        // an entry lost, one added, one changed, the inheritance flags dropped, another revision: never written back
        assert_eq!(compare_acls(&before, &acl(&[sy.clone(), logon.clone()], 0)), AclCompare::Different);
        assert_eq!(compare_acls(&before, &acl(&[sy.clone(), logon.clone(), inherit_only.clone(), deny.clone()], 0)), AclCompare::Different);
        assert_eq!(compare_acls(&before, &acl(&[sy.clone(), ace(0, 0, 0x37e, 5), inherit_only.clone()], 0)), AclCompare::Different);
        assert_eq!(compare_acls(&before, &acl(&[sy.clone(), logon.clone(), ace(0, 0, 0x1ff, 18)], 0)), AclCompare::Different);
        let mut rev4 = before.clone(); rev4[0] = 4;
        assert_eq!(compare_acls(&before, &rev4), AclCompare::Different);
        assert_eq!(compare_acls(&before, &[0u8; 4]), AclCompare::Different, "a malformed read is never Same");
        // the same entry twice is not the same as two different ones in another order
        assert_eq!(compare_acls(&acl(&[sy.clone(), sy.clone()], 0), &acl(&[sy.clone(), logon.clone()], 0)), AclCompare::Different);
    }

    // A container SID in binary form: revision 1, 7 sub-authorities, authority 15 (S-1-15-2-...).
    fn container_sid(tail: u8) -> Vec<u8> {
        let mut v = vec![1, 7, 0, 0, 0, 0, 0, 15];
        v.extend(2u32.to_le_bytes());
        for i in 0..6u32 { v.extend((1000 + i + tail as u32).to_le_bytes()); }
        v
    }
    fn sid_ace(kind: u8, flags: u8, mask: u32, sid: &[u8]) -> Vec<u8> {
        let mut v = vec![kind, flags];
        v.extend(((8 + sid.len()) as u16).to_le_bytes());
        v.extend(mask.to_le_bytes());
        v.extend_from_slice(sid);
        v
    }

    #[test]
    fn the_entry_is_added_without_changing_any_other_entry_and_removing_it_gives_back_the_same_entries() {
        let me = container_sid(0);
        let other = container_sid(1);
        let deny = ace(1, 0, 0x40, 9);
        let sy = ace(0, 0, 0x37f, 18);
        let inherit_only = ace(0, 0x0B, 0x1ff, 18);
        let logon = ace(0, 0, 0x37f, 5);
        // a list that is not in the canonical order (an allow before a deny): kept exactly as it is
        let before = acl(&[deny.clone(), sy.clone(), inherit_only.clone(), ace(1, 0, 0x2, 7), logon.clone(), sid_ace(0, 0, 0x1, &other)], 12);
        let with = with_allow_entry(&before, &me, 0x2_037f).expect("added");
        let (rev, e) = acl_entries(&with).unwrap();
        assert_eq!(rev, 2);
        assert_eq!(e.len(), 7);
        // where SetEntriesInAclW documents a new allow entry: before the first allow entry, after the leading deny
        assert_eq!(e[0], &deny[..]);
        assert_eq!(e[1], &sid_ace(0, 0, 0x2_037f, &me)[..]);
        assert_eq!(e[2..].to_vec(), acl_entries(&before).unwrap().1[1..].to_vec(), "every other entry unchanged, in its order");
        assert_eq!(u16::from_le_bytes([with[2], with[3]]) as usize, with.len(), "AclSize is the bytes used");
        let (back, n) = without_explicit_entries(&with, &me).unwrap();
        assert_eq!(n, 1);
        assert_eq!(compare_acls(&before, &back), AclCompare::Same);
        // no allow entry at all: the new one goes last; an empty ACL gets just the one
        let denies = acl(&[deny.clone()], 0);
        assert_eq!(acl_entries(&with_allow_entry(&denies, &me, 1).unwrap()).unwrap().1[1], &sid_ace(0, 0, 1, &me)[..]);
        assert_eq!(acl_entries(&with_allow_entry(&acl(&[], 0), &me, 1).unwrap()).unwrap().1.len(), 1);
        // the revision of the ACL is kept (ACL_REVISION_DS stays 4)
        let mut ds = before.clone(); ds[0] = 4;
        assert_eq!(with_allow_entry(&ds, &me, 1).unwrap()[0], 4);
    }

    #[test]
    fn nothing_is_added_to_a_malformed_list_or_next_to_an_entry_already_there() {
        let me = container_sid(0);
        let base = acl(&[ace(0, 0, 0x37f, 18)], 0);
        assert!(with_allow_entry(&[2, 0, 8], &me, 1).is_none(), "malformed ACL");
        assert!(with_allow_entry(&base, &me[..me.len() - 4], 1).is_none(), "SID shorter than its sub-authority count");
        let mut bad_rev = me.clone(); bad_rev[0] = 2;
        assert!(with_allow_entry(&base, &bad_rev, 1).is_none(), "SID revision");
        assert!(with_allow_entry(&acl(&[sid_ace(0, 0, 1, &me)], 0), &me, 1).is_none(), "an explicit allow for the SID is already there");
        assert!(with_allow_entry(&acl(&[sid_ace(1, 0, 1, &me)], 0), &me, 1).is_none(), "an explicit deny for the SID is already there");
        // an inherited entry for the SID is not this launcher's: it does not block, and the removal keeps it
        let inh = acl(&[sid_ace(0, 0x10, 1, &me), ace(0, 0, 0x37f, 18)], 0);
        let with = with_allow_entry(&inh, &me, 2).unwrap();
        let (back, n) = without_explicit_entries(&with, &me).unwrap();
        assert_eq!((n, compare_acls(&inh, &back)), (1, AclCompare::Same));
        // too large for an ACL: refused, not cut short
        let big: Vec<Vec<u8>> = (0..3275).map(|i| ace(0, 0, i, 18)).collect();
        let full = acl(&big, 0);
        assert!(acl_entries(&full).is_some());
        assert!(with_allow_entry(&full, &me, 1).is_none());
    }

    #[test]
    fn the_removal_takes_out_only_explicit_entries_for_exactly_this_sid() {
        let me = container_sid(0);
        let other = container_sid(1);
        let entries = [sid_ace(0, 0, 1, &me), sid_ace(0, 0, 1, &other), sid_ace(1, 0, 2, &me), sid_ace(0, 0x10, 4, &me), ace(0, 0, 0x37f, 18), sid_ace(0, 0x02, 8, &me)];
        let (out, n) = without_explicit_entries(&acl(&entries, 4), &me).unwrap();
        assert_eq!(n, 3, "allow, deny and a container-inherit allow for the SID; not the inherited one");
        assert_eq!(acl_entries(&out).unwrap().1, vec![&entries[1][..], &entries[3][..], &entries[4][..]]);
        let (same, none) = without_explicit_entries(&acl(&entries[1..2], 0), &me).unwrap();
        assert_eq!((none, compare_acls(&acl(&entries[1..2], 0), &same)), (0, AclCompare::Same));
        assert!(without_explicit_entries(&[0u8; 3], &me).is_none());
    }
}
