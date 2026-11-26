// The Windows part of the launcher. See ../README.md for the list of Win32 calls and what each is for.
//
// One source, two builds. The PRODUCT build (`nn-launcher.exe`, no cargo feature) speaks only what the worker's native Windows backend needs: the commands run, check, revoke and
// info; grant modes ro, rx, modify, modify-root and seal; standard input from a FILE; standard output and error to FILES; kill-on-close always on. Every other option below is an
// EXPERIMENT option (the measuring probes of experiments/windows-appcontainer): the product build refuses it at the argument check ("not in this build") and does not contain
// the NUL-device test or the hang diagnosis at all. The experiment's own crate (experiments/windows-appcontainer/launcher) builds this same source with the feature `experiment`.
use crate::args::{parse_args, Args, GrantSpec, Mode, AAP_OPT_IN, AAP_OPT_OUT, EXPERIMENT};
use crate::profile;
#[cfg(feature = "experiment")]
use crate::args::Creation;
/// The value of the `tool` field: the protocol identifier the TypeScript side matches (a test pins it). It is not the program's file name.
const TOOL: &str = "nn-appc-launcher";
use std::ffi::{c_void, OsStr};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::time::Instant;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::Isolation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
#[cfg(feature = "experiment")]
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Threading::*;

// Attribute numbers (the ProcThreadAttributeValue results documented for each PROC_THREAD_ATTRIBUTE_*), written out so a header
// that lacks one cannot change the meaning.
const ATTR_MITIGATION_POLICY: usize = 0x0002_0007;
const ATTR_SECURITY_CAPABILITIES: usize = 0x0002_0009;
const ATTR_HANDLE_LIST: usize = 0x0002_0002;
const ATTR_JOB_LIST: usize = 0x0002_000D;
const ATTR_ALL_APPLICATION_PACKAGES_POLICY: usize = 0x0002_000F;
// PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON (1 << 28)
const WIN32K_DISABLE_ALWAYS_ON: u64 = 1u64 << 28;
const HR_ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
const SE_GROUP_ENABLED_BIT: u32 = 0x4; // SE_GROUP_ENABLED: the attribute of a capability SID in SECURITY_CAPABILITIES
const EXIT_LAUNCHER_FAILED: i32 = 125;
const EXIT_TIMED_OUT: i32 = 124;

// The private window station and desktop each run gets (both builds; the fix for a launcher that runs as a Windows service, README "Window station").
#[path = "privdesk.rs"]
mod privdesk;
// Round 5 (experiment build only): the window station and desktop of the child, and the `context` and `desktop-revoke` commands.
#[cfg(feature = "experiment")]
#[path = "desk.rs"]
mod desk;
// The one-account ("home") measurement: `home-probe`, `ui-test`, `home-revoke`, `deelevate` (experiment build only; the pure rules are in homerules.rs).
#[cfg(feature = "experiment")]
#[path = "home.rs"]
mod home;

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Ordered key/raw-JSON pairs; a tiny JSON writer so the launcher needs no other crate.
struct Json(Vec<(String, String)>);
impl Json {
    fn new() -> Self { Json(Vec::new()) }
    /// Sets a key; a key set twice keeps its last value in its first place, so the line never carries duplicate keys.
    fn raw(&mut self, k: &str, v: String) {
        match self.0.iter_mut().find(|(key, _)| key == k) { Some(slot) => slot.1 = v, None => self.0.push((k.to_string(), v)) }
    }
    fn s(&mut self, k: &str, v: &str) { self.raw(k, json_str(v)); }
    fn b(&mut self, k: &str, v: bool) { self.raw(k, if v { "true".into() } else { "false".into() }); }
    fn n(&mut self, k: &str, v: i64) { self.raw(k, v.to_string()); }
    fn render(&self) -> String {
        format!("{{{}}}", self.0.iter().map(|(k, v)| format!("{}:{}", json_str(k), v)).collect::<Vec<_>>().join(","))
    }
}

// ---------------------------------------------------------------------------------------------------------------- arguments

// The arguments (Args, Mode, parse_args) live in ../args.rs, which builds and is unit-tested on every operating system.
impl Mode {
    fn mask(self) -> u32 {
        match self {
            Mode::Ro => FILE_GENERIC_READ,
            Mode::Rx => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            Mode::Modify => FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
            // What a protected name must not allow: writes, appends, attribute writes, delete, and delete-child on a folder.
            Mode::DenyWrite => FILE_GENERIC_WRITE & !SYNCHRONIZE & !READ_CONTROL | DELETE | FILE_DELETE_CHILD,
            // Everything except reading and executing: writes, appends, attribute writes, delete, delete-child, change the DACL, take ownership.
            Mode::DenyStrong => FILE_ALL_ACCESS & !FILE_GENERIC_READ & !FILE_GENERIC_EXECUTE,
            // `seal` and `modify-root` build their own entries (see `layered_acl`); the mask shown is the allow entry of a seal.
            Mode::Seal => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            Mode::ModifyRoot => FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- small owners

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { unsafe { CloseHandle(self.0) }; }
    }
}

struct Sid(PSID);
impl Drop for Sid {
    fn drop(&mut self) { if !self.0.is_null() { unsafe { FreeSid(self.0) }; } }
}

fn sid_string(sid: PSID) -> String {
    unsafe {
        let mut p: *mut u16 = null_mut();
        if ConvertSidToStringSidW(sid, &mut p) == 0 { return "?".into(); }
        let mut n = 0;
        while *p.add(n) != 0 { n += 1; }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
        LocalFree(p as *mut c_void);
        s
    }
}

/// Creates the profile, or finds the existing one with the same fixed name. Returns the SID and whether it was created now.
fn container_sid(name: &str) -> Result<(Sid, bool), String> {
    unsafe {
        let wname = wide(name);
        let wdisp = wide("NimbleNewt experiment");
        let mut sid: PSID = null_mut();
        let hr = CreateAppContainerProfile(wname.as_ptr(), wdisp.as_ptr(), wdisp.as_ptr(), null(), 0, &mut sid);
        if hr == 0 { return Ok((Sid(sid), true)); }
        if hr == HR_ALREADY_EXISTS {
            let mut sid2: PSID = null_mut();
            let hr2 = DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut sid2);
            if hr2 == 0 { return Ok((Sid(sid2), false)); }
            return Err(format!("DeriveAppContainerSidFromAppContainerName failed: 0x{:08x}", hr2 as u32));
        }
        Err(format!("CreateAppContainerProfile failed: 0x{:08x}", hr as u32))
    }
}

/// The SID a profile NAME derives to (DeriveAppContainerSidFromAppContainerName): a pure computation, no profile is made and none has to exist. Per-run names are only ever derived for
/// `check` and `revoke` (the profile may already be deleted: the entries for its SID are still removable), and before `run` makes the profile.
fn derived_sid(name: &str) -> Result<Sid, String> {
    unsafe {
        let mut sid: PSID = null_mut();
        let hr = DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(), &mut sid);
        if hr == 0 && !sid.is_null() { Ok(Sid(sid)) } else { Err(format!("DeriveAppContainerSidFromAppContainerName failed: 0x{:08x}", hr as u32)) }
    }
}

/// The SID for a command that only reads or removes entries (`check`, `revoke`): a per-run name is derived (never created; when `--sid` came with it, it must be the derived one), any other
/// name (the experiment build's own) keeps the old create-or-find behaviour.
fn sid_for_entries(a: &Args) -> Result<Sid, String> {
    if !profile::is_run_name(&a.name) { return container_sid(&a.name).map(|(s, _)| s); }
    let sid = derived_sid(&a.name)?;
    let text = sid_string(sid.0);
    if let Some(given) = a.sid.as_deref() { if given != text { return Err("the SID given is not the SID of this profile name".into()); } }
    Ok(sid)
}

/// What deleting a per-run profile came to.
struct Ended { deleted: bool, hr: i32, gone: bool }

/// Deletes a per-run profile and checks that it is gone. DeleteAppContainerProfile succeeds for a profile that does not exist (documented), and when it fails "the status of the profile is
/// undetermined, call it again", so it is called a second time after a failure. Gone is then read with GetAppContainerFolderPath on the profile's SID: the documentation lists only S_OK and
/// E_INVALIDARG, so the reading is that a profile that no longer exists has no folder to name and the call fails; a call that still succeeds means the profile is still there and is reported
/// as not gone (the supervisor then fails the run and keeps the record for its sweep). NOT MEASURED on real Windows. The folder path the call returns is not freed (the process ends at once).
fn delete_profile_verified(name: &str, sid_text: &str) -> Ended {
    unsafe {
        let wname = wide(name);
        let mut hr = DeleteAppContainerProfile(wname.as_ptr());
        if hr != 0 { hr = DeleteAppContainerProfile(wname.as_ptr()); }
        let mut path: *mut u16 = null_mut();
        let q = GetAppContainerFolderPath(wide(sid_text).as_ptr(), &mut path);
        Ended { deleted: hr == 0, hr, gone: hr == 0 && q != 0 }
    }
}

