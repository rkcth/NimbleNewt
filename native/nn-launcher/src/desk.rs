// Round 5 of the Windows AppContainer experiment (EXPERIMENT build only; this file is not compiled into the product launcher): the window station and the desktop of the child. The product launcher's
// own private window station (privdesk.rs) is the fix this round led to; the modes below stay as the measuring options.
// A child that is created from a Windows service (session 0) and is not given a window station of its own takes the launcher's: a non-interactive one named `Service-0x0-<logon id>$` with
// the desktop `Default`. Own-hardware run 45634597880 (host build 26200, service, elevated) showed every container child that needs user32 ending with 0xC0000142 (STATUS_DLL_INIT_FAILED).
// One suspect is that the container's SID has no access to that window station and desktop; this file lets the experiment vary that ONE thing (see the notes, "round 5").
//
// What is changed, and how it is undone:
//   - `grant-*` modes add ONE explicit allow entry for the container's SID to the DACL of the launcher's current window station and/or desktop (the objects of this logon session,
//     opened by name with READ_CONTROL and WRITE_DAC), and take that entry out again on every path out (Drop), reading the DACL back; the count left is in the JSON line. The objects
//     last as long as the logon session that owns them; if this program is killed between the grant and the revoke, the entry stays until that session ends or `desktop-revoke` is run.
//     Refused (nothing written): an interactive or unreadable window station (WinSta0 of a signed-in session is never changed: deskrules::may_change_launcher_objects), a SID that is not
//     one AppContainer profile's (crate::winobj::is_profile_sid), and a NULL DACL (merging into it would replace "everyone" with one entry). The DACL is copied BEFORE the grant; after the
//     revoke it is compared entry by entry with that copy: the same entries in another order are put back from the copy, any other difference is reported and not written.
//   - `new-desktop` creates a desktop in the current window station (and grants the station); `new-station` creates a window station and a desktop in it, both with an entry for the container.
//     Both are closed when the run ends (an object with no handle left is destroyed). The launcher's process window station is switched for the moment of the desktop creation and switched back.
//   - Nothing is written to the registry, no persistent machine setting is touched.
use super::*;
use crate::args::DesktopMode;
use crate::deskrules::{self, AclCompare};
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Wdk::System::SystemServices::RtlGetVersion;

use super::privdesk::{acl_copy, add_entry, sid_bytes, write_dacl, AclCopy, ERR_BAD_ACL, ERR_NOT_PROFILE_SID, ERR_NULL_DACL, ERR_STATION_SWITCH_BACK, WRITE_DAC_BIT};
pub(crate) const READ_CONTROL_BIT: u32 = 0x0002_0000;
// Window station rights (Microsoft: Window Station Security and Access Rights). "read" is the documented GENERIC_READ mapping of a NON-interactive window station: READ_CONTROL,
// WINSTA_ENUMDESKTOPS (0x1), WINSTA_READATTRIBUTES (0x2), WINSTA_ENUMERATE (0x100). "full" is WINSTA_ALL_ACCESS (0x37F) plus READ_CONTROL.
pub(crate) const STATION_READ: u32 = READ_CONTROL_BIT | 0x0001 | 0x0002 | 0x0100;
pub(crate) const STATION_FULL: u32 = READ_CONTROL_BIT | 0x037F;
// Desktop rights: "read" is the documented GENERIC_READ mapping (READ_CONTROL, DESKTOP_READOBJECTS 0x1, DESKTOP_ENUMERATE 0x40); "full" is every DESKTOP_* right (0x1FF) plus READ_CONTROL.
pub(crate) const DESKTOP_READ: u32 = READ_CONTROL_BIT | 0x0001 | 0x0040;
pub(crate) const DESKTOP_FULL: u32 = READ_CONTROL_BIT | 0x01FF;
/// What one mode does: the level of the entry on the CURRENT station and desktop (None: no entry), whether to create objects, and what lpDesktop holds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Create { No, Desktop, Station }
#[derive(Clone, Copy, Debug)]
pub(crate) struct Plan { pub(crate) station: Option<u32>, pub(crate) desktop: Option<u32>, pub(crate) create: Create }

