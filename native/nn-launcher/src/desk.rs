// Round 5 of the Windows AppContainer experiment (EXPERIMENT build only; this file is not compiled into the product launcher): the window station and the desktop of the child.
// A child that is created from a Windows service (session 0) and is not given a window station of its own takes the launcher's: a non-interactive one named `Service-0x0-<logon id>$` with
// the desktop `Default`. Own-hardware run 45634597880 (host build 26200, service, elevated) showed every container child that needs user32 ending with 0xC0000142 (STATUS_DLL_INIT_FAILED).
// One suspect is that the container's SID has no access to that window station and desktop; this file lets the experiment vary that ONE thing (see the notes, "round 5").
//
// What is changed, and how it is undone:
//   - `grant-*` modes add ONE explicit allow entry for the container's SID to the DACL of the launcher's current window station and/or desktop (the objects of this logon session,
//     opened by name with READ_CONTROL and WRITE_DAC), and take that entry out again on every path out (Drop), reading the DACL back; the count left is in the JSON line. The objects
//     last as long as the logon session that owns them; if this program is killed between the grant and the revoke, the entry stays until that session ends or `desktop-revoke` is run.
//     Refused (nothing written): an interactive or unreadable window station (WinSta0 of a signed-in session is never changed: deskrules::may_change_launcher_objects), a SID that is not
//     one AppContainer profile's (deskrules::is_profile_sid), and a NULL DACL (merging into it would replace "everyone" with one entry). The DACL is copied BEFORE the grant; after the
//     revoke it is compared entry by entry with that copy: the same entries in another order are put back from the copy, any other difference is reported and not written.
//   - `new-desktop` creates a desktop in the current window station (and grants the station); `new-station` creates a window station and a desktop in it, both with an entry for the container.
//     Both are closed when the run ends (an object with no handle left is destroyed). The launcher's process window station is switched for the moment of the desktop creation and switched back.
//   - Nothing is written to the registry, no persistent machine setting is touched.
use super::*;
use crate::args::DesktopMode;
use crate::deskrules::{self, AclCompare};
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Wdk::System::SystemServices::RtlGetVersion;

pub(crate) const READ_CONTROL_BIT: u32 = 0x0002_0000;
pub(crate) const WRITE_DAC_BIT: u32 = 0x0004_0000;
// Window station rights (Microsoft: Window Station Security and Access Rights). "read" is the documented GENERIC_READ mapping of a NON-interactive window station: READ_CONTROL,
// WINSTA_ENUMDESKTOPS (0x1), WINSTA_READATTRIBUTES (0x2), WINSTA_ENUMERATE (0x100). "full" is WINSTA_ALL_ACCESS (0x37F) plus READ_CONTROL.
pub(crate) const STATION_READ: u32 = READ_CONTROL_BIT | 0x0001 | 0x0002 | 0x0100;
pub(crate) const STATION_FULL: u32 = READ_CONTROL_BIT | 0x037F;
// Desktop rights: "read" is the documented GENERIC_READ mapping (READ_CONTROL, DESKTOP_READOBJECTS 0x1, DESKTOP_ENUMERATE 0x40); "full" is every DESKTOP_* right (0x1FF) plus READ_CONTROL.
pub(crate) const DESKTOP_READ: u32 = READ_CONTROL_BIT | 0x0001 | 0x0040;
pub(crate) const DESKTOP_FULL: u32 = READ_CONTROL_BIT | 0x01FF;
/// Private codes (outside the Win32 range used here): the object has a NULL DACL, so no entry is merged into it; the SID is not one AppContainer profile's.
pub(crate) const ERR_NULL_DACL: u32 = 0x2000_0002;
pub(crate) const ERR_NOT_PROFILE_SID: u32 = 0x2000_0003;

/// What one mode does: the level of the entry on the CURRENT station and desktop (None: no entry), whether to create objects, and what lpDesktop holds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Create { No, Desktop, Station }
#[derive(Clone, Copy, Debug)]
pub(crate) struct Plan { pub(crate) station: Option<u32>, pub(crate) desktop: Option<u32>, pub(crate) create: Create }

