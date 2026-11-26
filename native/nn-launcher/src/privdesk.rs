// The window objects of every run (card A03b, Session 0 fix; both builds, Windows only): the private window station and desktop below, or, for a NON-elevated launcher that is refused the named station with error 5,
// ONE private desktop on the user's own interactive WinSta0 (the home desktop, `create_home`; plan 12.5.1). Never the inherited desktop. The pure rules (names, masks, the DACL check) are in winobj.rs.
//
// What it does, for ONE run: make a window station with a name of its own, give the container's SID one explicit allow entry on it, make a desktop in it and give the container one entry there
// too, hand `station\desktop` to CreateProcessW as lpDesktop, and close the desktop and then the station when the run is over (the job's kill-on-close has ended the child by then; an object
// with no handle left is destroyed). A window station of the launcher's own session is never opened, never changed and never named: not WinSta0 (the interactive station), not the service's
// `Service-0x0-<logon id>$`, and no DACL of the launcher's own objects is written.
//
// Both objects are CREATED with their final DACL (winobj::private_dacl in the SECURITY_ATTRIBUTES of the creating call): the launcher's own token user and SYSTEM with every specific right of the
// type, the container with the measured mask (131967 station, 131583 desktop, the masks the experiment's `new-station` gave the container). Nothing is written afterwards, so the objects never
// exist with a default descriptor (which Microsoft documents two different ways for a NULL one) and there is no moment between creation and a DACL write in which another account could open
// them. The DACL is then READ BACK and checked (winobj::private_acl_ok, an allow list: exactly one flag-free entry for the container, otherwise only SYSTEM, Administrators, OWNER RIGHTS and the
// launcher's own token user and owner). The station is made with CWF_CREATE_ONLY. A failed step is a typed failure and the run does not start.
// Difference from the measured run: the experiment made the station with a NULL descriptor and then added the container's entry (SetSecurityInfo); the container's own masks are the same.
//
// CreateDesktopW makes a desktop in the CALLING PROCESS's window station, so the launcher switches its own process window station to the new one for that single call and back at once
// (SetProcessWindowStation). The switch back is checked, and a guard restores the original station on every other path out (an early return or a panic) too.
use super::*;
use crate::winobj::{self, WindowMode, DESKTOP_RIGHTS, STATION_RIGHTS};
use windows_sys::Win32::System::StationsAndDesktops::*;

#[cfg(feature = "experiment")] // the product never writes a DACL: its objects are created with their final one
pub(crate) const WRITE_DAC_BIT: u32 = 0x0004_0000;
/// Private codes (outside the Win32 range used here): the object has a NULL DACL, so no entry is merged into it; the SID is not one AppContainer profile's.
pub(crate) const ERR_NULL_DACL: u32 = 0x2000_0002;
pub(crate) const ERR_NOT_PROFILE_SID: u32 = 0x2000_0003;
/// The DACL read was not a well-formed ACL, already held an explicit entry for the SID, or the new one would not fit: nothing written.
pub(crate) const ERR_BAD_ACL: u32 = 0x2000_0004;
/// The launcher could not switch back to its own window station after making a desktop in the new one.
pub(crate) const ERR_STATION_SWITCH_BACK: u32 = 0x2000_0005;
/// A window object with that name already exists (never adopted: its DACL is not the launcher's).
const ERR_NAME_TAKEN: u32 = 0x2000_0006;
/// The launcher's own token user or owner was not a well-formed SID.
const ERR_OWN_SID: u32 = 0x2000_0007;

/// The binary form of a SID (None: not a valid SID).
pub(crate) fn sid_bytes(sid: PSID) -> Option<Vec<u8>> {
    unsafe {
        if sid.is_null() || IsValidSid(sid) == 0 { return None; }
        let n = GetLengthSid(sid) as usize;
        let v = std::slice::from_raw_parts(sid as *const u8, n).to_vec();
        if winobj::sid_ok(&v) { Some(v) } else { None }
    }
}

/// A copy of a DACL (aligned for the ACL structure).
pub(crate) struct AclCopy { buf: Vec<usize>, len: usize }
impl AclCopy {
    pub(crate) fn bytes(&self) -> &[u8] { unsafe { std::slice::from_raw_parts(self.buf.as_ptr() as *const u8, self.len) } }
}

