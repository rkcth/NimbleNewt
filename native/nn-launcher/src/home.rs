// The "home case" measurement (EXPERIMENT build only; this file is not compiled into the product launcher). The common home PC has ONE account, usually an administrator running with UAC, so the
// worker runs as that user in the normal desktop session: not elevated, medium integrity, no second account, no service, no password. Measured by the owner (build 26200, PowerShell 5.1,
// 2026-11-25): the product launcher, run that way, makes the per-run profile and deletes it (profile gone), but cannot make the named private window station (error 5) and so fails closed. These
// commands measure what a NON-ELEVATED user CAN do instead, on the user's OWN window station, without administrator rights and without touching anything that outlasts the run:
//
//   home-probe    one JSON line per step: the token facts, who may write WinSta0's access list, a throw-away profile, and for each way of giving the container a desktop (inherit the user's own,
//                 a private desktop on WinSta0, the same plus a temporary entry for the container on WinSta0 at the read or the full level) the programs that run in the container and exit codes
//                 (cmd, hostname, node when found, and `ui-test`, a program of this very executable that loads user32 and reports what a confined program sees of the desktop), with and without the
//                 job's UI limits. Console programs only: no program here opens a window.
//   ui-test       meant to run AS THE CHILD inside the container; read-only look at the desktop (no input is sent, no window message is sent, the clipboard is opened and closed without reading).
//   home-revoke   removes the container's explicit entries from WinSta0 for one profile name (the clean-up after a launcher killed in a `home-desktop-station-*` step).
//   deelevate     runs this executable again with a de-elevated token (Administrators deny-only, privileges removed, medium integrity), to measure the same steps as a non-elevated process from an
//                 elevated one (the hosted runner is an administrator); see README "The home case".
//
// What is written, and how it is undone: the desktop made for a step is created with its final access list (the launcher's own account, SYSTEM, the container) and closed at the end of the step.
// The ONLY write to a shared object is ONE temporary allow entry for ONE throw-away container SID on WinSta0 (the two `home-desktop-station-*` modes, only when asked for or when the desktop alone
// failed): taken out again in the same step (a Drop guard covers a panic), read back and compared with the copy taken before. A launcher KILLED between the write and the removal leaves that entry
// until sign-out, and also leaves that run's per-run profile and its record (the profile is deleted only at the end of a run); the ATTEMPT line prints both clean-up commands
// (`home-revoke` and `delete-profile`, each with the record as its proof, as delete-profile requires).
use super::*;
use crate::homerules::{self as hr, Group, Kind, Prog, Verdict};

use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardSequenceNumber, GlobalAddAtomW, GlobalDeleteAtom, OpenClipboard};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows_sys::Win32::UI::WindowsAndMessaging::{CallNextHookEx, EnumWindows, GetCursorPos, GetForegroundWindow, IsWindowVisible, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL};

use super::desk;
use super::privdesk::acl_copy;

fn get<'a>(j: &'a Json, k: &str) -> Option<&'a str> { j.0.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str()) }
fn log(msg: &str) { eprintln!("nn-home: {msg}"); }

/// 64 random bits (the OS-seeded hasher of std, the process number and the clock): names of the throw-away profiles and the work folder.
fn random_seed() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u32(std::process::id());
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

fn run_name() -> String { format!("{}{:016x}", profile::RUN_PREFIX, random_seed()) }

// ---------------------------------------------------------------------------------------------------------------- the token

fn open_own_token(access: u32) -> Option<Handle> {
    unsafe {
        let mut tok: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), access, &mut tok) == 0 { None } else { Some(Handle(tok)) }
    }
}

