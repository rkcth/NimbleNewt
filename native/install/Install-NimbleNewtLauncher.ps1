<#
.SYNOPSIS
  The one-time administrator step for the NimbleNewt native Windows launcher (card A03b): install, uninstall or verify.

.DESCRIPTION
  TEXT ONLY UNTIL AN ADMINISTRATOR RUNS IT. This file has been read and checked by tests on Linux (native/install/README.md says which); it has NEVER been run on a Windows
  machine by the people who wrote it. Run it first with -WhatIf and read every line it prints.

  What it makes (and nothing else; Uninstall removes exactly this, from the manifest it wrote):
    1. A local standard user (default "nimblenewt-worker"): not an administrator, a long random password that is generated in memory, handed to Windows once and never stored,
       shown or written anywhere (the service runs without a password: see "Password" below), with the right to log on as a batch job and the rights to log on interactively,
       through Remote Desktop and over the network DENIED.
    2. "%ProgramFiles%\NimbleNewt\" holding nn-launcher.exe, writable only by SYSTEM and Administrators; the account may read and run it.
    3. "%ProgramData%\NimbleNewt\" (manifest and worker.env, written by an administrator; the account may read) and its sub-folder "native" (the supervisor's control folder, where
       the account writes its job records; nobody else has any access).
    4. worker.env: the four NIMBLENEWT_WIN_* names the worker reads (no secret in it).
  What it does NOT do: it does not register or start the worker (the service unit is the release's own step), it never touches a task, workspace or data folder of the product,
  it does not change a firewall, a policy other than the five account rights above, or any other account, and it does not need the network.

  Password. The account is used through a scheduled task that logs it on with S4U ("run whether the user is logged on or not", no password stored) or, later, a Windows service.
  No password is needed at run time, so none is kept: the generated one is held in memory while the account is made and then dropped. A virtual service account
  (NT SERVICE\NimbleNewtWorker, the preferred form: no password at all) needs a real Windows service to run in, and the product has no service host yet (the release launcher is a
  Task Scheduler entry); a group-managed service account needs a domain. So the account is a local user. If a service host is added, rerun this script with -ServiceLogon
  (adds the right to log on as a service) and see README.md.

.PARAMETER Action
  Verify (the default, read-only), Install, or Uninstall.
.PARAMETER LauncherPath
  Install only: the built nn-launcher.exe (see native/nn-launcher/RELEASE.md).
.PARAMETER ExpectedSha256
  Install only, required: the hash the release recorded for that file. The install stops if the file differs.
.PARAMETER AllowUnsigned
  Install only: accept a file whose Authenticode signature is not valid (a build from the hosted CI or your own machine). A release is signed; see native/nn-launcher/RELEASE.md.
.PARAMETER AccountName
  The local account name (default nimblenewt-worker).
.PARAMETER Container
  lpac (default, the measured configuration) or appcontainer (the plain fallback): written to worker.env.
.PARAMETER ServiceLogon
  Also grant "log on as a service" (only for a future service host; a scheduled task does not need it).
.PARAMETER InstallDir
  Default %ProgramFiles%\NimbleNewt.
.PARAMETER DataDir
  Default %ProgramData%\NimbleNewt.
.EXAMPLE
  .\Install-NimbleNewtLauncher.ps1 -Action Install -LauncherPath .\nn-launcher.exe -ExpectedSha256 <hash> -WhatIf
.EXAMPLE
  .\Install-NimbleNewtLauncher.ps1 -Action Verify
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateSet('Verify', 'Install', 'Uninstall')] [string] $Action = 'Verify',
  [string] $LauncherPath,
  [ValidatePattern('^[0-9a-fA-F]{64}$')] [string] $ExpectedSha256,
  [switch] $AllowUnsigned,
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{0,19}$')] [string] $AccountName = 'nimblenewt-worker',
  [ValidateSet('lpac', 'appcontainer')] [string] $Container = 'lpac',
  [ValidatePattern('^[A-Za-z][A-Za-z0-9]{0,63}$')] [string] $ProfileName = 'NimbleNewtAgent',
  [switch] $ServiceLogon,
  [string] $InstallDir = (Join-Path $env:ProgramFiles 'NimbleNewt'),
  [string] $DataDir = (Join-Path $env:ProgramData 'NimbleNewt')
)
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# ---- fixed names -------------------------------------------------------------------------------------------------------------------------------------------------------
$ExeName = 'nn-launcher.exe'
$ControlDir = Join-Path $DataDir 'native'
$ManifestPath = Join-Path $DataDir 'install-manifest.json'
$EnvFile = Join-Path $DataDir 'worker.env'
$AccountMarker = 'NimbleNewt native launcher account (made by Install-NimbleNewtLauncher.ps1; no interactive logon)'
# Well-known SIDs, not names: the names change with the Windows language.
$SidSystem = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
$SidAdmins = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'
# The account rights this script may touch. Nothing else is ever added or removed.
$RightsGranted = @('SeBatchLogonRight') + $(if ($ServiceLogon) { @('SeServiceLogonRight') } else { @() })
$RightsDenied = @('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')
$RightsAll = @('SeBatchLogonRight', 'SeServiceLogonRight') + $RightsDenied