pub(crate) fn plan(mode: DesktopMode) -> Plan {
    match mode {
        DesktopMode::Inherit | DesktopMode::Empty | DesktopMode::Winsta0 => Plan { station: None, desktop: None, create: Create::No },
        DesktopMode::GrantRead => Plan { station: Some(STATION_READ), desktop: Some(DESKTOP_READ), create: Create::No },
        DesktopMode::GrantFull => Plan { station: Some(STATION_FULL), desktop: Some(DESKTOP_FULL), create: Create::No },
        DesktopMode::GrantStation => Plan { station: Some(STATION_FULL), desktop: None, create: Create::No },
        DesktopMode::GrantDesktop => Plan { station: None, desktop: Some(DESKTOP_FULL), create: Create::No },
        DesktopMode::NewDesktop => Plan { station: Some(STATION_FULL), desktop: None, create: Create::Desktop },
        DesktopMode::NewStation => Plan { station: None, desktop: None, create: Create::Station },
    }
}

fn log(msg: &str) { eprintln!("nn-desktop: {msg}"); }

/// The name of a window station or desktop handle (UOI_NAME), or "?".
fn object_name(h: HANDLE) -> String {
    unsafe {
        let mut buf = [0u16; 512];
        let mut needed = 0u32;
        if GetUserObjectInformationW(h, UOI_NAME, buf.as_mut_ptr() as *mut c_void, (buf.len() * 2) as u32, &mut needed) == 0 { return "?".into(); }
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }
}

/// The USEROBJECTFLAGS.dwFlags of a window station: bit 0 is WSF_VISIBLE, which only the interactive window station has. -1 when it cannot be read.
fn station_flags(h: HANDLE) -> i64 {
    unsafe {
        let mut buf = [0u32; 3]; // USEROBJECTFLAGS: fInherit (BOOL), fReserved (BOOL), dwFlags (DWORD)
        let mut needed = 0u32;
        if GetUserObjectInformationW(h, UOI_FLAGS, buf.as_mut_ptr() as *mut c_void, 12, &mut needed) == 0 { -1 } else { buf[2] as i64 }
    }
}

pub(crate) fn current_station_name() -> String { object_name(unsafe { GetProcessWindowStation() } as HANDLE) }
pub(crate) fn current_desktop_name() -> String { object_name(unsafe { GetThreadDesktop(GetCurrentThreadId()) } as HANDLE) }

/// The DACL of a window object as SDDL text ("error N" when it cannot be read). `h` needs READ_CONTROL.
fn object_sddl(h: HANDLE) -> String {
    unsafe {
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), null_mut(), &mut sd);
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

/// How many explicit entries for the SID the object's DACL holds (Err: the Win32 error).
fn object_entries(h: HANDLE, sid: PSID) -> Result<u32, u32> {
    unsafe {
        let mut acl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        let n = explicit_aces(acl, sid);
        LocalFree(sd as *mut c_void);
        Ok(n)
    }
}

/// Adds one explicit allow entry (no inheritance: these objects have no children that inherit) for the SID. `h` needs READ_CONTROL and WRITE_DAC.
fn add_entry(h: HANDLE, sid: PSID, mask: u32) -> Result<(), u32> {
    unsafe {
        let mut old: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut old, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        // A NULL DACL grants everyone everything; SetEntriesInAclW with no old ACL would make a DACL holding only this entry, which would shut everyone else out. Refused.
        if old.is_null() { LocalFree(sd as *mut c_void); return Err(ERR_NULL_DACL); }
        let mut ea: EXPLICIT_ACCESS_W = zeroed();
        ea.grfAccessPermissions = mask;
        ea.grfAccessMode = GRANT_ACCESS;
        ea.grfInheritance = 0; // NO_INHERITANCE
        ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        ea.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        ea.Trustee.ptstrName = sid as *mut u16;
        let mut new: *mut ACL = null_mut();
        let rc = SetEntriesInAclW(1, &ea, old, &mut new);
        if rc != 0 { LocalFree(sd as *mut c_void); return Err(rc); }
        let rc = SetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), new, null_mut());
        LocalFree(new as *mut c_void);
        LocalFree(sd as *mut c_void);
        if rc != 0 { Err(rc) } else { Ok(()) }
    }
}