fn report_ended(j: &mut Json, e: &Ended) {
    j.b("profileDeleted", e.deleted);
    j.b("profileGone", e.gone);
    j.n("profileDeleteHr", e.hr as i64);
}

/// One run's own profile. `begin` derives the SID from the name, writes the record file (create-new: a name used before is refused), THEN makes the profile and checks it got the derived SID;
/// a profile that already exists is never adopted (a per-run name is new by construction; one that exists is a collision or a leftover, and not this launcher's to use or delete).
struct ProfileLife { name: String, sid_text: String }
impl ProfileLife {
    fn begin(name: &str, record: &str) -> Result<(Sid, ProfileLife), String> {
        let sid = derived_sid(name)?;
        let text = sid_string(sid.0);
        if !crate::profile::is_app_sid_text(&text) { return Err(format!("the derived SID {text} is not an AppContainer SID")); }
        // Whole or not at all, create-new (profile.rs create_whole): a launcher killed while writing leaves no half-written record that would stop every later run.
        profile::create_whole(record, &profile::format_record(name, &text))?;
        unsafe {
            let mut made: PSID = null_mut();
            let wdisp = wide("NimbleNewt run");
            let hr = CreateAppContainerProfile(wide(name).as_ptr(), wdisp.as_ptr(), wdisp.as_ptr(), null(), 0, &mut made);
            if hr != 0 {
                // Nothing was made, so the record this call wrote is removed with it.
                let _ = std::fs::remove_file(record);
                return Err(if hr == HR_ALREADY_EXISTS { "a profile with this name already exists: it is not adopted".to_string() } else { format!("CreateAppContainerProfile failed: 0x{:08x}", hr as u32) });
            }
            let same = EqualSid(made, sid.0) != 0;
            FreeSid(made);
            if !same {
                let ended = delete_profile_verified(name, &text);
                let _ = ended;
                return Err("the profile that was made has another SID than the one derived from its name: it was deleted".to_string());
            }
        }
        Ok((sid, ProfileLife { name: name.to_string(), sid_text: text }))
    }

    /// Ends the profile after the run: deleted and checked only when every grant is revoked and read back (otherwise it is kept, named in the line, so the supervisor can revoke by SID first).
    fn finish(&self, j: &mut Json, grants_gone: bool) {
        if grants_gone { report_ended(j, &delete_profile_verified(&self.name, &self.sid_text)); }
        else { j.b("profileDeleted", false); j.b("profileGone", false); j.s("profileKept", "a grant could not be revoked, so the profile is kept for the supervisor's revoke by SID and delete"); }
    }
}

fn is_elevated() -> bool {
    unsafe {
        let mut tok: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 { return false; }
        let _g = Handle(tok);
        let mut e: TOKEN_ELEVATION = zeroed();
        let mut got = 0u32;
        GetTokenInformation(tok, TokenElevation, &mut e as *mut _ as *mut c_void, size_of::<TOKEN_ELEVATION>() as u32, &mut got) != 0 && e.TokenIsElevated != 0
    }
}

fn session_id() -> i64 {
    unsafe {
        let mut s = 0u32;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut s) == 0 { -1 } else { s as i64 }
    }
}

// ---------------------------------------------------------------------------------------------------------------- capabilities

/// The three network capabilities have fixed, well-known SIDs (Microsoft: "Well-known SIDs"): internetClient S-1-15-3-1, internetClientServer S-1-15-3-2,
/// privateNetworkClientServer S-1-15-3-3. Matching is by lower-case name.
fn well_known_capability(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "internetclient" => Some("S-1-15-3-1"),
        "internetclientserver" => Some("S-1-15-3-2"),
        "privatenetworkclientserver" => Some("S-1-15-3-3"),
        _ => None,
    }
}

/// Capability SIDs held until the process is created (freed with LocalFree), plus what each one was asked as and resolved to (for the JSON line).
struct CapabilitySids { sids: Vec<PSID>, described: Vec<(String, String)> }
impl Drop for CapabilitySids {
    fn drop(&mut self) { for s in &self.sids { if !s.is_null() { unsafe { LocalFree(*s as *mut c_void) }; } } }
}

