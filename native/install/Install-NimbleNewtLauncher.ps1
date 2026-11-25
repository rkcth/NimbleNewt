<#
.SYNOPSIS
  The one-time administrator step for the NimbleNewt native Windows launcher (card A03b): install, uninstall or verify.

.DESCRIPTION
  TEXT ONLY UNTIL AN ADMINISTRATOR RUNS IT. This file has been read and checked by tests on Linux (native/install/README.md says which); it has NEVER been run on a Windows
  machine by the people who wrote it. Run it first with -WhatIf and read every line it prints.

  What it makes (and nothing else; Uninstall removes exactly this, and only when the manifest it wrote names the same folders as the run of Uninstall):
    1. A local standard user (default "nimblenewt-worker"): not an administrator, a long random password that is generated in memory, handed to Windows once and never stored,
       shown or written anywhere (the service runs without a password: see "Password" below), with the right to log on as a batch job and the rights to log on interactively,
       through Remote Desktop and over the network DENIED.
    2. "%ProgramFiles%\NimbleNewt\" holding nn-launcher.exe, writable only by SYSTEM and Administrators; the account may read and run it.
    3. "%ProgramData%\NimbleNewt\" (manifest and worker.env, written by an administrator; the account may read) and its sub-folder "native" (the supervisor's control folder, where
       the account writes its job records and may delete them, but may not delete or rename the folder itself; no other user has any access).
    4. worker.env: the four NIMBLENEWT_WIN_* names the worker reads (no secret in it).
  What it does NOT do: it does not register or start the worker (the worker's task unit is the release's own step, run by an administrator; Verify only reads that task if it exists), it never touches a task (other than reading the worker task in Verify), workspace or data folder of the product,
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
  Default %ProgramFiles%\NimbleNewt. Must be a full local path (drive letter) whose last part is NimbleNewt.