/// The object's DACL as a copy (Ok(None): a NULL DACL). `h` needs READ_CONTROL.
pub(crate) fn acl_copy(h: HANDLE) -> Result<Option<AclCopy>, u32> {
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

/// Writes an ACL built by winobj as the object's DACL (an aligned copy, checked with IsValidAcl first; DACL_SECURITY_INFORMATION alone, so the protection bit of the descriptor is not changed:
/// a window object has no parent to inherit from). `h` needs WRITE_DAC.
#[cfg(feature = "experiment")]
pub(crate) fn write_dacl(h: HANDLE, acl: &[u8]) -> Result<(), u32> {
    unsafe {
        let mut buf = vec![0usize; acl.len().div_ceil(size_of::<usize>())];
        std::ptr::copy_nonoverlapping(acl.as_ptr(), buf.as_mut_ptr() as *mut u8, acl.len());
        let p = buf.as_mut_ptr() as *mut ACL;
        if IsValidAcl(p) == 0 { return Err(ERR_BAD_ACL); }
        let rc = SetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), p, null_mut());
        if rc != 0 { Err(rc) } else { Ok(()) }
    }
}

/// Adds one explicit allow entry (no inheritance flags: the desktops of a station do not take it over) for the SID, with every other entry left byte for byte where it was
/// (winobj::with_allow_entry; not SetEntriesInAclW, which rebuilds the list). `h` needs READ_CONTROL and WRITE_DAC. A NULL DACL is refused: a DACL made of this one entry would shut
/// everyone else out of an object that was not made by this launcher, and a NULL one on a new object is not what the default token DACL gives.
#[cfg(feature = "experiment")]
pub(crate) fn add_entry(h: HANDLE, sid: PSID, mask: u32) -> Result<(), u32> {
    let sid = sid_bytes(sid).ok_or(ERR_NOT_PROFILE_SID)?;
    let old = acl_copy(h)?.ok_or(ERR_NULL_DACL)?;
    let new = winobj::with_allow_entry(old.bytes(), &sid, mask).ok_or(ERR_BAD_ACL)?;
    write_dacl(h, &new)
}

/// 64 random bits for the station's name: the OS-seeded hasher of std (no extra crate), mixed with the process number and the clock.
fn random_seed() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u32(std::process::id());
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// The launcher's own token user and token owner (binary SIDs, the user FIRST): the account the objects are made for, and the only accounts the read-back check accepts besides the fixed ones.
/// The PROCESS token (the launcher never impersonates; the objects get the process token's owner).
pub(crate) fn own_principals() -> Result<Vec<Vec<u8>>, u32> {
    unsafe {
        let mut tok: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 { return Err(GetLastError()); }
        let tok = Handle(tok);
        let mut out = Vec::new();
        for class in [TokenUser, TokenOwner] {
            let mut need = 0u32;
            GetTokenInformation(tok.0, class, null_mut(), 0, &mut need);
            if need == 0 { return Err(GetLastError()); }
            let mut buf = vec![0usize; (need as usize).div_ceil(size_of::<usize>())];
            if GetTokenInformation(tok.0, class, buf.as_mut_ptr() as *mut c_void, need, &mut need) == 0 { return Err(GetLastError()); }
            // TOKEN_USER starts with SID_AND_ATTRIBUTES (its Sid first) and TOKEN_OWNER with Owner: both a PSID at offset 0.
            let sid = *(buf.as_ptr() as *const PSID);
            out.push(sid_bytes(sid).ok_or(ERR_OWN_SID)?);
        }
        Ok(out)
    }
}

fn trouble(what: &str, code: u32) -> String { format!("window objects: the private {what} (error {code})") }

/// The launcher's own process window station: its name (UOI_NAME, "?" when unreadable) and USEROBJECTFLAGS.dwFlags (-1 when unreadable; bit 0 is WSF_VISIBLE). The handle is the process's own and is not closed.
fn own_station() -> (String, i64) {
    unsafe {
        let h = GetProcessWindowStation() as HANDLE;
        if h.is_null() { return ("?".into(), -1); }
        let mut buf = [0u16; 256];
        let mut needed = 0u32;
        let name = if GetUserObjectInformationW(h, UOI_NAME, buf.as_mut_ptr() as *mut c_void, (buf.len() * 2) as u32, &mut needed) == 0 { "?".to_string() }
            else { String::from_utf16_lossy(&buf[..buf.iter().position(|c| *c == 0).unwrap_or(buf.len())]) };
        let mut f = [0u32; 3]; // USEROBJECTFLAGS: fInherit, fReserved, dwFlags
        let flags = if GetUserObjectInformationW(h, UOI_FLAGS, f.as_mut_ptr() as *mut c_void, 12, &mut needed) == 0 { -1 } else { f[2] as i64 };
        (name, flags)
    }
}

