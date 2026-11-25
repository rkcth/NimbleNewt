// The private window station and desktop of every run (card A03b, Session 0 fix; both builds, Windows only). The pure rules (names, masks, the DACL check) are in winobj.rs.
//
// What it does, for ONE run: make a window station with a name of its own, give the container's SID one explicit allow entry on it, make a desktop in it and give the container one entry there
// too, hand `station\desktop` to CreateProcessW as lpDesktop, and close the desktop and then the station when the run is over (the job's kill-on-close has ended the child by then; an object
// with no handle left is destroyed). A window station of the launcher's own session is never opened, never changed and never named: not WinSta0 (the interactive station), not the service's
// `Service-0x0-<logon id>$`, and no DACL of the launcher's own objects is written.
//
// The new objects get the launcher's default token DACL (the creating account and SYSTEM; CreateWindowStationW with no security attributes), the measured configuration. The container's entry is added
// with the same byte-exact builder the experiment used (winobj::with_allow_entry, masks 131967 and 131583), and the DACL is READ BACK and checked (winobj::private_acl_ok, an allow list: exactly one
// entry for the container, otherwise only SYSTEM, Administrators, OWNER RIGHTS, a logon-session SID and the launcher's own token user and owner). The station is made with CWF_CREATE_ONLY. A failed step is a typed failure and the run does not start.
//
// CreateDesktopW makes a desktop in the CALLING PROCESS's window station, so the launcher switches its own process window station to the new one for that single call and back at once
// (SetProcessWindowStation). The switch back is checked, and a guard restores the original station on every other path out (an early return or a panic) too.
use super::*;
use crate::winobj::{self, DESKTOP_RIGHTS, STATION_RIGHTS};
use windows_sys::Win32::System::StationsAndDesktops::*;

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

/// The launcher's own token user and token owner (binary SIDs): the principals its default token DACL is made for, the only accounts the read-back check accepts besides the fixed ones.
fn own_principals() -> Result<Vec<Vec<u8>>, u32> {
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
pub(crate) struct PrivateDesktop { station: HANDLE, desktop: HANDLE, station_name: String, desktop_name: String, lp: Vec<u16>, own: Vec<Vec<u8>>, closed: bool, close_error: Option<u32> }

impl PrivateDesktop {
    /// Makes the objects for the container with this SID. Err: a message that starts with "window objects:" (nothing is left open).
    pub(crate) fn create(sid: PSID) -> Result<PrivateDesktop, String> {
        let text = sid_string(sid);
        if !winobj::is_profile_sid(&text) { return Err(format!("window objects: refused: the SID is not one AppContainer profile's (error {ERR_NOT_PROFILE_SID})")); }
        let Some(sid_b) = sid_bytes(sid) else { return Err(format!("window objects: refused: the SID is not well formed (error {ERR_NOT_PROFILE_SID})")) };
        let own = own_principals().map_err(|e| format!("window objects: the launcher's own account could not be read (error {e})"))?;
        let (station_name, desktop_name) = winobj::private_names(random_seed());
        let lp = wide(&winobj::desktop_path(&station_name, &desktop_name));
        let (wstation, wdesktop) = (wide(&station_name), wide(&desktop_name));
        let mut p = PrivateDesktop { station: null_mut(), desktop: null_mut(), station_name, desktop_name, lp, own, closed: false, close_error: None };
        unsafe {
            // The station. A name that already exists is never adopted (its DACL is not ours).
            // CWF_CREATE_ONLY: an existing station of that name makes the call fail instead of opening it (the error code alone is not documented for that case).
            SetLastError(0);
            let hs = CreateWindowStationW(wstation.as_ptr(), winobj::STATION_CREATE_ONLY, STATION_RIGHTS | WRITE_DAC_BIT, null()) as HANDLE;
            let e = GetLastError();
            if hs.is_null() { return Err(trouble("window station could not be made", e)); }
            p.station = hs;
            if e == ERROR_ALREADY_EXISTS { return Err(trouble("window station name is already taken", ERR_NAME_TAKEN)); }
            p.give(hs, sid, &sid_b, STATION_RIGHTS, "window station")?;

            // The desktop: made in the process's current station, so the process is switched to the new station for that one call and back at once.
            SetLastError(0);
            let Some(mut back) = StationSwitch::to(p.station as HWINSTA) else { return Err(trouble("window station could not be entered to make its desktop", GetLastError())); };
            let hd = CreateDesktopW(wdesktop.as_ptr(), null(), null(), 0, DESKTOP_RIGHTS | WRITE_DAC_BIT, null()) as HANDLE;
            let created = GetLastError();
            let restored = back.restore();
            let restore_error = GetLastError();
            if !hd.is_null() { p.desktop = hd; }
            if !restored { return Err(trouble("launcher could not switch back to its own window station", if restore_error != 0 { restore_error } else { ERR_STATION_SWITCH_BACK })); }
            if hd.is_null() { return Err(trouble("desktop could not be made", created)); }
            if created == ERROR_ALREADY_EXISTS { return Err(trouble("desktop name is already taken", ERR_NAME_TAKEN)); }
            p.give(hd, sid, &sid_b, DESKTOP_RIGHTS, "desktop")?;
        }
        Ok(p)
    }

    /// The container's entry on a made object, then the DACL read back and checked.
    fn give(&self, h: HANDLE, sid: PSID, sid_b: &[u8], mask: u32, what: &str) -> Result<(), String> {
        add_entry(h, sid, mask).map_err(|e| trouble(&format!("{what} could not be given to the container"), e))?;
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
        o.s("mode", "private");
        o.s("station", &self.station_name);
        o.s("desktop", &self.desktop_name);
        o.b("closed", self.closed && self.close_error.is_none());
        if let Some(e) = self.close_error { o.n("closeError", e as i64); }
        o.render()
    }
}

impl Drop for PrivateDesktop { fn drop(&mut self) { let _ = self.close(); } }