pub(crate) fn plan(mode: DesktopMode) -> Plan {
    match mode {
        DesktopMode::Inherit | DesktopMode::Empty | DesktopMode::Winsta0 | DesktopMode::Private | DesktopMode::HomeDesktop | DesktopMode::HomeStationRead | DesktopMode::HomeStationFull => Plan { station: None, desktop: None, create: Create::No },
        DesktopMode::GrantRead => Plan { station: Some(STATION_READ), desktop: Some(DESKTOP_READ), create: Create::No },
        DesktopMode::GrantFull => Plan { station: Some(STATION_FULL), desktop: Some(DESKTOP_FULL), create: Create::No },
        DesktopMode::GrantStation => Plan { station: Some(STATION_FULL), desktop: None, create: Create::No },
        DesktopMode::GrantDesktop => Plan { station: None, desktop: Some(DESKTOP_FULL), create: Create::No },
        DesktopMode::NewDesktop => Plan { station: Some(STATION_FULL), desktop: None, create: Create::Desktop },
        DesktopMode::NewStation => Plan { station: None, desktop: None, create: Create::Station },
    }
}

/// A progress line on standard error. A failed write is ignored (eprintln! would panic, and this is called between a write to a window object's list and its removal, and from Drop).
fn log(msg: &str) { use std::io::Write; let _ = writeln!(std::io::stderr(), "nn-desktop: {msg}"); }

// ---------------------------------------------------------------------------------------------------------------- Ctrl+C and the window closing (the home modes)
//
// Without a handler Ctrl+C, Ctrl+Break and closing the console end the process at once (ExitProcess: no destructor runs), so an entry written to WinSta0 would stay until sign-out. The handler
// (installed before the first write) marks the run stopped and removes the registered container's entries from the station at once, under the same lock as the write and the normal removal.
// For Ctrl+C and Ctrl+Break it returns TRUE: the process goes on, finishes the current step (its own clean-up included: the desktop closed, the profile deleted) and runs no further step. For the
// window closing, sign-out and shutdown Windows ends the process when the handler returns (Microsoft: SetConsoleCtrlHandler, HandlerRoutine); the entry is gone by then, the per-run profile and
// the work folder may be left (the ATTEMPT line printed their clean-up commands). Ending the process from Task Manager (TerminateProcess) runs no handler: then `home-revoke` is the clean-up.

/// A SID's bytes in a u32-aligned buffer (EqualSid and GetLengthSid read it through a PSID).
pub(crate) struct SidBuf(Vec<u32>);
impl SidBuf {
    fn new(b: &[u8]) -> SidBuf { let mut v = vec![0u32; b.len().div_ceil(4)]; unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), v.as_mut_ptr() as *mut u8, b.len()); } SidBuf(v) }
    fn psid(&self) -> PSID { self.0.as_ptr() as PSID }
    fn is(&self, other: PSID) -> bool { unsafe { EqualSid(self.psid(), other) != 0 } }
}
// SAFETY of Send: the buffer is plain bytes owned by the Mutex below.
unsafe impl Send for SidBuf {}

static HOME_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The container whose entry may be on the station right now (set before the write, cleared after a removal read back as 0).
static HOME_PENDING: std::sync::Mutex<Option<SidBuf>> = std::sync::Mutex::new(None);
static HANDLER: std::sync::Once = std::sync::Once::new();

fn pending_lock() -> std::sync::MutexGuard<'static, Option<SidBuf>> { HOME_PENDING.lock().unwrap_or_else(|e| e.into_inner()) }

/// Was Ctrl+C pressed or the window closed? `home-probe` runs no further step then.
pub(crate) fn home_stopped() -> bool { HOME_STOP.load(std::sync::atomic::Ordering::SeqCst) }