function Say([string] $text) { Write-Host $text }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Assert-Admin { if (-not (Test-Admin)) { throw "$Action needs an elevated (administrator) PowerShell. Nothing was changed." } }
function Test-Reparse([string] $path) { (Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint }

# ---- the local security policy (account rights) through the LSA API; no tool to install ---------------------------------------------------------------------------------
if (-not ('NnLsa' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NnLsa {
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr Root; public IntPtr Name; public int Attributes; public IntPtr Descriptor; public IntPtr Quality; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct UnicodeString { public ushort Length; public ushort MaximumLength; public string Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeStringOut { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref ObjectAttributes attrs, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, UnicodeString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, UnicodeString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  // POLICY_LOOKUP_NAMES (0x800) | POLICY_CREATE_ACCOUNT (0x10): the least access that reads and changes one account's rights.
  const uint Access = 0x810;
  static IntPtr Open() {
    var a = new ObjectAttributes(); a.Length = Marshal.SizeOf(typeof(ObjectAttributes)); IntPtr p;
    uint s = LsaOpenPolicy(IntPtr.Zero, ref a, Access, out p);
    if (s != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s));
    return p;
  }
  static UnicodeString[] Strings(string[] names) {
    var r = new UnicodeString[names.Length];
    for (int i = 0; i < names.Length; i++) { r[i].Buffer = names[i]; r[i].Length = (ushort)(names[i].Length * 2); r[i].MaximumLength = (ushort)(names[i].Length * 2 + 2); }
    return r;
  }
  static byte[] Bytes(string sid) { var s = new System.Security.Principal.SecurityIdentifier(sid); var b = new byte[s.BinaryLength]; s.GetBinaryForm(b, 0); return b; }
  public static void Add(string sid, string[] rights) {
    IntPtr p = Open();
    try { uint s = LsaAddAccountRights(p, Bytes(sid), Strings(rights), (uint)rights.Length); if (s != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s)); } finally { LsaClose(p); }
  }
  public static void Remove(string sid, string[] rights) {
    IntPtr p = Open();
    try {
      uint s = LsaRemoveAccountRights(p, Bytes(sid), false, Strings(rights), (uint)rights.Length);
      if (s != 0 && s != 0xC0000034) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s)); // not found: it was not there
    } finally { LsaClose(p); }
  }
  public static void RemoveAll(string sid) {
    IntPtr p = Open();
    try { uint s = LsaRemoveAccountRights(p, Bytes(sid), true, null, 0); if (s != 0 && s != 0xC0000034) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s)); } finally { LsaClose(p); }
  }
  public static string[] List(string sid) {
    IntPtr p = Open();
    try {
      IntPtr buf; uint count; uint s = LsaEnumerateAccountRights(p, Bytes(sid), out buf, out count);
      if (s == 0xC0000034) return new string[0];
      if (s != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s));
      var list = new List<string>();
      for (uint i = 0; i < count; i++) {
        var u = (UnicodeStringOut)Marshal.PtrToStructure(IntPtr.Add(buf, (int)(i * (uint)Marshal.SizeOf(typeof(UnicodeStringOut)))), typeof(UnicodeStringOut));
        list.Add(Marshal.PtrToStringUni(u.Buffer, u.Length / 2));
      }
      LsaFreeMemory(buf);
      return list.ToArray();
    } finally { LsaClose(p); }
  }
}
'@
}