/// Resolves each --capability: a string SID (S-1-...) as it is, one of the three well-known network names, or any other name through
/// DeriveCapabilitySidsFromName (the named capabilities, for example registryRead or lpacCom). An unknown form fails the run before anything starts.
fn resolve_capabilities(specs: &[String]) -> Result<CapabilitySids, String> {
    let mut out = CapabilitySids { sids: Vec::new(), described: Vec::new() };
    for spec in specs {
        unsafe {
            let as_text = if spec.starts_with("S-1-") { Some(spec.as_str()) } else { well_known_capability(spec) };
            if let Some(text) = as_text {
                let mut sid: PSID = null_mut();
                if ConvertStringSidToSidW(wide(text).as_ptr(), &mut sid) == 0 { return Err(format!("capability {spec}: ConvertStringSidToSidW failed: {}", GetLastError())); }
                out.sids.push(sid);
                out.described.push((spec.clone(), sid_string(sid)));
                continue;
            }
            let mut group_sids: *mut PSID = null_mut();
            let mut group_count = 0u32;
            let mut cap_sids: *mut PSID = null_mut();
            let mut cap_count = 0u32;
            if DeriveCapabilitySidsFromName(wide(spec).as_ptr(), &mut group_sids, &mut group_count, &mut cap_sids, &mut cap_count) == 0 || cap_count == 0 {
                return Err(format!("capability {spec}: DeriveCapabilitySidsFromName failed: {}", GetLastError()));
            }
            // The first capability SID is the one that names the capability; the arrays and the group SIDs are released here.
            let first = *cap_sids;
            out.described.push((spec.clone(), sid_string(first)));
            out.sids.push(first);
            for i in 1..cap_count as usize { LocalFree(*cap_sids.add(i) as *mut c_void); }
            LocalFree(cap_sids as *mut c_void);
            for i in 0..group_count as usize { LocalFree(*group_sids.add(i) as *mut c_void); }
            if !group_sids.is_null() { LocalFree(group_sids as *mut c_void); }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------- ACL grants

// ACE_HEADER.AceType values and the ACE_HEADER.AceFlags bit (winnt.h), written out so their integer types are fixed here.
const ACE_TYPE_ALLOWED: u8 = 0; // ACCESS_ALLOWED_ACE_TYPE
const ACE_TYPE_DENIED: u8 = 1; // ACCESS_DENIED_ACE_TYPE
const ACE_FLAG_INHERITED: u8 = 0x10; // INHERITED_ACE
/// Returned by a revoke when the DACL still names the container after the write (a private code, outside the Win32 range used here).
pub const ERR_STILL_PRESENT: u32 = 0x2000_0001;

/// How many NON-inherited allow/deny entries of the DACL name this SID (a NULL DACL has none).
unsafe fn explicit_aces(acl: *const ACL, sid: PSID) -> u32 { count_aces(acl, sid, false) }

/// How many allow/deny entries of the DACL name this SID, counting the explicit ones (`inherited` false) or the inherited ones (true).
unsafe fn count_aces(acl: *const ACL, sid: PSID, inherited: bool) -> u32 {
    if acl.is_null() { return 0; }
    let mut n = 0;
    for i in 0..(*acl).AceCount as u32 {
        let mut ace: *mut c_void = null_mut();
        if GetAce(acl, i, &mut ace) == 0 || ace.is_null() { continue; }
        let header = &*(ace as *const ACE_HEADER);
        if header.AceType != ACE_TYPE_ALLOWED && header.AceType != ACE_TYPE_DENIED { continue; }
        if (header.AceFlags & ACE_FLAG_INHERITED != 0) != inherited { continue; }
        // ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE share one layout: header, mask, then the SID starting at SidStart.
        let ace_sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID;
        if EqualSid(ace_sid, sid) != 0 { n += 1; }
    }
    n
}

/// The number of explicit entries for the SID on a path (Err: the Win32 error of GetNamedSecurityInfoW).
fn explicit_count(path: &str, sid: PSID) -> Result<u32, u32> { entry_count(path, sid, false) }

/// The same for entries the path INHERITED from its parent (does a grant on a folder reach the target of a junction inside it?).
fn inherited_count(path: &str, sid: PSID) -> Result<u32, u32> { entry_count(path, sid, true) }

fn entry_count(path: &str, sid: PSID, inherited: bool) -> Result<u32, u32> {
    unsafe {
        let wpath = wide(path);
        let mut acl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetNamedSecurityInfoW(wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        let n = count_aces(acl, sid, inherited);
        LocalFree(sd as *mut c_void);
        Ok(n)
    }
}

/// Removes EVERY explicit (non-inherited) allow or deny entry that names the SID from the DACL, by building a copy of the ACL and deleting those entries
/// from it (DeleteAce, highest index first). The first round used SetEntriesInAcl with REVOKE_ACCESS, which left the container's deny entry on the
/// protected `.git` folder in place on the hosted runner (read-back: still present, error 0x20000001); removing entries by hand does not depend on the mode.
/// Returns Ok(true) when something was written.
unsafe fn remove_explicit(wpath: &[u16], old: *const ACL, sid: PSID, unprotect: bool) -> Result<bool, u32> {
    let size = (*old).AclSize as usize;
    // usize elements: an ACL is DWORD-aligned and the buffer is pointer-aligned.
    let mut buf = vec![0usize; size.div_ceil(size_of::<usize>())];
    std::ptr::copy_nonoverlapping(old as *const u8, buf.as_mut_ptr() as *mut u8, size);
    let copy = buf.as_mut_ptr() as *mut ACL;
    let mut removed = false;
    for i in (0..(*copy).AceCount as u32).rev() {
        let mut ace: *mut c_void = null_mut();
        if GetAce(copy, i, &mut ace) == 0 || ace.is_null() { continue; }
        let header = &*(ace as *const ACE_HEADER);
        if header.AceType != ACE_TYPE_ALLOWED && header.AceType != ACE_TYPE_DENIED { continue; }
        if header.AceFlags & ACE_FLAG_INHERITED != 0 { continue; }
        let ace_sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID;
        if EqualSid(ace_sid, sid) != 0 {
            if DeleteAce(copy, i) == 0 { return Err(GetLastError()); }
            removed = true;
        }
    }
    if !removed { return Ok(false); }
    // A sealed folder had its DACL protected (no inheritance); the revoke lets it inherit again.
    let info = if unprotect { DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION } else { DACL_SECURITY_INFORMATION };
    let rc = SetNamedSecurityInfoW(wpath.as_ptr() as *mut u16, SE_FILE_OBJECT, info, null_mut(), null_mut(), copy, null_mut());
    if rc != 0 { return Err(rc); }
    Ok(true)
}

// Round 4: entries built by hand, in a fixed order, so that the layout does not depend on how SetEntriesInAcl merges entries.
const ACL_REV: u32 = 2; // ACL_REVISION
const INHERIT_CI_OI: u32 = 0x3; // CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
const INHERIT_ONLY: u32 = 0x8; // INHERIT_ONLY_ACE
const SDDL_REV_1: u32 = 1; // SDDL_REVISION_1

/// One entry to add: (deny?, access mask, ACE flags).
type NewAce = (bool, u32, u32);

/// Builds a DACL from the old one: `front` entries (for the container), then the old explicit denies, then the old explicit entries of other kinds, `back` entries, then the
/// old inherited ones. Every old entry that names the container is dropped (the explicit ones always; the inherited ones when `drop_inherited`). With `clear_inherited` the
/// remaining inherited entries are copied as EXPLICIT ones (the DACL is about to be protected, so nothing is inherited any more). Returns the buffer (pointer-aligned) holding the ACL.
unsafe fn build_layered(old: *const ACL, sid: PSID, front: &[NewAce], back: &[NewAce], drop_inherited: bool, clear_inherited: bool) -> Result<Vec<usize>, u32> {
    let sid_len = GetLengthSid(sid) as usize;
    let old_size = if old.is_null() { 8 } else { (*old).AclSize as usize };
    let total = ((old_size + (front.len() + back.len()) * (16 + sid_len) + 16 + 3) & !3).min(0xFFF8); // an ACL length is a multiple of four
    let mut buf = vec![0usize; total.div_ceil(size_of::<usize>())];
    let acl = buf.as_mut_ptr() as *mut ACL;
    if InitializeAcl(acl, total as u32, ACL_REV) == 0 { return Err(GetLastError()); }
    let add_new = |e: &NewAce| -> Result<(), u32> {
        let ok = if e.0 { AddAccessDeniedAceEx(acl, ACL_REV, e.2, e.1, sid) } else { AddAccessAllowedAceEx(acl, ACL_REV, e.2, e.1, sid) };
        if ok == 0 { Err(GetLastError()) } else { Ok(()) }
    };
    // (type, inherited, pointer, size) of every old entry that stays.
    let mut kept: Vec<(u8, bool, *mut c_void, usize)> = Vec::new();
    if !old.is_null() {
        for i in 0..(*old).AceCount as u32 {
            let mut ace: *mut c_void = null_mut();
            if GetAce(old, i, &mut ace) == 0 || ace.is_null() { continue; }
            let header = &*(ace as *const ACE_HEADER);
            let inherited = header.AceFlags & ACE_FLAG_INHERITED != 0;
            if header.AceType == ACE_TYPE_ALLOWED || header.AceType == ACE_TYPE_DENIED {
                let ace_sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID;
                if EqualSid(ace_sid, sid) != 0 && (!inherited || drop_inherited) { continue; }
            }
            kept.push((header.AceType, inherited && !clear_inherited, ace, header.AceSize as usize));
        }
    }
    let copy = |e: &(u8, bool, *mut c_void, usize)| -> Result<(), u32> {
        let mut bytes = vec![0u8; e.3];
        std::ptr::copy_nonoverlapping(e.2 as *const u8, bytes.as_mut_ptr(), e.3);
        if clear_inherited { bytes[1] &= !ACE_FLAG_INHERITED; } // byte 1 of an ACE is AceFlags
        if AddAce(acl, ACL_REV, u32::MAX, bytes.as_ptr() as *const c_void, e.3 as u32) == 0 { Err(GetLastError()) } else { Ok(()) }
    };
    for e in front { add_new(e)?; }
    for e in kept.iter().filter(|e| !e.1 && e.0 == ACE_TYPE_DENIED) { copy(e)?; }
    for e in kept.iter().filter(|e| !e.1 && e.0 != ACE_TYPE_DENIED) { copy(e)?; }
    for e in back { add_new(e)?; }
    for e in kept.iter().filter(|e| e.1 && e.0 == ACE_TYPE_DENIED) { copy(e)?; }
    for e in kept.iter().filter(|e| e.1 && e.0 != ACE_TYPE_DENIED) { copy(e)?; }
    Ok(buf)
}

/// The two layered layouts.
///  `seal` (a protected name such as `.git`): the folder's DACL becomes PROTECTED (it inherits nothing, so the workspace grant's write rights do not reach it); for the container it
///    holds one deny entry (everything but read and execute, inheritable) and one allow entry (read and execute, inheritable). Other accounts' entries are kept, as explicit ones.
///  `modify-root` (the workspace folder itself): the container may modify everything below it, and the folder itself too, except that it may not DELETE it (and so not rename or move it):
///    one entry for the folder alone (modify without DELETE) and one inherit-only entry for everything inside (modify).
unsafe fn layered_acl(wpath: &[u16], old: *const ACL, sid: PSID, mode: Mode) -> Result<(), u32> {
    let modify = Mode::Modify.mask();
    let (built, protect) = match mode {
        Mode::Seal => (build_layered(old, sid, &[(true, Mode::DenyStrong.mask(), INHERIT_CI_OI)], &[(false, Mode::Seal.mask(), INHERIT_CI_OI)], true, true)?, true),
        _ => (build_layered(old, sid, &[], &[(false, modify & !DELETE, 0), (false, modify, INHERIT_CI_OI | INHERIT_ONLY)], false, false)?, false),
    };
    let info = if protect { DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION } else { DACL_SECURITY_INFORMATION };
    let rc = SetNamedSecurityInfoW(wpath.as_ptr() as *mut u16, SE_FILE_OBJECT, info, null_mut(), null_mut(), built.as_ptr() as *const ACL, null_mut());
    if rc != 0 { Err(rc) } else { Ok(()) }
}

/// The DACL of a path as SDDL text (or `error N`), for the diagnosis of what the grants really wrote.
fn dacl_sddl(path: &str) -> String {
    unsafe {
        let wpath = wide(path);
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetNamedSecurityInfoW(wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), null_mut(), &mut sd);
        if rc != 0 { return format!("error {rc}"); }
        let mut text: *mut u16 = null_mut();
        let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REV_1, DACL_SECURITY_INFORMATION, &mut text, null_mut());
        let code = GetLastError();
        LocalFree(sd as *mut c_void);
        if ok == 0 || text.is_null() { return format!("convert error {code}"); }
        let mut n = 0;
        while *text.add(n) != 0 { n += 1; }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
        LocalFree(text as *mut c_void);
        s
    }
}

/// `[{"path":..,"sddl":..}]` for the paths given with --dump (a path that does not exist reports its error number).
fn dump_json(paths: &[String]) -> String {
    let parts: Vec<String> = paths.iter().map(|p| { let mut o = Json::new(); o.s("path", p); o.s("sddl", &dacl_sddl(p)); o.render() }).collect();
    format!("[{}]", parts.join(","))
}

/// One machine-wide lock around every DACL read-modify-write this launcher does. Several launchers may run at once (the backend's `maxConcurrentRuns`), and they all write the SAME program
/// folder's DACL (each adds, then removes, its own container's entry): a write made from a copy read before another launcher's write would lose that entry or bring a removed one back. The name
/// has the `Global\` prefix: without one a named object lives in the namespace of the creator's Terminal Services SESSION (Microsoft, "Kernel Object Namespaces"), so a launcher started from a
/// signed-in session and one started by the worker in session 0 would hold two different locks over the same folder. Creating a MUTEX in the global namespace needs no privilege (Microsoft names
/// only file-mapping and symbolic-link objects as needing SeCreateGlobalPrivilege). Its default security is the creator's: a launcher of another account that cannot open it fails, and so does a
/// launcher that cannot take it in two minutes: the grant or the revoke fails (fail closed). Any local account could create the name first and so stop every grant (refusal, never a weaker run).
/// An abandoned mutex (a launcher that died holding it) is taken: each DACL write is one SetNamedSecurityInfo call, so nothing is left half done. NOT MEASURED with two real launchers.
/// The lock's name (a test pins the `Global\\` prefix).
pub(crate) const ACL_LOCK_NAME: &str = "Global\\NimbleNewtAclWrite";
struct AclLock(HANDLE);
impl AclLock {
    fn take() -> Result<AclLock, u32> {
        unsafe {
            let h = CreateMutexW(null(), 0, wide(ACL_LOCK_NAME).as_ptr());
            if h.is_null() { return Err(GetLastError()); }
            match WaitForSingleObject(h, 120_000) {
                WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(AclLock(h)),
                other => { let e = if other == WAIT_TIMEOUT { WAIT_TIMEOUT } else { GetLastError() }; CloseHandle(h); Err(e) }
            }
        }
    }
}
impl Drop for AclLock { fn drop(&mut self) { unsafe { ReleaseMutex(self.0); CloseHandle(self.0); } } }

/// Adds (GRANT_ACCESS / DENY_ACCESS) or removes (a revoke) the container's explicit entries on a folder or file. Returns a Win32 error code.
/// A revoke on a path whose DACL holds no explicit entry for the container writes nothing (so it needs no rights and is idempotent), and a revoke
/// that wrote is checked by reading the DACL back: an entry still there is an error, never a success.
fn change_ace(path: &str, sid: PSID, mode: Mode, revoke: bool) -> Result<(), u32> {
    let _lock = AclLock::take()?;
    unsafe {
        let wpath = wide(path);
        let mut old: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetNamedSecurityInfoW(wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut old, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        if revoke {
            let none = old.is_null() || explicit_aces(old, sid) == 0;
            let written = if none { Ok(false) } else { remove_explicit(&wpath, old, sid, mode == Mode::Seal) };
            LocalFree(sd as *mut c_void);
            written?;
            return match explicit_count(path, sid) { Ok(0) => Ok(()), Ok(_) => Err(ERR_STILL_PRESENT), Err(e) => Err(e) };
        }
        if matches!(mode, Mode::Seal | Mode::ModifyRoot) {
            let r = layered_acl(&wpath, old, sid, mode);
            LocalFree(sd as *mut c_void);
            return r;
        }
        let mut ea: EXPLICIT_ACCESS_W = zeroed();
        ea.grfAccessPermissions = mode.mask();
        ea.grfAccessMode = if mode.is_deny() { DENY_ACCESS } else { GRANT_ACCESS };
        ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
        ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        ea.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        ea.Trustee.ptstrName = sid as *mut u16;
        let mut new: *mut ACL = null_mut();
        let rc = SetEntriesInAclW(1, &ea, old, &mut new);
        if rc != 0 { LocalFree(sd as *mut c_void); return Err(rc); }
        let rc = SetNamedSecurityInfoW(wpath.as_ptr() as *mut u16, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), new, null_mut());
        LocalFree(new as *mut c_void);
        LocalFree(sd as *mut c_void);
        if rc != 0 { return Err(rc); }
        Ok(())
    }
}

struct GrantRecord { spec: GrantSpec, applied: bool, revoked: bool, error: Option<u32> }

/// Holds what was granted so the entries are removed on every path out, including a panic (Drop).
struct GrantSet { sid: PSID, items: Vec<GrantRecord> }
impl GrantSet {
    /// Two passes: every other entry first (newest first), the sealed names LAST. A revoked seal lets the folder inherit again, so while the workspace's own entry for the container were
    /// still in place the sealed folder would take its write rights back from the parent for a moment; revoking the seals after everything else leaves nothing to inherit.
    /// A seal is KEPT while any other entry could not be removed (the seal is a deny, so keeping it takes nothing from anyone but the container; the caller's read-back sees it left and retries).
    fn revoke_all(&mut self) {
        for seals in [false, true] {
            if seals && self.items.iter().any(|g| g.spec.mode != Mode::Seal && g.applied && !g.revoked) { break; }
            for g in self.items.iter_mut().rev() {
                if (g.spec.mode == Mode::Seal) != seals { continue; }
                if g.applied && !g.revoked {
                    match change_ace(&g.spec.path, self.sid, g.spec.mode, true) { Ok(()) => g.revoked = true, Err(e) => g.error = Some(e) }
                }
            }
        }
    }
    fn json(&self) -> String {
        let parts: Vec<String> = self.items.iter().map(|g| {
            let mut j = Json::new();
            j.s("path", &g.spec.path); j.s("mode", g.spec.mode.name()); j.b("soft", g.spec.soft); j.b("applied", g.applied); j.b("revoked", g.revoked);
            if let Some(e) = g.error { j.n("errorCode", e as i64); }
            // The read-back after the revoke: how many explicit entries for the container are still on the path (-1: the DACL could not be read).
            j.n("entriesLeft", match explicit_count(&g.spec.path, self.sid) { Ok(n) => n as i64, Err(_) => -1 });
            // Entries the path inherited for the container (-1: unreadable); a grant on a parent folder may or may not reach a junction's target.
            j.n("inheritedEntries", match inherited_count(&g.spec.path, self.sid) { Ok(n) => n as i64, Err(_) => -1 });
            j.render()
        }).collect();
        format!("[{}]", parts.join(","))
    }
}
impl Drop for GrantSet { fn drop(&mut self) { self.revoke_all(); } }

// ---------------------------------------------------------------------------------------------------------------- the job

fn make_job(a: &Args) -> Result<Handle, String> {
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() { return Err(format!("CreateJobObjectW failed: {}", GetLastError())); }
        let job = Handle(job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        let mut flags = JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if a.kill_on_close { flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; }
        if a.memory_mb > 0 { flags |= JOB_OBJECT_LIMIT_JOB_MEMORY; info.JobMemoryLimit = (a.memory_mb as usize) * 1024 * 1024; }
        if a.active_processes > 0 { flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS; info.BasicLimitInformation.ActiveProcessLimit = a.active_processes; }
        info.BasicLimitInformation.LimitFlags = flags;
        if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
            return Err(format!("SetInformationJobObject(limits) failed: {}", GetLastError()));
        }
        if a.ui_limits {
            let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass: 0x0000_00FF /* JOB_OBJECT_UILIMIT_ALL */ };
            if SetInformationJobObject(job.0, JobObjectBasicUIRestrictions, &ui as *const _ as *const c_void, size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32) == 0 {
                return Err(format!("SetInformationJobObject(ui) failed: {}", GetLastError()));
            }
        }
        Ok(job)
    }
}