/// Removes every explicit entry that names the SID (the same hand-made removal as for files: a copy of the ACL with those entries deleted, highest index first).
fn remove_entries(h: HANDLE, sid: PSID) -> Result<(), u32> {
    unsafe {
        let mut old: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut old, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        if old.is_null() || explicit_aces(old, sid) == 0 { LocalFree(sd as *mut c_void); return Ok(()); }
        let size = (*old).AclSize as usize;
        let mut buf = vec![0usize; size.div_ceil(size_of::<usize>())];
        std::ptr::copy_nonoverlapping(old as *const u8, buf.as_mut_ptr() as *mut u8, size);
        LocalFree(sd as *mut c_void);
        let copy = buf.as_mut_ptr() as *mut ACL;
        for i in (0..(*copy).AceCount as u32).rev() {
            let mut ace: *mut c_void = null_mut();
            if GetAce(copy, i, &mut ace) == 0 || ace.is_null() { continue; }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACE_TYPE_ALLOWED && header.AceType != ACE_TYPE_DENIED { continue; }
            if header.AceFlags & ACE_FLAG_INHERITED != 0 { continue; }
            let ace_sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID;
            if EqualSid(ace_sid, sid) != 0 && DeleteAce(copy, i) == 0 { return Err(GetLastError()); }
        }
        let rc = SetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), copy, null_mut());
        if rc != 0 { return Err(rc); }
        match object_entries(h, sid) { Ok(0) => Ok(()), Ok(_) => Err(ERR_STILL_PRESENT), Err(e) => Err(e) }
    }
}

/// A copy of a DACL (aligned for the ACL structure), taken before the grant.
struct AclCopy { buf: Vec<usize>, len: usize }
impl AclCopy {
    fn bytes(&self) -> &[u8] { unsafe { std::slice::from_raw_parts(self.buf.as_ptr() as *const u8, self.len) } }
}

/// The object's DACL as a copy (Ok(None): a NULL DACL). `h` needs READ_CONTROL.
fn acl_copy(h: HANDLE) -> Result<Option<AclCopy>, u32> {
    unsafe {
        let mut acl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut sd);
        if rc != 0 { return Err(rc); }
        if acl.is_null() { LocalFree(sd as *mut c_void); return Ok(None); }
        let len = (*acl).AclSize as usize;
        let mut buf = vec![0usize; len.div_ceil(size_of::<usize>())];
        std::ptr::copy_nonoverlapping(acl as *const u8, buf.as_mut_ptr() as *mut u8, len);
        LocalFree(sd as *mut c_void);
        Ok(Some(AclCopy { buf, len }))
    }
}

/// One object the launcher changed or made, and what became of it. `original`: the DACL before the grant (objects the launcher did not make); `matches`: whether the DACL after the revoke
/// has the same entries as `original` (None: not compared); `reordered`: the entries came back in another order and the copy was written back.
struct Touched { what: &'static str, name: String, mask: u32, applied: bool, error: Option<u32>, revoked: bool, left: i64, handle: HANDLE, owned: bool, is_station: bool, created: bool,
    original: Option<AclCopy>, matches: Option<bool>, reordered: bool }

/// Everything round 5 does to window objects for one run. Dropping it undoes the entries and closes what it opened or made.
pub(crate) struct Desk { sid: PSID, items: Vec<Touched>, pub(crate) lp_desktop: Option<Vec<u16>>, pub(crate) lp_text: String, pub(crate) failed: Option<String> }

fn open_station(name: &str, access: u32) -> HANDLE { unsafe { OpenWindowStationW(wide(name).as_ptr(), 0, access) as HANDLE } }
fn open_desktop(name: &str, access: u32) -> HANDLE { unsafe { OpenDesktopW(wide(name).as_ptr(), 0, 0, access) as HANDLE } }