/// A security descriptor (absolute form) holding one DACL, kept alive with the ACL it points to for the creating call. The DACL is marked protected, so nothing is inherited into it.
pub(crate) struct CreationSd { _acl: Vec<usize>, sd: Box<SECURITY_DESCRIPTOR> }
impl CreationSd {
    fn new(acl: &[u8]) -> Result<CreationSd, u32> {
        unsafe {
            let mut buf = vec![0usize; acl.len().div_ceil(size_of::<usize>())];
            std::ptr::copy_nonoverlapping(acl.as_ptr(), buf.as_mut_ptr() as *mut u8, acl.len());
            let p = buf.as_mut_ptr() as *mut ACL;
            if IsValidAcl(p) == 0 { return Err(ERR_BAD_ACL); }
            let mut sd: Box<SECURITY_DESCRIPTOR> = Box::new(zeroed());
            let psd = &mut *sd as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR;
            // SECURITY_DESCRIPTOR_REVISION is 1 (winnt.h).
            if InitializeSecurityDescriptor(psd, 1) == 0 || SetSecurityDescriptorDacl(psd, 1, p, 0) == 0 || SetSecurityDescriptorControl(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED) == 0 { return Err(GetLastError()); }
            Ok(CreationSd { _acl: buf, sd })
        }
    }
    /// SECURITY_ATTRIBUTES for the creating call (the handle is not inheritable). Valid while `self` lives.
    pub(crate) fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: &mut *self.sd as *mut SECURITY_DESCRIPTOR as *mut c_void, bInheritHandle: 0 }
    }
}

/// The creation descriptor of one private object (Err: a typed "window objects:" message).
pub(crate) fn creation_sd(user: &[u8], container: &[u8], mask: u32, full: u32, what: &str) -> Result<CreationSd, String> {
    let acl = winobj::private_dacl(user, container, mask, full).ok_or_else(|| format!("window objects: refused: no access list could be built for the private {what} (error {ERR_BAD_ACL})"))?;
    CreationSd::new(&acl).map_err(|e| trouble(&format!("{what}'s security descriptor could not be built"), e))
}

/// The launcher's own process window station, put back on every path out of a scope (an early return or a panic included).
struct StationSwitch { original: HWINSTA, armed: bool }
impl StationSwitch {
    /// Makes `to` the process window station. None when the switch fails (nothing to restore).
    fn to(to: HWINSTA) -> Option<StationSwitch> {
        unsafe {
            let original = GetProcessWindowStation();
            if original.is_null() || SetProcessWindowStation(to) == 0 { return None; }
            Some(StationSwitch { original, armed: true })
        }
    }
    /// Switches back now and says whether that worked.
    fn restore(&mut self) -> bool {
        if !self.armed { return true; }
        self.armed = false;
        unsafe { SetProcessWindowStation(self.original) != 0 }
    }
}
impl Drop for StationSwitch { fn drop(&mut self) { self.restore(); } }

/// One run's private window station and desktop. Dropping it closes both (the desktop first).
pub(crate) struct PrivateDesktop { station: HANDLE, desktop: HANDLE, station_name: String, desktop_name: String, lp: Vec<u16>, own: Vec<Vec<u8>>, closed: bool, close_error: Option<u32>, mode: WindowMode, named_refusal: Option<String> }

/// Why no window objects were made: the mode that was last attempted, the typed message ("window objects: ...") and, when the home desktop was tried after the named station was refused, the
/// named station's own message (so the report says both).
pub(crate) struct MakeError { pub(crate) mode: WindowMode, pub(crate) message: String, pub(crate) named_refusal: Option<String> }

impl PrivateDesktop {
    /// The window objects of one run, in the order of plan 12.5: the NAMED private window station when this launcher may name one (an administrator's elevated token); when a launcher KNOWN
    /// to be not elevated (`elevation` Some(false): the token was read) is refused with error 5 (the documented administrators-only rule), ONE private desktop on the user's own interactive station (the home desktop). Any other failure, and every
    /// failure of the home desktop, is returned: the launcher never inherits a desktop, so nothing starts.
    pub(crate) fn create(sid: PSID, elevation: Option<bool>) -> Result<PrivateDesktop, MakeError> {
        let mut station_error = 0u32;
        match Self::create_named(sid, &mut station_error) {
            Ok(p) => Ok(p),
            Err(message) if winobj::try_home_desktop(elevation, station_error) => match Self::create_home(sid) {
                Ok(mut p) => { p.named_refusal = Some(message); Ok(p) }
                Err(home) => Err(MakeError { mode: WindowMode::HomeDesktop, message: format!("{home} (after: {message})"), named_refusal: Some(message) }),
            },
            Err(message) => Err(MakeError { mode: WindowMode::Private, message, named_refusal: None }),
        }
    }