/// Installs the handler once per process (also used by `deelevate`, whose parent then waits for its child's clean-up instead of ending at Ctrl+C).
pub(crate) fn install_console_handler() {
    HANDLER.call_once(|| unsafe { if SetConsoleCtrlHandler(Some(console_ctrl), 1) == 0 { log(&format!("the Ctrl+C handler could not be installed (error {})", GetLastError())); } });
}

unsafe extern "system" fn console_ctrl(kind: u32) -> BOOL {
    // A panic must not cross this boundary (it would abort): everything is caught, and the answer is TRUE either way.
    let _ = std::panic::catch_unwind(|| {
        HOME_STOP.store(true, std::sync::atomic::Ordering::SeqCst);
        let what = match kind { 0 => "Ctrl+C", 1 => "Ctrl+Break", 2 => "the window closing", 5 => "sign-out", 6 => "shutdown", _ => "a console event" };
        let removed = remove_pending_now();
        log(&format!("{what}: stopping after the current step; {removed}"));
    });
    1
}

/// The handler's removal: the registered container's explicit entries off the process's window station (only the interactive WinSta0, the only station the home modes write), read back.
fn remove_pending_now() -> String {
    let mut pending = pending_lock();
    let Some(sid) = pending.as_ref() else { return "no entry of this run is on the window station".into() };
    let name = current_station_name();
    let flags = station_flags(unsafe { GetProcessWindowStation() } as HANDLE);
    if let Err(e) = crate::homerules::may_write_interactive_station(&name, flags) { return format!("the entry was not removed: {e}"); }
    let h = open_station(&name, READ_CONTROL_BIT | WRITE_DAC_BIT);
    if h.is_null() { return format!("the entry could not be removed (open error {}): run the home-revoke command of the ATTEMPT line", unsafe { GetLastError() }); }
    let r = remove_entries(h, sid.psid());
    let left = object_entries(h, sid.psid()).map(|n| n as i64).unwrap_or(-1);
    unsafe { CloseWindowStation(h as HWINSTA); }
    if r.is_ok() && left == 0 { *pending = None; "the container's entry on WinSta0 was removed (read back: none left)".into() }
    else { format!("the entry could not be removed ({r:?}, entries left {left}): run the home-revoke command of the ATTEMPT line") }
}

/// The name of a window station or desktop handle (UOI_NAME), or "?".
pub(crate) fn object_name(h: HANDLE) -> String {
    unsafe {
        let mut buf = [0u16; 512];
        let mut needed = 0u32;
        if GetUserObjectInformationW(h, UOI_NAME, buf.as_mut_ptr() as *mut c_void, (buf.len() * 2) as u32, &mut needed) == 0 { return "?".into(); }
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }
}

/// The USEROBJECTFLAGS.dwFlags of a window station: bit 0 is WSF_VISIBLE, which only the interactive window station has. -1 when it cannot be read.
pub(crate) fn station_flags(h: HANDLE) -> i64 {
    unsafe {
        let mut buf = [0u32; 3]; // USEROBJECTFLAGS: fInherit (BOOL), fReserved (BOOL), dwFlags (DWORD)
        let mut needed = 0u32;
        if GetUserObjectInformationW(h, UOI_FLAGS, buf.as_mut_ptr() as *mut c_void, 12, &mut needed) == 0 { -1 } else { buf[2] as i64 }
    }
}

pub(crate) fn current_station_name() -> String { object_name(unsafe { GetProcessWindowStation() } as HANDLE) }
pub(crate) fn current_desktop_name() -> String { object_name(unsafe { GetThreadDesktop(GetCurrentThreadId()) } as HANDLE) }

