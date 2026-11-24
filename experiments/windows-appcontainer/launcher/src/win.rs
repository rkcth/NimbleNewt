// The Windows part of the launcher. See ../README.md for the list of Win32 calls and what each is for.
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
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::*;

// Attribute numbers (the ProcThreadAttributeValue results documented for each PROC_THREAD_ATTRIBUTE_*), written out so a header
// that lacks one cannot change the meaning.
const ATTR_MITIGATION_POLICY: usize = 0x0002_0007;
const ATTR_SECURITY_CAPABILITIES: usize = 0x0002_0009;
const ATTR_HANDLE_LIST: usize = 0x0002_0002;
const ATTR_JOB_LIST: usize = 0x0002_000D;
const ATTR_ALL_APPLICATION_PACKAGES_POLICY: usize = 0x0002_000F;
// PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT / _OPT_IN
const AAP_OPT_OUT: u32 = 0x1;
const AAP_OPT_IN: u32 = 0x0;
// PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON (1 << 28)
const WIN32K_DISABLE_ALWAYS_ON: u64 = 1u64 << 28;
const HR_ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
const SE_GROUP_ENABLED_BIT: u32 = 0x4; // SE_GROUP_ENABLED: the attribute of a capability SID in SECURITY_CAPABILITIES
const EXIT_LAUNCHER_FAILED: i32 = 125;
const EXIT_TIMED_OUT: i32 = 124;

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

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode { Ro, Rx, Modify, DenyWrite }

impl Mode {
    fn parse(s: &str) -> Option<Mode> {
        match s { "ro" => Some(Mode::Ro), "rx" => Some(Mode::Rx), "modify" => Some(Mode::Modify), "deny-write" => Some(Mode::DenyWrite), _ => None }
    }
    fn name(self) -> &'static str {
        match self { Mode::Ro => "ro", Mode::Rx => "rx", Mode::Modify => "modify", Mode::DenyWrite => "deny-write" }
    }
    fn mask(self) -> u32 {
        match self {
            Mode::Ro => FILE_GENERIC_READ,
            Mode::Rx => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            Mode::Modify => FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
            // What a protected name must not allow: writes, appends, attribute writes, delete, and delete-child on a folder.
            Mode::DenyWrite => FILE_GENERIC_WRITE & !SYNCHRONIZE & !READ_CONTROL | DELETE | FILE_DELETE_CHILD,
        }
    }
}

#[derive(Clone, Debug)]
struct GrantSpec { mode: Mode, path: String, soft: bool }