impl Desk {
    pub(crate) fn new(sid: PSID) -> Desk { Desk { sid, items: Vec::new(), lp_desktop: None, lp_text: "(null)".into(), failed: None } }

    fn grant(&mut self, what: &'static str, is_station: bool, name: String, mask: u32) {
        let h = if is_station { open_station(&name, READ_CONTROL_BIT | WRITE_DAC_BIT) } else { open_desktop(&name, READ_CONTROL_BIT | WRITE_DAC_BIT) };
        let open_error = unsafe { GetLastError() };
        let mut t = Touched { what, name: name.clone(), mask, applied: false, error: None, revoked: false, left: -1, handle: h, owned: true, is_station, created: false, original: None, matches: None, reordered: false };
        log(&format!("before grant {what} {name} mask 0x{mask:x}"));
        if h.is_null() { t.error = Some(open_error); }
        else {
            // The copy to compare with after the revoke; no copy (or a NULL DACL), no write.
            match acl_copy(h) {
                Err(e) => t.error = Some(e),
                Ok(None) => t.error = Some(ERR_NULL_DACL),
                Ok(Some(c)) => {
                    t.original = Some(c);
                    match add_entry(h, self.sid, mask) { Ok(()) => t.applied = true, Err(e) => t.error = Some(e) }
                }
            }
        }
        log(&format!("after grant {what} {name}: applied {} error {:?}", t.applied, t.error));
        if !t.applied && self.failed.is_none() { self.failed = Some(format!("window objects: the entry on the {what} {name} could not be added (error {})", t.error.unwrap_or(0))); }
        self.items.push(t);
    }