fn active_processes(job: HANDLE) -> i64 {
    unsafe {
        let mut acc: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        if QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &mut acc as *mut _ as *mut c_void, size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut()) == 0 { -1 } else { acc.ActiveProcesses as i64 }
    }
}

// ---------------------------------------------------------------------------------------------------------------- files, environment

fn open_inheritable(path: &str, write: bool) -> Result<Handle, String> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let w = wide(path);
        let h = if write {
            CreateFileW(w.as_ptr(), FILE_GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, null_mut())
        } else {
            CreateFileW(w.as_ptr(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut())
        };
        if h == INVALID_HANDLE_VALUE { Err(format!("CreateFileW({}) failed: {}", if write { "output" } else { "NUL" }, GetLastError())) } else { Ok(Handle(h)) }
    }
}

/// NUL opened for reading AND writing (what git for Windows does at start-up: open("/dev/null", O_RDWR) becomes _wopen("nul", O_RDWR)).
fn open_nul_rw() -> Result<Handle, String> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let w = wide("NUL");
        let h = CreateFileW(w.as_ptr(), FILE_GENERIC_READ | FILE_GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());
        if h == INVALID_HANDLE_VALUE { Err(format!("CreateFileW(NUL read-write) failed: {}", GetLastError())) } else { Ok(Handle(h)) }
    }
}

/// An anonymous pipe. Both ends are created inheritable; the end the launcher keeps is then made non-inheritable. Returns (read end, write end).
fn make_pipe(keep_read: bool) -> Result<(Handle, Handle), String> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let (mut r, mut w): (HANDLE, HANDLE) = (null_mut(), null_mut());
        if CreatePipe(&mut r, &mut w, &sa, 0) == 0 { return Err(format!("CreatePipe failed: {}", GetLastError())); }
        let (r, w) = (Handle(r), Handle(w));
        let ours = if keep_read { r.0 } else { w.0 };
        if SetHandleInformation(ours, 1 /* HANDLE_FLAG_INHERIT */, 0) == 0 { return Err(format!("SetHandleInformation failed: {}", GetLastError())); }
        Ok((r, w))
    }
}

