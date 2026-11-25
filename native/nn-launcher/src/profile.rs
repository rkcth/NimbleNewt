// The pure rules of the per-run container profile (card A03b, per-run profile slice). Platform-neutral (no Win32 call), so it is compiled and unit-tested on every operating system.
//
// Every run of the product launcher makes its OWN AppContainer profile, named `NimbleNewtRun-<16 lower-case hex digits>` (30 characters, inside the 64 that CreateAppContainerProfile allows and
// inside its pattern `[-_. A-Za-z0-9]+`). The backend (TypeScript) chooses the name; the launcher only validates it. The launcher may delete a profile ONLY when it can prove it made it: the name has
// this exact form AND a record file (`--profile-record PATH`, in the supervisor's control folder, which no container can write) holds the same name and the SID that
// DeriveAppContainerSidFromAppContainerName gives for that name. The record is written (create-new) BEFORE the profile is made, so a crash between the two leaves a record without a profile
// (harmless: deleting a profile that does not exist succeeds), never a profile without a record. Nothing here scans the machine's profile list or the registry.

/// The only prefix the product launcher accepts for a container profile.
pub(crate) const RUN_PREFIX: &str = "NimbleNewtRun-";
/// Hexadecimal digits after the prefix (64 random bits, chosen by the backend).
pub(crate) const RUN_HEX_LEN: usize = 16;
/// The first line of a record file; the version is part of the proof.
const RECORD_TAG: &str = "nn-run-profile v1";

