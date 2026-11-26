// Card A03b slice 3: the native Windows launcher's release inputs, its Rust dependency licenses, the administrator installer script (read as text: PowerShell is not available on the Linux and macOS
// cells) and the hand-started workflow's new steps. Nothing here runs the launcher or the installer; what they DO on Windows is judged by the hosted run and, later, the owner's own machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargoPackages, cargoProblems } from "./license-inventory.mjs";
import { RECORD_SCHEMA, checkRecord, makeRecord, pinnedToolchain } from "./native-launcher.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const LOCK = read("native", "nn-launcher", "Cargo.lock");

// ------------------------------------------------------------------------------------------------ the release record

test("the release record names the file, the inputs of the build, and no time, path or user", () => {
  const bytes = Buffer.from("MZ pretend executable");
  const a = makeRecord({ fileName: "C:\\build\\nn-launcher.exe", bytes, commit: COMMIT });
  assert.equal(a.schema, RECORD_SCHEMA);
  assert.equal(a.file, "nn-launcher.exe", "the file name only, never the build machine's path");
  assert.equal(a.size, bytes.length);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.match(a.cargoLockSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.toolchain, pinnedToolchain());
  assert.deepEqual(a.features, []);
  assert.deepEqual(makeRecord({ fileName: "x/nn-launcher.exe", bytes, commit: COMMIT }), a, "same inputs, same record (nothing time- or place-dependent)");
  assert.ok(!/time|date|path|user|host/i.test(Object.keys(a).join(",")), Object.keys(a).join(","));
});

test("a record is refused without a full commit, and a file must match it exactly (a changed byte, a wrong size, a feature build)", () => {
  const bytes = Buffer.from("abc");
  assert.throws(() => makeRecord({ fileName: "a.exe", bytes, commit: "abc123" }), /40-character/);
  assert.throws(() => makeRecord({ fileName: "a.exe", bytes, commit: undefined }), /40-character/);
  const record = makeRecord({ fileName: "a.exe", bytes, commit: COMMIT });
  assert.deepEqual(checkRecord(record, bytes), []);
  assert.match(checkRecord(record, Buffer.from("abd")).join(), /SHA-256/);
  assert.match(checkRecord({ ...record, size: 9 }, bytes).join(), /size/);
  assert.match(checkRecord({ ...record, features: ["experiment"] }, bytes).join(), /features/);
  assert.match(checkRecord({ schema: "other" }, bytes).join(), /not a release record/);
  // a record without its feature list, or with a malformed one, is not "built with no feature"
  const { features: _omitted, ...noFeatures } = record;
  assert.match(checkRecord(noFeatures, bytes).join(), /does not list its cargo features/);
  assert.match(checkRecord({ ...record, features: "experiment" }, bytes).join(), /does not list its cargo features/);
});

test("the toolchain is pinned to an exact version, the same one the workflow installs, and the lock file belongs to the product crate", () => {
  const v = pinnedToolchain();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.throws(() => pinnedToolchain('[toolchain]\nchannel = "stable"\n'), /exact version/);
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(wf.includes(`rustup toolchain install ${v} --profile minimal`), "the workflow installs the pinned toolchain");
  assert.match(read("native", "nn-launcher", "RELEASE.md"), new RegExp(`rustup toolchain install ${v.replace(/\./g, "\\.")}`));
  assert.ok(/name = "nn-launcher"/.test(LOCK) && !/nn-appc-launcher/.test(LOCK));
  // reproducible-build inputs are all in the documented steps
  const rel = read("native", "nn-launcher", "RELEASE.md");
  for (const word of ["--locked", "--remap-path-prefix", "/Brepro", "native-launcher.mjs record", "native-launcher.mjs verify", "-AllowUnsigned", "signtool verify"]) assert.ok(rel.includes(word), word);
  assert.ok(/NOT yet shown more widely/.test(rel) && rel.includes("e7ac4337c77d57a093d615a7906d37bc2452754df24ca9bb08b47ef4322cf902"), "the reproducibility claim is stated as measured once and unproven more widely");
  assert.ok(!/password|secret key|\.pfx/i.test(rel.replace(/nothing secret|never copied/gi, "")) || /never (copied|stored)/.test(rel), "the signing text stores no secret");
});

// ------------------------------------------------------------------------------------------------ Rust dependency licenses