/// Copies everything that arrives on the read end of a pipe into a file, until every write end is closed. The handle travels as an integer so the thread may own it.
fn drain_pipe(read_end: Handle, path: String) -> std::thread::JoinHandle<()> {
    let raw = read_end.0 as usize;
    std::mem::forget(read_end);
    std::thread::spawn(move || {
        use std::io::Write;
        let h = Handle(raw as HANDLE);
        let Ok(mut f) = std::fs::File::create(&path) else { return };
        let mut buf = vec![0u8; 65536];
        loop {
            let mut got = 0u32;
            let ok = unsafe { ReadFile(h.0, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut got, null_mut::<OVERLAPPED>()) };
            if ok == 0 || got == 0 { break; }
            if f.write_all(&buf[..got as usize]).is_err() { break; }
        }
    })
}

fn file_size(path: &str) -> i64 { std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(-1) }

use crate::args::env_block;

// ---------------------------------------------------------------------------------------------------------------- run

struct Outcome { j: Json, code: i32 }

fn fail(mut j: Json, stage: &str, msg: &str) -> Outcome {
    // childStarted stays true when the child did start (for example a failed wait): only a missing value becomes false.
    if !j.0.iter().any(|(k, _)| k == "childStarted") { j.b("childStarted", false); }
    j.b("ok", false); j.s("stage", stage); j.s("error", msg);
    Outcome { j, code: EXIT_LAUNCHER_FAILED }
}

/// Does this run give the child a private window station and desktop? Always in the product build (it has no other way to start a child); in the experiment build only for `--desktop private`,
/// so the measured baselines and the other modes stay as they were.
fn private_wanted(a: &Args) -> bool {
    #[cfg(feature = "experiment")]
    { a.desktop == crate::args::DesktopMode::Private }
    #[cfg(not(feature = "experiment"))]
    { let _ = a; true }
}

/// `info` and `check`: can this account make (and close) the window objects for the container? Writes `windowStation` (the mode: `private` for a named station of its own, `home-desktop` for the
/// non-elevated user's private desktop on WinSta0), `windowStationOk`, and `windowStationError` when not; when the home desktop was used because the named station was refused, also
/// `privateStationError` (the named station's own message). Err: the message.
fn report_private_station(j: &mut Json, sid: PSID) -> Result<(), String> {
    match privdesk::PrivateDesktop::create(sid, is_elevated()) {
        Ok(mut p) => {
            j.s("windowStation", p.mode().name());
            if let Some(r) = p.named_refusal() { j.s("privateStationError", r); }
            if p.close() { j.b("windowStationOk", true); return Ok(()); }
            let e = format!("window objects: the private window station or desktop could not be closed (error {})", p.close_error().unwrap_or(0));
            j.b("windowStationOk", false); j.s("windowStationError", &e); Err(e)
        }
        Err(e) => {
            j.s("windowStation", e.mode.name());
            if let Some(r) = &e.named_refusal { j.s("privateStationError", r); }
            j.b("windowStationOk", false); j.s("windowStationError", &e.message); Err(e.message)
        }
    }
}

/// `run`. A per-run profile name (the product's only kind) gets its own profile for this run and has it deleted at the end; any other name (the experiment build's own) keeps the shared,
/// create-or-find profile exactly as before.
fn run(a: &Args, j: Json) -> Outcome {
    if !profile::is_run_name(&a.name) {
        let mut j = j;
        let (sid, created) = match container_sid(&a.name) { Ok(v) => v, Err(e) => return fail(j, "container", &e) };
        j.s("containerSid", &sid_string(sid.0));
        j.s("profile", if created { "created" } else { "reused" });
        return run_core(a, j, &sid).0;
    }
    let mut j = j;
    let Some(record) = a.profile_record.as_deref() else { return fail(j, "arguments", "run with a per-run profile needs --profile-record") };
    let (sid, life) = match ProfileLife::begin(&a.name, record) { Ok(v) => v, Err(e) => return fail(j, "container", &e) };
    j.s("containerSid", &life.sid_text);
    j.s("profile", "created");
    let (mut outcome, grants_gone) = run_core(a, j, &sid);
    // Every path out of the run, a failed one included, ends here: the grants were revoked by run_core, the window objects closed and the job ended, so the profile can be deleted.
    life.finish(&mut outcome.j, grants_gone);
    outcome
}