    /// Carries out the plan for a mode: entries on the current objects, objects of its own, and the lpDesktop text.
    pub(crate) fn prepare(&mut self, mode: DesktopMode) {
        let p = plan(mode);
        let station = current_station_name();
        let desktop = current_desktop_name();
        match mode {
            DesktopMode::Empty => { self.lp_desktop = Some(vec![0u16]); self.lp_text = "(empty string)".into(); }
            DesktopMode::Winsta0 => { self.lp_desktop = Some(wide("WinSta0\\Default")); self.lp_text = "WinSta0\\Default".into(); }
            _ => {}
        }
        if p.station.is_none() && p.desktop.is_none() && p.create == Create::No { return; }
        // Only the SID of one AppContainer profile ever gets an entry (never a group, an account, a capability).
        if !deskrules::is_profile_sid(&sid_string(self.sid)) {
            self.failed = Some(format!("window objects: refused: the SID is not one AppContainer profile's (error {ERR_NOT_PROFILE_SID})"));
            return;
        }
        // The launcher's own station and desktop are changed only when the station is a non-interactive (service) one: never WinSta0 of a signed-in session.
        if p.station.is_some() || p.desktop.is_some() {
            let flags = station_flags(unsafe { GetProcessWindowStation() } as HANDLE);
            if let Err(e) = deskrules::may_change_launcher_objects(&station, flags) {
                log(&format!("no grant: {e}"));
                self.failed = Some(format!("window objects: {e}"));
                return;
            }
        }
        if let Some(mask) = p.station { self.grant("window station", true, station.clone(), mask); }
        if let Some(mask) = p.desktop { self.grant("desktop", false, desktop.clone(), mask); }
        // A failed entry on the current objects stops here: nothing is created and the run does not start (run_inner checks `failed`).
        if self.failed.is_some() { return; }
        let pid = unsafe { GetCurrentProcessId() };
        match p.create {
            Create::No => {}
            Create::Desktop => {
                let name = format!("nn-appc-d{pid}");
                log(&format!("before create desktop {name} in {station}"));
                let h = unsafe { CreateDesktopW(wide(&name).as_ptr(), null(), null(), 0, 0x01FF | READ_CONTROL_BIT | WRITE_DAC_BIT, null()) } as HANDLE;
                let mut t = Touched { what: "new desktop", name: name.clone(), mask: DESKTOP_FULL, applied: false, error: None, revoked: false, left: -1, handle: h, owned: true, is_station: false, created: true, original: None, matches: None, reordered: false };
                if h.is_null() { t.error = Some(unsafe { GetLastError() }); }
                else { match add_entry(h, self.sid, DESKTOP_FULL) { Ok(()) => t.applied = true, Err(e) => t.error = Some(e) } }
                log(&format!("after create desktop {name}: applied {} error {:?}", t.applied, t.error));
                if t.applied { self.lp_desktop = Some(wide(&format!("{station}\\{name}"))); self.lp_text = format!("{station}\\{name}"); }
                else if self.failed.is_none() { self.failed = Some(format!("window objects: the desktop {name} could not be made or given to the container (error {})", t.error.unwrap_or(0))); }
                self.items.push(t);
            }
            Create::Station => {
                let sname = format!("nn-appc-w{pid}");
                let dname = "nn-appc-d";
                log(&format!("before create window station {sname}"));
                let hs = unsafe { CreateWindowStationW(wide(&sname).as_ptr(), 0, 0x37F | READ_CONTROL_BIT | WRITE_DAC_BIT, null()) } as HANDLE;
                let mut ts = Touched { what: "new window station", name: sname.clone(), mask: STATION_FULL, applied: false, error: None, revoked: false, left: -1, handle: hs, owned: true, is_station: true, created: true, original: None, matches: None, reordered: false };
                if hs.is_null() { ts.error = Some(unsafe { GetLastError() }); }
                else { match add_entry(hs, self.sid, STATION_FULL) { Ok(()) => ts.applied = true, Err(e) => ts.error = Some(e) } }
                log(&format!("after create window station {sname}: applied {} error {:?}", ts.applied, ts.error));
                let station_ok = ts.applied;
                let station_error = ts.error;
                self.items.push(ts);
                if !station_ok {
                    if self.failed.is_none() { self.failed = Some(format!("window objects: the window station {sname} could not be made or given to the container (error {})", station_error.unwrap_or(0))); }
                } else {
                    // CreateDesktopW makes the desktop in the CALLING process's window station: switch to the new one for that call only, then back.
                    let original = unsafe { GetProcessWindowStation() };
                    log(&format!("before create desktop {dname} in {sname}"));
                    let switched = unsafe { SetProcessWindowStation(hs as HWINSTA) } != 0;
                    let hd = if switched { (unsafe { CreateDesktopW(wide(dname).as_ptr(), null(), null(), 0, 0x01FF | READ_CONTROL_BIT | WRITE_DAC_BIT, null()) }) as HANDLE } else { null_mut() };
                    let create_error = unsafe { GetLastError() };
                    if switched { unsafe { SetProcessWindowStation(original) }; }
                    let mut td = Touched { what: "new desktop", name: dname.to_string(), mask: DESKTOP_FULL, applied: false, error: None, revoked: false, left: -1, handle: hd, owned: true, is_station: false, created: true, original: None, matches: None, reordered: false };
                    if hd.is_null() { td.error = Some(if switched { create_error } else { create_error.max(1) }); }
                    else { match add_entry(hd, self.sid, DESKTOP_FULL) { Ok(()) => td.applied = true, Err(e) => td.error = Some(e) } }
                    log(&format!("after create desktop {dname}: applied {} error {:?}", td.applied, td.error));
                    if td.applied { self.lp_desktop = Some(wide(&format!("{sname}\\{dname}"))); self.lp_text = format!("{sname}\\{dname}"); }
                    else if self.failed.is_none() { self.failed = Some(format!("window objects: the desktop in {sname} could not be made or given to the container (error {})", td.error.unwrap_or(0))); }
                    self.items.push(td);
                }
            }
        }
    }