test("the Rust crates of Cargo.lock each have a recorded, allowed license, and a stale or missing record is a problem", () => {
  const keys = cargoPackages(LOCK);
  assert.ok(keys.includes("windows-sys@0.59.0") && keys.length >= 5, keys.join(","));
  assert.ok(!keys.some((k) => k.startsWith("nn-launcher@")), "the crate itself is not a third-party entry");
  const recorded = JSON.parse(read("native", "nn-launcher", "cargo-licenses.json"));
  assert.deepEqual(cargoProblems(LOCK, recorded), []);
  assert.match(cargoProblems(LOCK, { ...recorded, "windows-sys@0.59.0": undefined }).join(), /no license recorded/);
  assert.match(cargoProblems(LOCK, { ...recorded, "windows-sys@0.59.0": "GPL-3.0-only" }).join(), /not on the allow list/);
  assert.match(cargoProblems(LOCK, { ...recorded, "gone@1.0.0": "MIT" }).join(), /stale/);
  const added = `${LOCK}\n[[package]]\nname = "newcrate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
  assert.match(cargoProblems(added, recorded).join(), /newcrate@1\.0\.0: no license recorded/);
  // a crate from a git repository, a lock file with Windows line endings, and fields in another order are all still checked
  const fromGit = `${LOCK}\n[[package]]\nname = "gitcrate"\nversion = "0.1.0"\nsource = "git+https://example.invalid/x#0123"\n`;
  assert.match(cargoProblems(fromGit, recorded).join(), /gitcrate@0\.1\.0: no license recorded/);
  assert.deepEqual(cargoPackages(LOCK.replace(/\n/g, "\r\n")), keys);
  assert.deepEqual(cargoPackages(`${LOCK}\n[[package]]\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nversion = "2.0.0"\nname = "reordered"\n`), [...keys, "reordered@2.0.0"].sort());
  assert.throws(() => cargoPackages(`${LOCK}\n[[package]]\nsource = "registry+x"\n`), /without a name and version/);
  // a line TOML would read but cargo never writes is refused, not skipped: it could hide a crate or make a third-party crate look local
  for (const odd of ['[[package]]\nname = "spaced"\nversion = "1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"', '[[ package ]]\nname = "hidden"\nversion = "1.0.0"\nsource = "registry+x"',
    '[[package]] # x\nname = "c"\nversion = "1.0.0"\nsource = "registry+x"', '[[package]]\nname = "t"\nversion = "1.0.0"\n  source = "registry+x"', '[[package]]\nname = "q"\nversion = "1.0.0"\nsource = \'registry+x\'']) {
    assert.throws(() => cargoPackages(`${LOCK}\n${odd}\n`), /not in the form cargo writes/, odd);
  }
});

// ------------------------------------------------------------------------------------------------ the installer script, read as text

const ps = read("native", "install", "Install-NimbleNewtLauncher.ps1");
const code = ps.replace(/<#[\s\S]*?#>/, "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");
const fn = (name) => { const a = ps.indexOf(`function ${name}`); assert.ok(a >= 0, name); const b = ps.indexOf("\nfunction ", a + 5); const c = ps.indexOf("\nswitch ($Action)", a); return ps.slice(a, b > 0 ? b : c); };

test("the installer is Verify by default, supports -WhatIf, and asks an administrator for Install and Uninstall only", () => {
  assert.match(ps, /\[CmdletBinding\(SupportsShouldProcess = \$true, ConfirmImpact = 'High'\)\]/);
  assert.match(ps, /\[ValidateSet\('Verify', 'Install', 'Uninstall'\)\] \[string\] \$Action = 'Verify'/);
  assert.ok(fn("Invoke-Install").includes("Assert-Admin") && fn("Invoke-Uninstall").includes("Assert-Admin"));
  assert.ok(!fn("Invoke-Verify").includes("Assert-Admin"), "Verify may run without elevation (the rights part says so)");
  assert.match(ps, /\$ExpectedSha256/);
  assert.ok(fn("Invoke-Install").includes("-ne $ExpectedSha256.ToUpperInvariant()") && fn("Invoke-Install").includes("-AllowUnsigned"));
});

test("A03b worker task: Verify only READS the worker's scheduled task (S4U, least privilege, boot trigger, worker.env), registers nothing, and a missing task is not a failure", () => {
  const verify = fn("Invoke-Verify");
  assert.match(ps, /\$WorkerTaskName = 'NimbleNewtWorker'/);
  // the root folder only (-TaskName alone also returns same-named tasks of other folders, and an array would make every check below unreliable)
  assert.ok(verify.includes("@(Invoke-Read { Get-ScheduledTask -TaskPath '\\' -TaskName $WorkerTaskName -ErrorAction SilentlyContinue } | Where-Object { $null -ne $_ })"));
  assert.ok(verify.includes("$task = $task[0]"));
  // enum or number: the text of LogonType (S4U = 2) and RunLevel (Limited = 0) is compared; the UserId is the bare name or THIS computer's, never any domain's
  for (const part of ['$logon = "$($tp.LogonType)"', '$level = "$($tp.RunLevel)"', "@('S4U', '2') -contains $logon", "@('Limited', '0') -contains $level", "MSFT_TaskBootTrigger", "--env-file=$EnvFile", "OrdinalIgnoreCase", "$tp.UserId -ieq $AccountName", '$tp.UserId -ieq "$env:COMPUTERNAME\\$AccountName"', "$acts.Count -eq 1"]) assert.ok(verify.includes(part), part);
  assert.ok(!/UserId -like/.test(verify), "no wildcard match of the account (OTHERDOMAIN\\name would pass)");
  // collections that may be empty or hold $null are filtered before a property is read (Set-StrictMode -Version 3)
  assert.ok(verify.includes("@(@($task.Triggers) | Where-Object { $null -ne $_ } | ForEach-Object { $_.CimClass.CimClassName })"));
  // the task checks are Checks (a FAIL when it exists and is wrong), and an absent task only says so
  assert.match(verify, /if \(\$task\.Count -eq 0\) \{ Say '  not registered/);
  assert.ok(!/\$task\.Count -eq 0\) \{[^}]*Check \$false/.test(verify), "a task that is not registered is not a failure");
  // nothing in the whole script registers, changes, starts or removes a task (cmdlets, schtasks, the COM object, the CIM class behind the cmdlets)
  assert.ok(!/\b(Register|Unregister|Set|New|Start|Stop|Enable|Disable)-ScheduledTask\b|\bschtasks\b|Register-ScheduledJob|\bSchedule\.Service\b|PS_ScheduledTask|MSFT_ScheduledTask\b|Invoke-CimMethod|RegisterByXml|RegisterTask/i.test(code), "the installer never registers or changes a task");
  assert.deepEqual([...code.matchAll(/\b\w+-ScheduledTask\w*/g)].map((m) => m[0]), ["Get-ScheduledTask"], "the only task cmdlet is the read");
  assert.ok(/does not register or start the worker/.test(ps));
  // the password story is unchanged: no password reaches a task from here
  assert.ok(!/-Password\b|-RunAsUser|LogonType\s+Password/i.test(code.replace(/New-LocalUser[^\n]*-Password[^\n]*/g, "")));
});

/** True when the line is, or is inside a block opened by, a line that asks `$PSCmdlet.ShouldProcess(` (walks up through the enclosing braces only; an earlier, closed block does not count). */
function insideShouldProcess(lines, i) {
  const count = (l, c) => l.split(c).length - 1;
  if (lines[i].includes("$PSCmdlet.ShouldProcess(")) return true;
  let need = 0;
  for (let j = i - 1; j >= 0; j--) {
    const opens = count(lines[j], "{"); const closes = count(lines[j], "}");
    if (closes > opens) need += closes - opens;
    else if (opens > closes) {
      if (need >= opens - closes) need -= opens - closes;
      else { if (lines[j].includes("$PSCmdlet.ShouldProcess(")) return true; need = 0; }
    }
  }
  return false;
}

test("every line that changes the machine sits inside a ShouldProcess question, and Verify changes nothing", () => {
  const mutating = [/\bNew-LocalUser\b/, /\bAdd-LocalGroupMember\b/, /\bRemove-LocalUser\b/, /\[NnLsa\]::(Add|Remove|RemoveAll)\(/, /\bSet-Acl\b/, /\bCopy-Item\b/, /\bRemove-Item\b/, /\bSet-Content\b/, /\bNew-Item\b/, /\bRemove-CimInstance\b/, /\bSet-ProtectedAcl \$/, /\bRemove-TreeNoFollow \$/, /\[System\.IO\.(Directory|File)\]::(Delete|CreateDirectory|Move)\(/, /FileSystemAclExtensions\]::Create\(/];
  const lines = code.split("\n");
  // The two helpers that write are checked at their call sites (which must each sit inside a ShouldProcess question), not inside their own bodies.
  const helperLines = new Set();
  for (const helper of ["Set-ProtectedAcl", "Remove-TreeNoFollow"]) {
    const start = lines.findIndex((l) => l.startsWith(`function ${helper}(`));
    assert.ok(start >= 0, helper);
    for (let i = start; i < lines.length && !(i > start && /^}/.test(lines[i - 1])); i++) helperLines.add(i);
  }
  let seen = 0;
  lines.forEach((line, i) => {
    if (/^\s*function /.test(line) || helperLines.has(i)) return;
    for (const re of mutating) {
      if (!re.test(line)) continue;
      seen++;
      assert.ok(insideShouldProcess(lines, i), `not inside a ShouldProcess block: ${line.trim()}`);
    }
  });
  assert.ok(seen >= 14, `${seen} mutating lines found`);
  assert.ok(!/\bNew-Item\b|-Recurse\b/.test(code), "folders are made with their list in one call, and nothing is removed with a recursive delete that could follow a link");
  assert.equal(code.match(/Set-ProtectedAcl \$item\.Path/g).length, 1, "one call site");
  assert.ok(/ShouldProcess\(\$item\.Path[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*Set-ProtectedAcl \$item\.Path/.test(code), "that call site is inside its ShouldProcess");
  for (const re of mutating) assert.ok(!re.test(fn("Invoke-Verify")), `Verify must not contain ${re}`);
  assert.ok(!/\bNnLsa\]::(Add|Remove)/.test(fn("Invoke-Verify")) && fn("Invoke-Verify").includes("[NnLsa]::List("));
});

test("least privilege: each access-list entry has its reason, no broad group is granted, the account never gets more than read/execute on the program and Modify on its control folder, inheritance is off", () => {
  const plan = fn("New-AclPlan");
  const entries = [...plan.matchAll(/@\{ Who = (\$\w+); Rights = '([\w, ]+)'; Scope = '(All|Folder|Below)'; Why = '([^']+)'/g)];
  assert.equal(entries.length, 10, "three folders: three entries each, and the account's two on its control folder");
  for (const e of entries) assert.ok(e[4].length > 25, `reason for ${e[1]} ${e[2]}`);
  assert.equal(plan.match(/Rights = /g).length, plan.match(/Why = /g).length, "no entry without its reason");
  const byFolder = plan.split("@{ Path = ").slice(1);
  assert.deepEqual(byFolder.map((f) => f.split("\n")[0].trim()), ["$InstallDir; Rules = @(", "$DataDir; Rules = @(", "$ControlDir; Rules = @("]);
  const account = (f) => [...f.matchAll(/Who = \$account; Rights = '([\w, ]+)'; Scope = '(\w+)'/g)].map((m) => `${m[1]} (${m[2]})`);
  // the control folder: the account may create in it and delete what is inside, but holds no Delete on the folder itself (it cannot remove or rename it)
  assert.deepEqual(byFolder.map(account), [["ReadAndExecute (All)"], ["ReadAndExecute (All)"], ["ReadAndExecute, Write (Folder)", "Modify (Below)"]]);
  assert.ok(/'Below' \{ return @\('ContainerInherit, ObjectInherit', 'InheritOnly'\) \}/.test(ps) && /'Folder' \{ return @\('None', 'None'\) \}/.test(ps), "the scopes map to the right inheritance flags");
  assert.ok(!/Who = \$(SidUsers|account); Rights = '(FullControl|Write|TakeOwnership|ChangePermissions)'/.test(plan));
  for (const broad of [/Everyone/i, /S-1-1-0/, /Authenticated Users/i, /S-1-5-11/, /BUILTIN\\Users/i, /ALL APPLICATION PACKAGES/i, /S-1-15-2/]) assert.ok(!broad.test(plan), `${broad} must not be granted`);
  const acl = fn("New-ProtectedSecurity");
  assert.ok(acl.includes("SetAccessRuleProtection($true, $false)") && acl.includes("SetOwner($SidAdmins)") && acl.includes("'Allow'") && !acl.includes("'Deny'"));
  const safe = fn("Assert-SafeItem");
  assert.ok(safe.includes("Test-Reparse") && /not by an administrator/.test(safe) && safe.includes("$TrustedOwners -notcontains"), "a pre-made folder, file or link under our names is refused");
  assert.ok(!safe.includes("ManifestPath"), "no exemption: a planted manifest file must not make a foreign folder acceptable");
  // the folder is made WITH its list (one call), then checked (a race winner's folder is refused), then the list is written
  const set = fn("Set-ProtectedAcl");
  assert.ok(set.indexOf("CreateDirectory($path, $security)") < set.indexOf("Assert-SafeItem $path $true") && set.indexOf("Assert-SafeItem $path $true") < set.indexOf("Set-Acl -LiteralPath $path"));
  const install = fn("Invoke-Install");
  assert.ok(/foreach \(\$d in @\(\$InstallDir, \$DataDir, \$ControlDir\)\) \{ Assert-SafeItem \$d \$true \}/.test(install) && /Assert-SafeItem \$f \$false/.test(install), "every name is checked before any change");
  assert.ok(install.indexOf("Assert-SafeItem $d $true") < install.indexOf("ShouldProcess("), "the checks come before the first change");
  // Verify compares rights with SYNCHRONIZE normalised on both sides, and inheritance too
  const verify = fn("Invoke-Verify");
  assert.equal(verify.match(/-bor \$SynchronizeBit/g)?.length, 2);
  assert.ok(verify.includes("[int]$_.InheritanceFlags") && verify.includes("[int]$_.PropagationFlags"));
});

test("the account is a local standard user: in Users only, batch logon granted, interactive, remote-desktop and network logon denied, and no right outside the managed list", () => {
  assert.match(ps, /\$RightsDenied = @\('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight'\)/);
  assert.match(ps, /\$RightsGranted = @\('SeBatchLogonRight'\) \+ \$\(if \(\$ServiceLogon\) \{ @\('SeServiceLogonRight'\) \}/);
  assert.match(ps, /\$RightsAll = @\('SeBatchLogonRight', 'SeServiceLogonRight'\) \+ \$RightsDenied/);
  assert.ok(!/SeDenyServiceLogonRight|SeDenyBatchLogonRight|SeTcb|SeDebug|SeImpersonate|SeAssignPrimaryToken|SeBackup|SeRestore|SeTakeOwnership|SeLoadDriver/.test(code), "no other privilege or right is named");
  const install = fn("Invoke-Install");
  assert.ok(install.includes("Add-LocalGroupMember -SID $SidUsers"), "Users");
  assert.ok(!/Add-LocalGroupMember[^\n]*(Administrators|S-1-5-32-544|\$SidAdmins)/.test(code), "never an administrator");
  assert.ok(/\$SidUsers = 'S-1-5-32-545'/.test(ps));
  assert.ok(install.includes("-PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires"));
  assert.ok(/Description \$AccountMarker/.test(install) && fn("Invoke-Uninstall").includes("$user.Description -ne $AccountMarker"), "only the account it made is removed");
});

test("no secret is stored: the password is generated in memory, never converted from text, printed or written; there is no network and no code download", () => {
  assert.ok(/RandomNumberGenerator\]::Create\(\)/.test(fn("New-RandomSecureString")) && fn("New-RandomSecureString").includes("AppendChar") && fn("New-RandomSecureString").includes("MakeReadOnly"));
  for (const bad of [/-AsPlainText/, /ConvertTo-SecureString/, /ConvertFrom-SecureString/, /Out-File/, /Add-Content/, /Write-(Host|Output|Verbose|Debug) [^\n]*\$(secure|plain|password)/i, /\bnet user\b/i, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|\bcurl\b|\bwget\b|DownloadString|DownloadFile|Invoke-Expression|\biex\b|Set-ExecutionPolicy|Start-Process/i]) assert.ok(!bad.test(code), `${bad} must not appear`);
  const passwordUses = [...code.matchAll(/\$\w*(?:secure|password)\w*/gi)].map((m) => m[0]);
  assert.ok(passwordUses.every((u) => /^\$(secure|Password)$/i.test(u)), passwordUses.join(","));
  assert.ok(code.includes("-Password (New-RandomSecureString)"), "the generated value goes straight to New-LocalUser");
  // what is written to disk: worker.env and the manifest, from names and paths only
  assert.ok(/Set-Content -LiteralPath \$EnvFile -Value \$lines/.test(code) && /Set-Content -LiteralPath \$ManifestPath/.test(code));
  assert.equal(code.match(/Set-Content/g).length, 2);
});

test("worker.env carries exactly the four names and defaults the TypeScript backend reads", () => {
  const ts = read("packages", "worker", "src", "sandbox", "windows-native.ts");
  const plan = read("packages", "worker", "src", "sandbox", "windows-native-plan.ts");
  const names = [...ts.matchAll(/env\["(NIMBLENEWT_WIN_[A-Z_]+)"\]/g)].map((m) => m[1]);
  // The installer writes four. The fifth, NIMBLENEWT_WIN_MAX_RUNS (how many confined runs at once, default 1), is the operator's own and is NOT written by the installer; NIMBLENEWT_WIN_PROFILE is
  // still written and still read, but ignored (retired: every run makes its own container profile).
  const installerNames = ["NIMBLENEWT_WIN_CONTAINER", "NIMBLENEWT_WIN_CONTROL_DIR", "NIMBLENEWT_WIN_LAUNCHER", "NIMBLENEWT_WIN_PROFILE"];
  assert.deepEqual([...new Set(names)].sort(), [...installerNames, "NIMBLENEWT_WIN_MAX_RUNS"].sort());
  for (const n of installerNames) assert.ok(fn("Invoke-Install").includes(`"${n}=`), `worker.env writes ${n}`);
  assert.ok(!ps.includes("NIMBLENEWT_WIN_MAX_RUNS"), "the installer never sets the run limit: more than one run at once is an explicit, unmeasured choice");
  assert.equal(code.match(/NIMBLENEWT_[A-Z_]+=/g).length, 4, "no fifth variable");
  // the defaults the backend uses when the file is absent are the places the installer makes
  assert.ok(ts.includes('win32.join(programFiles, "NimbleNewt", "nn-launcher.exe")') && ps.includes("$ExeName = 'nn-launcher.exe'") && ps.includes("Join-Path $env:ProgramFiles 'NimbleNewt'"));
  assert.ok(ts.includes('win32.join(programData, "NimbleNewt", "native")') && ps.includes("Join-Path $DataDir 'native'") && ps.includes("Join-Path $env:ProgramData 'NimbleNewt'"));
  assert.ok(new RegExp(`DEFAULT_PROFILE_NAME = "${/\$ProfileName = '(\w+)'/.exec(ps)[1]}"`).test(plan), "the profile name default");
  assert.ok(ps.includes("[string] $Container = 'lpac'"));
});

test("uninstall removes what install made, from a manifest, and nothing it did not make", () => {
  const un = fn("Invoke-Uninstall");
  for (const part of ["$ManifestPath", "nimblenewt.native-install/1", "RemoveAll", "Remove-CimInstance", "Remove-LocalUser", "Get-Process -Name 'nn-launcher'", "$user.SID.Value -ne $mSid", "Assert-SafeItem $ManifestPath $false", "Assert-SafeItem $DataDir $true", "Test-SamePath $pair[0] $pair[1]", "Remove-TreeNoFollow $ControlDir"]) assert.ok(un.includes(part), part);
  // the manifest only confirms this run's own folders; it never supplies a path to remove
  for (const field of ["installDir", "dataDir", "controlDir", "launcher"]) assert.ok(un.includes(`@((Get-Prop $m '${field}'), `), `the manifest's ${field} is compared with this run's`);
  assert.ok(!/Remove-Item[^\n]*\$m\.|Delete\([^\n]*\$m\.|Remove-TreeNoFollow \$m\.|Remove-Item[^\n]*Get-Prop \$m/.test(un), "nothing is removed by a path read from the manifest");
  // the control folder is closed to the account before it is walked, and the two top folders go only when empty
  assert.ok(un.indexOf("Set-Acl -LiteralPath $ControlDir") < un.indexOf("Remove-TreeNoFollow $ControlDir"));
  assert.ok(un.includes(".Count -eq 0) { [System.IO.Directory]::Delete($d, $false) }"));
  const walk = fn("Remove-TreeNoFollow");
  assert.ok(walk.indexOf("Test-Reparse $path") < walk.indexOf("Get-ChildItem") && /if \(Test-Reparse \$path\) \{\n\s+if \(\$isFolder\) \{ \[System\.IO\.Directory\]::Delete\(\$path, \$false\) \}[^\n]*\n\s+return/.test(walk), "a link is removed as the link and not descended into");
  assert.ok(/Assert-NimbleNewtPath \$InstallDir '-InstallDir'\nAssert-NimbleNewtPath \$DataDir '-DataDir'\nswitch \(\$Action\)/.test(ps), "the folder parameters are checked before any action");
  const made = fn("Invoke-Install");
  for (const part of ["New-LocalUser", "[NnLsa]::Add(", "Set-ProtectedAcl", "Copy-Item", "Set-Content -LiteralPath $EnvFile", "$manifest = [ordered]@"]) assert.ok(made.includes(part), part);
  // idempotent: the account and the launcher are checked before they are made or copied
  assert.ok(made.includes("if ($null -eq $existing)") && made.includes("-ne $hash) { Copy-Item"));
  assert.ok(fn("Invoke-Verify").includes("the entry list is exactly the expected one"));
});

test("second review: the account marker fits New-LocalUser, links are seen without being followed, a folder that inherits its parent's list is refused, and LSA code is compiled only when used", () => {
  // New-LocalUser -Description takes at most 48 characters; a longer marker would make Install fail at the account step, after its checks
  const marker = /^\$AccountMarker = '([^']*)'$/m.exec(ps)?.[1];
  assert.ok(marker !== undefined && marker.length > 10 && marker.length <= 48, `marker length ${marker?.length}`);
  // presence and link checks read the item's own attributes (a dangling link is present and a link); Test-Path and Get-Item follow links on 5.1
  assert.ok(/function Get-ItemAttributes\(\[string\] \$path\) \{\n\s+try \{ return \[System\.IO\.File\]::GetAttributes\(\$path\) \} catch \[System\.IO\.FileNotFoundException\], \[System\.IO\.DirectoryNotFoundException\] \{ return \$null \}/.test(ps), "absent only on not-found; every other failure is thrown");
  assert.match(ps, /function Test-Reparse\(\[string\] \$path\) \{ \$attrs = Get-ItemAttributes \$path;/);
  for (const name of ["Assert-SafeItem", "Set-ProtectedAcl", "Remove-TreeNoFollow", "Invoke-Uninstall"]) {
    assert.ok(!/Test-Path|Get-Item /.test(fn(name).replace(/Test-Path -LiteralPath \$ManifestPath/, "")), `${name} decides presence without following links`);
  }
  const safe = fn("Assert-SafeItem");
  assert.ok(/if \(\$folder -and -not \$acl\.AreAccessRulesProtected\) \{ throw/.test(safe), "a folder with its parent's list was not made by this script and is refused");
  assert.ok(safe.indexOf("Test-Reparse $path") < safe.indexOf("Get-Acl"), "the link check comes before the list is read");
  // Add-Type only inside Initialize-NnLsa, and each LSA call is preceded by it in the same block
  assert.equal(code.match(/\bAdd-Type\b/g).length, 1);
  assert.ok(fn("Initialize-NnLsa").includes("Add-Type -TypeDefinition"));
  const lines = code.split("\n");
  let calls = 0;
  lines.forEach((line, i) => {
    if (!/\[NnLsa\]::\w+\(/.test(line)) return;
    calls++;
    let j = i - 1;
    while (j > 0 && /\[NnLsa\]::\w+\(/.test(lines[j])) j--; // calls right after another LSA call share its Initialize-NnLsa
    assert.match(lines[j], /^\s*Initialize-NnLsa$/, `before: ${line.trim()}`);
  });
  assert.equal(calls, 4, "List, Add, Remove, RemoveAll");
  // the folder parameters: printable ASCII, and none of # ' ` = (node --env-file cuts an unquoted value at #), refused before any action
  const shape = fn("Assert-NimbleNewtPath");
  assert.ok(shape.includes("$path -notmatch '^[\\x20-\\x7E]+$'") && shape.includes(`[^:*?"<>|#''\`=]+$'`), shape);
  assert.ok(fn("Invoke-Install").includes(`'^[\\x21-\\x7E][\\x20-\\x7E]*$'`) && fn("Invoke-Install").includes(`'["=#''\`]'`), "worker.env values are checked again where they are written");
});

test("second review: the hosted installer step captures Verify's Write-Host lines, and the product build remaps the Windows form of its folders", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(/& \$shellExe @shellArgs -File \$f @scriptArgs \*> \$outFile/.test(wf), "Write-Host is the information stream in 5.1: 2>&1 alone captures nothing and the step would fail on a correct Verify");
  assert.ok(/function Say\(\[string\] \$text\) \{ Write-Host \$text \}/.test(ps), "the script prints with Write-Host (the reason for *>&1)");
  assert.ok(/crate_w="\$\(cygpath -w "\$PWD"\)"/.test(wf) && /--remap-path-prefix=\$crate_w=\/nn-launcher --remap-path-prefix=\$cargo_w=\/cargo -C link-arg=\/Brepro/.test(wf));
  assert.ok(!/--remap-path-prefix=\$PWD=/.test(wf), "a Git Bash path (/d/a/...) never matches the Windows paths rustc sees");
});

test("the installer's README states what is not proven, and the contribution guide accounts for the new files", () => {
  const readme = read("native", "install", "README.md");
  for (const phrase of ["NOT RUN", "Session 0", "S4U", "Windows Home", "service-units.ts", "virtual service account", "group-managed service account"]) assert.ok(readme.includes(phrase), phrase);
  const contributing = read("CONTRIBUTING.md");
  for (const file of ["native/nn-launcher/src/lib.rs", "native/nn-launcher/src/main.rs", "native/nn-launcher/src/win.rs", "native/nn-launcher/Cargo.toml", "native/install/Install-NimbleNewtLauncher.ps1", "experiments/windows-appcontainer/launcher/src/main.rs"]) assert.ok(contributing.includes(file), file);
});

import { psBracketProblem } from "./ps-brackets.mjs";
export { psBracketProblem };

test("the installer's brackets and strings close in order (Linux cells cannot run PowerShell; the hosted run parses it with PowerShell itself)", () => {
  assert.equal(psBracketProblem(ps), "");
  // the checker itself: the slice-3 shape that closed a list before its last table, and a few others, are found
  assert.match(psBracketProblem("@(\n  @{ Why = 'a' }) })\n"), /closes '\{'|never closed|closes nothing/);
  assert.match(psBracketProblem("@{ Rules = @(\n  @{ Why = 'x') })\n)\n"), /line 2: '\)' closes '\{'/);
  assert.match(psBracketProblem("Say \"$($a\"\n"), /unclosed/);
  assert.equal(psBracketProblem("Say 'it''s (not a bracket'; Say \"x $(f ')') y\" # ) comment\n@'\n{ here\n'@\n"), "");
});

test("the installer uses Windows PowerShell 5.1 syntax only (no PowerShell 7 operators or parameters)", () => {
  const plain = code.replace(/@'\n[\s\S]*?\n'@/g, "").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
  for (const re of [/\?\?=?/, /\?\./, /&&/, /\|\|/, /\s\?\s[^\n]*\s:\s/, /-Parallel\b/, /-AsHashtable\b/, /-AsByteStream\b/, /\$PSStyle\b/, /\bclean\s*\{/, /-SkipCertificateCheck\b/]) assert.ok(!re.test(plain), `${re} is not Windows PowerShell 5.1`);
  assert.ok(ps.includes("[System.IO.Directory].GetMethod('CreateDirectory'"), "the .NET Framework call is used when it exists, the .NET one otherwise");
});

// ------------------------------------------------------------------------------------------------ -WhatIf safety (the owner's first real run on Windows PowerShell 5.1)

// Under -WhatIf, Windows PowerShell 5.1's own file-hash cmdlet printed 'What if: ... Retrieve the value for property ProviderPath' and returned nothing, and '.Hash' failed under StrictMode.
// Linux cannot run PowerShell, so these tests pin the shape of the repair: no such cmdlet, a .NET-only hash helper, and every read whose result is used goes through Invoke-Read.
const READ_CMDLETS = /\b(Get-Acl|Get-LocalUser|Get-LocalGroupMember|Get-LocalGroup|Get-AuthenticodeSignature|Get-ScheduledTask|Get-Content|Get-ChildItem|Get-Process|Get-Item|Test-Path|ConvertFrom-Json|Resolve-Path|Get-FileHash)\b/g;

test("the installer has no Get-FileHash anywhere (a PowerShell-written cmdlet honours -WhatIf inside its own steps on Windows PowerShell 5.1)", () => {
  assert.ok(!/Get-FileHash/.test(ps), "not even in a comment: the next reader must not add it back");
});

test("Get-Sha256Hex uses .NET only, disposes in finally, and is what every hash comparison calls", () => {
  const h = fn("Get-Sha256Hex");
  assert.match(ps, /\nfunction Get-Sha256Hex\(\[string\] \$Path\) \{/, "the helper exists under exactly this name");
  assert.match(ps, /\nfunction Invoke-Read\(\[scriptblock\] \$Block\) \{/, "Invoke-Read exists under exactly this name");
  assert.ok(h.includes("[System.IO.File]::OpenRead(") && h.includes("[System.Security.Cryptography.SHA256]::Create()") && h.includes(".ComputeHash("));
  const fin = h.slice(h.indexOf("finally {"));
  assert.ok(h.includes("finally {") && fin.includes("$stream.Dispose()") && fin.includes("$sha.Dispose()"), "the stream and the hash object are disposed in finally");
  assert.ok(h.includes("GetUnresolvedProviderPathFromPSPath"), "a relative path is resolved against the PowerShell location, with a .NET call");
  assert.ok(h.includes("ToString('X2')"), "upper-case hex: the manifest keeps the form Get-FileHash gave");
  // no cmdlet call of any kind in the helper except the one pipeline step that formats bytes
  const calls = [...h.replace(/ForEach-Object/g, "").matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g)].map((m) => m[0]);
  assert.deepEqual(calls, [], "the helper calls no cmdlet");
  assert.ok((code.match(/Get-Sha256Hex \$/g) ?? []).length >= 4, "the source, the placed file, the re-hash and Verify all use it");
  assert.match(code, /\$hash -ne \$ExpectedSha256\.ToUpperInvariant\(\)/, "the comparison stays case-insensitive (-ne) with both sides upper-case");
});

test("Invoke-Read switches -WhatIf off inside its own scope, and every read-only cmdlet whose result is used runs inside it", () => {
  const r = fn("Invoke-Read");
  assert.match(r, /\$WhatIfPreference = \$false;\s*& \$Block/);
  const lines = code.split("\n");
  let seen = 0;
  for (const [n, line] of lines.entries()) {
    if (line.startsWith("function Invoke-Read")) continue;
    for (const m of line.matchAll(READ_CMDLETS)) {
      seen++;
      const open = line.lastIndexOf("Invoke-Read {", m.index);
      assert.ok(open >= 0, `line ${n}: ${m[0]} is not inside Invoke-Read: ${line.trim().slice(0, 120)}`);
      const between = line.slice(open + "Invoke-Read {".length, m.index);
      const depth = 1 + (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
      assert.ok(depth > 0, `line ${n}: ${m[0]} comes after its Invoke-Read block closed`);
    }
  }
  assert.ok(seen >= 20, `the scan saw the read calls (${seen})`);
});

test("everything that changes the machine stays inside a ShouldProcess question (so -WhatIf still changes nothing)", () => {
  const install = fn("Invoke-Install");
  for (const call of ["New-LocalUser", "Add-LocalGroupMember", "[NnLsa]::Add", "Set-ProtectedAcl", "Copy-Item", "Set-Content"]) {
    const at = install.indexOf(call);
    assert.ok(at > 0, call);
    assert.ok(install.lastIndexOf("$PSCmdlet.ShouldProcess(", at) > install.lastIndexOf("Get-Sha256Hex $LauncherPath"), `${call} follows a ShouldProcess question`);
  }
  for (const call of ["Remove-LocalUser", "[NnLsa]::RemoveAll", "Remove-TreeNoFollow", "Remove-Item"]) {
    const un = fn("Invoke-Uninstall");
    assert.ok(un.lastIndexOf("$PSCmdlet.ShouldProcess(", un.indexOf(call)) >= 0, call);
  }
});

test("the dry-run lines the hosted step requires are lines the installer really prints", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const step = wf.slice(wf.indexOf("Installer script (parse"), wf.indexOf("G05 containment cases through the native backend"));
  const list = /\$mustSay = @\((.*)\)\n/.exec(step);
  assert.ok(list, "the list of required lines is in the step");
  const lines = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(lines.length >= 6);
  // the grant line is built from $RightsGranted, whose first entry is SeBatchLogonRight (pinned by the account-rights test)
  for (const l of lines) assert.ok(ps.includes(l.replace(/^What if: Performing the operation "/, "").replace("grant SeBatchLogonRight", "grant $($RightsGranted -join")), `the installer prints: ${l}`);
  assert.ok(ps.includes("$RightsGranted = @('SeBatchLogonRight')"));
});

// ------------------------------------------------------------------------------------------------ the workflow steps

test("the hand-started workflow builds the product launcher --locked after the experiment build and before the containment cases, and runs the installer without changing the machine", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(!/^\s+(push|pull_request|schedule):/m.test(wf));
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const at = (s) => { const i = hosted.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("Build the launcher (locked dependencies)") < at("Product launcher (native/nn-launcher)") && at("Product launcher (native/nn-launcher)") < at("Installer script (parse") && at("Installer script (parse") < at("G05 containment cases through the native backend"));
  const product = hosted.slice(at("Product launcher (native/nn-launcher)"), at("Installer script (parse"));
  for (const part of ["cargo build --release --locked", "--remap-path-prefix", "/Brepro", "nn-launcher.exe info", "grep -q '\"ok\":true'", "not in this build", 'test "$rc" -eq 125', "native-launcher.mjs record", "native-launcher.mjs verify", "if: always()"]) assert.ok(product.includes(part), part);
  assert.ok(!product.replace("cargo test --locked --features experiment", "").includes("--features"), "the product build enables no feature (only the argument tests of the experiment build name one)");
  assert.ok(product.includes("cargo test --locked 2>&1") && product.indexOf("cargo build --release --locked") < product.indexOf("cargo test --locked"), "the argument tests run after the release build, so the tested release file is the built one");
  const installer = hosted.slice(at("Installer script (parse"), at("G05 containment cases through the native backend"));
  for (const part of ["Parser]::ParseFile", "'-WhatIf'", "'Verify'", "'-AllowUnsigned'", "if (Get-LocalUser -Name $account", "Test-Path (Join-Path $env:ProgramFiles 'NimbleNewt')", "Test-Path (Join-Path $env:ProgramData 'NimbleNewt')"]) assert.ok(installer.includes(part), part);
  assert.ok(!/'Uninstall'/.test(installer), "the hosted step never runs Uninstall");
  assert.match(installer, /\$common = @\('-Action', 'Install', '-ExpectedSha256', \$h, '-AllowUnsigned', '-WhatIf'\)/, "Install is only ever run with -WhatIf there");
  // the containment cases use the product binary, not the experiment's
  assert.match(hosted.slice(at("G05 containment cases through the native backend")), /NIMBLENEWT_WIN_LAUNCHER: [^\n]*native\\nn-launcher\\target\\release\\nn-launcher\.exe/);
});

test("the hosted installer step runs the owner's command under Windows PowerShell 5.1 AND PowerShell 7 with the real launcher and its hash, and fails on errors or changes", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const from = hosted.indexOf("Installer script (parse");
  const step = hosted.slice(from, hosted.indexOf("G05 containment cases through the native backend"));
  const text = step.replace(/^\s*#.*$/gm, "");
  assert.ok(hosted.indexOf("id: build_product") < from, "after the product build, so the exe exists");
  assert.match(step, /shell: powershell\n/, "the step itself is Windows PowerShell 5.1");
  assert.match(step, /\n\s+if: always\(\)\n/);
  assert.ok(!/continue-on-error/.test(step), "a gate for this check: the step is allowed to fail the job");
  // the same file the release record names, its hash, the owner's relative path
  assert.ok(text.includes("native\\nn-launcher\\target\\release\\nn-launcher.exe") && text.includes("ComputeHash") && text.includes("ReadAllBytes"));
  assert.ok(text.includes("'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass')") && text.includes("'pwsh' @('-NoProfile', '-ExecutionPolicy', 'Bypass')"), "both shells, started as a program with -ExecutionPolicy Bypass");
  assert.ok(text.includes("-File $f @scriptArgs"), "with -File, as the owner ran it");
  assert.ok(text.includes("'-LauncherPath', '.\\nn-launcher.exe'") && text.includes("'-LauncherPath', (Join-Path $tmp 'nn-launcher.exe')"), "the real -LauncherPath: relative under 5.1, full under pwsh");
  assert.ok(text.includes("'-ExpectedSha256', $h") && text.includes("'-AllowUnsigned', '-WhatIf'"));
  assert.ok(text.includes("Assert-Dry $r51") && text.includes("Assert-Dry $r7"), "both results are checked");
  // what is checked: exit code, required lines, forbidden text, nothing made
  for (const part of ["$r.Code -ne 0", "$mustSay", "$mustNot", "PropertyNotFound", "Retrieve the value for property", "Assert-Untouched $label", "Assert-Untouched 'before the dry run'", "Assert-Untouched 'after Verify'", "$account = 'nimblenewt-worker'"]) assert.ok(text.includes(part), part);
  assert.ok(text.includes("(@('-Action', 'Verify') + $extra)") && text.includes("foreach ($extra in @(@(), @('-WhatIf')))"), "Verify runs under 5.1 plainly and with -WhatIf");
  assert.ok(text.includes("-Action', 'Install'") && !/'Uninstall'/.test(text));
  // read-only checks of what exists afterwards (no cmdlet that changes anything)
  assert.ok(!/\b(New|Set|Remove|Add|Register|Start|Stop)-[A-Z]\w+/.test(text.replace(/New-Item -ItemType Directory -Path \$tmp -Force|Set-Location|Push-Location|Pop-Location/g, "")), "the step changes nothing but its own temporary folder");
  // action pins and permissions are untouched by this step
  assert.ok(!/uses:/.test(step));
});

test("verify started through a link still checks the file (a link once made the command a silent no-op that ended 0)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nn-nl-"));
  try {
    const link = join(dir, "native-launcher.mjs");
    // a file link needs Developer Mode or an administrator on Windows; without it there is nothing to test there
    try { symlinkSync(join(root, "scripts", "native-launcher.mjs"), link); } catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("no file links here"); return; } throw error; }
    const file = join(dir, "nn-launcher.exe");
    writeFileSync(file, "MZ pretend executable");
    const record = join(dir, "record.json");
    writeFileSync(record, JSON.stringify(makeRecord({ fileName: file, bytes: Buffer.from("MZ another executable"), commit: COMMIT })));
    const bad = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", record], { encoding: "utf8" });
    assert.equal(bad.status, 1, `${bad.stdout}${bad.stderr}`);
    assert.match(bad.stderr, /SHA-256/);
    const missing = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", join(dir, "none.json")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    writeFileSync(record, JSON.stringify(makeRecord({ fileName: file, bytes: readFileSync(file), commit: COMMIT })));
    const good = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", record], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /matches the record/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hosted product-launcher step and the own-runner info step both require the private window station to be made (Session 0 fix)", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const hosted = wf.slice(wf.indexOf('- name: "Product launcher (native/nn-launcher)'), wf.indexOf("node ../../scripts/native-launcher.mjs record"));
  const ownAt = wf.indexOf("- name: Product launcher info as the runner service");
  const own = wf.slice(ownAt, wf.indexOf("\n      - name:", ownAt + 10));
  for (const [name, text] of [["hosted", hosted], ["own runner", own]]) {
    assert.ok(text.length > 200, name);
    assert.ok(text.includes(`grep -q '"windowStation":"private"'`), `${name}: the product names the private station`);
    assert.ok(text.includes(`grep -q '"windowStationOk":true'`), `${name}: a private station was made and closed`);
    // the per-run profile `info` made is reported deleted and gone (README: info prints profileDeleted and profileGone)
    assert.ok(text.includes("profileDeleted") && text.includes("profileGone"), `${name}: the throw-away profile is checked deleted and gone`);
  }
  const hostedStep = wf.slice(wf.indexOf('- name: "Product launcher (native/nn-launcher)'), wf.indexOf("# Card A03b reproducibility"));
  assert.ok(hostedStep.indexOf('echo "sha256=$(sha256sum') > 0 && hostedStep.indexOf('echo "sha256=$(sha256sum') < hostedStep.indexOf('exit "$profile_bad"'), "the hosted step reports a profile miss only after the release record and hash output");
});

test("no product-launcher call in the workflow uses a fixed profile name: each takes a fresh NimbleNewtRun-<16 hex> name, its record file, and delete-profile also its SID", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const code = wf.replace(/^\s*#.*$/gm, "");
  // the product refuses any other name (native/nn-launcher/src/args.rs), so a fixed name is a call that exits 125
  assert.ok(!/NimbleNewtProductCheck|NimbleNewtOwnRunnerG05|NimbleNewtAgent|NIMBLENEWT_WIN_PROFILE/.test(code), "no fixed product profile name is left");
  const gen = /([a-z_]+)="NimbleNewtRun-\$\(node -e "process\.stdout\.write\(require\('crypto'\)\.randomBytes\(8\)\.toString\('hex'\)\)"\)"/g;
  const generated = [...code.matchAll(gen)].map((m) => m[1]);
  assert.deepEqual(generated, ["info_name", "info_name"], "the name is generated (8 random bytes, 16 hex digits) in the hosted and in the own-runner info step");
  // every line that starts the product launcher with a profile command (the `dump` refusal check has no profile)
  const calls = code.split("\n").filter((l) => /(nn-launcher\.exe"?|"\$prod") +(run|check|revoke|info|delete-profile)\b/.test(l));
  assert.equal(calls.length, 3, calls.join("\n")); // hosted info, own-runner info, clean-up delete-profile
  for (const l of calls) {
    assert.ok(!/--name +[A-Za-z]/.test(l) && /--name "\$(info_name|pname)"/.test(l), `the name comes from a variable: ${l.trim()}`);
    const cmd = /(run|check|revoke|info|delete-profile)\b/.exec(l.slice(l.indexOf("nn-launcher.exe") >= 0 ? l.indexOf("nn-launcher.exe") : l.indexOf("$prod")))[1];
    if (["run", "info", "delete-profile"].includes(cmd)) assert.match(l, /--profile-record /, `${cmd} needs its record file`);
    if (cmd === "delete-profile") assert.match(l, /--sid "\$psid"/, "delete-profile needs the recorded SID");
    else assert.ok(!/--sid/.test(l), `${cmd} takes no --sid`);
  }
  // the launcher's own rule, read from its source: the same pattern the workflow generates
  const args = read("native", "nn-launcher", "src", "args.rs");
  assert.match(args, /--name must be \{\}<\{\} lower-case hex digits>/);
  assert.match(read("native", "nn-launcher", "src", "profile.rs"), /RUN_PREFIX: &str = "NimbleNewtRun-"[^]*RUN_HEX_LEN: usize = 16/);
  // the record folder exists before the first use (the launcher creates the file, never the folder)
  assert.equal((code.match(/mkdir -p "\$RUNNER_TEMP\/profile-records"/g) ?? []).length, 2);
});

// ------------------------------------------------------------------------------------------------ A03b: property names on cmdlet objects (found by the owner's first real Verify)
// The owner's first real `-Action Verify` (Windows PowerShell 5.1, StrictMode 3, after a real Install) stopped with "The property 'PasswordNeverExpires' cannot be found on this object": that name is a
// PARAMETER of New-LocalUser, and the object Get-LocalUser returns has no such property. Under StrictMode 3 a missing property throws. Linux cannot run PowerShell, so this test reads the script and
// checks every `$variable.Property` and `(cmdlet ...).Property` against the properties Microsoft documents for the object that variable holds. Sources (documentation, not guesses):
//   LocalUser           learn.microsoft.com/powershell/module/microsoft.powershell.localaccounts/get-localuser (Microsoft.PowerShell.Commands.LocalUser)
//   LocalGroup          .../get-localgroup ; LocalPrincipal (Get-LocalGroupMember): Name, SID, ObjectClass, PrincipalSource
//   FileSecurity        System.Security.AccessControl.FileSystemSecurity + Get-Acl's note properties (Path, Owner, Group, Access, Sddl)
//   Signature           Get-AuthenticodeSignature: Status, StatusMessage, SignerCertificate, TimeStamperCertificate, SignatureType, Path, IsOSBinary
//   ScheduledTask       MSFT_ScheduledTask: TaskName, TaskPath, Principal, Triggers, Actions, Settings, State, Description, URI, Author, Source, Date, Documentation, Version
//   TaskPrincipal       MSFT_TaskPrincipal2: UserId, LogonType, RunLevel, GroupId, Id, DisplayName, ProcessTokenSidType, RequiredPrivilege
//   SecurityIdentifier  System.Security.Principal.SecurityIdentifier: Value, BinaryLength, AccountDomainSid
// A property the documentation does not guarantee on EVERY object of its kind (the exec action's Execute, Arguments and WorkingDirectory are absent from other action types; every field of a JSON file) is
// read with Get-Prop, never with a dot, and this test forbids the dotted form.
const DOCUMENTED = {
  LocalUser: ["AccountExpires", "Description", "Enabled", "FullName", "PasswordChangeableDate", "PasswordExpires", "UserMayChangePassword", "PasswordRequired", "PasswordLastSet", "LastLogon", "Name", "SID", "PrincipalSource", "ObjectClass"],
  LocalGroup: ["Description", "Name", "SID", "PrincipalSource", "ObjectClass"],
  FileSecurity: ["Path", "Owner", "Group", "Access", "Sddl", "AreAccessRulesProtected", "AreAccessRulesCanonical", "AreAuditRulesProtected", "AccessRightType", "AccessRuleType", "AuditRuleType"],
  Signature: ["Status", "StatusMessage", "SignerCertificate", "TimeStamperCertificate", "SignatureType", "Path", "IsOSBinary"],
  ScheduledTask: ["TaskName", "TaskPath", "Principal", "Triggers", "Actions", "Settings", "State", "Description", "URI", "Author", "Source", "Date", "Documentation", "Version"],
  TaskPrincipal: ["UserId", "LogonType", "RunLevel", "GroupId", "Id", "DisplayName", "ProcessTokenSidType", "RequiredPrivilege"],
  SecurityIdentifier: ["Value", "BinaryLength", "AccountDomainSid"],
};
// variable name in the script -> the kind of object it holds (every variable assigned from one of these cmdlets must be listed: the test below checks that)
const HOLDERS = { user: "LocalUser", existing: "LocalUser", acl: "FileSecurity", sig: "Signature", task: "ScheduledTask", tp: "TaskPrincipal", sid: "SecurityIdentifier" };
const CMDLET_KIND = { "Get-LocalUser": "LocalUser", "Get-LocalGroup": "LocalGroup", "Get-AuthenticodeSignature": "Signature", "Get-Acl": "FileSecurity", "Get-ScheduledTask": "ScheduledTask" };
// `$_` inside a pipeline: the union of what the script's pipelines iterate (members, group members, access rules, tasks' triggers, files, user profiles, hashtable plan entries). Execute, Arguments,
// WorkingDirectory and the manifest's fields are deliberately NOT here: they go through Get-Prop.
const PIPE_PROPS = ["SID", "Name", "FullName", "IdentityReference", "FileSystemRights", "InheritanceFlags", "PropagationFlags", "AccessControlType", "Value", "Who", "Rights", "Scope", "Why", "Path", "CimClass", "CimClassName"];
const OPTIONAL_PROPS = ["Execute", "Arguments", "WorkingDirectory", "schema", "account", "accountSid", "installDir", "dataDir", "controlDir", "launcher", "PasswordNeverExpires"];

function propertyProblems(src) {
  const body = src.replace(/<#[\s\S]*?#>/, "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");
  const problems = [];
  const known = new Set(Object.values(DOCUMENTED).flat());
  for (const m of body.matchAll(/\$([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\()?/g)) {
    const [, variable, prop, call] = m;
    if (call || prop === "Count" || prop === "Length") continue; // a method, or the intrinsic Count/Length every value has (an array is held in $task until its first element is taken)
    if (variable === "_") {
      if (!PIPE_PROPS.includes(prop)) problems.push(`$_.${prop}: not a documented property of anything the pipelines carry`);
    } else if (HOLDERS[variable]) {
      if (!DOCUMENTED[HOLDERS[variable]].includes(prop)) problems.push(`$${variable}.${prop}: ${HOLDERS[variable]} has no property ${prop}`);
    } else if (/^(a|m|manifest|acts)$/.test(variable) && OPTIONAL_PROPS.includes(prop)) {
      problems.push(`$${variable}.${prop}: optional property read with a dot (use Get-Prop)`);
    }
  }
  for (const m of body.matchAll(/\(\s*(?:Invoke-Read \{\s*)?(Get-LocalUser|Get-LocalGroup|Get-AuthenticodeSignature|Get-Acl)\b[^()]*\)\.([A-Za-z_]\w*)(\()?/g)) {
    if (!m[3] && !DOCUMENTED[CMDLET_KIND[m[1]]].includes(m[2])) problems.push(`(${m[1]} ...).${m[2]}: not a documented property`);
  }
  // any dotted use of a name that is a parameter or an optional property, anywhere
  for (const m of body.matchAll(/\.(PasswordNeverExpires|Execute|Arguments|WorkingDirectory)\b(?!\()/g)) problems.push(`.${m[1]}: absent or optional on some objects (Get-Prop)`);
  // every variable assigned from one of these cmdlets must be a holder the table knows (so a new variable cannot slip past)
  for (const m of body.matchAll(/\$([A-Za-z_]\w*) = [^\n]*?\b(Get-LocalUser|Get-AuthenticodeSignature|Get-ScheduledTask)\b/g)) if (!HOLDERS[m[1]]) problems.push(`$${m[1]} is assigned from ${m[2]} but is not in the table`);
  void known;
  return problems;
}

test("A03b: every property read on a cmdlet object is one Microsoft documents for it (the owner's Verify stopped on PasswordNeverExpires)", () => {
  assert.deepEqual(propertyProblems(ps), []);
  // the repair itself: the printed line uses PasswordExpires, says never when it is empty, and the parameter name appears only as New-LocalUser's parameter
  assert.match(code, /\$expires = \$user\.PasswordExpires/);
  assert.match(code, /password expires: \$\(if \(\$null -eq \$expires\) \{ 'never' \}/);
  assert.equal([...code.matchAll(/PasswordNeverExpires/g)].length, 1);
  assert.match(code, /New-LocalUser [^\n]*-PasswordNeverExpires /);
  assert.ok(ps.includes("leaves PasswordExpires empty") && ps.includes("Informational only"), "the comment states the intent and that the line is informational");
  assert.ok(!/Check[^\n]*PasswordExpires/.test(code), "informational, not a PASS/FAIL line (the README makes no such claim)");
  // the helper: null object, absent property, present property; and it is used for the optional ones
  const g = fn("Get-Prop");
  assert.ok(g.includes("$null -eq $Object") && g.includes("$Object.PSObject.Properties[$Name]") && g.includes("$p.Value"));
  assert.ok((code.match(/Get-Prop /g) ?? []).length >= 10, "the optional properties and the manifest fields are read with Get-Prop");
  // Uninstall: the manifest is validated before any use
  const un = fn("Invoke-Uninstall");
  assert.ok(un.includes("(Get-Prop $m 'schema')") && un.includes("$mAccount -notmatch") && un.includes("$mSid -notmatch") && !/\$m\.\w/.test(un));
});

test("A03b: the property check catches at least eight deliberate breakages, and the installer file is untouched by them", async () => {
  const { createHash } = await import("node:crypto");
  const file = join(root, "native", "install", "Install-NimbleNewtLauncher.ps1");
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();
  const mutations = [
    ["the wrong name the owner hit", (s) => s.replace("$user.PasswordExpires", "$user.PasswordNeverExpires")],
    ["a misspelt property of the signature", (s) => s.replace("$sig.Status)", "$sig.Statuz)")],
    ["a wrong property of the access list", (s) => s.replace("$acl.AreAccessRulesProtected)", "$acl.AreRulesProtected)")],
    ["a wrong property of the task principal", (s) => s.replace("$tp.UserId -ieq $AccountName", "$tp.User -ieq $AccountName")],
    ["a pipeline property that nothing has", (s) => s.replace("$_.SID -eq $user.SID", "$_.Sid2 -eq $user.SID")],
    ["a dotted read of the manifest's account", (s) => s.replace("-Name $mAccount", "-Name $m.account")],
    ["a dotted read of an action's Execute", (s) => s.replace("$(Get-Prop $a 'Execute')", "$($a.Execute)")],
    ["a wrong name on a parenthesised cmdlet result", (s) => s.replace("(Get-Prop (Invoke-Read { Get-LocalGroup -SID $SidUsers }) 'Name')", "(Invoke-Read { Get-LocalGroup -SID $SidUsers }).Nam")],
    ["a user property that is a parameter name", (s) => s.replace("$existing.Description -ne", "$existing.AccountNeverExpires -ne")],
    ["a new variable from Get-LocalUser that the table does not know", (s) => s.replace("$existing = Invoke-Read {", "$found = Invoke-Read {")],
  ];
  for (const [what, mutate] of mutations) {
    const changed = mutate(ps);
    assert.notEqual(changed, ps, `the mutation applies: ${what}`);
    assert.ok(propertyProblems(changed).length > 0, `caught: ${what}`);
  }
  assert.equal(sha(), before, "the installer file on disk was not touched");
});

test("A03b: the hosted workflow's real-account step is the only place a user is made, and it is hosted-only", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const live = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.equal([...live.matchAll(/New-LocalUser/g)].length, 1, "one place makes a user");
  assert.ok(hosted.includes("New-LocalUser") && !wf.slice(wf.indexOf("  own-runner:")).includes("New-LocalUser"));
  assert.ok(hosted.includes("RUNNER_ENVIRONMENT -ne 'github-hosted'") && hosted.includes("Remove-LocalUser -Name $name"));
  assert.equal([...wf.matchAll(/^\s*permissions:/gm)].length, 1, "one permissions block");
  assert.ok(wf.includes("permissions:\n  contents: read\n"), "permissions unchanged");
});

// ------------------------------------------------------------------------------------------------ A03b: a REAL Install, Verify and Uninstall on the disposable hosted runner
// The owner's first real runs found two faults the text tests could not reach, and the rest of Verify and ALL of Uninstall have never run anywhere. The hosted job now installs for real onto a throw-away
// account and throw-away folders, checks the machine, uninstalls and checks that nothing is left. Linux cannot run it; these tests pin the shape of the step (and of the offline fixes made while reading the paths).

test("A03b real run: Uninstall tolerates 'right not held', only a process that runs THIS launcher blocks it, and Verify reads group members with a fallback (offline fixes, text-checked)", () => {
  assert.ok(ps.includes("s != 0xC0000060") && /public static void Remove\(string sid[^]*?0xC0000034 && s != 0xC0000060/.test(ps), "Remove tolerates the account having no such right as well as no rights record");
  const un = fn("Invoke-Uninstall");
  assert.ok(un.includes("$running = @(Invoke-Read { Get-Process -Name 'nn-launcher'") && un.includes("Test-SamePath $path $launcher") && un.includes("$running.Count -gt 0"), "path-aware, and a count rather than the truth of an array");
  const g = fn("Test-GroupHasUser");
  assert.ok(g.includes("Invoke-Read { Get-LocalGroupMember -Group $Group -ErrorAction Stop }") && g.includes("catch {") && g.includes("net.exe localgroup $Group.Name"), "a group the cmdlet cannot read is read with net localgroup, never skipped");
  assert.ok(fn("Invoke-Verify").includes("Where-Object { Test-GroupHasUser $_ $user }"), "Verify uses the helper");
  assert.ok(!/Get-LocalGroupMember[^\n]*SilentlyContinue/.test(code), "a failing group read is no longer silently treated as 'not a member'");
});

const REAL_FROM = "id: installer_real\n";
function realStepParts(wf) {
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const own = wf.slice(wf.indexOf("  own-runner:"));
  const a = hosted.lastIndexOf("\n      - name:", hosted.indexOf(REAL_FROM)) + 1;
  const b = hosted.indexOf("\n      # Safety net for the step above", a);
  const c = hosted.indexOf("\n      - uses: actions/upload-artifact", b);
  return { hosted, own, step: hosted.slice(a, b), clean: hosted.slice(b, c), before: hosted.slice(0, a), after: hosted.slice(c) };
}
const noComments = (t) => t.replace(/^\s*#.*$/gm, "");

/** Every way the real-run step may be wrong that a Linux test can see; an empty list is a pass. */
function realStepProblems(wf) {
  const problems = [];
  const bad = (cond, what) => { if (!cond) problems.push(what); };
  if (!wf.includes(REAL_FROM)) return ["the step is missing"];
  const { hosted, own, step, clean, before, after } = realStepParts(wf);
  const text = noComments(step);
  const ctext = noComments(clean);
  // position: after the staging and the launchers upload (so a failure cannot stop them), before the last upload
  bad(before.includes("id: stage") && before.includes("name: windows-appcontainer-launchers") && after.includes("name: windows-appcontainer-hosted"), "ordered after staging and the launchers upload, before the last upload");
  bad(/shell: powershell\n/.test(step) && /\n\s+if: always\(\)\n/.test(step) && /timeout-minutes: \d+/.test(step), "Windows PowerShell 5.1, always(), with a time-out");
  bad(!/continue-on-error/.test(step + clean) && !/uses:/.test(step + clean) && !/permissions:/.test(step + clean), "a gate; pins and permissions untouched");
  // the hosted-only guard (the same two variables as the throw-away-account step) comes before ANY change
  const guard = text.indexOf("$env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'");
  const firstChange = Math.min(...["New-Item", "AppendAllText", "Run-Installer '", "Copy-Item", "Remove-LocalUser"].map((s) => { const i = text.indexOf(s); return i < 0 ? Infinity : i; }));
  bad(guard >= 0 && guard < firstChange && text.slice(guard, guard + 260).includes("exit 1"), "the hosted-only guard refuses before any change");
  // a throw-away name and throw-away folders named NimbleNewt under RUNNER_TEMP, never the runner's own
  bad(text.includes("'nnprobe' + $tag") && text.includes("New-Object byte[] 6") && text.includes("abcdefghijklmnopqrstuvwxyz0123456789") && text.includes("RandomNumberGenerator]::Create()"), "random nnprobe name");
  bad(text.includes("$root = Join-Path $env:RUNNER_TEMP ('nn-real-' + $tag)") && text.includes("$d1 = Join-Path $root 'prog\\NimbleNewt'") && text.includes("$d2 = Join-Path $root 'data\\NimbleNewt'"), "folders named NimbleNewt under RUNNER_TEMP");
  bad(!/-InstallDir\s+\$env:ProgramFiles|-DataDir\s+\$env:ProgramData/.test(text) && !/'nimblenewt-worker'/.test(text), "never the default account or the runner's own folders");
  // every real Install and Uninstall is non-interactive and runs as a command (-Confirm:$false is not parsed as a switch value by -File)
  const runs = [...text.matchAll(/Run-Installer '([a-z0-9-]+)' "([^"\n]*)"/g)];
  const mutating = runs.filter((r) => /-Action (Install|Uninstall)/.test(r[2]));
  bad(mutating.length === 4 && mutating.every((r) => r[2].includes("-Confirm:`$false")), "all four Install/Uninstall runs pass -Confirm:$false");
  bad(text.includes("-Command $cmd") && !/-File/.test(text), "run with -Command, not -File");
  // the sequence and its proofs
  const order = ["Run-Installer 'install'", "Run-Installer 'verify-1'", "Run-Installer 'install-again'", "Run-Installer 'verify-2'", "Run-Installer 'uninstall-wrong-folder'", "Run-Installer 'uninstall' ", "Run-Installer 'verify-3'"].map((s) => text.indexOf(s));
  bad(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "Install, Verify, Install again, refused Uninstall, Uninstall, Verify in that order");
  for (const part of ["Install finished", "Uninstall finished", "RESULT: everything this script manages is as designed.", "FAIL  the account exists", "No manifest at", "PropertyNotFound", "cannot be found on this object", "$expectedFail", "Fail \"Uninstall left $p\"", "Win32_UserProfile", "Get-Rights $sid", "Uninstall left the account", "the local users differs", "Get-LocalUser | ForEach-Object", "Administrators differ", "worker.env is not exactly the four", "secret-looking", "the manifest does not name this install", "the account is a member of Administrators", "is not a member of Users", "the placed launcher differs", "AreAccessRulesProtected", "ChangePermissions, TakeOwnership"]) bad(text.includes(part) || (part === "the local users differs" && text.includes("the list of local users differs")), `asserts: ${part}`);
  bad(text.includes("$expectedFail = @()"), "no expected failure is allowed in Verify after a real Install");
  // the password never exists in this step
  bad(!/New-LocalUser|SecureString|ConvertFrom-SecureString|-AsPlainText|Password/i.test(text), "no password in the step");
  // clean-up: in finally, by the exact name and folder, no wildcard, and it fails the step when it had work to do
  const fin = text.slice(text.indexOf("} finally {"));
  bad(fin.includes("^nnprobe[a-z0-9]{6}$") && fin.includes("Remove-LocalUser -Name $name") && fin.includes("Wipe $root") && fin.includes("Uninstall left $($left -join '; ')"), "finally removes by the exact name and folder and reports");
  const removals = [...(text + ctext).matchAll(/Remove-LocalUser[^\n]*/g)].map((m) => m[0]);
  bad(removals.length === 2 && removals.every((r) => /^Remove-LocalUser -Name \$name( \})?(\s*\})?/.test(r)), "Remove-LocalUser only by the exact generated name");
  bad(!/Remove-Item[^\n]*[*?]|rmdir[^\n]*[*?]|Get-LocalUser[^\n]*(-Name|-Filter)[^\n]*\*|nnprobe\*/.test(text + ctext), "no wildcard removal");
  // the safety net
  bad(/id: installer_real_cleanup\n[^]*?if: always\(\)/.test(clean) && ctext.includes("$env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'") && ctext.includes("'^nnprobe[a-z0-9]{6}$'") && ctext.includes("Uninstall left") && clean.includes("steps.installer_real.outputs.name") && clean.includes("steps.installer_real.outputs.root"), "the follow-up step: always(), guarded, exact names, fails when something was left");
  // never in the own-runner job; one place makes a user
  bad(!/installer_real|nn-real-|nnprobe|-Action (Install|Uninstall)/.test(own), "not in the own-runner job");
  void hosted;
  return problems;
}

test("A03b real run: the hosted job's real Install, Verify, second Install, refused Uninstall and Uninstall step has the pinned shape", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.deepEqual(realStepProblems(wf), []);
  const { step } = realStepParts(wf);
  assert.ok(wf.includes("ORDER: it is the LAST step before the final"), "the notes say where it sits and why");
  // Verify after a real Install must name no expected failure: the installer only REPORTS the unsigned launcher and the missing worker task
  assert.ok(step.includes("$expectedFail = @()"));
  assert.ok(ps.includes("Worker task '$WorkerTaskName'") && ps.includes("not registered (see README.md") && ps.includes("WARNING: installing an UNSIGNED launcher") && !/Check[^\n]*(signature|UNSIGNED)/.test(code), "the two documented non-failures are printed lines, not checks");
  assert.equal(wf.match(/^\s*permissions:/gm).length, 1);
});

test("A03b real run: the pin catches at least ten deliberate breakages, and the workflow file on disk is untouched by them", async () => {
  const { createHash } = await import("node:crypto");
  const file = join(root, ".github", "workflows", "windows-appcontainer-experiment.yml");
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const mutations = [
    ["no hosted-only guard", (s) => s.replace("$env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { Write-Output '::error::this step installs a real", "$env:GITHUB_ACTIONS -eq 'x') { Write-Output '::error::this step installs a real")],
    ["Uninstall without -Confirm:$false", (s) => s.replace('"-Action Uninstall $paths -Confirm:`$false"', '"-Action Uninstall $paths"')],
    ["a prompt-able second Install", (s) => s.replace('-AllowUnsigned $paths -Confirm:`$false"\n            Assert-Run $i2', '-AllowUnsigned $paths"\n            Assert-Run $i2')],
    ["the safety net not always()", (s) => s.replace('id: installer_real_cleanup\n        shell: powershell\n        if: always()', 'id: installer_real_cleanup\n        shell: powershell\n        if: success()')],
    ["a wildcard account removal", (s) => s.replace("Remove-LocalUser -Name $name } }", "Remove-LocalUser -Name nnprobe* } }")],
    ["the step is allowed to fail silently", (s) => s.replace('id: installer_real\n        shell: powershell', 'id: installer_real\n        continue-on-error: true\n        shell: powershell')],
    ["the step also runs on the own runner", (s) => s + "\n      - run: echo installer_real\n"],
    ["the default account", (s) => s.replace("$name = 'nnprobe' + $tag", "$name = 'nimblenewt-worker'")],
    ["the runner's own Program Files", (s) => s.replace("$d1 = Join-Path $root 'prog\\NimbleNewt'", "$d1 = Join-Path $env:ProgramFiles 'NimbleNewt'")],
    ["run with -File", (s) => s.replace("-Command $cmd", "-File $f")],
    ["no check that nothing is left", (s) => s.replace('Fail "Uninstall left $p"', 'Write-Host "left $p"')],
    ["no leftover report in finally", (s) => s.replace("Uninstall left $($left -join '; ') (removed by the cleanup)", "left something")],
    ["a password in the step", (s) => s.replace("$script:failed = $false", "$script:failed = $false; $secure = ConvertTo-SecureString 'x' -AsPlainText -Force")],
    ["Verify may name an expected failure", (s) => s.replace("$expectedFail = @()", "$expectedFail = @('FAIL  the account exists')")],
    ["the step moved before the staging", (s) => { const a = s.indexOf("      # Card A03b, the owner's first real runs found two faults"); const b = s.indexOf("      # Safety net for the step above"); const c = s.indexOf("      - uses: actions/upload-artifact", b); const blk = s.slice(a, c); return s.replace(blk, "").replace("      # The programs the own-runner job runs", blk + "      # The programs the own-runner job runs"); }],
  ];
  let caught = 0;
  for (const [what, mutate] of mutations) {
    const changed = mutate(wf);
    assert.notEqual(changed, wf, `the mutation applies: ${what}`);
    if (realStepProblems(changed).length > 0) caught++; else assert.fail(`not caught: ${what}`);
  }
  assert.ok(caught >= 10);
  assert.equal(sha(), before, "the workflow file on disk was not touched");
});

// ---------------------------------------------------------------------------------------------------------------- the home desktop in the product (plan 12.5.1)

test("the home desktop: the product's own documents record what it closes, what stays shared, the limit's measured effect, and the owner's clipboard decision", () => {
  const plan = read("docs", "nimblenewt", "windows-isolation-plan.md");
  const s = plan.slice(plan.indexOf("#### 12.5.1 The home desktop in the product"), plan.indexOf("## 13. What we would tell users"));
  assert.ok(s.length > 4000, "the section exists");
  for (const fact of ["495 windows (28 visible)", "0 with them", "`EnumWindows`", "foreground window", "cursor position", "one screen pixel", "clipboard open", "clipboard sequence number", "global atom add", "keyboard hook", "on its own desktop only",
    "0x20327", "0xf00ff", "The job's clipboard limit, stated plainly", "did NOT block the open in this one run", "unmeasured", "GetClipboardData", "nn-hd-<64 random bits>", "NO fallback to the inherited desktop",
    "windowStation", "privateStationError", "try_home_desktop", "may_make_home_desktop", "Still not measured on the product itself"]) assert.ok(s.includes(fact), fact);
  // second review: the figures say where they come from (the owner's pasted output, not stored), the mask is decoded, and what stops SwitchDesktop on the visible station is named as documented only
  for (const fact of ["pasted into the working session on 2026-11-26", "is NOT stored in this repository", "0x201FF", "`DESKTOP_SWITCHDESKTOP`", "`JOB_OBJECT_UILIMIT_DESKTOP`", "documented, NOT measured",
    "no WRITE_DAC, WRITE_OWNER or DELETE", "`jobProcessesAtEnd`", "If the specified desktop already exists, the function succeeds and returns a handle to the existing desktop", "deny-only",
    "that `JOB_OBJECT_UILIMIT_DESKTOP` stops `SwitchDesktop` on WinSta0"]) assert.ok(s.includes(fact), fact);
  const launcherReadme = read("native", "nn-launcher", "README.md");
  for (const fact of ["that output is not stored in this repository", "0x201FF", "`JOB_OBJECT_UILIMIT_DESKTOP` (documented, not measured)", "`jobProcessesAtEnd`", "the UI limit stops `SwitchDesktop` there"]) assert.ok(launcherReadme.includes(fact), fact);
  // the owner's decision is recorded as a decision (with the date), not as an open item
  assert.ok(s.includes('Owner decision (2026-11-26: "The clipboard is fine")') && s.includes("ACCEPTED exposure"));
  assert.ok(!/open item for the owner|owner must decide|\bOPEN:|for the owner to decide/i.test(s), "no open clipboard question is left for the owner");
  assert.ok(plan.includes("**Correction (2026-11-26).**"), "the earlier claim that the limits close the clipboard is corrected where it was made");
  assert.ok(s.includes('Owner decision (2026-11-26: "Let\'s require someone to be logged in")') && s.includes("Windows work STOPS when nobody is signed in") && s.includes("TO BE VERIFIED on Windows, not proven"));
  assert.ok(!/(requires?|needs?) an unattended Session-0 service/i.test(s), "no unattended service identity is described as a requirement");
  const readme = read("native", "nn-launcher", "README.md");
  const w = readme.slice(readme.indexOf("## Window objects: the private station, or the home desktop"), readme.indexOf("## What is not in it"));
  for (const fact of ["never by an option", "NEVER inherits the user's desktop", "NOTHING is written to WinSta0's access list", "CLIPBOARD", "ATOM table", "did not block the clipboard open", "accepted exposure", "2026-11-26", "The clipboard is fine", "495", "Let's require someone to be logged in", "Windows work stops when nobody is signed in", "not a requirement"]) assert.ok(w.includes(fact), fact);
  const notes = read("docs", "nimblenewt", "implementation-plan", "implementation-notes.md");
  const n = notes.slice(notes.indexOf("### A03b: the home desktop in the product launcher"));
  for (const fact of ["card NOT flipped", "ASSUMPTION:", "NOT done / only Windows can show", "Owner decision (2026-11-26", "ACCEPTED exposure", "did not block the open", "Let's require someone to be logged in", "TO BE VERIFIED on Windows, not proven"]) assert.ok(n.includes(fact), fact);
  const contributing = read("CONTRIBUTING.md");
  assert.ok(contributing.includes("private home desktop on WinSta0") && contributing.includes("which mode is used and the home desktop's station rule"));
  // no native file exists without a CONTRIBUTING entry
  for (const f of readdirSync(join(root, "native", "nn-launcher", "src"))) assert.ok(contributing.includes(`native/nn-launcher/src/${f}`), f);
});

test("the home desktop: the hosted de-elevated cross-check reports the mode and is a report, not a gate; the elevated steps still demand the named station", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const from = wf.indexOf("# the cross-check: the product launcher's info, de-elevated");
  assert.ok(from > 0);
  const block = wf.slice(from, wf.indexOf("          exit 0", from));
  for (const piece of ['"windowStation":"[^"]*"', '"privateStationError":"[^"]*"', `grep -q '"elevated":false'`, `grep -q '"windowStation":"home-desktop"'`, `grep -q '"windowStationOk":true'`, "::notice::de-elevated product info: windowStation home-desktop, windowStationOk true", "::warning::de-elevated product info did not report"]) assert.ok(block.includes(piece), piece);
  assert.ok(!/\bexit [1-9]|set -e|\|\| false/.test(block), "a report: nothing in the block can fail the step");
  assert.ok(wf.slice(from).includes("          exit 0"), "the step still ends with exit 0");
  // the two elevated steps keep demanding `private` (the named path is unchanged)
  assert.equal(wf.split(`grep -q '"windowStation":"private"'`).length - 1, 2);
});

test("the home desktop: `info` tries the home desktop through the same function as a run, and no code path inherits a desktop", () => {
  const w = read("native", "nn-launcher", "src", "win.rs");
  const report = w.slice(w.indexOf("fn report_private_station"), w.indexOf("fn run("));
  assert.ok(report.includes("privdesk::PrivateDesktop::create(sid, elevation())"), "info and check ask exactly what a run asks");
  const priv = read("native", "nn-launcher", "src", "privdesk.rs");
  assert.equal([...priv.matchAll(/CreateDesktopW\(/g)].length, 2, "the named desktop and the home desktop: the only two ways to a desktop");
  assert.ok(!/OpenInputDesktop|OpenDesktopW|GetThreadDesktop|SwitchDesktop/.test(priv));
  assert.ok(w.includes("home_needs_ui_limits(p.mode(), a.ui_limits)"));
});