/// The run itself, with the container's SID already known. Returns the outcome and whether every grant that was applied is revoked and read back.
fn run_core(a: &Args, j: Json, sid: &Sid) -> (Outcome, bool) {
    let mut j = j;
    let (Some(exe), Some(cmdline), Some(cwd)) = (a.exe.as_deref(), a.cmdline.as_deref(), a.cwd.as_deref()) else { return (fail(j, "arguments", "run needs --exe, --cmdline and --cwd"), true) };
    let (Some(out_path), Some(err_path)) = (a.stdout.as_deref(), a.stderr.as_deref()) else { return (fail(j, "arguments", "run needs --stdout and --stderr"), true) };
    if !EXPERIMENT && !a.stdin.starts_with("file:") { return (fail(j, "arguments", "run needs --stdin file:PATH in this build"), true); }

    // The private window station and desktop come first: if they cannot be made nothing else was changed (no grant, no job), and the program does not start.
    let mut private: Option<privdesk::PrivateDesktop> = None;
    if private_wanted(a) {
        match privdesk::PrivateDesktop::create(sid.0, is_elevated()) {
            Ok(p) => {
                j.s("windowStation", p.mode().name());
                if let Some(r) = p.named_refusal() { j.s("privateStationError", r); }
                // The home desktop shares the user's window station: the job's UI limits are not optional there (the backend always passes them).
                if let Err(e) = crate::winobj::home_needs_ui_limits(p.mode(), a.ui_limits) { return (fail(j, "grant", &e), true); }
                private = Some(p)
            }
            Err(e) => { j.s("windowStation", e.mode.name()); if let Some(r) = &e.named_refusal { j.s("privateStationError", r); } return (fail(j, "grant", &e.message), true) }
        }
    }
    let mut grants = GrantSet { sid: sid.0, items: Vec::new() };
    #[cfg(feature = "experiment")]
    let mut desk = desk::Desk::new(sid.0);
    #[cfg(feature = "experiment")]
    desk.prepare(a.desktop);
    let result = run_inner(a, &mut j, sid, &mut grants, exe, cmdline, cwd, out_path, err_path, private.as_ref().map(|p| p.lp_desktop()), #[cfg(feature = "experiment")] &desk);
    grants.revoke_all();
    // The child and everything it started are gone (the job ended them): the desktop is closed, then the station.
    if let Some(p) = private.as_mut() { p.close(); j.raw("windowObjects", p.json()); }
    #[cfg(feature = "experiment")]
    { desk.finish(); j.raw("desktop", desk.json(a.desktop)); }
    j.raw("grants", grants.json());
    let all = grants.items.iter().all(|g| !g.applied || g.revoked);
    j.b("allGrantsRevoked", all);
    match result {
        Ok(code) => { j.b("ok", true); (Outcome { j, code }, all) }
        Err((stage, msg)) => (fail(j, stage, &msg), all),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_inner(a: &Args, j: &mut Json, sid: &Sid, grants: &mut GrantSet, exe: &str, cmdline: &str, cwd: &str, out_path: &str, err_path: &str, private_desktop: Option<Vec<u16>>, #[cfg(feature = "experiment")] desk: &desk::Desk) -> Result<i32, (&'static str, String)> {
    // The product never starts a child without its private desktop (the stage is `grant`, the message starts with "window objects:": the stage list stays as it is).
    if private_wanted(a) && private_desktop.is_none() { return Err(("grant", "window objects: no private window station was made for this run".into())); }
    // Stage `grant`: an entry on a window object is a grant too (the message starts with "window objects:"; the product's stage list stays as it is).
    #[cfg(feature = "experiment")]
    if let Some(e) = &desk.failed { return Err(("grant", e.clone())); }
    // 1. Grants. A hard grant that fails stops the run before anything starts. A soft grant that fails is recorded and the run goes on.
    for spec in &a.grants {
        grants.items.push(GrantRecord { spec: spec.clone(), applied: false, revoked: false, error: None });
        let last = grants.items.len() - 1;
        match change_ace(&spec.path, sid.0, spec.mode, false) {
            Ok(()) => grants.items[last].applied = true,
            Err(e) => { grants.items[last].error = Some(e); if !spec.soft { return Err(("grant", format!("grant {} on a required path failed: {e}", spec.mode.name()))); } }
        }
    }
    if !a.dump.is_empty() { j.raw("daclsBefore", dump_json(&a.dump)); }
    // 2. The job, the three standard handles, the environment.
    let job = make_job(a).map_err(|e| ("job", e))?;
    // Standard input: NUL read-only (default), NUL read-write, a real file, an empty pipe (end of input at once) or a pipe held open until the child ends.
    let mut _stdin_keep: Option<Handle> = None;
    let nul = match a.stdin.as_str() {
        "nul" => open_inheritable("NUL", false),
        "nul-rw" => open_nul_rw(),
        "pipe" | "pipe-open" => make_pipe(false).map(|(r, w)| { if a.stdin == "pipe-open" { _stdin_keep = Some(w); } r }),
        other => open_inheritable(other.trim_start_matches("file:"), false),
    }.map_err(|e| ("stdio", e))?;
    // Standard output and error: the file itself, or an anonymous pipe that a launcher thread copies into the file.
    let mut drains: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut open_output = |path: &str, piped: bool, nul_rw: bool| -> Result<Handle, String> {
        if nul_rw { return open_nul_rw(); }
        if !piped { return open_inheritable(path, true); }
        let (r, w) = make_pipe(true)?;
        drains.push(drain_pipe(r, path.to_string()));
        Ok(w)
    };
    let out = open_output(out_path, a.stdout_pipe, a.stdout_nul).map_err(|e| ("stdio", e))?;
    let err = open_output(err_path, a.stderr_pipe, a.stderr_nul).map_err(|e| ("stdio", e))?;
    let env = env_block(&a.env);

    // 3. The attribute list: security capabilities (the container, no capability), the all-application-packages policy, the
    //    mitigation policy, the job list, and the list of handles the child may inherit. The values must outlive CreateProcessW.
    let cap_sids = resolve_capabilities(&a.capabilities).map_err(|e| ("capability", e))?;
    let mut cap_list: Vec<SID_AND_ATTRIBUTES> = cap_sids.sids.iter().map(|s| SID_AND_ATTRIBUTES { Sid: *s, Attributes: SE_GROUP_ENABLED_BIT }).collect();
    j.raw("capabilities", format!("[{}]", cap_sids.described.iter().map(|(n, s)| { let mut c = Json::new(); c.s("name", n); c.s("sid", s); c.render() }).collect::<Vec<_>>().join(",")));
    let mut caps = SECURITY_CAPABILITIES { AppContainerSid: sid.0, Capabilities: if cap_list.is_empty() { null_mut() } else { cap_list.as_mut_ptr() }, CapabilityCount: cap_list.len() as u32, Reserved: 0 };
    let mut aap: u32 = a.aap.unwrap_or(AAP_OPT_IN);
    let mut mitigation: u64 = WIN32K_DISABLE_ALWAYS_ON;
    let mut job_list: [HANDLE; 1] = [job.0];
    let mut inherit: [HANDLE; 3] = [nul.0, out.0, err.0];
    let count = 3 + usize::from(a.aap.is_some()) + usize::from(a.win32k_off);
    let mut size = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), count as u32, 0, &mut size); // the first call only reports the size
        if size == 0 { return Err(("attributes", format!("InitializeProcThreadAttributeList size query failed: {}", GetLastError()))); }
        // usize elements: the opaque list holds pointer-sized fields, so its buffer is pointer-aligned (a Vec<u8> promises only 1-byte alignment).
        let mut buf = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(list, count as u32, 0, &mut size) == 0 { return Err(("attributes", format!("InitializeProcThreadAttributeList failed: {}", GetLastError()))); }
        let update = |attr: usize, p: *mut c_void, len: usize, what: &str| -> Result<(), (&'static str, String)> {
            if UpdateProcThreadAttribute(list, 0, attr, p, len, null_mut(), null()) == 0 { Err(("attributes", format!("UpdateProcThreadAttribute({what}) failed: {}", GetLastError()))) } else { Ok(()) }
        };
        let built = (|| {
            update(ATTR_SECURITY_CAPABILITIES, &mut caps as *mut _ as *mut c_void, size_of::<SECURITY_CAPABILITIES>(), "security capabilities")?;
            if a.aap.is_some() { update(ATTR_ALL_APPLICATION_PACKAGES_POLICY, &mut aap as *mut _ as *mut c_void, size_of::<u32>(), "all application packages policy")?; }
            if a.win32k_off { update(ATTR_MITIGATION_POLICY, &mut mitigation as *mut _ as *mut c_void, size_of::<u64>(), "mitigation policy")?; }
            update(ATTR_JOB_LIST, job_list.as_mut_ptr() as *mut c_void, size_of::<HANDLE>() * job_list.len(), "job list")?;
            update(ATTR_HANDLE_LIST, inherit.as_mut_ptr() as *mut c_void, size_of::<HANDLE>() * inherit.len(), "handle list")?;
            Ok(())
        })();
        if let Err(e) = built { DeleteProcThreadAttributeList(list); return Err(e); }

        let mut si: STARTUPINFOEXW = zeroed();
        si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = nul.0; si.StartupInfo.hStdOutput = out.0; si.StartupInfo.hStdError = err.0;
        si.lpAttributeList = list;
        // lpDesktop: `station\desktop` of the private objects made for this run (the product always has them: see the check at the top). Without it the child would take the launcher's own
        // window station, which for a service is a non-interactive one the container has no access to (0xC0000142). Round 5 (experiment build) can pass an empty string, a named station and
        // desktop, or the made ones instead.
        let mut lp_desktop: Vec<u16> = private_desktop.unwrap_or_default();
        #[cfg(feature = "experiment")]
        if lp_desktop.is_empty() { lp_desktop = desk.lp_desktop.clone().unwrap_or_default(); }
        if !lp_desktop.is_empty() { si.StartupInfo.lpDesktop = lp_desktop.as_mut_ptr(); }
        let wexe = wide(exe);
        let mut wcmd = wide(cmdline); // CreateProcessW may write into this buffer
        let wcwd = wide(cwd);
        let mut pi: PROCESS_INFORMATION = zeroed();
        let started = Instant::now();
        let ok = CreateProcessW(wexe.as_ptr(), wcmd.as_mut_ptr(), null(), null(), 1, creation_flags(a), env.as_ptr() as *const c_void, wcwd.as_ptr(), &si.StartupInfo, &mut pi);
        let create_error = GetLastError();
        DeleteProcThreadAttributeList(list);
        if ok == 0 { return Err(("create-process", format!("CreateProcessW failed: {create_error}"))); }
        let process = Handle(pi.hProcess);
        let _thread = Handle(pi.hThread);
        // The launcher's copies of the output pipes' write ends must go now, or the drain threads would never see the end of the output.
        if a.stdout_pipe { drop(out); }
        if a.stderr_pipe { drop(err); }
        j.b("childStarted", true);
        j.n("childPid", pi.dwProcessId as i64);

        let waited = WaitForSingleObject(process.0, a.timeout_ms);
        let timed_out = waited == WAIT_TIMEOUT;
        if timed_out {
            #[cfg(feature = "experiment")]
            j.raw("hang", hang_report(process.0, job.0, pi.dwProcessId));
            TerminateJobObject(job.0, 1);
            WaitForSingleObject(process.0, 5000);
        }
        let leftover = active_processes(job.0);
        let mut code = 0u32;
        GetExitCodeProcess(process.0, &mut code);
        if leftover != 0 { TerminateJobObject(job.0, 1); } // the program ended but left processes behind: end them too
        for d in drains.drain(..) { let _ = d.join(); } // every write end is closed by now (the job is ended), so the copies finish
        if !a.dump.is_empty() { j.raw("daclsAfter", dump_json(&a.dump)); }
        j.s("stdin", &a.stdin);
        j.b("stdoutPipe", a.stdout_pipe);
        j.b("stderrPipe", a.stderr_pipe);
        j.n("elapsedMs", started.elapsed().as_millis() as i64);
        j.b("timedOut", timed_out);
        j.n("leftoverProcesses", leftover);
        j.n("childExitCode", code as i32 as i64);
        j.n("stdoutBytes", file_size(out_path));
        j.n("stderrBytes", file_size(err_path));
        if waited != WAIT_OBJECT_0 && !timed_out { return Err(("wait", format!("WaitForSingleObject returned {waited}"))); }
        Ok(if timed_out { EXIT_TIMED_OUT } else { code as i32 })
    }
}

/// The process creation flags: the product always uses CREATE_NO_WINDOW; the experiment build can use another console flag (round 5).
fn creation_flags(a: &Args) -> u32 {
    let base = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    #[cfg(feature = "experiment")]
    { base | match a.creation { Creation::NoWindow => CREATE_NO_WINDOW, Creation::Detached => DETACHED_PROCESS, Creation::NoFlag => 0, Creation::NewConsole => CREATE_NEW_CONSOLE } }
    #[cfg(not(feature = "experiment"))]
    { let _ = a; base | CREATE_NO_WINDOW }
}