# ---- access lists ------------------------------------------------------------------------------------------------------------------------------------------------------
# Every access-list line below carries its reason ("why"), and Verify prints the same table. An entry is allow-only. Inheritance from the parent folder is switched OFF (the parent's
# defaults, for example "Users may create and read" in %ProgramData%, must not apply), the owner is set to Administrators, and the entry list is replaced as a whole, so a rerun
# repairs a drifted list and never adds to it.
function New-AclPlan([System.Security.Principal.SecurityIdentifier] $account) {
  @(
    @{ Path = $InstallDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Why = 'SYSTEM maintains the machine; it is not the account the launcher runs as' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Why = 'only administrators may replace the launcher (this is what makes the folder admin-only-writable)' },
        @{ Who = $account; Rights = 'ReadAndExecute'; Why = 'the service account must run nn-launcher.exe; read and execute, never write or delete, so it cannot replace its own launcher' }) },
    @{ Path = $DataDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Why = 'SYSTEM maintains the machine' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Why = 'administrators write the manifest and worker.env' },
        @{ Who = $account; Rights = 'ReadAndExecute'; Why = 'the account reads worker.env and walks down to its control folder; read only, so it cannot change its own settings' }) },
    @{ Path = $ControlDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Why = 'SYSTEM maintains the machine' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Why = 'administrators can inspect and clear leftovers' },
        @{ Who = $account; Rights = 'Modify'; Why = 'the supervisor writes job records here and removes them; Modify is not FullControl: it cannot change this list or take ownership. No container is ever granted this folder') })
  )
}
function Set-ProtectedAcl([string] $path, $rules) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)            # no inheritance from the parent, and none of the parent's entries copied
  $acl.SetOwner($SidAdmins)
  foreach ($r in $rules) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($r.Who, [System.Security.AccessControl.FileSystemRights]$r.Rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
function Assert-SafeFolder([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  # %ProgramData% lets any user make a folder. A pre-made folder, a link or a junction under our name must never be adopted.
  if (Test-Reparse $path) { throw "$path is a link or junction; remove it (as an administrator) and run again. Nothing was changed." }
  $owner = (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier])
  $trusted = @($SidSystem.Value, $SidAdmins.Value, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # SYSTEM, Administrators, TrustedInstaller
  if ((-not (Test-Path -LiteralPath $ManifestPath)) -and ($trusted -notcontains $owner.Value)) { throw "$path already exists and is owned by $($owner.Value), not by an administrator. Remove it or choose another -DataDir/-InstallDir. Nothing was changed." }
}

# ---- Verify ------------------------------------------------------------------------------------------------------------------------------------------------------------
function Invoke-Verify {
  $script:bad = 0
  function Check([bool] $ok, [string] $what) { if ($ok) { Say "  PASS  $what" } else { Say "  FAIL  $what"; $script:bad++ } }
  Say "NimbleNewt native launcher: what is set on this machine ($(Get-Date -Format s))"
  $user = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  Say "Account '$AccountName':"
  Check ($null -ne $user) 'the account exists'
  $sid = $null
  if ($null -ne $user) {
    $sid = $user.SID
    Say "  sid $($user.SID.Value); enabled $($user.Enabled); password never expires $($user.PasswordNeverExpires); description: $($user.Description)"
    Check ($user.Description -eq $AccountMarker) 'it is the account this script made (marker in its description)'
    $groups = @(Get-LocalGroup | Where-Object { (Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }) } | ForEach-Object { $_.Name })
    Say "  member of: $($groups -join ', ')"
    Check ($groups.Count -eq 1 -and (Get-LocalGroup -SID $SidUsers).Name -eq $groups[0]) 'it is a member of Users only (not Administrators, not any other group)'
    if (Test-Admin) {
      $rights = [NnLsa]::List($user.SID.Value)
      Say "  account rights: $($rights -join ', ')"
      Check ($rights -contains 'SeBatchLogonRight') 'it may log on as a batch job'
      foreach ($d in $RightsDenied) { Check ($rights -contains $d) "$d is denied" }
      Check (@($rights | Where-Object { $RightsAll -notcontains $_ }).Count -eq 0) 'it holds no right other than the ones this script manages'
    } else { Say '  account rights: not readable without administrator rights (run Verify elevated for this part)' }
  }
  Say 'Files and access lists (owner, inheritance, then each entry with its reason):'
  $plan = if ($null -ne $sid) { New-AclPlan $sid } else { @() }
  foreach ($item in $plan) {
    if (-not (Test-Path -LiteralPath $item.Path)) { Check $false "$($item.Path) exists"; continue }
    $acl = Get-Acl -LiteralPath $item.Path
    Say "  $($item.Path)   owner $($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)   inherited entries: $(-not $acl.AreAccessRulesProtected)"
    foreach ($a in $acl.Access) { Say "      $($a.AccessControlType) $($a.IdentityReference.Value) $($a.FileSystemRights)" }
    foreach ($r in $item.Rules) { Say "      expected: $($r.Who.Value) $($r.Rights): $($r.Why)" }
    Check ($acl.AreAccessRulesProtected) "$($item.Path): inheritance is off"
    Check ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $SidAdmins) "$($item.Path): owned by Administrators"
    $expected = @($item.Rules | ForEach-Object { "$($_.Who.Value)|$([int][System.Security.AccessControl.FileSystemRights]$_.Rights)" })
    $actual = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.IdentityReference.Value)|$([int]$_.FileSystemRights)" })
    Check ((@($expected | Where-Object { $actual -notcontains $_ }).Count -eq 0) -and (@($actual | Where-Object { $expected -notcontains $_ }).Count -eq 0)) "$($item.Path): the entry list is exactly the expected one"
  }
  $exe = Join-Path $InstallDir $ExeName
  if (Test-Path -LiteralPath $exe) {
    $sig = Get-AuthenticodeSignature -LiteralPath $exe
    Say "Launcher: $exe  sha256 $((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash)  signature $($sig.Status)"
    Check (-not (Test-Reparse $exe)) 'the launcher is a plain file, not a link'
  } else { Check $false "$exe exists" }
  if (Test-Path -LiteralPath $ManifestPath) { Say "Manifest ($ManifestPath):"; Get-Content -LiteralPath $ManifestPath | ForEach-Object { Say "  $_" } } else { Check $false 'the install manifest exists' }
  if (Test-Path -LiteralPath $EnvFile) { Say "Worker environment file ($EnvFile; no secret in it):"; Get-Content -LiteralPath $EnvFile | ForEach-Object { Say "  $_" } } else { Check $false 'worker.env exists' }
  Say "How the service gets these: start the worker with 'node --env-file=$EnvFile ...' (the release's service unit names this file); with the default folders the worker finds the same values without it."
  Say $(if ($script:bad -eq 0) { 'RESULT: everything this script manages is as designed.' } else { "RESULT: $($script:bad) check(s) failed (see FAIL lines)." })
  if ($script:bad -gt 0) { exit 1 }
}