/// A token information buffer (pointer-aligned), None when the call fails.
fn token_info(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<Vec<usize>> {
    unsafe {
        let mut need = 0u32;
        GetTokenInformation(tok, class, null_mut(), 0, &mut need);
        if need == 0 { return None; }
        let mut buf = vec![0usize; (need as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(tok, class, buf.as_mut_ptr() as *mut c_void, need, &mut need) == 0 { None } else { Some(buf) }
    }
}

/// The token's groups: SID text and attributes (SE_GROUP_*).
fn token_groups(tok: HANDLE) -> Vec<(String, u32)> {
    let Some(buf) = token_info(tok, TokenGroups) else { return Vec::new() };
    unsafe {
        let tg = buf.as_ptr() as *const TOKEN_GROUPS;
        let n = (*tg).GroupCount as usize;
        let first = (*tg).Groups.as_ptr();
        (0..n).map(|i| { let g = &*first.add(i); (sid_string(g.Sid), g.Attributes) }).collect()
    }
}

fn token_user_text(tok: HANDLE) -> String {
    let Some(buf) = token_info(tok, TokenUser) else { return "?".into() };
    unsafe { sid_string((*(buf.as_ptr() as *const TOKEN_USER)).User.Sid) }
}

fn token_u32(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> i64 {
    unsafe {
        let mut v = 0u32;
        let mut got = 0u32;
        if GetTokenInformation(tok, class, &mut v as *mut _ as *mut c_void, 4, &mut got) == 0 { -1 } else { v as i64 }
    }
}

fn base_line(step: &str, group: &str) -> Json {
    let mut j = Json::new();
    j.s("tool", TOOL);
    j.s("probe", "home");
    j.s("step", step);
    if !group.is_empty() { j.s("group", group); }
    j
}

/// `context`: who runs this, read-only. Account-specific SIDs are redacted (homerules::redact_sid).
fn step_context(j: &mut Json) {
    j.b("elevated", is_elevated());
    j.n("sessionId", session_id());
    let tok = open_own_token(TOKEN_QUERY);
    if let Some(t) = &tok {
        let groups = token_groups(t.0);
        j.s("elevationType", hr::elevation_type_name(token_u32(t.0, TokenElevationType)));
        j.s("adminGroup", hr::admin_group_state(&groups));
        j.s("tokenUser", &hr::redact_sid(&token_user_text(t.0)));
        j.n("groupCount", groups.len() as i64);
    }
    let rid = desk::integrity_rid();
    j.n("integrityRid", rid);
    j.s("integrity", hr::integrity_name(rid));
    let station = desk::current_station_name();
    let flags = unsafe { desk::station_flags(GetProcessWindowStation() as HANDLE) };
    j.s("windowStation", &station);
    j.n("windowStationFlags", flags);
    j.b("interactiveStation", station.eq_ignore_ascii_case("winsta0") && flags >= 0 && flags & 1 == 1);
    j.s("desktop", &desk::current_desktop_name());
    let (major, minor, build) = desk::os_version();
    j.n("osMajor", major); j.n("osMinor", minor); j.n("osBuild", build);
    j.b("ok", true);
}

// ---------------------------------------------------------------------------------------------------------------- who may write the window station's access list

/// What one window object (the current station or desktop) allows, read without writing anything: its access list (redacted, with the right names), what ALL APPLICATION PACKAGES holds on it,
/// its owner, and whether an OPEN asking for WRITE_DAC is granted to this token (the open is closed at once; no access list is written).
fn object_report(name: &str, station: bool) -> Json {
    let mut o = Json::new();
    o.s("name", name);
    let open = |access: u32| -> (HANDLE, u32) {
        unsafe {
            SetLastError(0);
            let h = if station { desk::open_station(name, access) } else { desk::open_desktop(name, access) };
            (h, GetLastError())
        }
    };
    let close = |h: HANDLE| unsafe { if !h.is_null() { if station { CloseWindowStation(h as HWINSTA); } else { CloseDesktop(h as HDESK); } } };
    let (h, e) = open(desk::READ_CONTROL_BIT);
    if h.is_null() { o.b("readable", false); o.n("readError", e as i64); }
    else {
        o.b("readable", true);
        match acl_copy(h) {
            Err(e) => { o.n("aclError", e as i64); }
            Ok(None) => { o.b("nullDacl", true); }
            Ok(Some(c)) => match hr::ace_infos(c.bytes()) {
                None => { o.s("aclError", "not a well-formed ACL"); }
                Some(infos) => {
                    o.raw("aces", hr::aces_json(&infos, station));
                    let p = hr::package_groups(&infos);
                    o.raw("allApplicationPackagesAllow", hr::masks_json(&p.all_app_packages));
                    o.raw("allRestrictedPackagesAllow", hr::masks_json(&p.all_restricted));
                    o.b("hasAllApplicationPackagesEntry", !p.all_app_packages.is_empty());
                }
            },
        }
        unsafe {
            let mut owner: PSID = null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = null_mut();
            let rc = GetSecurityInfo(h, SE_WINDOW_OBJECT, OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(), null_mut(), &mut sd);
            if rc == 0 && !owner.is_null() {
                let text = sid_string(owner);
                o.s("owner", &hr::redact_sid(&text));
                o.b("ownerIsAdministrators", text == "S-1-5-32-544");
                if let Some(t) = open_own_token(TOKEN_QUERY) { o.b("ownerIsTokenUser", text == token_user_text(t.0)); }
            } else { o.n("ownerError", rc as i64); }
            if !sd.is_null() { LocalFree(sd as *mut c_void); }
        }
        close(h);
    }
    let (h, e) = open(desk::READ_CONTROL_BIT | super::privdesk::WRITE_DAC_BIT);
    o.b("openWithWriteDac", !h.is_null());
    if h.is_null() { o.n("openWithWriteDacError", e as i64); }
    close(h);
    if station {
        let (h, e) = open(0x0008); // WINSTA_CREATEDESKTOP
        o.b("openWithCreateDesktop", !h.is_null());
        if h.is_null() { o.n("openWithCreateDesktopError", e as i64); }
        close(h);
    }
    o
}

fn step_station_access(j: &mut Json) {
    let station = desk::current_station_name();
    let desktop = desk::current_desktop_name();
    j.raw("station", object_report(&station, true).render());
    j.raw("desktopObject", object_report(&desktop, false).render());
    j.b("ok", true);
}

// ---------------------------------------------------------------------------------------------------------------- a throw-away profile

fn step_profile(j: &mut Json, rec: &str) {
    let name = run_name();
    let record = format!("{rec}\\{name}.sid");
    match ProfileLife::begin(&name, &record) {
        Err(e) => { j.b("ok", false); j.s("error", &e); }
        Ok((_sid, life)) => {
            j.s("profile", "created");
            life.finish(j, true);
            let ok = get(j, "profileDeleted") == Some("true") && get(j, "profileGone") == Some("true");
            j.b("ok", ok);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- programs in the container

struct Resolved { exe: String, cmdline: String, soft_rx: Option<String> }

fn find_on_path(file: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(file)).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
}

fn resolve(prog: Prog, ws: &str, sys: &str, ui_exe: &str) -> Result<Resolved, String> {
    match prog {
        Prog::Cmd => { let exe = format!("{sys}\\System32\\cmd.exe"); Ok(Resolved { cmdline: format!("{} /c echo nn-home-ok", hr::quote_arg(&exe)), exe, soft_rx: None }) }
        Prog::Hostname => { let exe = format!("{sys}\\System32\\hostname.exe"); Ok(Resolved { cmdline: hr::quote_arg(&exe), exe, soft_rx: None }) }
        Prog::Node => {
            let exe = find_on_path("node.exe").ok_or("node.exe was not found on PATH")?;
            let dir = std::path::Path::new(&exe).parent().map(|p| p.to_string_lossy().into_owned());
            Ok(Resolved { cmdline: format!("{} -e \"process.stdout.write('nn-home-node-ok')\"", hr::quote_arg(&exe)), exe, soft_rx: dir })
        }
        Prog::UiTest => { let _ = ws; Ok(Resolved { cmdline: format!("{} ui-test", hr::quote_arg(ui_exe)), exe: ui_exe.to_string(), soft_rx: None }) }
    }
}

fn read_head(path: &str, max: usize) -> String {
    match std::fs::read(path) { Ok(b) => String::from_utf8_lossy(&b[..b.len().min(max)]).trim().to_string(), Err(_) => String::new() }
}

/// One run step: a throw-away per-run profile (the product's own name form and record), the work folder as the only grant, the product's LPAC arguments, one program.
#[allow(clippy::too_many_arguments)]
fn step_run(base: &Args, id: &str, group: Group, prog: Prog, limits: bool, ws: &str, dir: &str, rec: &str, ui_exe: &str) -> (String, bool) {
    let mut j = base_line(id, group.name());
    j.s("program", prog.name());
    j.b("limits", limits);
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let r = match resolve(prog, ws, &sys, ui_exe) {
        Ok(r) => r,
        Err(why) => { j.b("skipped", true); j.s("reason", &why); j.b("ok", true); return (j.render(), false); }
    };
    let name = run_name();
    let mut a = Args { command: "run".into(), name: name.clone(), kill_on_close: true, stdin: "nul".into(), ..Default::default() };
    a.exe = Some(r.exe.clone());
    a.cmdline = Some(r.cmdline);
    a.cwd = Some(ws.to_string());
    let (out, err) = (format!("{dir}\\{id}.out"), format!("{dir}\\{id}.err"));
    a.stdout = Some(out.clone());
    a.stderr = Some(err.clone());
    a.profile_record = Some(format!("{rec}\\{name}.sid"));
    a.env = vec![("SystemRoot".into(), sys.clone()), ("windir".into(), sys.clone()), ("TEMP".into(), ws.to_string()), ("TMP".into(), ws.to_string()),
        ("PATH".into(), format!("{sys}\\System32;{sys}{}", r.soft_rx.as_deref().map(|d| format!(";{d}")).unwrap_or_default()))];
    a.grants = vec![GrantSpec { mode: Mode::Modify, path: ws.to_string(), soft: false }];
    if let Some(d) = &r.soft_rx { a.grants.push(GrantSpec { mode: Mode::Rx, path: d.clone(), soft: true }); }
    // The product's LPAC form when the caller chose `--aap-policy optout`; the plain AppContainer when it chose `none` (or gave nothing).
    a.aap = base.aap;
    a.capabilities = if base.aap == Some(AAP_OPT_OUT) && base.capabilities.is_empty() { vec!["registryRead".into(), "lpacCom".into()] } else { base.capabilities.clone() };
    a.memory_mb = 1024;
    a.active_processes = 16;
    a.ui_limits = limits;
    a.timeout_ms = base.timeout_ms.min(30_000);
    a.desktop = group.mode();
    j.s("command", "run");
    j.b("elevated", is_elevated());
    j.n("sessionId", session_id());
    let j = describe(&a, j);
    if group.mode().is_home() && hr_writes_station(group) {
        let sid = derived_sid(&name).map(|s| sid_string(s.0)).unwrap_or_default();
        let record = format!("{rec}\\{name}.sid");
        log(&format!("ATTEMPT {id}: a temporary entry for the container {sid} (profile {name}) is written to WinSta0 and removed in this step; if this program is killed, run: {}", hr::cleanup_commands(&name, &sid, &record)));
    }
    let mut o = run(&a, j);
    let works = get(&o.j, "ok") == Some("true") && get(&o.j, "childExitCode") == Some("0") && get(&o.j, "timedOut") == Some("false");
    o.j.b("works", works);
    o.j.s("childStdout", &read_head(&out, 1500));
    o.j.s("childStderr", &read_head(&err, 400));
    let left = o.j.render().contains("\"allReverted\":false");
    (o.j.render(), left)
}

fn hr_writes_station(g: Group) -> bool { matches!(g, Group::StationRead | Group::StationFull) }

/// `home-probe`: runs the steps (all, or `--steps`), one JSON line each, then a summary line. Returns the process exit code (0 when the probe itself ran; the lines hold the findings).
pub(crate) fn home_probe(a: &Args) -> i32 {
    let steps = match hr::select_steps(hr::all_steps(), &a.steps) { Ok(s) => s, Err(e) => { let mut j = base_line("arguments", ""); j.b("ok", false); j.s("error", &e); println!("{}", j.render()); return 125; } };
    // The work folder is ALWAYS a new folder of its own (create-new) inside --cwd or the temp folder, never the folder --cwd names: it is removed whole at the end.
    let base = a.cwd.as_deref().map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let root = base.join(hr::work_folder_name(random_seed()));
    if let Err(e) = std::fs::create_dir(&root) { let mut j = base_line("arguments", ""); j.b("ok", false); j.s("error", &format!("the work folder could not be made (it must be new): {e}")); println!("{}", j.render()); return 125; }
    // `rec` (the launcher's profile records) is outside the work folder the container is granted, as the product keeps them out of its reach.
    let (ws, dir, rec) = (root.join("ws"), root.join("steps"), root.join("rec"));
    for d in [&ws, &dir, &rec] {
        if let Err(e) = std::fs::create_dir(d) { let mut j = base_line("arguments", ""); j.b("ok", false); j.s("error", &format!("the work folder could not be made: {e}")); println!("{}", j.render()); return 125; }
    }
    let (ws, dir, rec) = (ws.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned(), rec.to_string_lossy().into_owned());
    // The program that loads user32 inside the container is this same executable, copied into the work folder (the folder carries the container's only grant, so it can start there).
    let ui_exe = format!("{ws}\\nn-ui.exe");
    let copied = std::env::current_exe().and_then(|me| std::fs::copy(me, &ui_exe)).is_ok();
    let mut verdicts: Vec<(Group, Verdict)> = Vec::new();
    let mut seen: Vec<(Group, bool, bool)> = Vec::new(); // group, a deciding step ran, all deciding steps worked
    let mut entry_left = false;
    let mut ran = 0;
    for step in &steps {
        log(&format!("ATTEMPT step {}", step.id));
        if let Err(why) = hr::station_decision(step.group, !a.steps.is_empty(), a.force_station_entry, &verdicts) {
            let mut j = base_line(&step.id, step.group.name()); j.b("skipped", true); j.s("reason", &why); j.b("ok", true);
            println!("{}", j.render());
            continue;
        }
        ran += 1;
        let line = match step.kind {
            Kind::Context => { let mut j = base_line(&step.id, ""); step_context(&mut j); j.render() }
            Kind::StationAccess => { let mut j = base_line(&step.id, ""); step_station_access(&mut j); j.render() }
            Kind::Profile => { let mut j = base_line(&step.id, ""); step_profile(&mut j, &rec); j.render() }
            Kind::Run { prog, limits } => {
                if prog == Prog::UiTest && !copied {
                    let mut j = base_line(&step.id, step.group.name()); j.b("skipped", true); j.s("reason", "this executable could not be copied into the work folder"); j.b("ok", true); j.render()
                } else {
                    let (line, left) = step_run(a, &step.id, step.group, prog, limits, &ws, &dir, &rec, &ui_exe);
                    entry_left |= left;
                    if hr::decides_verdict(step) && !line.contains("\"skipped\":true") {
                        let worked = line.contains("\"works\":true");
                        match seen.iter_mut().find(|(g, _, _)| *g == step.group) { Some(s) => { s.1 = true; s.2 &= worked; } None => seen.push((step.group, true, worked)) }
                        verdicts.retain(|(g, _)| *g != step.group);
                        let all = seen.iter().find(|(g, _, _)| *g == step.group).map(|s| s.2).unwrap_or(false);
                        verdicts.push((step.group, if all { Verdict::Works } else { Verdict::Fails }));
                    }
                    line
                }
            }
        };
        println!("{line}");
    }
    let mut s = base_line("summary", "");
    for g in hr::GROUPS { s.s(&format!("group_{}", g.name().replace('-', "_")), verdicts.iter().find(|(x, _)| *x == g).map(|(_, v)| v.name()).unwrap_or("not-run")); }
    s.n("stepsRun", ran);
    s.b("stationEntryLeftBehind", entry_left);
    // With an entry left behind the folder is KEPT: its `rec` folder holds the record home-revoke needs as proof (the summary names it).
    if entry_left { s.b("workFolderRemoved", false); s.s("workFolderKept", &root.to_string_lossy()); } else { s.b("workFolderRemoved", std::fs::remove_dir_all(&root).is_ok()); }
    s.b("ok", !entry_left);
    println!("{}", s.render());
    0
}


// ---------------------------------------------------------------------------------------------------------------- inside the container

/// `ui-test`: read-only look at the desktop the confined program got. Nothing is sent: no input, no window message, no clipboard read; the clipboard is opened and closed, one pixel is read (only
/// whether it could be), a low-level keyboard hook is installed and removed at once without a message loop (its procedure never runs; a key pressed in that instant waits at most the system's LowLevelHooksTimeout), one atom is added and deleted. Titles, pixel values,
/// the cursor position and key states are never printed (only counts and success).
pub(crate) fn ui_test() -> String {
    unsafe extern "system" fn count(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let c = &mut *(lparam as *mut [u32; 2]);
        c[0] += 1;
        if IsWindowVisible(hwnd) != 0 { c[1] += 1; }
        1
    }
    unsafe extern "system" fn hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT { CallNextHookEx(null_mut(), code, w, l) }
    let mut j = Json::new();
    j.s("tool", TOOL);
    j.s("probe", "ui-test");
    j.b("user32Loaded", true); // reaching this line means user32 initialised (it is what 0xC0000142 breaks)
    j.s("windowStation", &desk::current_station_name());
    j.s("desktop", &desk::current_desktop_name());
    let rid = desk::integrity_rid();
    j.n("integrityRid", rid);
    j.s("integrity", hr::integrity_name(rid));
    unsafe {
        let mut c = [0u32; 2];
        SetLastError(0);
        let ok = EnumWindows(Some(count), &mut c as *mut _ as LPARAM);
        j.b("enumWindowsOk", ok != 0);
        j.n("enumWindowsError", if ok != 0 { 0 } else { GetLastError() as i64 });
        j.n("windowsSeen", c[0] as i64);
        j.n("windowsSeenVisible", c[1] as i64);
        j.b("foregroundWindowSeen", !GetForegroundWindow().is_null());
        let mut pt = POINT { x: 0, y: 0 };
        j.b("cursorPositionReadable", GetCursorPos(&mut pt) != 0);
        SetLastError(0);
        let opened = OpenClipboard(null_mut());
        let e = GetLastError();
        j.b("openClipboardOk", opened != 0);
        if opened != 0 { CloseClipboard(); } else { j.n("openClipboardError", e as i64); }
        j.b("clipboardSequenceReadable", GetClipboardSequenceNumber() != 0);
        let dc = GetDC(null_mut());
        if dc.is_null() { j.b("screenPixelReadable", false); }
        else { j.b("screenPixelReadable", GetPixel(dc, 0, 0) != 0xFFFF_FFFF); ReleaseDC(null_mut(), dc); }
        let down = (0..256).filter(|k| GetAsyncKeyState(*k) < 0).count();
        j.n("asyncKeysDownCount", down as i64);
        SetLastError(0);
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), GetModuleHandleW(null()), 0);
        let e = GetLastError();
        j.b("lowLevelKeyboardHookInstalled", !h.is_null());
        if h.is_null() { j.n("lowLevelKeyboardHookError", e as i64); } else { UnhookWindowsHookEx(h); }
        SetLastError(0);
        let atom = GlobalAddAtomW(wide("nn-home-atom").as_ptr());
        let e = GetLastError();
        j.b("globalAtomAdded", atom != 0);
        if atom != 0 { GlobalDeleteAtom(atom); } else { j.n("globalAtomError", e as i64); }
    }
    j.b("ok", true);
    j.render()
}

// ---------------------------------------------------------------------------------------------------------------- clean-up after a killed launcher

/// `home-revoke`: removes the container's explicit entries from WinSta0 (the entry a killed `home-desktop-station-*` step left), and reports how many are left. Only the SID of one profile; only the
/// interactive station is written to (any other station: counted, never written).
pub(crate) fn home_revoke(j: &mut Json, sid: PSID) -> bool {
    if !crate::winobj::is_profile_sid(&sid_string(sid)) { j.s("error", "refused: the SID is not one AppContainer profile's"); return false; }
    let name = desk::current_station_name();
    let flags = unsafe { desk::station_flags(GetProcessWindowStation() as HANDLE) };
    j.s("windowStation", &name);
    let writable = match hr::may_write_interactive_station(&name, flags) { Ok(()) => true, Err(e) => { j.s("skipped", &e); false } };
    let h = desk::open_station(&name, if writable { desk::READ_CONTROL_BIT | super::privdesk::WRITE_DAC_BIT } else { desk::READ_CONTROL_BIT });
    if h.is_null() { j.n("openError", unsafe { GetLastError() } as i64); return false; }
    let mut ok = true;
    if writable { let r = desk::remove_entries(h, sid); j.b("removed", r.is_ok()); if r.is_err() { ok = false; } }
    let left = desk::object_entries(h, sid).map(|n| n as i64).unwrap_or(-1);
    j.n("entriesLeft", left);
    if left != 0 { ok = false; }
    unsafe { CloseWindowStation(h as HWINSTA); }
    ok
}

// ---------------------------------------------------------------------------------------------------------------- a de-elevated child

/// `deelevate [--exe PATH] ARGS...`: runs this executable (or PATH, for example the product launcher) with ARGS as a child with a restricted copy of this process's token: the Administrators group (and the operator groups) deny-only, every privilege except
/// SeChangeNotify removed (CreateRestrictedToken with DISABLE_MAX_PRIVILEGE), integrity lowered to medium. Documented: CreateProcessAsUser needs no extra privilege for a restricted version of the caller's
/// own primary token. This is what a UAC-filtered token looks like to access checks (Administrators deny-only, medium integrity); it is NOT the identical token (the linked filtered token of UAC is not used,
/// so a machine with UAC off is measured the same way). The child's own `context` step reports what it got. The child's output goes to this console (the handles are inherited); the exit code is the child's.
pub(crate) fn deelevate(rest: &[String]) -> i32 {
    let mut j = Json::new();
    j.s("tool", TOOL);
    j.s("command", "deelevate");
    let fail = |mut j: Json, stage: &str, e: u32| -> i32 { j.b("ok", false); j.s("stage", stage); j.n("error", e as i64); println!("{}", j.render()); 125 };
    let (program, rest) = match hr::split_deelevate_args(rest) { Ok(v) => v, Err(_) => return fail(j, "arguments", 0) };
    unsafe {
        // TOKEN_ADJUST_DEFAULT is needed by SetTokenInformation(TokenIntegrityLevel) below: CreateRestrictedToken's new handle "has the same access rights as ExistingTokenHandle" (Microsoft).
        let Some(tok) = open_own_token(TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT) else { return fail(j, "open-token", GetLastError()) };
        let Some(gbuf) = token_info(tok.0, TokenGroups) else { return fail(j, "groups", GetLastError()) };
        let tg = gbuf.as_ptr() as *const TOKEN_GROUPS;
        let first = (*tg).Groups.as_ptr();
        let mut disable: Vec<SID_AND_ATTRIBUTES> = Vec::new();
        for i in 0..(*tg).GroupCount as usize {
            let g = &*first.add(i);
            if hr::is_admin_like(&sid_string(g.Sid)) && g.Attributes & hr::SE_GROUP_DENY_ONLY == 0 { disable.push(SID_AND_ATTRIBUTES { Sid: g.Sid, Attributes: 0 }); }
        }
        j.n("groupsDisabled", disable.len() as i64);
        let mut restricted: HANDLE = null_mut();
        if CreateRestrictedToken(tok.0, DISABLE_MAX_PRIVILEGE, disable.len() as u32, if disable.is_empty() { null() } else { disable.as_ptr() }, 0, null(), 0, null(), &mut restricted) == 0 { return fail(j, "restrict-token", GetLastError()); }
        let restricted = Handle(restricted);
        // medium integrity: S-1-16-8192
        let mut medium: [u8; 12] = [1, 1, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0];
        medium[8..12].copy_from_slice(&hr::MEDIUM_INTEGRITY_RID.to_le_bytes());
        let mut label: TOKEN_MANDATORY_LABEL = zeroed();
        label.Label.Sid = medium.as_mut_ptr() as PSID;
        label.Label.Attributes = 0x20; // SE_GROUP_INTEGRITY
        if SetTokenInformation(restricted.0, TokenIntegrityLevel, &label as *const _ as *const c_void, (size_of::<TOKEN_MANDATORY_LABEL>() + medium.len()) as u32) == 0 { return fail(j, "integrity", GetLastError()); }
        let exe = match program { Some(p) => p, None => match std::env::current_exe() { Ok(p) => p.to_string_lossy().into_owned(), Err(_) => return fail(j, "current-exe", 0) } };
        j.s("program", if std::path::Path::new(&exe).file_name().is_some_and(|n| n.eq_ignore_ascii_case("nn-launcher.exe")) { "nn-launcher.exe" } else { "this executable" });
        let mut cmd = wide(&std::iter::once(hr::quote_arg(&exe)).chain(rest.iter().map(|a| hr::quote_arg(a))).collect::<Vec<_>>().join(" "));
        let wexe = wide(&exe);
        let mut si: STARTUPINFOW = zeroed();
        si.cb = size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = zeroed();
        if CreateProcessAsUserW(restricted.0, wexe.as_ptr(), cmd.as_mut_ptr(), null(), null(), 1, 0, null(), null(), &si, &mut pi) == 0 { return fail(j, "create-process", GetLastError()); }
        let process = Handle(pi.hProcess);
        let _thread = Handle(pi.hThread);
        WaitForSingleObject(process.0, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(process.0, &mut code);
        j.n("childExitCode", code as i32 as i64);
        j.b("ok", true);
        println!("{}", j.render());
        code as i32
    }
}