#[cfg(feature = "experiment")]
/// FILETIME pairs of a process or thread as milliseconds of kernel and user CPU time.
fn cpu_ms(kernel: FILETIME, user: FILETIME) -> (i64, i64) {
    let ms = |f: FILETIME| (((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) / 10_000) as i64;
    (ms(kernel), ms(user))
}

/// A short diagnosis of a child that did not end in time, taken BEFORE the job is ended: is it still alive, how many processes does the job hold, how much CPU
/// time did the process and each of its threads use, and did any thread use CPU in the one second between two samples (busy) or none (waiting). It cannot
/// name what a thread waits on (that needs a debugger or the system information calls this launcher does not use); no CPU in a second means it is waiting.
#[cfg(feature = "experiment")]
fn hang_report(process: HANDLE, job: HANDLE, pid: u32) -> String {
    unsafe {
        let mut h = Json::new();
        let mut code = 0u32;
        h.b("stillActive", GetExitCodeProcess(process, &mut code) != 0 && code == 259 /* STILL_ACTIVE */);
        h.n("jobProcesses", active_processes(job));
        let sample = || -> Vec<(u32, i64)> {
            let mut out = Vec::new();
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap == INVALID_HANDLE_VALUE { return out; }
            let _g = Handle(snap);
            let mut e: THREADENTRY32 = zeroed();
            e.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut more = Thread32First(snap, &mut e) != 0;
            while more {
                if e.th32OwnerProcessID == pid {
                    let t = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, e.th32ThreadID);
                    if !t.is_null() {
                        let _t = Handle(t);
                        let (mut c, mut x, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = (zeroed(), zeroed(), zeroed(), zeroed());
                        if GetThreadTimes(t, &mut c, &mut x, &mut k, &mut u) != 0 { let (kk, uu) = cpu_ms(k, u); out.push((e.th32ThreadID, kk + uu)); }
                    }
                }
                more = Thread32Next(snap, &mut e) != 0;
            }
            out
        };
        let (mut c, mut x, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = (zeroed(), zeroed(), zeroed(), zeroed());
        if GetProcessTimes(process, &mut c, &mut x, &mut k, &mut u) != 0 { let (kk, uu) = cpu_ms(k, u); h.n("processKernelMs", kk); h.n("processUserMs", uu); }
        let first = sample();
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let second = sample();
        h.n("threads", second.len() as i64);
        let busy = second.iter().filter(|(id, ms)| first.iter().any(|(i, m)| i == id && ms > m)).count();
        h.n("threadsBusyInOneSecond", busy as i64);
        let top: Vec<String> = second.iter().take(8).map(|(id, ms)| format!("{id}:{ms}ms")).collect();
        h.s("threadCpu", &top.join(" "));
        h.render()
    }
}

fn describe(a: &Args, mut j: Json) -> Json {
    j.b("lpac", a.aap == Some(AAP_OPT_OUT));
    j.s("aapPolicy", match a.aap { None => "none", Some(AAP_OPT_OUT) => "optout", _ => "optin" });
    j.b("win32kOff", a.win32k_off);
    j.b("killOnClose", a.kill_on_close);
    j.n("memoryMb", a.memory_mb as i64);
    j.n("activeProcessLimit", a.active_processes as i64);
    j.b("uiLimits", a.ui_limits);
    j.n("timeoutMs", a.timeout_ms as i64);
    j.s("profileName", &a.name);
    // The window station of the child: in the product it is `private` or `home-desktop` (see privdesk.rs); the line says which one only once the objects were made (or refused), so an early failure
    // claims neither. The experiment build names its own mode here.
    #[cfg(feature = "experiment")]
    j.s("windowStation", a.desktop.name());
    #[cfg(feature = "experiment")]
    j.s("creation", a.creation.name());
    j
}

// ---------------------------------------------------------------------------------------------------------------- the NUL device open test

// The C runtime's own open (what git for Windows' mingw_open calls for "/dev/null"): declared here because windows-sys has no C runtime bindings.
#[cfg(feature = "experiment")]
extern "C" {
    fn _wopen(path: *const u16, oflag: i32, pmode: i32) -> i32;
    fn _close(fd: i32) -> i32;
    fn _errno() -> *mut i32;
}

#[cfg(feature = "experiment")]
/// `open-test`: meant to be started AS THE CHILD inside the container (run --exe <this program> --cmdline "<this program> open-test"). It opens the NUL device with the flag
/// combinations that git's start-up could use and prints the result of each (GetLastError, or the C runtime's errno) as one JSON line. It writes nothing and holds no secrets.
fn open_test() -> String {
    let mut results: Vec<String> = Vec::new();
    let mut add = |name: &str, ok: bool, code: i64, via: &str| {
        let mut o = Json::new();
        o.s("name", name);
        o.s("via", via);
        o.b("ok", ok);
        o.n("code", code);
        results.push(o.render());
    };
    let rw = GENERIC_READ | GENERIC_WRITE;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let share_del = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    let combos: [(&str, &str, u32, u32, u32); 12] = [
        ("NUL GENERIC_READ|GENERIC_WRITE share R|W NORMAL (the C runtime's O_RDWR)", "NUL", rw, share, FILE_ATTRIBUTE_NORMAL),
        ("NUL GENERIC_READ|GENERIC_WRITE share R|W|DELETE", "NUL", rw, share_del, FILE_ATTRIBUTE_NORMAL),
        ("NUL GENERIC_READ|GENERIC_WRITE no sharing", "NUL", rw, 0, FILE_ATTRIBUTE_NORMAL),
        ("NUL GENERIC_READ only", "NUL", GENERIC_READ, share, FILE_ATTRIBUTE_NORMAL),
        ("NUL GENERIC_WRITE only", "NUL", GENERIC_WRITE, share, FILE_ATTRIBUTE_NORMAL),
        ("NUL FILE_GENERIC_READ|FILE_GENERIC_WRITE (the launcher's own open)", "NUL", FILE_GENERIC_READ | FILE_GENERIC_WRITE, share, FILE_ATTRIBUTE_NORMAL),
        ("NUL FILE_READ_DATA|FILE_WRITE_DATA|SYNCHRONIZE", "NUL", FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, share, FILE_ATTRIBUTE_NORMAL),
        ("NUL FILE_READ_ATTRIBUTES only", "NUL", FILE_READ_ATTRIBUTES, share_del, FILE_ATTRIBUTE_NORMAL),
        ("NUL access 0 (query only)", "NUL", 0, share_del, FILE_ATTRIBUTE_NORMAL),
        ("NUL GENERIC_READ|GENERIC_WRITE, no attributes", "NUL", rw, share, 0),
        ("\\\\.\\NUL GENERIC_READ|GENERIC_WRITE share R|W", "\\\\.\\NUL", rw, share, FILE_ATTRIBUTE_NORMAL),
        ("\\\\.\\NUL GENERIC_READ|GENERIC_WRITE share R|W|DELETE", "\\\\.\\NUL", rw, share_del, FILE_ATTRIBUTE_NORMAL),
    ];
    for (name, path, access, sharing, flags) in combos {
        unsafe {
            let w = wide(path);
            let h = CreateFileW(w.as_ptr(), access, sharing, null(), OPEN_EXISTING, flags, null_mut());
            if h == INVALID_HANDLE_VALUE { add(name, false, GetLastError() as i64, "CreateFileW"); } else { CloseHandle(h); add(name, true, 0, "CreateFileW"); }
        }
    }
    // The same with an inheritable handle (security attributes with bInheritHandle set): what a descriptor that children may inherit is opened with.
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let w = wide("NUL");
        let h = CreateFileW(w.as_ptr(), rw, share, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());
        if h == INVALID_HANDLE_VALUE { add("NUL GENERIC_READ|GENERIC_WRITE share R|W, inheritable", false, GetLastError() as i64, "CreateFileW"); } else { CloseHandle(h); add("NUL GENERIC_READ|GENERIC_WRITE share R|W, inheritable", true, 0, "CreateFileW"); }
    }
    // The C runtime's _wopen with O_RDWR (2) and O_RDWR|O_BINARY (0x8002): the call git makes. The code is the C runtime's errno.
    for (name, flags) in [("_wopen(nul, O_RDWR)", 2i32), ("_wopen(nul, O_RDWR|O_BINARY)", 0x8002i32), ("_wopen(nul, O_RDONLY)", 0i32), ("_wopen(nul, O_WRONLY)", 1i32)] {
        unsafe {
            let w = wide("nul");
            let fd = _wopen(w.as_ptr(), flags, 0o600);
            if fd < 0 { let e = *_errno(); add(name, false, e as i64, "C runtime errno"); } else { _close(fd); add(name, true, 0, "C runtime"); }
        }
    }
    let mut j = Json::new();
    j.s("tool", TOOL);
    j.s("command", "open-test");
    j.b("ok", true);
    j.raw("opens", format!("[{}]", results.join(",")));
    j.render()
}

pub fn main() {
    let raw: Vec<String> = std::env::args().collect();
    #[cfg(feature = "experiment")]
    if raw.get(1).map(String::as_str) == Some("open-test") {
        println!("{}", open_test());
        std::process::exit(0);
    }
    #[cfg(feature = "experiment")]
    if raw.get(1).map(String::as_str) == Some("ui-test") {
        println!("{}", home::ui_test());
        std::process::exit(0);
    }
    #[cfg(feature = "experiment")]
    if raw.get(1).map(String::as_str) == Some("deelevate") {
        std::process::exit(home::deelevate(&raw[2..]));
    }
    let mut j = Json::new();
    j.s("tool", TOOL);
    j.n("version", 1);
    let a = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => { let o = fail(j, "arguments", &e); println!("{}", o.j.render()); std::process::exit(o.code); }
    };
    #[cfg(feature = "experiment")]
    if a.command == "home-probe" { std::process::exit(home::home_probe(&a)); }
    j.s("command", &a.command);
    j.b("elevated", is_elevated());
    j.n("sessionId", session_id());
    let j = describe(&a, j);
    let outcome = match a.command.as_str() {
        "info" => {
            let mut j = j;
            if profile::is_run_name(&a.name) {
                // The product's `info` makes a throw-away per-run profile exactly as a run does (record first, then the profile), asks the private window station question, and deletes the profile again.
                let Some(record) = a.profile_record.as_deref() else { finish_main(fail(j, "arguments", "info with a per-run profile needs --profile-record")) };
                match ProfileLife::begin(&a.name, record) {
                    Err(e) => fail(j, "container", &e),
                    Ok((sid, life)) => {
                        j.s("containerSid", &life.sid_text); j.s("profile", "created");
                        let station = if private_wanted(&a) { report_private_station(&mut j, sid.0) } else { Ok(()) };
                        life.finish(&mut j, true);
                        match station { Err(e) => fail(j, "grant", &e), Ok(()) => { j.b("ok", true); Outcome { j, code: 0 } } }
                    }
                }
            } else {
                match container_sid(&a.name) {
                    Ok((sid, created)) => {
                        j.s("containerSid", &sid_string(sid.0)); j.s("profile", if created { "created" } else { "reused" });
                        // A host that cannot make the private window station cannot run a confined program: `info` says so (stage `grant`, "window objects: ...") instead of the first run failing.
                        if private_wanted(&a) { if let Err(e) = report_private_station(&mut j, sid.0) { finish_main(fail(j, "grant", &e)); } }
                        j.b("ok", true); Outcome { j, code: 0 }
                    }
                    Err(e) => fail(j, "container", &e),
                }
            }
        }
        "run" => run(&a, j),
        #[cfg(feature = "experiment")]
        "context" => {
            // Read-only: where the launcher itself runs (window station, desktop, session, integrity, OS build). No container is made.
            let mut j = j;
            desk::context(&mut j);
            j.b("ok", true);
            Outcome { j, code: 0 }
        }
        #[cfg(feature = "experiment")]
        "home-revoke" => {
            // Removes the container's explicit entries from WinSta0 (after a killed `--desktop home-desktop-station-*` run); the SID is derived from the name, no profile is made. The same proof as
            // delete-profile (homerules::may_revoke): a per-run name and the record this launcher wrote for it, naming that profile and the SID the name derives to. Without it nothing is written.
            let mut j = j;
            match desk::derived_sid(&a.name) {
                Err(e) => fail(j, "container", &e),
                Ok(sid) => {
                    let text = sid_string(sid.0);
                    let record = a.profile_record.as_deref().and_then(|p| std::fs::read_to_string(p).ok());
                    j.s("containerSid", &text);
                    match crate::homerules::may_revoke(&a.name, record.as_deref(), &text) {
                        Err(e) => fail(j, "profile", &e),
                        Ok(()) => { let ok = home::home_revoke(&mut j, sid.0); j.b("ok", ok); Outcome { j, code: if ok { 0 } else { EXIT_LAUNCHER_FAILED } } }
                    }
                }
            }
        }
        #[cfg(feature = "experiment")]
        "desktop-revoke" => {
            // Removes the container's explicit entries from the launcher's current window station and desktop (after a killed `--desktop grant-*` run). The SID is derived from the name:
            // this command never creates a profile.
            let mut j = j;
            match desk::derived_sid(&a.name) {
                Err(e) => fail(j, "container", &e),
                Ok(sid) => { let ok = desk::revoke_current(&mut j, sid.0); j.b("ok", ok); Outcome { j, code: if ok { 0 } else { EXIT_LAUNCHER_FAILED } } }
            }
        }
        "revoke" => {
            // Removes the container's explicit entries from each --grant path (for cleanup after a crashed run). A per-run name is only DERIVED to its SID (no profile is made, and the profile
            // may be gone already: the entries for its SID are still there to remove).
            let mut j = j;
            match sid_for_entries(&a) {
                Err(e) => fail(j, "container", &e),
                Ok(sid) => {
                    j.s("containerSid", &sid_string(sid.0));
                    let mut set = GrantSet { sid: sid.0, items: a.grants.iter().map(|s| GrantRecord { spec: s.clone(), applied: true, revoked: false, error: None }).collect() };
                    set.revoke_all();
                    j.raw("grants", set.json());
                    let all = set.items.iter().all(|g| g.revoked);
                    j.b("ok", all);
                    Outcome { j, code: if all { 0 } else { EXIT_LAUNCHER_FAILED } }
                }
            }
        }
        #[cfg(feature = "experiment")]
        "grant" => {
            // Applies each --grant and LEAVES the entries in place (for the junction experiment: grant, check what the targets inherited, then revoke). A failed grant is reported.
            let mut j = j;
            match container_sid(&a.name) {
                Err(e) => fail(j, "container", &e),
                Ok((sid, _)) => {
                    let mut set = GrantSet { sid: sid.0, items: Vec::new() };
                    for spec in &a.grants {
                        let r = change_ace(&spec.path, sid.0, spec.mode, false);
                        set.items.push(GrantRecord { spec: spec.clone(), applied: r.is_ok(), revoked: false, error: r.err() });
                    }
                    j.raw("grants", set.json());
                    let all = set.items.iter().all(|g| g.applied);
                    j.b("ok", all);
                    std::mem::forget(set); // no revoke on the way out: that is the point of this command
                    Outcome { j, code: if all { 0 } else { EXIT_LAUNCHER_FAILED } }
                }
            }
        }
        "check" => {
            // Read-only: how many explicit entries for the container remain on each --grant path (the read-back used after a run).
            let mut j = j;
            match sid_for_entries(&a) {
                Err(e) => fail(j, "container", &e),
                Ok(sid) => {
                    j.s("containerSid", &sid_string(sid.0));
                    let set = GrantSet { sid: sid.0, items: a.grants.iter().map(|s| GrantRecord { spec: s.clone(), applied: false, revoked: false, error: None }).collect() };
                    j.raw("grants", set.json());
                    let clean = a.grants.iter().all(|s| matches!(explicit_count(&s.path, sid.0), Ok(0)));
                    // Reported only: the read-back after a run does not depend on it.
                    if private_wanted(&a) && !profile::is_run_name(&a.name) { let _ = report_private_station(&mut j, sid.0); }
                    j.b("ok", true);
                    j.b("clean", clean);
                    Outcome { j, code: 0 }
                }
            }
        }
        #[cfg(feature = "experiment")]
        "dump" => {
            // Read-only: the DACL of each --dump path as SDDL.
            let mut j = j;
            j.raw("dacls", dump_json(&a.dump));
            j.b("ok", true);
            Outcome { j, code: 0 }
        }
        "delete-profile" => {
            let mut j = j;
            if profile::is_run_name(&a.name) {
                // The only profiles this command deletes are per-run ones with a record this launcher wrote: the name has the per-run form, the record file holds this name and the SID the name
                // derives to, and the SID the supervisor passed is the same (profile.rs may_delete). Nothing is listed or searched: the profile is named, and proven, or left alone.
                let derived = match derived_sid(&a.name) { Ok(s) => s, Err(e) => finish_main(fail(j, "container", &e)) };
                let text = sid_string(derived.0);
                let record = a.profile_record.as_deref().and_then(|p| std::fs::read_to_string(p).ok());
                j.s("containerSid", &text);
                match profile::may_delete(&a.name, record.as_deref(), &text, a.sid.as_deref()) {
                    Err(e) => fail(j, "profile", &e),
                    Ok(()) => { let ended = delete_profile_verified(&a.name, &text); report_ended(&mut j, &ended); j.b("ok", ended.deleted && ended.gone); Outcome { j, code: if ended.deleted && ended.gone { 0 } else { EXIT_LAUNCHER_FAILED } } }
                }
            } else {
                #[cfg(feature = "experiment")]
                {
                    let hr = unsafe { DeleteAppContainerProfile(wide(&a.name).as_ptr()) };
                    j.b("ok", hr == 0);
                    j.n("hresult", hr as i64);
                    Outcome { j, code: if hr == 0 { 0 } else { EXIT_LAUNCHER_FAILED } }
                }
                #[cfg(not(feature = "experiment"))]
                { fail(j, "arguments", "delete-profile deletes only per-run profiles in this build") }
            }
        }
        other => fail(j, "arguments", &format!("unknown command {other}")),
    };
    finish_main(outcome)
}

fn finish_main(outcome: Outcome) -> ! {
    println!("{}", outcome.j.render());
    std::process::exit(outcome.code);
}