    /// Removes the entries from the objects that were changed (the made ones are only closed), reads each DACL back, closes every handle. Safe to call twice.
    pub(crate) fn finish(&mut self) {
        for t in self.items.iter_mut() {
            if t.handle.is_null() { continue; }
            // Every object whose DACL was copied before the grant is cleaned, applied or not (a removal with nothing to remove writes nothing).
            if t.original.is_some() && !t.created && !t.revoked {
                log(&format!("before revoke {} {}", t.what, t.name));
                match remove_entries(t.handle, self.sid) { Ok(()) => t.revoked = true, Err(e) => t.error = Some(e) }
                t.left = object_entries(t.handle, self.sid).map(|n| n as i64).unwrap_or(-1);
                if let Some(orig) = &t.original {
                    let now = acl_copy(t.handle);
                    let cmp = match &now { Ok(Some(c)) => deskrules::compare_acls(orig.bytes(), c.bytes()), _ => AclCompare::Different };
                    if cmp == AclCompare::Reordered {
                        // The same entries in another order: write the copy taken before the grant back (it holds nothing anyone else added) and compare again.
                        let mut copy = AclCopy { buf: orig.buf.clone(), len: orig.len };
                        let rc = unsafe { SetSecurityInfo(t.handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), copy.buf.as_mut_ptr() as *mut ACL, null_mut()) };
                        t.reordered = rc == 0;
                        if rc != 0 { t.error = Some(rc); }
                        let again = acl_copy(t.handle);
                        t.matches = Some(matches!(&again, Ok(Some(c)) if deskrules::compare_acls(orig.bytes(), c.bytes()) == AclCompare::Same));
                    } else {
                        t.matches = Some(cmp == AclCompare::Same);
                    }
                }
                log(&format!("after revoke {} {}: revoked {} entries left {} same as before {:?} order restored {}", t.what, t.name, t.revoked, t.left, t.matches, t.reordered));
            }
            if t.owned {
                unsafe { if t.is_station { CloseWindowStation(t.handle as HWINSTA); } else { CloseDesktop(t.handle as HDESK); } }
                t.owned = false;
            }
        }
    }

    /// Every object the launcher did not make is back as it was: no entry left and the same entries as before the grant (objects never copied were never written).
    pub(crate) fn all_reverted(&self) -> bool { self.items.iter().all(|t| t.created || t.original.is_none() || (t.revoked && t.left == 0 && t.matches == Some(true))) }

    pub(crate) fn json(&self, mode: DesktopMode) -> String {
        let mut o = Json::new();
        o.s("mode", mode.name());
        o.s("lpDesktop", &self.lp_text);
        o.s("launcherStation", &current_station_name());
        o.s("launcherDesktop", &current_desktop_name());
        let items: Vec<String> = self.items.iter().map(|t| {
            let mut i = Json::new();
            i.s("object", t.what); i.s("name", &t.name); i.n("mask", t.mask as i64); i.b("applied", t.applied); i.b("created", t.created);
            i.n("error", t.error.map(|e| e as i64).unwrap_or(0)); i.b("revoked", t.revoked); i.n("entriesLeft", t.left);
            match t.matches { Some(m) => i.b("matchesOriginal", m), None => i.raw("matchesOriginal", "null".into()) }
            i.b("orderRestored", t.reordered);
            i.render()
        }).collect();
        o.raw("objects", format!("[{}]", items.join(",")));
        o.b("allReverted", self.all_reverted());
        o.render()
    }
}

impl Drop for Desk { fn drop(&mut self) { self.finish(); } }

// ---------------------------------------------------------------------------------------------------------------- the `context` and `desktop-revoke` commands