.PARAMETER DataDir
  Default %ProgramData%\NimbleNewt. The same rule.
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
# The scheduled task of the worker: registered by an administrator from the release's unit text (generateWorkerServiceUnit); this script only reads it in Verify.
$WorkerTaskName = 'NimbleNewtWorker'
# New-LocalUser refuses a description longer than 48 characters, so the marker is short (a test pins the length).
$AccountMarker = 'NimbleNewt launcher account (installer-made)'
# Well-known SIDs, not names: the names change with the Windows language.
$SidSystem = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
$SidAdmins = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'
# The account rights this script may touch. Nothing else is ever added or removed.
$RightsGranted = @('SeBatchLogonRight') + $(if ($ServiceLogon) { @('SeServiceLogonRight') } else { @() })
$RightsDenied = @('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')
$RightsAll = @('SeBatchLogonRight', 'SeServiceLogonRight') + $RightsDenied
# Owners an existing folder or file under our names may have (SYSTEM, Administrators, TrustedInstaller). Anything else was made by someone else and is never adopted.
# The administrator running this script is trusted too: with the policy "default owner: object creator" the files it writes are owned by that user, not by the Administrators group.
$TrustedOwners = @($SidSystem.Value, $SidAdmins.Value, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$SynchronizeBit = 0x100000   # .NET adds SYNCHRONIZE to every allow entry it writes, so a read-back carries it; both sides of a comparison are normalised with it

function Say([string] $text) { Write-Host $text }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# WHAT-IF SAFETY (found by the first real run on Windows PowerShell 5.1, elevated, StrictMode 3: with -WhatIf the script's own file-hash cmdlet printed 'What if: Performing the operation
# "Retrieve the value for property 'ProviderPath'"' and returned nothing, and '.Hash' then failed). -WhatIf sets $WhatIfPreference for EVERYTHING the script calls, including the cmdlets
# written in PowerShell inside Windows PowerShell 5.1, which can honour it in their own internals. A read must never be silenced, so every read-only cmdlet whose result the script
# looks at runs through Invoke-Read (it sets $WhatIfPreference to $false inside its own scope only), and the file hash is computed with .NET alone (Get-Sha256Hex). Everything that
# changes the machine stays inside $PSCmdlet.ShouldProcess, so -WhatIf still changes nothing.
function Invoke-Read([scriptblock] $Block) { $WhatIfPreference = $false; & $Block }
# STRICT-MODE SAFETY (found by the first real Verify on Windows PowerShell 5.1 after a real Install, StrictMode 3: 'The property 'PasswordNeverExpires' cannot be found on this object'; that name is a
# PARAMETER of New-LocalUser, not a property of the object Get-LocalUser returns). Under StrictMode 3 reading a property an object does not have throws, and so does reading a member of $null.
# Get-Prop reads a property that may be absent (an optional property, an object from a file, one of several action types) and returns $null when the object or the property is not there.
# Properties that the documentation guarantees on the cmdlet's object (LocalUser: Name, SID, Enabled, Description, PasswordExpires, ...) are read directly; a test pins every such name.
function Get-Prop($Object, [string] $Name) {
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}
# The SHA-256 of a file as upper-case hex, with .NET only (no cmdlet can honour -WhatIf). A relative path is resolved against the PowerShell location, as the cmdlets would.
function Get-Sha256Hex([string] $Path) {
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead($full)
    $bytes = $sha.ComputeHash($stream)
    return (($bytes | ForEach-Object { $_.ToString('X2') }) -join '')
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}
function Assert-Admin { if (-not (Test-Admin)) { throw "$Action needs an elevated (administrator) PowerShell. Nothing was changed." } }
# The attributes of the item itself, or $null when nothing has that name. A link or junction is NOT followed (GetFileAttributes reports the link), so a dangling link counts as
# present; Test-Path and Get-Item follow links on Windows PowerShell 5.1 and would call it absent. Any other failure (access denied, a bad name) is thrown: fail closed.
function Get-ItemAttributes([string] $path) {
  try { return [System.IO.File]::GetAttributes($path) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return $null }
}
function Test-Present([string] $path) { $null -ne (Get-ItemAttributes $path) }
function Test-Reparse([string] $path) { $attrs = Get-ItemAttributes $path; ($null -ne $attrs) -and (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
function Test-FolderItem([string] $path) { (((Get-ItemAttributes $path) -band [IO.FileAttributes]::Directory) -ne 0) }
function Test-SamePath([string] $a, [string] $b) { (-not [string]::IsNullOrEmpty($a)) -and (-not [string]::IsNullOrEmpty($b)) -and ([IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\')) }
function Assert-NimbleNewtPath([string] $path, [string] $what) {
  # A full local path, already normal (no "..", no relative part, no share), ending in \NimbleNewt: the only shape Install makes and Uninstall removes.
  # Printable ASCII only (worker.env is written as ASCII) and no # ' ` = (node --env-file cuts an unquoted value at #): checked here, before anything is changed.
  if ($path -notmatch '^[\x20-\x7E]+$' -or $path -notmatch '^[A-Za-z]:\\[^:*?"<>|#''`=]+$' -or $path.TrimEnd('\') -ne [IO.Path]::GetFullPath($path).TrimEnd('\') -or (Split-Path -Leaf $path.TrimEnd('\')) -ne 'NimbleNewt') {
    throw "$what must be a full local path ending in \NimbleNewt, in printable ASCII without # ' `` = (it is '$path'). Nothing was changed."
  }
}

# ---- the local security policy (account rights) through the LSA API; no tool to install ---------------------------------------------------------------------------------
# Compiled only right before the first LSA call (Install and Uninstall inside their ShouldProcess question, Verify when elevated): a -WhatIf run compiles nothing.
function Initialize-NnLsa {
  if ('NnLsa' -as [type]) { return }
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
  // POLICY_LOOKUP_NAMES (0x800) | POLICY_CREATE_ACCOUNT (0x10): the least access that changes one account's rights; reading them (List, used by Verify) asks POLICY_LOOKUP_NAMES only.
  const uint ChangeAccess = 0x810;
  const uint ReadAccess = 0x800;
  static IntPtr Open() { return Open(ChangeAccess); }
  static IntPtr Open(uint access) {
    var a = new ObjectAttributes(); a.Length = Marshal.SizeOf(typeof(ObjectAttributes)); IntPtr p;
    uint s = LsaOpenPolicy(IntPtr.Zero, ref a, access, out p);
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
    IntPtr p = Open(ReadAccess);
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
# repairs a drifted list and never adds to it. Scope: All (the folder and everything in it), Folder (the folder itself only), Below (only what is inside it, not the folder).
function New-AclPlan([System.Security.Principal.SecurityIdentifier] $account) {
  @(
    @{ Path = $InstallDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Scope = 'All'; Why = 'SYSTEM maintains the machine; it is not the account the launcher runs as' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Scope = 'All'; Why = 'only administrators may replace the launcher (this is what makes the folder admin-only-writable)' },
        @{ Who = $account; Rights = 'ReadAndExecute'; Scope = 'All'; Why = 'the service account must run nn-launcher.exe; read and execute, never write or delete, so it cannot replace its own launcher' }) },
    @{ Path = $DataDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Scope = 'All'; Why = 'SYSTEM maintains the machine' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Scope = 'All'; Why = 'administrators write the manifest and worker.env' },
        @{ Who = $account; Rights = 'ReadAndExecute'; Scope = 'All'; Why = 'the account reads worker.env and walks down to its control folder; read only, so it cannot change its own settings' }) },
    @{ Path = $ControlDir; Rules = @(
        @{ Who = $SidSystem; Rights = 'FullControl'; Scope = 'All'; Why = 'SYSTEM maintains the machine' },
        @{ Who = $SidAdmins; Rights = 'FullControl'; Scope = 'All'; Why = 'administrators can inspect and clear leftovers' },
        @{ Who = $account; Rights = 'ReadAndExecute, Write'; Scope = 'Folder'; Why = 'the supervisor lists the folder and makes its job records in it; no Delete on the folder itself, so the account cannot remove it' },
        @{ Who = $account; Rights = 'Modify'; Scope = 'Below'; Why = 'the supervisor writes and removes its own job records; Modify is not FullControl: it cannot change this list or take ownership. No container is ever granted this folder' }) }
  )
}
function Get-Inheritance([string] $scope) {
  switch ($scope) {
    'All' { return @('ContainerInherit, ObjectInherit', 'None') }
    'Folder' { return @('None', 'None') }
    'Below' { return @('ContainerInherit, ObjectInherit', 'InheritOnly') }
    default { throw "unknown access-list scope '$scope'" }
  }
}
function New-ProtectedSecurity($rules) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)            # no inheritance from the parent, and none of the parent's entries copied
  $acl.SetOwner($SidAdmins)
  foreach ($r in $rules) {
    $flags = Get-Inheritance $r.Scope
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($r.Who, [System.Security.AccessControl.FileSystemRights]$r.Rights, [System.Security.AccessControl.InheritanceFlags]$flags[0], [System.Security.AccessControl.PropagationFlags]$flags[1], 'Allow')
    $acl.AddAccessRule($rule)
  }
  return $acl
}
function Assert-SafeItem([string] $path, [bool] $folder) {
  if (-not (Test-Present $path)) { return }
  # %ProgramData% lets any user make a folder. A pre-made folder or file, a link or a junction (also a dangling one) under our names must never be adopted (the owner of a thing keeps the
  # right to change its list).
  if (Test-Reparse $path) { throw "$path is a link or junction; remove it (as an administrator) and run again. Nothing more was changed." }
  if ((Test-FolderItem $path) -ne $folder) { throw "$path exists but is not a $(if ($folder) { 'folder' } else { 'file' }). Nothing more was changed." }
  $acl = Invoke-Read { Get-Acl -LiteralPath $path }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($TrustedOwners -notcontains $owner.Value) { throw "$path already exists and is owned by $($owner.Value), not by an administrator. Remove it or choose another -DataDir/-InstallDir. Nothing more was changed." }
  # A folder this script made never inherits its parent's list. One that does was made by someone else (for example an administrator by hand in %ProgramData%), and while it carried the
  # parent's "Users may create" any user could have put a file or a hard link under one of our names in it (a hard link is no reparse point and has its target's owner).
  if ($folder -and -not $acl.AreAccessRulesProtected) { throw "$path already exists with the access list of its parent folder, so this script did not make it and other users may have written in it. Remove it (as an administrator) and run again. Nothing more was changed." }
}
# Makes the folder WITH its protected list in one call when it is absent (no moment with the parent's default list), then checks what is there and writes the list as a whole. If someone
# else made the folder first (a race in %ProgramData%), the check after the call sees their ownership or their link and stops.
function Set-ProtectedAcl([string] $path, $rules) {
  $security = New-ProtectedSecurity $rules
  if (-not (Test-Present $path)) {
    if ($null -ne [System.IO.Directory].GetMethod('CreateDirectory', [type[]]@([string], [System.Security.AccessControl.DirectorySecurity]))) { [void][System.IO.Directory]::CreateDirectory($path, $security) }   # Windows PowerShell 5.1
    else { [void][System.IO.FileSystemAclExtensions]::Create((New-Object System.IO.DirectoryInfo $path), $security) }                                                                                         # PowerShell 7
  }
  Assert-SafeItem $path $true
  Set-Acl -LiteralPath $path -AclObject $security
  if (Test-Reparse $path) { throw "$path became a link while its access list was set. Stop and inspect it." }
}
# Removes a folder tree WITHOUT following any link or junction in it: a link is removed as the link itself, never what it points to (Windows PowerShell 5.1's Remove-Item -Recurse follows
# directory links, and the account can make a junction in its control folder).
function Remove-TreeNoFollow([string] $path) {
  if (-not (Test-Present $path)) { return }
  $isFolder = Test-FolderItem $path
  if (Test-Reparse $path) {
    if ($isFolder) { [System.IO.Directory]::Delete($path, $false) } else { [System.IO.File]::Delete($path) }
    return
  }
  if ($isFolder) {
    foreach ($child in @(Invoke-Read { Get-ChildItem -LiteralPath $path -Force })) { Remove-TreeNoFollow $child.FullName }
    [System.IO.File]::SetAttributes($path, [IO.FileAttributes]::Directory)
    [System.IO.Directory]::Delete($path, $false)
  } else {
    [System.IO.File]::SetAttributes($path, [IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($path)
  }
}

# ---- Verify ------------------------------------------------------------------------------------------------------------------------------------------------------------
function Invoke-Verify {
  $script:bad = 0
  function Check([bool] $ok, [string] $what) { if ($ok) { Say "  PASS  $what" } else { Say "  FAIL  $what"; $script:bad++ } }
  Say "NimbleNewt native launcher: what is set on this machine ($(Get-Date -Format s))"
  $user = Invoke-Read { Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue }
  Say "Account '$AccountName':"
  Check ($null -ne $user) 'the account exists'
  $sid = $null
  if ($null -ne $user) {
    $sid = $user.SID
    # Get-LocalUser has no PasswordNeverExpires property (that is a parameter of the cmdlet that creates a user). Creating the user with that switch (what Install does) leaves PasswordExpires empty ($null), so "never" is printed when it is empty.
    # Informational only (not PASS/FAIL): the README does not make this a requirement, and a policy applied later by an administrator is not this script's fault.
    $expires = $user.PasswordExpires
    Say "  sid $($user.SID.Value); enabled $($user.Enabled); password expires: $(if ($null -eq $expires) { 'never' } else { $expires }); description: $($user.Description)"
    Check ($user.Description -eq $AccountMarker) 'it is the account this script made (marker in its description)'
    $groups = @(Invoke-Read { Get-LocalGroup | Where-Object { (Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }) } | ForEach-Object { $_.Name } })
    Say "  member of: $($groups -join ', ')"
    Check ($groups.Count -eq 1 -and (Get-Prop (Invoke-Read { Get-LocalGroup -SID $SidUsers }) 'Name') -eq $groups[0]) 'it is a member of Users only (not Administrators, not any other group)'
    if (Test-Admin) {
      Initialize-NnLsa
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
    if (-not (Invoke-Read { Test-Path -LiteralPath $item.Path })) { Check $false "$($item.Path) exists"; continue }
    try { $acl = Invoke-Read { Get-Acl -LiteralPath $item.Path } } catch { Check $false "$($item.Path): its access list is readable (run Verify elevated: only administrators may read it)"; continue }
    Say "  $($item.Path)   owner $($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)   inherited entries: $(-not $acl.AreAccessRulesProtected)"
    foreach ($a in $acl.Access) { Say "      $($a.AccessControlType) $($a.IdentityReference.Value) $($a.FileSystemRights)" }
    foreach ($r in $item.Rules) { Say "      expected: $($r.Who.Value) $($r.Rights) ($($r.Scope)): $($r.Why)" }
    Check ($acl.AreAccessRulesProtected) "$($item.Path): inheritance is off"
    Check ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $SidAdmins) "$($item.Path): owned by Administrators"
    # who | rights (with SYNCHRONIZE, which .NET adds to every allow entry) | inheritance | propagation | allow
    $expected = @($item.Rules | ForEach-Object { $f = Get-Inheritance $_.Scope; "$($_.Who.Value)|$(([int][System.Security.AccessControl.FileSystemRights]$_.Rights) -bor $SynchronizeBit)|$([int][System.Security.AccessControl.InheritanceFlags]$f[0])|$([int][System.Security.AccessControl.PropagationFlags]$f[1])|Allow" })
    $actual = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.IdentityReference.Value)|$(([int]$_.FileSystemRights) -bor $SynchronizeBit)|$([int]$_.InheritanceFlags)|$([int]$_.PropagationFlags)|$($_.AccessControlType)" })
    Check ((@($expected | Where-Object { $actual -notcontains $_ }).Count -eq 0) -and (@($actual | Where-Object { $expected -notcontains $_ }).Count -eq 0)) "$($item.Path): the entry list is exactly the expected one"
  }
  $exe = Join-Path $InstallDir $ExeName
  if (Invoke-Read { Test-Path -LiteralPath $exe }) {
    $sig = Invoke-Read { Get-AuthenticodeSignature -LiteralPath $exe }
    Say "Launcher: $exe  sha256 $(Get-Sha256Hex $exe)  signature $($sig.Status)"
    Check (-not (Test-Reparse $exe)) 'the launcher is a plain file, not a link'
  } else { Check $false "$exe exists" }
  if (Invoke-Read { Test-Path -LiteralPath $ManifestPath }) { Say "Manifest ($ManifestPath):"; Invoke-Read { Get-Content -LiteralPath $ManifestPath } | ForEach-Object { Say "  $_" } } else { Check $false 'the install manifest exists' }
  if (Invoke-Read { Test-Path -LiteralPath $EnvFile }) { Say "Worker environment file ($EnvFile; no secret in it):"; Invoke-Read { Get-Content -LiteralPath $EnvFile } | ForEach-Object { Say "  $_" } } else { Check $false 'worker.env exists' }
  Say "How the service gets these: start the worker with 'node --env-file=$EnvFile ...' (the worker's task unit names this file); with the default folders the worker finds the same values without it."
  # The worker's scheduled task is registered by an administrator, never by this script. If it exists, report (read only) who it runs as, how it logs on and what starts it; if it does not, say so (not a failure).
  Say "Worker task '$WorkerTaskName' (registered by an administrator; this script only reads it):"
  # Only the root folder ('\'): the unit's steps register there, and -TaskName alone would also return tasks of the same name in other folders.
  $task = @(Invoke-Read { Get-ScheduledTask -TaskPath '\' -TaskName $WorkerTaskName -ErrorAction SilentlyContinue } | Where-Object { $null -ne $_ })
  if ($task.Count -eq 0) { Say '  not registered (see README.md, "The worker task"); nothing to check' }
  else {
    $task = $task[0]
    $tp = $task.Principal
    # The ScheduledTasks module returns enums (LogonType S4U = 2, RunLevel Limited = 0); compare their text so that a name or a number reads the same.
    $logon = "$($tp.LogonType)"
    $level = "$($tp.RunLevel)"
    $tt = @(@($task.Triggers) | Where-Object { $null -ne $_ } | ForEach-Object { $_.CimClass.CimClassName })
    $acts = @(@($task.Actions) | Where-Object { $null -ne $_ })
    Say "  principal $($tp.UserId); logon type $logon; run level $level"
    Say "  triggers: $($tt -join ', ')"
    # Only the exec action type (MSFT_TaskExecAction) has Execute, Arguments and WorkingDirectory; a COM-handler or e-mail action does not, so they are read with Get-Prop.
    foreach ($a in $acts) { Say "  action: $(Get-Prop $a 'Execute') $(Get-Prop $a 'Arguments')  (working directory $(Get-Prop $a 'WorkingDirectory'))" }
    Check (@('S4U', '2') -contains $logon) 'the task logs on with S4U (no stored password; no network or encrypted-file access)'
    Check (@('Limited', '0') -contains $level) 'the task runs with the limited run level (LeastPrivilege)'
    Check (($tp.UserId -ieq $AccountName) -or ($tp.UserId -ieq "$env:COMPUTERNAME\$AccountName")) "the task runs as the local account '$AccountName'"
    Check (($tt.Count -ge 1) -and (@($tt | Where-Object { $_ -ne 'MSFT_TaskBootTrigger' }).Count -eq 0)) 'its trigger is a boot trigger only (nobody needs to be signed in)'
    Check (($acts.Count -eq 1) -and (@($acts | Where-Object { "$(Get-Prop $_ 'Arguments')".IndexOf("--env-file=$EnvFile", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -eq 1)) 'it has one action, which starts node with the environment file worker.env'
  }
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
  if (-not $LauncherPath -or -not (Invoke-Read { Test-Path -LiteralPath $LauncherPath -PathType Leaf })) { throw '-LauncherPath must name the built nn-launcher.exe.' }
  if (-not $ExpectedSha256) { throw '-ExpectedSha256 is required: the hash recorded by the release (native/nn-launcher/RELEASE.md).' }
  $LauncherPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LauncherPath)   # one full path for every .NET call below (they resolve against the process folder, not the PowerShell location)
  if (Test-Reparse $LauncherPath) { throw '-LauncherPath is a link; name the file itself.' }
  $hash = Get-Sha256Hex $LauncherPath
  if ($hash -ne $ExpectedSha256.ToUpperInvariant()) { throw "The file's SHA-256 is $hash, not the expected $ExpectedSha256. Nothing was changed." }
  $sig = Invoke-Read { Get-AuthenticodeSignature -LiteralPath $LauncherPath }
  if ($sig.Status -ne 'Valid') {
    if (-not $AllowUnsigned) { throw "The launcher's Authenticode signature is '$($sig.Status)'. A release is signed. For a build of your own or from the hosted CI, add -AllowUnsigned (and understand what you are installing). Nothing was changed." }
    Say "WARNING: installing an UNSIGNED launcher (-AllowUnsigned): its identity rests on the SHA-256 you gave."
  }
  # Before any change: nothing under our names is a link or belongs to someone else (each is checked again right before it is written).
  foreach ($d in @($InstallDir, $DataDir, $ControlDir)) { Assert-SafeItem $d $true }
  foreach ($f in @((Join-Path $InstallDir $ExeName), $EnvFile, $ManifestPath)) { Assert-SafeItem $f $false }
  $existing = Invoke-Read { Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue }
  if ($null -ne $existing -and $existing.Description -ne $AccountMarker) { throw "A user named '$AccountName' exists that this script did not make. Choose another -AccountName. Nothing was changed." }

  # 1. The account.
  if ($null -eq $existing) {
    if ($PSCmdlet.ShouldProcess($AccountName, 'create a local standard user (random password held in memory only, never stored; no admin rights)')) {
      New-LocalUser -Name $AccountName -Password (New-RandomSecureString) -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description $AccountMarker | Out-Null
      # Users: so it can read Node and the system folders; NOT Administrators. (Some Windows versions already add a new user to Users: that is not an error.)
      try { Add-LocalGroupMember -SID $SidUsers -Member $AccountName } catch [Microsoft.PowerShell.Commands.MemberExistsException] { }
    }
  }
  $sid = if ($WhatIfPreference -and $null -eq $existing) { New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-21-0-0-0-1000' } else { (Invoke-Read { Get-LocalUser -Name $AccountName }).SID }
  # 2. The account rights (only these; Verify lists them).
  if ($PSCmdlet.ShouldProcess($AccountName, "grant $($RightsGranted -join ', ') and deny $($RightsDenied -join ', ')")) {
    Initialize-NnLsa
    [NnLsa]::Add($sid.Value, $RightsGranted + $RightsDenied)
    if (-not $ServiceLogon) { [NnLsa]::Remove($sid.Value, @('SeServiceLogonRight')) }
  }
  # 3. Folders: made with the protected list in the same call (Set-ProtectedAcl), in order, so each parent is closed before its child is made or checked.
  $plan = New-AclPlan $sid
  foreach ($item in $plan) {
    if ($PSCmdlet.ShouldProcess($item.Path, 'create (if absent) and set a protected access list: ' + (($item.Rules | ForEach-Object { "$($_.Who.Value) $($_.Rights)" }) -join '; '))) {
      Set-ProtectedAcl $item.Path $item.Rules
    }
  }
  # 4. The launcher: copied only when it differs, then re-hashed at its place.
  $target = Join-Path $InstallDir $ExeName
  if ($PSCmdlet.ShouldProcess($target, 'place nn-launcher.exe')) {
    Assert-SafeItem $target $false
    if (-not (Invoke-Read { Test-Path -LiteralPath $target }) -or (Get-Sha256Hex $target) -ne $hash) { Copy-Item -LiteralPath $LauncherPath -Destination $target -Force }
    # the source may have changed after it was hashed: the placed file is what counts, and a wrong one is not left in place
    if ((Get-Sha256Hex $target) -ne $hash) { Remove-Item -LiteralPath $target -Force; throw 'The placed launcher did not match the expected hash and was removed.' }
  }
  # 5. worker.env and the manifest: paths and names only. No password, token or key exists anywhere in this script, so none can be written.
  if ($PSCmdlet.ShouldProcess($EnvFile, 'write the four NIMBLENEWT_WIN_* names')) {
    foreach ($v in @($target, $ControlDir, $Container, $ProfileName)) { if ($v -notmatch '^[\x21-\x7E][\x20-\x7E]*$' -or $v -match '["=#''`]') { throw "a value for worker.env has a character that is not allowed: $v" } }
    foreach ($f in @($EnvFile, $ManifestPath)) { Assert-SafeItem $f $false }
    $lines = @("NIMBLENEWT_WIN_LAUNCHER=$target", "NIMBLENEWT_WIN_CONTROL_DIR=$ControlDir", "NIMBLENEWT_WIN_CONTAINER=$Container", "NIMBLENEWT_WIN_PROFILE=$ProfileName")
    Set-Content -LiteralPath $EnvFile -Value $lines -Encoding ascii
    $manifest = [ordered]@{ schema = 'nimblenewt.native-install/1'; installedAt = (Get-Date).ToUniversalTime().ToString('o'); account = $AccountName; accountSid = $sid.Value; installDir = $InstallDir; dataDir = $DataDir
      controlDir = $ControlDir; launcher = $target; launcherSha256 = $hash; signature = [string]$sig.Status; rightsGranted = $RightsGranted; rightsDenied = $RightsDenied }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $ManifestPath -Encoding ascii
  }
  Say 'Install finished. Run -Action Verify (elevated) to print what was set.'
}

# ---- Uninstall ---------------------------------------------------------------------------------------------------------------------------------------------------------
function Invoke-Uninstall {
  Assert-Admin
  # The manifest sits in the data folder, which only administrators can write once installed; it is still only allowed to CONFIRM what this run would remove anyway: the folders of this
  # run (-InstallDir/-DataDir or their defaults) and the account it made. It can never aim a removal at another folder or another account.
  Assert-SafeItem $DataDir $true
  if (-not (Invoke-Read { Test-Path -LiteralPath $ManifestPath })) { throw "No manifest at $($ManifestPath): this script did not make what is here, so it removes nothing. Nothing was changed." }
  Assert-SafeItem $ManifestPath $false
  $m = Invoke-Read { Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
  # The manifest is a file: any field may be missing or empty (a damaged or foreign file), and under StrictMode a missing property throws, so every field is read with Get-Prop and checked.
  if ((Get-Prop $m 'schema') -ne 'nimblenewt.native-install/1') { throw 'The manifest is not one this script wrote. Nothing was changed.' }
  $mAccount = Get-Prop $m 'account'
  $mSid = Get-Prop $m 'accountSid'
  if ($mAccount -isnot [string] -or $mAccount -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,19}$' -or $mSid -isnot [string] -or $mSid -notmatch '^S-1-5-21(-[0-9]+)+$') { throw 'The manifest does not name a valid account and SID. Nothing was changed.' }
  $launcher = Join-Path $InstallDir $ExeName
  foreach ($pair in @(@((Get-Prop $m 'installDir'), $InstallDir), @((Get-Prop $m 'dataDir'), $DataDir), @((Get-Prop $m 'controlDir'), $ControlDir), @((Get-Prop $m 'launcher'), $launcher))) {
    if (-not (Test-SamePath $pair[0] $pair[1])) { throw "The manifest names '$($pair[0])' where this run expects '$($pair[1])' (pass the -InstallDir/-DataDir the install used). Nothing was changed." }
  }
  foreach ($d in @($InstallDir, $ControlDir)) { Assert-SafeItem $d $true }
  foreach ($f in @($launcher, $EnvFile)) { Assert-SafeItem $f $false }
  $running = Invoke-Read { Get-Process -Name 'nn-launcher' -ErrorAction SilentlyContinue }
  if ($running) { throw 'nn-launcher.exe is running (a job is in progress). Stop the worker first. Nothing was changed.' }
  $user = Invoke-Read { Get-LocalUser -Name $mAccount -ErrorAction SilentlyContinue }
  if ($null -ne $user -and ($user.Description -ne $AccountMarker -or $user.SID.Value -ne $mSid)) { throw "The user '$mAccount' is not the one this script made. Nothing was changed." }

  # 1. The account first (the manifest stays until the end, so a rerun can finish an interrupted removal).
  if ($null -ne $user) {
    if ($PSCmdlet.ShouldProcess($mAccount, 'remove every account right it holds, delete its profile (and with it the AppContainer profile it made), and delete the user')) {
      Initialize-NnLsa
      [NnLsa]::RemoveAll($user.SID.Value)
      Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value } | Remove-CimInstance
      Remove-LocalUser -SID $user.SID
    }
  }
  # 2. The files this script placed, then its two folders only if nothing else is left in them.
  if ($PSCmdlet.ShouldProcess($DataDir, 'close and remove the control folder (links in it are removed as links, never followed), remove worker.env, the launcher and the manifest, then the two folders if empty')) {
    if (Test-Present $ControlDir) {
      Set-Acl -LiteralPath $ControlDir -AclObject (New-ProtectedSecurity @(@{ Who = $SidSystem; Rights = 'FullControl'; Scope = 'All' }, @{ Who = $SidAdmins; Rights = 'FullControl'; Scope = 'All' }))
      Remove-TreeNoFollow $ControlDir
    }
    foreach ($f in @($EnvFile, $launcher, $ManifestPath)) { if (Test-Present $f) { Remove-Item -LiteralPath $f -Force } }
    foreach ($d in @($DataDir, $InstallDir)) {
      if (-not (Test-Present $d)) { continue }
      if (@(Invoke-Read { Get-ChildItem -LiteralPath $d -Force }).Count -eq 0) { [System.IO.Directory]::Delete($d, $false) } else { Say "Left $d in place: it holds files this script did not make." }
    }
  }
  Say 'Uninstall finished. Run -Action Verify to see that nothing is left (it will say the account and folders are missing).'
}

Assert-NimbleNewtPath $InstallDir '-InstallDir'
Assert-NimbleNewtPath $DataDir '-DataDir'
switch ($Action) {
  'Verify' { Invoke-Verify }
  'Install' { Invoke-Install }
  'Uninstall' { Invoke-Uninstall }
}