# ---- Install -----------------------------------------------------------------------------------------------------------------------------------------------------------
function New-RandomSecureString {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  $secure = New-Object System.Security.SecureString
  foreach ($c in ([Convert]::ToBase64String($bytes) + 'aA1!').ToCharArray()) { $secure.AppendChar($c) }  # base64 plus one of each class: always meets a complexity rule
  [Array]::Clear($bytes, 0, $bytes.Length)
  $secure.MakeReadOnly()
  return $secure
}
function Invoke-Install {
  Assert-Admin
  if (-not $LauncherPath -or -not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) { throw '-LauncherPath must name the built nn-launcher.exe.' }
  if (-not $ExpectedSha256) { throw '-ExpectedSha256 is required: the hash recorded by the release (native/nn-launcher/RELEASE.md).' }
  if (Test-Reparse $LauncherPath) { throw '-LauncherPath is a link; name the file itself.' }
  $hash = (Get-FileHash -LiteralPath $LauncherPath -Algorithm SHA256).Hash
  if ($hash -ne $ExpectedSha256.ToUpperInvariant()) { throw "The file's SHA-256 is $hash, not the expected $ExpectedSha256. Nothing was changed." }
  $sig = Get-AuthenticodeSignature -LiteralPath $LauncherPath
  if ($sig.Status -ne 'Valid') {
    if (-not $AllowUnsigned) { throw "The launcher's Authenticode signature is '$($sig.Status)'. A release is signed. For a build of your own or from the hosted CI, add -AllowUnsigned (and understand what you are installing). Nothing was changed." }
    Say "WARNING: installing an UNSIGNED launcher (-AllowUnsigned): its identity rests on the SHA-256 you gave."
  }
  foreach ($d in @($InstallDir, $DataDir)) { Assert-SafeFolder $d }
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($null -ne $existing -and $existing.Description -ne $AccountMarker) { throw "A user named '$AccountName' exists that this script did not make. Choose another -AccountName. Nothing was changed." }

  # 1. The account.
  if ($null -eq $existing) {
    if ($PSCmdlet.ShouldProcess($AccountName, 'create a local standard user (random password held in memory only, never stored; no admin rights)')) {
      New-LocalUser -Name $AccountName -Password (New-RandomSecureString) -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description $AccountMarker | Out-Null
      Add-LocalGroupMember -SID $SidUsers -Member $AccountName   # Users: so it can read Node and the system folders; NOT Administrators
    }
  }
  $sid = if ($WhatIfPreference -and $null -eq $existing) { New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-21-0-0-0-1000' } else { (Get-LocalUser -Name $AccountName).SID }
  # 2. The account rights (only these; Verify lists them).
  if ($PSCmdlet.ShouldProcess($AccountName, "grant $($RightsGranted -join ', ') and deny $($RightsDenied -join ', ')")) {
    [NnLsa]::Add($sid.Value, $RightsGranted + $RightsDenied)
    if (-not $ServiceLogon) { [NnLsa]::Remove($sid.Value, @('SeServiceLogonRight')) }
  }
  # 3. Folders: made empty with the protected list in place BEFORE anything is copied in, so there is no moment when a default list applies.
  $plan = New-AclPlan $sid
  foreach ($item in $plan) {
    if ($PSCmdlet.ShouldProcess($item.Path, 'create (if absent) and set a protected access list: ' + (($item.Rules | ForEach-Object { "$($_.Who.Value) $($_.Rights)" }) -join '; '))) {
      if (-not (Test-Path -LiteralPath $item.Path)) { New-Item -ItemType Directory -Path $item.Path | Out-Null }
      Set-ProtectedAcl $item.Path $item.Rules
    }
  }
  # 4. The launcher: copied only when it differs, then re-hashed at its place.
  $target = Join-Path $InstallDir $ExeName
  if ($PSCmdlet.ShouldProcess($target, 'place nn-launcher.exe')) {
    if (-not (Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { Copy-Item -LiteralPath $LauncherPath -Destination $target -Force }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { throw 'The placed launcher does not match the expected hash.' }
  }
  # 5. worker.env and the manifest: paths and names only. No password, token or key exists anywhere in this script, so none can be written.
  if ($PSCmdlet.ShouldProcess($EnvFile, 'write the four NIMBLENEWT_WIN_* names')) {
    foreach ($v in @($target, $ControlDir, $Container, $ProfileName)) { if ($v -match '[\r\n"=]') { throw "a value for worker.env has a character that is not allowed: $v" } }
    $lines = @("NIMBLENEWT_WIN_LAUNCHER=$target", "NIMBLENEWT_WIN_CONTROL_DIR=$ControlDir", "NIMBLENEWT_WIN_CONTAINER=$Container", "NIMBLENEWT_WIN_PROFILE=$ProfileName")
    Set-Content -LiteralPath $EnvFile -Value $lines -Encoding ascii
    $manifest = [ordered]@{ schema = 'nimblenewt.native-install/1'; installedAt = (Get-Date).ToUniversalTime().ToString('o'); account = $AccountName; accountSid = $sid.Value; installDir = $InstallDir; dataDir = $DataDir
      controlDir = $ControlDir; launcher = $target; launcherSha256 = $hash; signature = [string]$sig.Status; rightsGranted = $RightsGranted; rightsDenied = $RightsDenied; madeFolders = @($InstallDir, $DataDir) }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $ManifestPath -Encoding ascii
  }
  Say 'Install finished. Run -Action Verify (elevated) to print what was set.'
}

# ---- Uninstall ---------------------------------------------------------------------------------------------------------------------------------------------------------
function Invoke-Uninstall {
  Assert-Admin
  if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "No manifest at $ManifestPath: this script did not make what is here, so it removes nothing. Nothing was changed." }
  $m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($m.schema -ne 'nimblenewt.native-install/1') { throw 'The manifest is not one this script wrote.' }
  # Only paths the manifest names AND that sit where this script would have put them are removed (a hand-edited manifest cannot aim the delete elsewhere).
  foreach ($p in @($m.installDir, $m.dataDir)) {
    if ((Split-Path -Leaf $p) -ne 'NimbleNewt' -or (Test-Reparse $p)) { throw "The manifest names $p, which is not a NimbleNewt folder this script made. Nothing was changed." }
  }
  $running = Get-Process -Name 'nn-launcher' -ErrorAction SilentlyContinue
  if ($running) { throw 'nn-launcher.exe is running (a job is in progress). Stop the worker first. Nothing was changed.' }
  if ($PSCmdlet.ShouldProcess($m.dataDir, 'remove the control folder, worker.env, the manifest and the data folder')) {
    foreach ($p in @($m.dataDir, $m.installDir)) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
  }
  $user = Get-LocalUser -Name $m.account -ErrorAction SilentlyContinue
  if ($null -ne $user) {
    if ($user.Description -ne $AccountMarker -or $user.SID.Value -ne $m.accountSid) { throw "The user '$($m.account)' is not the one this script made. It was left alone; the folders above were removed." }
    if ($PSCmdlet.ShouldProcess($m.account, 'remove every account right it holds, delete its profile (and with it the AppContainer profile it made), and delete the user')) {
      [NnLsa]::RemoveAll($user.SID.Value)
      Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value } | Remove-CimInstance
      Remove-LocalUser -SID $user.SID
    }
  }
  Say 'Uninstall finished. Run -Action Verify to see that nothing is left (it will say the account and folders are missing).'
}

switch ($Action) {
  'Verify' { Invoke-Verify }
  'Install' { Invoke-Install }
  'Uninstall' { Invoke-Uninstall }
}