    /// The mode these objects are (`private` or `home-desktop`).
    pub(crate) fn mode(&self) -> WindowMode { self.mode }
    /// The named station's own error text when this run is a home desktop (the named station was refused first), else None.
    pub(crate) fn named_refusal(&self) -> Option<&str> { self.named_refusal.as_deref() }

    /// The home desktop (plan 12.5): ONE desktop on the launcher's own CURRENT window station, which must be the visible interactive WinSta0 (winobj::may_make_home_desktop), CREATED with its final
    /// protected access list (the launcher's own account, SYSTEM and the container: the same descriptor and the same read-back as the private desktop) and NOT written afterwards. Nothing is
    /// written to the station's access list (the measured run needed no entry) and the station handle is the process's own, never closed here. `lpDesktop` is `WinSta0\<name>`.
    fn create_home(sid: PSID) -> Result<PrivateDesktop, String> {
        let text = sid_string(sid);
        if !winobj::is_profile_sid(&text) { return Err(format!("window objects: refused: the SID is not one AppContainer profile's (error {ERR_NOT_PROFILE_SID})")); }
        let Some(sid_b) = sid_bytes(sid) else { return Err(format!("window objects: refused: the SID is not well formed (error {ERR_NOT_PROFILE_SID})")) };
        let own = own_principals().map_err(|e| format!("window objects: the launcher's own account could not be read (error {e})"))?;
        let (station, flags) = own_station();
        winobj::may_make_home_desktop(&station, flags, session_id()).map_err(|e| format!("window objects: the home desktop {e}"))?;
        let mut sd = creation_sd(&own[0], &sid_b, DESKTOP_RIGHTS, winobj::DESKTOP_FULL, "home desktop")?;
        let name = winobj::home_desktop_name(random_seed());
        let lp = wide(&winobj::desktop_path(&station, &name));
        let mut p = PrivateDesktop { station: null_mut(), desktop: null_mut(), station_name: station, desktop_name: name.clone(), lp, own, closed: false, close_error: None, mode: WindowMode::HomeDesktop, named_refusal: None };
        unsafe {
            let sa = sd.attributes();
            SetLastError(0);
            let hd = CreateDesktopW(wide(&name).as_ptr(), null(), null(), 0, DESKTOP_RIGHTS, &sa) as HANDLE;
            let e = GetLastError();
            if hd.is_null() { return Err(trouble("home desktop could not be made", e)); }
            p.desktop = hd; // closed by Drop on every path out
            if e == ERROR_ALREADY_EXISTS { return Err(trouble("home desktop name is already taken", ERR_NAME_TAKEN)); }
            p.check(hd, &sid_b, DESKTOP_RIGHTS, "home desktop")?;
        }
        Ok(p)
    }