/// `NimbleNewtRun-` followed by exactly sixteen lower-case hexadecimal digits: the product's only profile name. Nothing else (another prefix, upper-case digits, a longer or shorter suffix,
/// a trailing space or dot) passes.
pub(crate) fn is_run_name(name: &str) -> bool {
    match name.strip_prefix(RUN_PREFIX) {
        Some(hex) => hex.len() == RUN_HEX_LEN && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

/// An AppContainer SID in its string form: `S-1-15-2` and seven more decimal sub-authorities (the package SID layout: SECURITY_APP_PACKAGE_BASE_RID, then seven). Used to cross-check a `--sid`
/// the backend passes (it never selects anything by itself: the SID is always derived from the validated name and compared).
pub(crate) fn is_app_sid_text(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-15-2") else { return false };
    let parts: Vec<&str> = rest.split('-').collect();
    // `rest` starts with "-", so the first piece is empty
    parts.len() == 8 && parts[0].is_empty() && parts[1..].iter().all(|p| !p.is_empty() && p.len() <= 10 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The text of a record file: tag line, then `name SID`.
pub(crate) fn format_record(name: &str, sid: &str) -> String { format!("{RECORD_TAG}\n{name} {sid}\n") }

/// The name and SID of a record file, or None when it is not exactly the format above (a tag line, one `name SID` line, nothing else of substance; a trailing newline is fine).
pub(crate) fn parse_record(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    if lines.next()? != RECORD_TAG { return None; }
    let body = lines.next()?;
    if lines.any(|l| !l.is_empty()) { return None; }
    let (name, sid) = body.split_once(' ')?;
    if !is_run_name(name) || !is_app_sid_text(sid) { return None; }
    Some((name.to_string(), sid.to_string()))
}

/// Whether a profile may be deleted: the name is a run name, the record parses, its name is this name, its SID is the SID derived from the name now, and (when the caller passed one) the SID given on
/// the command line is the same. The error says which part failed. `derived` is the string form of the derived SID.
pub(crate) fn may_delete(name: &str, record_text: Option<&str>, derived: &str, given_sid: Option<&str>) -> Result<(), String> {
    if !is_run_name(name) { return Err(format!("{name:?} is not a per-run profile name ({RUN_PREFIX}<{RUN_HEX_LEN} hex digits>): nothing is deleted")); }
    let Some(text) = record_text else { return Err("there is no record of this profile in the control folder, so it is not proven to be this launcher's: nothing is deleted".into()) };
    let Some((rec_name, rec_sid)) = parse_record(text) else { return Err("the profile record is not in the launcher's format: nothing is deleted".into()) };
    if rec_name != name { return Err("the profile record names another profile: nothing is deleted".into()); }
    if rec_sid != derived { return Err("the SID in the profile record is not the SID of this name: nothing is deleted".into()); }
    if let Some(s) = given_sid { if s != derived { return Err("the SID given is not the SID of this name: nothing is deleted".into()); } }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SID: &str = "S-1-15-2-1-2-3-4-5-6-7";

    #[test]
    fn run_names_are_the_prefix_and_sixteen_lower_case_hex_digits_and_nothing_else() {
        assert!(is_run_name("NimbleNewtRun-0123456789abcdef"));
        assert!(is_run_name("NimbleNewtRun-0000000000000000"));
        assert_eq!(RUN_PREFIX.len() + RUN_HEX_LEN, 30, "far inside the 64 characters CreateAppContainerProfile allows");
        for bad in ["", "NimbleNewtRun-", "NimbleNewtRun-0123456789abcde", "NimbleNewtRun-0123456789abcdef0", "NimbleNewtRun-0123456789ABCDEF", "NimbleNewtRun-0123456789abcdeg", "nimblenewtrun-0123456789abcdef",
            "NimbleNewtAgent", "NimbleNewtExperiment", "NimbleNewtRun-0123456789abcdef ", "NimbleNewtRun-0123456789abcdef.", " NimbleNewtRun-0123456789abcdef", "NimbleNewtRun_0123456789abcdef",
            "NimbleNewtRun-0123456789abcdef\n", "NimbleNewtRun-0123456789abcdef\0", "NimbleNewtRun-0123456789abcd\u{e9}f", "NimbleNewtRun-\u{ff10}123456789abcdef", "NimbleNewtRunNimbleNewtRun-0123456789abcdef"] {
            assert!(!is_run_name(bad), "{bad:?}");
        }
        // every accepted name also fits the documented pattern [-_. A-Za-z0-9]+ and the 64-character limit
        let name = "NimbleNewtRun-0123456789abcdef";
        assert!(name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    }

    #[test]
    fn app_container_sids_have_the_package_layout() {
        assert!(is_app_sid_text(SID));
        assert!(is_app_sid_text("S-1-15-2-3624051433-2125758914-1423191267-1740899205-1073925389-3782572162-737981194"));
        for bad in ["", "S-1-15-2", "S-1-15-2-1-2-3-4-5-6", "S-1-15-2-1-2-3-4-5-6-7-8", "S-1-15-3-1-2-3-4-5-6-7", "S-1-5-21-1-2-3-4-5-6-7", "S-1-15-2--1-2-3-4-5-6", "S-1-15-2-1-2-3-4-5-6-x", "S-1-15-2-1-2-3-4-5-6-12345678901", "S-1-15-2-1-2-3-4-5-6-7 ", "s-1-15-2-1-2-3-4-5-6-7", "S-1-15-2-1-2-3-4-5-6-7\n"] {
            assert!(!is_app_sid_text(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_record_round_trips_and_nothing_else_parses() {
        let name = "NimbleNewtRun-0123456789abcdef";
        let text = format_record(name, SID);
        assert_eq!(parse_record(&text), Some((name.to_string(), SID.to_string())));
        assert_eq!(parse_record(&text.replace('\n', "\r\n")), Some((name.to_string(), SID.to_string())), "a rewritten line ending is still the same record");
        for bad in ["", "nn-run-profile v1\n", "nn-run-profile v2\nNimbleNewtRun-0123456789abcdef S-1-15-2-1-2-3-4-5-6-7\n", "NimbleNewtRun-0123456789abcdef S-1-15-2-1-2-3-4-5-6-7\n",
            "nn-run-profile v1\nNimbleNewtAgent S-1-15-2-1-2-3-4-5-6-7\n", "nn-run-profile v1\nNimbleNewtRun-0123456789abcdef S-1-5-18\n", "nn-run-profile v1\nNimbleNewtRun-0123456789abcdef\n",
            "nn-run-profile v1\nNimbleNewtRun-0123456789abcdef S-1-15-2-1-2-3-4-5-6-7 extra\n", "nn-run-profile v1\nNimbleNewtRun-0123456789abcdef S-1-15-2-1-2-3-4-5-6-7\nsecond\n"] {
            assert_eq!(parse_record(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_profile_is_deleted_only_with_a_matching_record() {
        let name = "NimbleNewtRun-0123456789abcdef";
        let rec = format_record(name, SID);
        assert!(may_delete(name, Some(&rec), SID, None).is_ok());
        assert!(may_delete(name, Some(&rec), SID, Some(SID)).is_ok());
        // no record at all
        assert!(may_delete(name, None, SID, Some(SID)).unwrap_err().contains("no record"));
        // a record of another profile
        assert!(may_delete(name, Some(&format_record("NimbleNewtRun-fedcba9876543210", SID)), SID, None).unwrap_err().contains("another profile"));
        // a record with another SID than the one this name derives to
        let other = "S-1-15-2-9-9-9-9-9-9-9";
        assert!(may_delete(name, Some(&format_record(name, other)), SID, None).unwrap_err().contains("not the SID of this name"));
        // a SID on the command line that is not the derived one
        assert!(may_delete(name, Some(&rec), SID, Some(other)).unwrap_err().contains("SID given"));
        // a name that is not a run name is never deleted, whatever the record says
        for bad in ["NimbleNewtAgent", "Microsoft.Windows.Cortana", "", "NimbleNewtRun-0123456789ABCDEF"] {
            assert!(may_delete(bad, Some(&format_record(name, SID)), SID, None).unwrap_err().contains("not a per-run profile name"), "{bad:?}");
        }
        // a garbled record
        assert!(may_delete(name, Some("garbage"), SID, None).unwrap_err().contains("not in the launcher's format"));
    }
}