/// The DACL of a window object as SDDL text ("error N" when it cannot be read). `h` needs READ_CONTROL.
pub(crate) fn object_sddl(h: HANDLE) -> String {
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
pub(crate) fn object_entries(h: HANDLE, sid: PSID) -> Result<u32, u32> {
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

/// Removes every explicit entry that names the SID and keeps every other entry in its order (deskrules::without_explicit_entries); with none there, nothing is written.
pub(crate) fn remove_entries(h: HANDLE, sid: PSID) -> Result<(), u32> {
    let sid_b = sid_bytes(sid).ok_or(ERR_NOT_PROFILE_SID)?;
    let Some(old) = acl_copy(h)? else { return Ok(()) }; // a NULL DACL holds no entry
    let (new, removed) = deskrules::without_explicit_entries(old.bytes(), &sid_b).ok_or(ERR_BAD_ACL)?;
    if removed == 0 { return Ok(()); }
    write_dacl(h, &new)?;
    match object_entries(h, sid) { Ok(0) => Ok(()), Ok(_) => Err(ERR_STILL_PRESENT), Err(e) => Err(e) }
}

/// One object the launcher changed or made, and what became of it. `original`: the DACL before the grant (objects the launcher did not make); `matches`: whether the DACL after the revoke
/// has the same entries as `original` (None: not compared); `reordered`: the same entries came back in another order (reported; nothing is written back). `sddl_before` / `sddl_same`: the whole
/// DACL part of the descriptor as SDDL text (the control flags such as P and AI included, so a change of the descriptor's flags is seen too) before the grant, and whether the text after the revoke
/// is identical (never printed: it names the user's logon session).
struct Touched { what: &'static str, name: String, mask: u32, applied: bool, error: Option<u32>, revoked: bool, left: i64, handle: HANDLE, owned: bool, is_station: bool, created: bool,
    original: Option<AclCopy>, matches: Option<bool>, reordered: bool, sddl_before: Option<String>, sddl_same: Option<bool> }

/// Everything round 5 does to window objects for one run. Dropping it undoes the entries and closes what it opened or made.
pub(crate) struct Desk { sid: PSID, items: Vec<Touched>, pub(crate) lp_desktop: Option<Vec<u16>>, pub(crate) lp_text: String, pub(crate) failed: Option<String>, close_errors: Vec<(String, u32)> }

pub(crate) fn open_station(name: &str, access: u32) -> HANDLE { unsafe { OpenWindowStationW(wide(name).as_ptr(), 0, access) as HANDLE } }
pub(crate) fn open_desktop(name: &str, access: u32) -> HANDLE { unsafe { OpenDesktopW(wide(name).as_ptr(), 0, 0, access) as HANDLE } }

impl Desk {
    pub(crate) fn new(sid: PSID) -> Desk { Desk { sid, items: Vec::new(), lp_desktop: None, lp_text: "(null)".into(), failed: None, close_errors: Vec::new() } }

    fn grant(&mut self, what: &'static str, is_station: bool, name: String, mask: u32) {
        let h = if is_station { open_station(&name, READ_CONTROL_BIT | WRITE_DAC_BIT) } else { open_desktop(&name, READ_CONTROL_BIT | WRITE_DAC_BIT) };
        let open_error = unsafe { GetLastError() };
        let mut t = Touched { what, name: name.clone(), mask, applied: false, error: None, revoked: false, left: -1, handle: h, owned: true, is_station, created: false, original: None, matches: None, reordered: false, sddl_before: None, sddl_same: None };
        log(&format!("before grant {what} {name} mask 0x{mask:x}"));
        if h.is_null() { t.error = Some(open_error); }
        else {
            // The copy to compare with after the revoke; no copy (or a NULL DACL), no write.
            match acl_copy(h) {
                Err(e) => t.error = Some(e),
                Ok(None) => t.error = Some(ERR_NULL_DACL),
                Ok(Some(c)) => {
                    // The SDDL text too (the descriptor's DACL flags included); an unreadable one means no write either.
                    let text = object_sddl(h);
                    if !text.starts_with("D:") { t.error = Some(ERR_BAD_ACL); }
                    else {
                        t.original = Some(c);
                        t.sddl_before = Some(text);
                        match add_entry(h, self.sid, mask) { Ok(()) => t.applied = true, Err(e) => t.error = Some(e) }
                    }
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
        if mode.is_home() { self.prepare_home(mode, &station); return; }
        if p.station.is_none() && p.desktop.is_none() && p.create == Create::No { return; }
        // Only the SID of one AppContainer profile ever gets an entry (never a group, an account, a capability).
        if !crate::winobj::is_profile_sid(&sid_string(self.sid)) {
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
                let mut t = Touched { what: "new desktop", name: name.clone(), mask: DESKTOP_FULL, applied: false, error: None, revoked: false, left: -1, handle: h, owned: true, is_station: false, created: true, original: None, matches: None, reordered: false, sddl_before: None, sddl_same: None };
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
                let mut ts = Touched { what: "new window station", name: sname.clone(), mask: STATION_FULL, applied: false, error: None, revoked: false, left: -1, handle: hs, owned: true, is_station: true, created: true, original: None, matches: None, reordered: false, sddl_before: None, sddl_same: None };
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
                    // Switched back at once, checked: a launcher left on the made station would report and close the wrong objects, so the run does not start.
                    let back = !switched || unsafe { SetProcessWindowStation(original) } != 0;
                    if !back {
                        log(&format!("could not switch back to the window station {station} (error {})", unsafe { GetLastError() }));
                        if self.failed.is_none() { self.failed = Some(format!("window objects: the launcher could not switch back to its window station {station} (error {ERR_STATION_SWITCH_BACK})")); }
                    }
                    let mut td = Touched { what: "new desktop", name: dname.to_string(), mask: DESKTOP_FULL, applied: false, error: None, revoked: false, left: -1, handle: hd, owned: true, is_station: false, created: true, original: None, matches: None, reordered: false, sddl_before: None, sddl_same: None };
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

    /// The home modes (one account, not elevated; see homerules.rs): ONE desktop made on the launcher's CURRENT window station with its final access list (the launcher's own account, SYSTEM and the
    /// container, nothing written afterwards), and, for the two `home-desktop-station-*` modes, ONE temporary allow entry for the container on that station first (removed again in `finish`, read back,
    /// compared with the copy taken before). The entry is written only to the interactive station WinSta0 (deskrules::may_write_interactive_station); a station of a service is never touched here.
    fn prepare_home(&mut self, mode: DesktopMode, station: &str) {
        // The same rule as every other mode: only the SID of one AppContainer profile ever gets an entry (on the station or in the desktop's list), never a group, an account or a capability.
        if !crate::winobj::is_profile_sid(&sid_string(self.sid)) { self.failed = Some(format!("window objects: refused: the SID is not one AppContainer profile's (error {ERR_NOT_PROFILE_SID})")); return; }
        if let Err(e) = crate::homerules::may_make_home_desktop(station) { self.failed = Some(format!("window objects: {e}")); return; }
        let Some(sid_b) = sid_bytes(self.sid) else { self.failed = Some(format!("window objects: refused: the SID is not well formed (error {ERR_NOT_PROFILE_SID})")); return };
        if let Some(mask) = crate::homerules::home_station_mask(mode) {
            let flags = station_flags(unsafe { GetProcessWindowStation() } as HANDLE);
            if let Err(e) = crate::homerules::may_write_interactive_station(station, flags) { log(&format!("no grant: {e}")); self.failed = Some(format!("window objects: {e}")); return; }
            // The console control handler (Ctrl+C, Ctrl+Break, the window closing, sign-out) removes the entry at once; it is installed and the SID registered BEFORE the write, under the
            // same lock as the write, so the handler either runs before (and the write is refused) or after it (and removes it).
            install_console_handler();
            {
                let mut pending = pending_lock();
                if home_stopped() { self.failed = Some("window objects: stopped (Ctrl+C or the window closing) before the entry was written; nothing was written".into()); return; }
                *pending = Some(SidBuf::new(&sid_b));
                self.grant("window station", true, station.to_string(), mask);
                // Nothing was copied, so nothing was written: no entry of this run can be there.
                if self.items.last().is_some_and(|t| t.original.is_none()) { *pending = None; }
            }
            if self.failed.is_some() { return; }
        }
        let own = match super::privdesk::own_principals() { Ok(o) => o, Err(e) => { self.failed = Some(format!("window objects: the launcher's own account could not be read (error {e})")); return; } };
        let mut sd = match super::privdesk::creation_sd(&own[0], &sid_b, crate::winobj::DESKTOP_RIGHTS, crate::winobj::DESKTOP_FULL, "desktop") { Ok(s) => s, Err(e) => { self.failed = Some(e); return; } };
        let name = format!("nn-home-{:x}-{:x}", unsafe { GetCurrentProcessId() }, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64 & 0xFFFF_FFFF).unwrap_or(0));
        log(&format!("before create home desktop {name} in {station}"));
        let sa = sd.attributes();
        let h = unsafe { SetLastError(0); CreateDesktopW(wide(&name).as_ptr(), null(), null(), 0, crate::winobj::DESKTOP_RIGHTS, &sa) } as HANDLE;
        let created_error = unsafe { GetLastError() };
        let mut t = Touched { what: "home desktop", name: name.clone(), mask: crate::winobj::DESKTOP_RIGHTS, applied: false, error: None, revoked: false, left: -1, handle: h, owned: true, is_station: false, created: true, original: None, matches: None, reordered: false, sddl_before: None, sddl_same: None };
        if h.is_null() { t.error = Some(created_error); }
        else if created_error == ERROR_ALREADY_EXISTS { t.error = Some(ERROR_ALREADY_EXISTS); }
        else {
            // The access list is read back and checked exactly like the private desktop's: one flag-free entry for the container, otherwise only SYSTEM, Administrators, OWNER RIGHTS and the launcher's own account.
            match acl_copy(h) {
                Err(e) => t.error = Some(e),
                Ok(None) => t.error = Some(ERR_NULL_DACL),
                Ok(Some(c)) => match crate::winobj::private_acl_ok(c.bytes(), &sid_b, crate::winobj::DESKTOP_RIGHTS, &own) { Ok(()) => t.applied = true, Err(why) => { log(&format!("home desktop access list not acceptable: {why}")); t.error = Some(ERR_BAD_ACL); } },
            }
        }
        log(&format!("after create home desktop {name}: applied {} error {:?}", t.applied, t.error));
        if t.applied { self.lp_desktop = Some(wide(&format!("{station}\\{name}"))); self.lp_text = format!("{station}\\{name}"); }
        else { self.failed = Some(format!("window objects: the home desktop {name} could not be made or its access list is not acceptable (error {})", t.error.unwrap_or(0))); }
        self.items.push(t);
    }

    /// Removes the entries from the objects that were changed (the made ones are only closed), reads each DACL back, closes every handle. Safe to call twice.
    pub(crate) fn finish(&mut self) {
        for t in self.items.iter_mut() {
            if t.handle.is_null() { continue; }
            // Every object whose DACL was copied before the grant is cleaned, applied or not (a removal with nothing to remove writes nothing).
            if t.original.is_some() && !t.created && !t.revoked {
                log(&format!("before revoke {} {}", t.what, t.name));
                // The same lock as the console control handler's removal: the two never write the list at the same moment.
                let mut pending = pending_lock();
                match remove_entries(t.handle, self.sid) { Ok(()) => t.revoked = true, Err(e) => t.error = Some(e) }
                t.left = object_entries(t.handle, self.sid).map(|n| n as i64).unwrap_or(-1);
                if t.left == 0 && pending.as_ref().is_some_and(|p| p.is(self.sid)) { *pending = None; }
                drop(pending);
                if let Some(before) = &t.sddl_before { t.sddl_same = Some(object_sddl(t.handle) == *before); }
                if let Some(orig) = &t.original {
                    // Compared and reported only: the copy taken before the grant is NEVER written back (it could be stale; the insert and the removal keep every other entry as it was,
                    // so a difference means something else changed the DACL meanwhile, and that change is left alone).
                    let now = acl_copy(t.handle);
                    let cmp = match &now { Ok(Some(c)) => deskrules::compare_acls(orig.bytes(), c.bytes()), _ => AclCompare::Different };
                    t.reordered = cmp == AclCompare::Reordered;
                    t.matches = Some(cmp == AclCompare::Same);
                }
                log(&format!("after revoke {} {}: revoked {} entries left {} same as before {:?} order differs {} descriptor text the same {:?}", t.what, t.name, t.revoked, t.left, t.matches, t.reordered, t.sddl_same));
            }
            if t.owned {
                let closed = unsafe { if t.is_station { CloseWindowStation(t.handle as HWINSTA) } else { CloseDesktop(t.handle as HDESK) } };
                if closed == 0 { self.close_errors.push((format!("{} {}", t.what, t.name), unsafe { GetLastError() })); }
                t.owned = false;
            }
        }
    }

    /// Every object the launcher did not make is back as it was: no entry left and the same entries as before the grant (objects never copied were never written).
    pub(crate) fn all_reverted(&self) -> bool { self.items.iter().all(|t| t.created || t.original.is_none() || (t.revoked && t.left == 0 && t.matches == Some(true) && t.sddl_same == Some(true))) }

    /// Is an entry for the container still (or possibly) on an object the launcher did not make? (-1: the list could not be read back, counted as left.) Separate from `all_reverted`: a list that
    /// another program changed meanwhile is not an entry of this run left behind.
    pub(crate) fn entry_left(&self) -> bool { self.items.iter().any(|t| !t.created && t.original.is_some() && t.left != 0) }

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
            i.b("orderDiffers", t.reordered);
            match t.sddl_same { Some(m) => i.b("descriptorTextSame", m), None => i.raw("descriptorTextSame", "null".into()) }
            i.render()
        }).collect();
        o.raw("objects", format!("[{}]", items.join(",")));
        o.raw("closeErrors", format!("[{}]", self.close_errors.iter().map(|(what, e)| { let mut c = Json::new(); c.s("object", what); c.n("error", *e as i64); c.render() }).collect::<Vec<_>>().join(",")));
        o.b("allReverted", self.all_reverted());
        o.b("entryLeft", self.entry_left());
        o.render()
    }
}

impl Drop for Desk { fn drop(&mut self) { self.finish(); } }

// ---------------------------------------------------------------------------------------------------------------- the `context` and `desktop-revoke` commands

pub(crate) fn integrity_rid() -> i64 {
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

pub(crate) fn os_version() -> (i64, i64, i64) {
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
    if !crate::winobj::is_profile_sid(&sid_string(sid)) { j.s("error", "refused: the SID is not one AppContainer profile's"); return false; }
    let sname = current_station_name();
    let dname = current_desktop_name();
    // The same rule as for the grant: an interactive (or unreadable) window station is never written, also not to remove entries (the grant never added any there). Its entries for
    // the SID are only counted (READ_CONTROL), and `ok` is true only when there are none.
    if let Err(e) = deskrules::may_change_launcher_objects(&sname, station_flags(unsafe { GetProcessWindowStation() } as HANDLE)) {
        j.s("skipped", &e);
        let mut ok = true;
        for (key, h, station) in [("windowStation", open_station(&sname, READ_CONTROL_BIT), true), ("desktop", open_desktop(&dname, READ_CONTROL_BIT), false)] {
            let mut o = Json::new();
            let left = if h.is_null() { -1 } else { object_entries(h, sid).map(|n| n as i64).unwrap_or(-1) };
            o.b("removed", false);
            o.n("entriesLeft", left);
            if left != 0 { ok = false; }
            if !h.is_null() { unsafe { if station { CloseWindowStation(h as HWINSTA); } else { CloseDesktop(h as HDESK); } } }
            j.raw(key, o.render());
        }
        return ok;
    }
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