    /// Makes the named station and its desktop for the container with this SID. Err: a message that starts with "window objects:" (nothing is left open); `station_error` is the error of
    /// CreateWindowStationW when that call was the one that failed (else left 0).
    fn create_named(sid: PSID, station_error: &mut u32) -> Result<PrivateDesktop, String> {
        let text = sid_string(sid);
        if !winobj::is_profile_sid(&text) { return Err(format!("window objects: refused: the SID is not one AppContainer profile's (error {ERR_NOT_PROFILE_SID})")); }
        let Some(sid_b) = sid_bytes(sid) else { return Err(format!("window objects: refused: the SID is not well formed (error {ERR_NOT_PROFILE_SID})")) };
        let own = own_principals().map_err(|e| format!("window objects: the launcher's own account could not be read (error {e})"))?;
        let mut station_sd = creation_sd(&own[0], &sid_b, STATION_RIGHTS, winobj::STATION_FULL, "window station")?;
        let mut desktop_sd = creation_sd(&own[0], &sid_b, DESKTOP_RIGHTS, winobj::DESKTOP_FULL, "desktop")?;
        let (station_name, desktop_name) = winobj::private_names(random_seed());
        let lp = wide(&winobj::desktop_path(&station_name, &desktop_name));
        let (wstation, wdesktop) = (wide(&station_name), wide(&desktop_name));
        let mut p = PrivateDesktop { station: null_mut(), desktop: null_mut(), station_name, desktop_name, lp, own, closed: false, close_error: None, mode: WindowMode::Private, named_refusal: None };
        unsafe {
            // The station. A name that already exists is never adopted (its DACL is not ours).
            // CWF_CREATE_ONLY: an existing station of that name makes the call fail instead of opening it (the error code alone is not documented for that case).
            // The handle asks for what the launcher uses (READ_CONTROL for the read-back, WINSTA_CREATEDESKTOP for the desktop), no WRITE_DAC: the DACL is never written.
            let sa = station_sd.attributes();
            SetLastError(0);
            let hs = CreateWindowStationW(wstation.as_ptr(), winobj::STATION_CREATE_ONLY, STATION_RIGHTS, &sa) as HANDLE;
            let e = GetLastError();
            if hs.is_null() {
                *station_error = e;
                // Microsoft: "Only members of the Administrators group are allowed to specify a name" (CreateWindowStation). A NULL name is not used: it names the station after the caller's
                // logon session, which is the station a service already has.
                let hint = if e == ERROR_ACCESS_DENIED { " (Microsoft documents that only members of Administrators may name a window station)" } else { "" };
                return Err(format!("{}{hint}", trouble("window station could not be made", e)));
            }
            p.station = hs;
            if e == ERROR_ALREADY_EXISTS { return Err(trouble("window station name is already taken", ERR_NAME_TAKEN)); }
            p.check(hs, &sid_b, STATION_RIGHTS, "window station")?;

            // The desktop: made in the process's current station, so the process is switched to the new station for that one call and back at once.
            SetLastError(0);
            let Some(mut back) = StationSwitch::to(p.station as HWINSTA) else { return Err(trouble("window station could not be entered to make its desktop", GetLastError())); };
            let sa = desktop_sd.attributes();
            SetLastError(0);
            let hd = CreateDesktopW(wdesktop.as_ptr(), null(), null(), 0, DESKTOP_RIGHTS, &sa) as HANDLE;
            let created = GetLastError();
            let restored = back.restore();
            let restore_error = GetLastError();
            if !hd.is_null() { p.desktop = hd; }
            if !restored { return Err(trouble("launcher could not switch back to its own window station", if restore_error != 0 { restore_error } else { ERR_STATION_SWITCH_BACK })); }
            if hd.is_null() { return Err(trouble("desktop could not be made", created)); }
            if created == ERROR_ALREADY_EXISTS { return Err(trouble("desktop name is already taken", ERR_NAME_TAKEN)); }
            p.check(hd, &sid_b, DESKTOP_RIGHTS, "desktop")?;
        }
        Ok(p)
    }

    /// The DACL of a made object read back and checked.
    fn check(&self, h: HANDLE, sid_b: &[u8], mask: u32, what: &str) -> Result<(), String> {
        match acl_copy(h) {
            Err(e) => Err(trouble(&format!("{what}'s access list could not be read back"), e)),
            Ok(None) => Err(trouble(&format!("{what} has no access list"), ERR_NULL_DACL)),
            Ok(Some(c)) => winobj::private_acl_ok(c.bytes(), sid_b, mask, &self.own).map_err(|why| format!("window objects: the private {what}'s access list is not acceptable: {why} (error {ERR_BAD_ACL})")),
        }
    }

    /// The `lpDesktop` text, NUL-terminated, for STARTUPINFO.
    pub(crate) fn lp_desktop(&self) -> Vec<u16> { self.lp.clone() }

    /// Closes the desktop and then the station. Safe to call twice. False (with the first error kept for the JSON line) when a close failed: that handle then stays open until the
    /// launcher exits a moment later, when the system closes it (an object with no handle left is destroyed), so it is reported, not retried.
    pub(crate) fn close(&mut self) -> bool {
        if self.closed { return self.close_error.is_none(); }
        self.closed = true;
        unsafe {
            if !self.desktop.is_null() { if CloseDesktop(self.desktop as HDESK) == 0 { self.close_error.get_or_insert(GetLastError()); } self.desktop = null_mut(); }
            if !self.station.is_null() { if CloseWindowStation(self.station as HWINSTA) == 0 { self.close_error.get_or_insert(GetLastError()); } self.station = null_mut(); }
        }
        self.close_error.is_none()
    }

    /// The first error of a failed close (None: closed cleanly, or not closed yet).
    pub(crate) fn close_error(&self) -> Option<u32> { self.close_error }

    /// The part of the launcher's JSON line that names the objects (their names are not secret: the DACL is what protects them).
    pub(crate) fn json(&self) -> String {
        let mut o = Json::new();
        o.s("mode", self.mode.name());
        o.s("station", &self.station_name);
        o.s("desktop", &self.desktop_name);
        if let Some(r) = &self.named_refusal { o.s("privateStationError", r); }
        o.b("closed", self.closed && self.close_error.is_none());
        if let Some(e) = self.close_error { o.n("closeError", e as i64); }
        o.render()
    }
}

impl Drop for PrivateDesktop { fn drop(&mut self) { let _ = self.close(); } }