#[derive(Default, Debug)]
struct Args {
    command: String,
    name: String,
    exe: Option<String>,
    cmdline: Option<String>,
    cwd: Option<String>,
    stdout: Option<String>,
    stderr: Option<String>,
    env: Vec<(String, String)>,
    grants: Vec<GrantSpec>,
    aap: Option<u32>, // None: the policy attribute is not set at all
    win32k_off: bool,
    kill_on_close: bool,
    memory_mb: u64,
    active_processes: u32,
    ui_limits: bool,
    timeout_ms: u32,
    keep_profile: bool,
    capabilities: Vec<String>, // names or SID strings, in the order given (repeatable --capability)
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut a = Args { name: "NimbleNewtExperiment".into(), kill_on_close: true, timeout_ms: 120_000, ..Default::default() };
    let mut it = raw.iter().skip(1);
    a.command = it.next().cloned().ok_or("no command (run, info, revoke, check, delete-profile)")?;
    while let Some(flag) = it.next() {
        let mut value = |what: &str| -> Result<String, String> { it.next().cloned().ok_or(format!("{what} needs a value")) };
        match flag.as_str() {
            "--name" => a.name = value("--name")?,
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
                let mode = Mode::parse(m).ok_or("grant mode must be ro, rx, modify or deny-write")?;
                a.grants.push(GrantSpec { mode, path: p.to_string(), soft: flag == "--grant-soft" });
            }
            // none: no attribute (a plain AppContainer). optout: the LPAC form. optin: the attribute present with the default value.
            "--aap-policy" => a.aap = match value("--aap-policy")?.as_str() { "none" => None, "optout" => Some(AAP_OPT_OUT), "optin" => Some(AAP_OPT_IN), _ => return Err("--aap-policy: none, optout or optin".into()) },
            "--win32k-off" => a.win32k_off = true,
            "--no-kill-on-close" => a.kill_on_close = false,
            "--memory-mb" => a.memory_mb = value("--memory-mb")?.parse().map_err(|_| "--memory-mb is not a number")?,
            "--active-processes" => a.active_processes = value("--active-processes")?.parse().map_err(|_| "--active-processes is not a number")?,
            "--ui-limits" => a.ui_limits = true,
            "--timeout-ms" => a.timeout_ms = value("--timeout-ms")?.parse().map_err(|_| "--timeout-ms is not a number")?,
            "--keep-profile" => a.keep_profile = true,
            "--capability" => { let c = value("--capability")?; if c.is_empty() { return Err("--capability is empty".into()); } a.capabilities.push(c); }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(a)
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
unsafe fn explicit_aces(acl: *const ACL, sid: PSID) -> u32 {
    if acl.is_null() { return 0; }
    let mut n = 0;
    for i in 0..(*acl).AceCount as u32 {
        let mut ace: *mut c_void = null_mut();
        if GetAce(acl, i, &mut ace) == 0 || ace.is_null() { continue; }
        let header = &*(ace as *const ACE_HEADER);
        if header.AceType != ACE_TYPE_ALLOWED && header.AceType != ACE_TYPE_DENIED { continue; }
        if header.AceFlags & ACE_FLAG_INHERITED != 0 { continue; }
        // ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE share one layout: header, mask, then the SID starting at SidStart.
        let ace_sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID;
        if EqualSid(ace_sid, sid) != 0 { n += 1; }
    }
    n
}

/// The number of explicit entries for the SID on a path (Err: the Win32 error of GetNamedSecurityInfoW).
fn explicit_count(path: &str, sid: PSID) -> Result<u32, u32> {
    unsafe {
        let wpath = wide(path);
        let mut acl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetNamedSecurityInfoW(wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        let n = explicit_aces(acl, sid);
        LocalFree(sd as *mut c_void);
        Ok(n)
    }
}

/// Removes EVERY explicit (non-inherited) allow or deny entry that names the SID from the DACL, by building a copy of the ACL and deleting those entries
/// from it (DeleteAce, highest index first). The first round used SetEntriesInAcl with REVOKE_ACCESS, which left the container's deny entry on the
/// protected `.git` folder in place on the hosted runner (read-back: still present, error 0x20000001); removing entries by hand does not depend on the mode.
/// Returns Ok(true) when something was written.
unsafe fn remove_explicit(wpath: &[u16], old: *const ACL, sid: PSID) -> Result<bool, u32> {
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
    let rc = SetNamedSecurityInfoW(wpath.as_ptr() as *mut u16, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), copy, null_mut());
    if rc != 0 { return Err(rc); }
    Ok(true)
}

/// Adds (GRANT_ACCESS / DENY_ACCESS) or removes (a revoke) the container's explicit entries on a folder or file. Returns a Win32 error code.
/// A revoke on a path whose DACL holds no explicit entry for the container writes nothing (so it needs no rights and is idempotent), and a revoke
/// that wrote is checked by reading the DACL back: an entry still there is an error, never a success.
fn change_ace(path: &str, sid: PSID, mode: Mode, revoke: bool) -> Result<(), u32> {
    unsafe {
        let wpath = wide(path);
        let mut old: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetNamedSecurityInfoW(wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut old, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        if revoke {
            let none = old.is_null() || explicit_aces(old, sid) == 0;
            let written = if none { Ok(false) } else { remove_explicit(&wpath, old, sid) };
            LocalFree(sd as *mut c_void);
            written?;
            return match explicit_count(path, sid) { Ok(0) => Ok(()), Ok(_) => Err(ERR_STILL_PRESENT), Err(e) => Err(e) };
        }
        let mut ea: EXPLICIT_ACCESS_W = zeroed();
        ea.grfAccessPermissions = mode.mask();
        ea.grfAccessMode = if mode == Mode::DenyWrite { DENY_ACCESS } else { GRANT_ACCESS };
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
    fn revoke_all(&mut self) {
        for g in self.items.iter_mut().rev() {
            if g.applied && !g.revoked {
                match change_ace(&g.spec.path, self.sid, g.spec.mode, true) { Ok(()) => g.revoked = true, Err(e) => g.error = Some(e) }
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

fn file_size(path: &str) -> i64 { std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(-1) }

/// The child's environment: only what --env named (nothing is inherited), sorted by name as Windows expects.
fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_uppercase());
    let mut b: Vec<u16> = Vec::new();
    for (k, v) in sorted {
        b.extend(OsStr::new(&format!("{k}={v}")).encode_wide());
        b.push(0);
    }
    if b.is_empty() { b.push(0); }
    b.push(0);
    b
}

// ---------------------------------------------------------------------------------------------------------------- run

struct Outcome { j: Json, code: i32 }

fn fail(mut j: Json, stage: &str, msg: &str) -> Outcome {
    // childStarted stays true when the child did start (for example a failed wait): only a missing value becomes false.
    if !j.0.iter().any(|(k, _)| k == "childStarted") { j.b("childStarted", false); }
    j.b("ok", false); j.s("stage", stage); j.s("error", msg);
    Outcome { j, code: EXIT_LAUNCHER_FAILED }
}

fn run(a: &Args, j: Json) -> Outcome {
    let mut j = j;
    let (sid, created) = match container_sid(&a.name) { Ok(v) => v, Err(e) => return fail(j, "container", &e) };
    j.s("containerSid", &sid_string(sid.0));
    j.s("profile", if created { "created" } else { "reused" });
    let (Some(exe), Some(cmdline), Some(cwd)) = (a.exe.as_deref(), a.cmdline.as_deref(), a.cwd.as_deref()) else { return fail(j, "arguments", "run needs --exe, --cmdline and --cwd") };
    let (Some(out_path), Some(err_path)) = (a.stdout.as_deref(), a.stderr.as_deref()) else { return fail(j, "arguments", "run needs --stdout and --stderr") };

    let mut grants = GrantSet { sid: sid.0, items: Vec::new() };
    let result = run_inner(a, &mut j, &sid, &mut grants, exe, cmdline, cwd, out_path, err_path);
    grants.revoke_all();
    j.raw("grants", grants.json());
    j.b("allGrantsRevoked", grants.items.iter().all(|g| !g.applied || g.revoked));
    match result {
        Ok(code) => { j.b("ok", true); Outcome { j, code } }
        Err((stage, msg)) => fail(j, stage, &msg),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_inner(a: &Args, j: &mut Json, sid: &Sid, grants: &mut GrantSet, exe: &str, cmdline: &str, cwd: &str, out_path: &str, err_path: &str) -> Result<i32, (&'static str, String)> {
    // 1. Grants. A hard grant that fails stops the run before anything starts. A soft grant that fails is recorded and the run goes on.
    for spec in &a.grants {
        grants.items.push(GrantRecord { spec: spec.clone(), applied: false, revoked: false, error: None });
        let last = grants.items.len() - 1;
        match change_ace(&spec.path, sid.0, spec.mode, false) {
            Ok(()) => grants.items[last].applied = true,
            Err(e) => { grants.items[last].error = Some(e); if !spec.soft { return Err(("grant", format!("grant {} on a required path failed: {e}", spec.mode.name()))); } }
        }
    }
    // 2. The job, the three standard handles, the environment.
    let job = make_job(a).map_err(|e| ("job", e))?;
    let nul = open_inheritable("NUL", false).map_err(|e| ("stdio", e))?;
    let out = open_inheritable(out_path, true).map_err(|e| ("stdio", e))?;
    let err = open_inheritable(err_path, true).map_err(|e| ("stdio", e))?;
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
        let wexe = wide(exe);
        let mut wcmd = wide(cmdline); // CreateProcessW may write into this buffer
        let wcwd = wide(cwd);
        let mut pi: PROCESS_INFORMATION = zeroed();
        let started = Instant::now();
        let ok = CreateProcessW(wexe.as_ptr(), wcmd.as_mut_ptr(), null(), null(), 1, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env.as_ptr() as *const c_void, wcwd.as_ptr(), &si.StartupInfo, &mut pi);
        let create_error = GetLastError();
        DeleteProcThreadAttributeList(list);
        if ok == 0 { return Err(("create-process", format!("CreateProcessW failed: {create_error}"))); }
        let process = Handle(pi.hProcess);
        let _thread = Handle(pi.hThread);
        j.b("childStarted", true);
        j.n("childPid", pi.dwProcessId as i64);

        let waited = WaitForSingleObject(process.0, a.timeout_ms);
        let timed_out = waited == WAIT_TIMEOUT;
        if timed_out { j.raw("hang", hang_report(process.0, job.0, pi.dwProcessId)); TerminateJobObject(job.0, 1); WaitForSingleObject(process.0, 5000); }
        let leftover = active_processes(job.0);
        let mut code = 0u32;
        GetExitCodeProcess(process.0, &mut code);
        if leftover != 0 { TerminateJobObject(job.0, 1); } // the program ended but left processes behind: end them too
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

/// FILETIME pairs of a process or thread as milliseconds of kernel and user CPU time.
fn cpu_ms(kernel: FILETIME, user: FILETIME) -> (i64, i64) {
    let ms = |f: FILETIME| (((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) / 10_000) as i64;
    (ms(kernel), ms(user))
}

/// A short diagnosis of a child that did not end in time, taken BEFORE the job is ended: is it still alive, how many processes does the job hold, how much CPU
/// time did the process and each of its threads use, and did any thread use CPU in the one second between two samples (busy) or none (waiting). It cannot
/// name what a thread waits on (that needs a debugger or the system information calls this launcher does not use); no CPU in a second means it is waiting.
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
    j
}

pub fn main() {
    let raw: Vec<String> = std::env::args().collect();
    let mut j = Json::new();
    j.s("tool", "nn-appc-launcher");
    j.n("version", 1);
    let a = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => { let o = fail(j, "arguments", &e); println!("{}", o.j.render()); std::process::exit(o.code); }
    };
    j.s("command", &a.command);
    j.b("elevated", is_elevated());
    j.n("sessionId", session_id());
    let j = describe(&a, j);
    let outcome = match a.command.as_str() {
        "info" => {
            let mut j = j;
            match container_sid(&a.name) {
                Ok((sid, created)) => { j.s("containerSid", &sid_string(sid.0)); j.s("profile", if created { "created" } else { "reused" }); j.b("ok", true); Outcome { j, code: 0 } }
                Err(e) => fail(j, "container", &e),
            }
        }
        "run" => run(&a, j),
        "revoke" => {
            // Removes the container's explicit entries from each --grant path (for cleanup after a crashed run).
            let mut j = j;
            match container_sid(&a.name) {
                Err(e) => fail(j, "container", &e),
                Ok((sid, _)) => {
                    let mut set = GrantSet { sid: sid.0, items: a.grants.iter().map(|s| GrantRecord { spec: s.clone(), applied: true, revoked: false, error: None }).collect() };
                    set.revoke_all();
                    j.raw("grants", set.json());
                    let all = set.items.iter().all(|g| g.revoked);
                    j.b("ok", all);
                    Outcome { j, code: if all { 0 } else { EXIT_LAUNCHER_FAILED } }
                }
            }
        }
        "check" => {
            // Read-only: how many explicit entries for the container remain on each --grant path (the read-back used after a run).
            let mut j = j;
            match container_sid(&a.name) {
                Err(e) => fail(j, "container", &e),
                Ok((sid, _)) => {
                    let set = GrantSet { sid: sid.0, items: a.grants.iter().map(|s| GrantRecord { spec: s.clone(), applied: false, revoked: false, error: None }).collect() };
                    j.raw("grants", set.json());
                    let clean = a.grants.iter().all(|s| matches!(explicit_count(&s.path, sid.0), Ok(0)));
                    j.b("ok", true);
                    j.b("clean", clean);
                    Outcome { j, code: 0 }
                }
            }
        }
        "delete-profile" => {
            let mut j = j;
            let hr = unsafe { DeleteAppContainerProfile(wide(&a.name).as_ptr()) };
            j.b("ok", hr == 0);
            j.n("hresult", hr as i64);
            Outcome { j, code: if hr == 0 { 0 } else { EXIT_LAUNCHER_FAILED } }
        }
        other => fail(j, "arguments", &format!("unknown command {other}")),
    };
    println!("{}", outcome.j.render());
    std::process::exit(outcome.code);
}