fn integrity_rid() -> i64 {
    unsafe {
        let mut tok: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 { return -1; }
        let _g = Handle(tok);
        let mut need = 0u32;
        GetTokenInformation(tok, TokenIntegrityLevel, null_mut(), 0, &mut need);
        if need == 0 { return -1; }
        let mut buf = vec![0usize; (need as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(tok, TokenIntegrityLevel, buf.as_mut_ptr() as *mut c_void, need, &mut need) == 0 { return -1; }
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        if count == 0 { return -1; }
        *GetSidSubAuthority(label.Label.Sid, count as u32 - 1) as i64
    }
}

fn os_version() -> (i64, i64, i64) {
    unsafe {
        let mut v: OSVERSIONINFOW = zeroed();
        v.dwOSVersionInfoSize = size_of::<OSVERSIONINFOW>() as u32;
        if RtlGetVersion(&mut v) != 0 { return (-1, -1, -1); }
        (v.dwMajorVersion as i64, v.dwMinorVersion as i64, v.dwBuildNumber as i64)
    }
}

/// `context`: where this program runs, read-only. The window station and desktop it was started in (names, whether the station is the visible interactive one, their DACLs as SDDL),
/// the session, the token's integrity level (RID: 0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system) and elevation, the operating system version from RtlGetVersion.
pub(crate) fn context(j: &mut Json) {
    let station = unsafe { GetProcessWindowStation() } as HANDLE;
    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) } as HANDLE;
    j.s("windowStation", &object_name(station));
    j.n("windowStationFlags", station_flags(station));
    j.s("desktop", &object_name(desktop));
    // The process's own handles may lack READ_CONTROL: open the same objects by name for the read.
    let sname = object_name(station);
    let dname = object_name(desktop);
    let hs = open_station(&sname, READ_CONTROL_BIT);
    let hs_error = unsafe { GetLastError() };
    let hd = open_desktop(&dname, READ_CONTROL_BIT);
    let hd_error = unsafe { GetLastError() };
    j.s("windowStationSddl", &if hs.is_null() { format!("open error {hs_error}") } else { object_sddl(hs) });
    j.s("desktopSddl", &if hd.is_null() { format!("open error {hd_error}") } else { object_sddl(hd) });
    unsafe { if !hs.is_null() { CloseWindowStation(hs as HWINSTA); } if !hd.is_null() { CloseDesktop(hd as HDESK); } }
    j.n("integrityRid", integrity_rid());
    let (major, minor, build) = os_version();
    j.n("osMajor", major); j.n("osMinor", minor); j.n("osBuild", build);
}

/// The SID of the profile with this name, DERIVED from the name (no profile is created: `desktop-revoke` must not leave one behind).
pub(crate) fn derived_sid(name: &str) -> Result<Sid, String> {
    unsafe {
        let mut sid: PSID = null_mut();
        let hr = DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(), &mut sid);
        if hr != 0 || sid.is_null() { return Err(format!("DeriveAppContainerSidFromAppContainerName failed: 0x{:08x}", hr as u32)); }
        Ok(Sid(sid))
    }
}

/// `desktop-revoke`: removes the container's explicit entries from the launcher's current window station and desktop (the clean-up after a launcher that was killed in a `grant-*` run) and
/// reports how many are left. Idempotent: with no entry for the SID nothing is written. Only the SID of one AppContainer profile is accepted.
pub(crate) fn revoke_current(j: &mut Json, sid: PSID) -> bool {
    if !deskrules::is_profile_sid(&sid_string(sid)) { j.s("error", "refused: the SID is not one AppContainer profile's"); return false; }
    let sname = current_station_name();
    let dname = current_desktop_name();
    let mut ok = true;
    let hs = open_station(&sname, READ_CONTROL_BIT | WRITE_DAC_BIT);
    let hs_error = unsafe { GetLastError() };
    let hd = open_desktop(&dname, READ_CONTROL_BIT | WRITE_DAC_BIT);
    let hd_error = unsafe { GetLastError() };
    for (key, h, station, open_error) in [("windowStation", hs, true, hs_error), ("desktop", hd, false, hd_error)] {
        let mut o = Json::new();
        if h.is_null() { o.n("openError", open_error as i64); ok = false; }
        else {
            let r = remove_entries(h, sid);
            o.b("removed", r.is_ok());
            o.n("entriesLeft", object_entries(h, sid).map(|n| n as i64).unwrap_or(-1));
            if r.is_err() { ok = false; }
            unsafe { if station { CloseWindowStation(h as HWINSTA); } else { CloseDesktop(h as HDESK); } }
        }
        j.raw(key, o.render());
    }
    ok
}
