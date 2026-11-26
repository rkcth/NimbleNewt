<#
.SYNOPSIS
  The standard-account probe (card A03b, plan 12.3): can a NON-administrator S4U task of the installer's account make the container profile and the private window station?

.DESCRIPTION
  TEXT ONLY UNTIL THE OWNER RUNS IT. This file has been read and checked by tests on Linux; it has never been run on Windows by the people who wrote it. Run it with -WhatIf first.
  Run it from an ELEVATED Windows PowerShell 5.1, after Install-NimbleNewtLauncher.ps1 -Action Install and -Action Verify passed.

  What it does, in order:
    1. Refuses unless it is elevated, the installer's manifest exists, the account exists, is enabled, is the installer's account and is NOT a member of Administrators, the launcher is the file the
       manifest names (hash compared) and the control folder exists. No password is asked for, stored or passed anywhere.
    2. Asks once (or prints what it would do under -WhatIf), then writes probe-inner.ps1 into the control folder (the one place the account may write) with its own protected access list
       (SYSTEM and Administrators full, the account read and execute only, read back before use), registers ONE temporary task
       "NimbleNewtProbe" (S4U, least privilege, no password element, no trigger, 10 minute limit) that runs it as the account, and starts it once.
    3. The task (as the account, Session 0) writes probe-result.json in the control folder: the token facts (whoami /user /groups /priv, administrator role, integrity level, session id, profile folders)
       and the product launcher's `info` (makes a throw-away per-run container profile and a private window station, deletes the profile) and `check`. If `info` leaves its profile behind, the task
       deletes it with the launcher's own `delete-profile` and its proof. No contained `run` is attempted: a `run` needs the stdin, output and grant files and the limits that the worker's backend
       writes for each run, so a hand-made one would test a second implementation, not the product. `info` plus `check` are the probe; the ten G05 cases through the backend come later.
    4. Waits on the task's state and the result file (bounded by -TimeoutSeconds), then ALWAYS (finally, also after Ctrl+C) removes the task by its exact name (only when its text names this
       run's random name) and the files this script made by their exact names. The clean-up uses the Task Scheduler's COM interface and .NET only, because after Ctrl+C a cmdlet inside
       finally may be stopped too. Closing the window instead of Ctrl+C skips the clean-up: the task (no trigger) then stays until removed in Task Scheduler.
       probe-result.json is kept and its path printed. It prints a verdict (plan 12.3's outcome table) and a block to paste back.

  What it changes: the temporary task and probe-inner.ps1, probe-result.json (kept), probe-result.tmp and one record in the profiles folder of the control folder (the folder is the backend's too: it is removed only if this run made it; the others are removed
  or kept as stated in the output). Nothing else: no account, right, existing access list, firewall or setting.

  What it cannot show: Windows Home behaviour, a real reboot with nobody signed in, and what Task Scheduler does when it restarts a failed task (see README.md, "The standard-account probe").

  -WhatIf: nothing is registered or written; it prints the task text and what it would do. The two overrides below exist only so a hosted runner can exercise this path with a made-up manifest; they are
  refused without -WhatIf.
.PARAMETER ManifestPath
  Default %ProgramData%\NimbleNewt\install-manifest.json. Another path is only accepted together with -WhatIf (test use).
.PARAMETER ControlDir
  Default: the control folder the manifest names. Another folder is only accepted together with -WhatIf (test use).
.PARAMETER TimeoutSeconds
  How long to wait for the task to write its result (480 to 900, default 540). The task's own program bounds each step (whoami 3 x 30 s, info 120 s, check 60 s, delete-profile 60 s, and up to 15 s more per call for its pipes and a kill: 420 s
  at worst), so a shorter wait could stop the task in the middle of a launcher call.
.EXAMPLE
  .\Probe-NimbleNewtWorker.ps1 -WhatIf
.EXAMPLE
  .\Probe-NimbleNewtWorker.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string] $ManifestPath = (Join-Path $env:ProgramData 'NimbleNewt\install-manifest.json'),
  [string] $ControlDir,
  [ValidateRange(480, 900)] [int] $TimeoutSeconds = 540
)
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# ---- fixed names -------------------------------------------------------------------------------------------------------------------------------------------------------
$TaskName = 'NimbleNewtProbe'
$InnerName = 'probe-inner.ps1'
$ResultName = 'probe-result.json'
$ResultTmpName = 'probe-result.tmp'
$ProfilesName = 'profiles'
$ManifestSchema = 'nimblenewt.native-install/1'
$AccountMarker = 'NimbleNewt launcher account (installer-made)'
$SidAdmins = 'S-1-5-32-544'
# A path from the manifest goes into XML and a command line: ASCII letters, digits, space, dot, underscore, dash and backslash only, never ending in a backslash.
$SafePath = '^[A-Za-z]:\\[A-Za-z0-9 ._\\-]*[A-Za-z0-9._-]$'
$MaxResultBytes = 1048576

function Say([string] $Text) { Write-Host $Text }
# Text from the account's files or from error messages is printed with control characters replaced and a length bound (nothing the account wrote can steer this console).
function Clean($Value, [int] $Max = 300) {
  if ($null -eq $Value) { return '' }
  $s = [regex]::Replace([string]$Value, '[^\x20-\x7E]', '?')
  if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) + '...' }
  return $s
}
# WHAT-IF SAFETY (same lesson as the installer: found by the owner's first real run on Windows PowerShell 5.1). -WhatIf sets $WhatIfPreference for every cmdlet this script calls, including
# the ones written in PowerShell, and a read can then return nothing. Every read-only cmdlet whose result is looked at runs through Invoke-Read; hashing uses .NET only. Everything that changes
# the machine is inside $PSCmdlet.ShouldProcess.
function Invoke-Read([scriptblock] $Block) { $WhatIfPreference = $false; & $Block }
function Get-Sha256HexOfBytes([byte[]] $Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('X2') }) -join '') } finally { $sha.Dispose() }
}
function Get-Sha256Hex([string] $Path) { return (Get-Sha256HexOfBytes ([System.IO.File]::ReadAllBytes($Path))) }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# Attributes of the item itself (a link is not followed), or $null when nothing has that name; other failures are thrown.
function Get-ItemAttributes([string] $Path) {
  try { return [System.IO.File]::GetAttributes($Path) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return $null }
}
function Test-Present([string] $Path) { $null -ne (Get-ItemAttributes $Path) }
function Test-Reparse([string] $Path) { $a = Get-ItemAttributes $Path; ($null -ne $a) -and (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
function Get-Prop($Obj, [string] $Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}
function Format-Hresult($Value) {
  if ($null -eq $Value) { return 'none' }
  $n = [int64]$Value
  if ($n -lt 0) { $n += 4294967296 }
  return ('0x{0:X8}' -f $n)
}
function Get-ResultMeaning([string] $Hex) {
  switch ($Hex) {
    '0x00000000' { return 'the task ended with success' }
    '0x00041301' { return 'the task is still running' }
    '0x00041303' { return 'the task has not run yet' }
    '0x00041306' { return 'the task was stopped' }
    '0x80070005' { return 'access denied' }
    '0x80070002' { return 'a file the task names was not found' }
    '0x8007010B' { return 'the working directory is not valid' }
    '0x8007052E' { return 'logon failure: unknown user name or bad password' }
    '0x80070569' { return 'logon failure: the account has not been granted the batch logon type here' }
    default { return 'see the Task Scheduler documentation for this code' }
  }
}
# One exact file by its exact name. $true when it is gone afterwards.
function Remove-OwnFile([string] $Path) {
  if (-not (Test-Present $Path)) { return $true }
  try { [System.IO.File]::Delete($Path) } catch { return $false }
  return (-not (Test-Present $Path))
}
# The SIDs of the local groups the account is in, through the WinNT provider (ADSI): the account's own list, so an orphaned member of some group cannot break the reading.
function Get-AccountGroupSids([string] $Account) {
  $list = New-Object System.Collections.ArrayList
  $u = [ADSI]('WinNT://' + $env:COMPUTERNAME + '/' + $Account + ',user')
  foreach ($g in @($u.psbase.Invoke('Groups'))) {
    $bytes = [byte[]]($g.GetType().InvokeMember('objectSid', 'GetProperty', $null, $g, $null))
    [void]$list.Add([System.Security.Principal.SecurityIdentifier]::new($bytes, 0).Value)
  }
  return ,$list.ToArray()
}
# Reads back the access list of the program file the task runs: protected (nothing inherited), entries only for SYSTEM, Administrators and the account, and the account without any right that
# writes, deletes, re-permissions or takes ownership. Also the control folder: nobody but SYSTEM and Administrators may delete its children (else the file could be replaced by deleting it).
# Returns '' when all holds, else what does not.
function Test-ProgramAcl([string] $Path, [string] $Folder, [string] $AccountSid) {
  # WriteData 0x2, AppendData 0x4, WriteExtendedAttributes 0x10, DeleteSubdirectoriesAndFiles 0x40, WriteAttributes 0x100, Delete 0x10000, ChangePermissions 0x40000, TakeOwnership 0x80000,
  # GENERIC_ALL 0x10000000, GENERIC_WRITE 0x40000000
  $changeRights = [int64]0x500D0156
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $acl = [System.IO.File]::GetAccessControl($Path)
  if (-not $acl.AreAccessRulesProtected) { return 'its access list still inherits from the folder' }
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    $who = $rule.IdentityReference.Value
    if ($rule.IsInherited) { return "it has an inherited entry for $who" }
    if ($who -eq 'S-1-5-18' -or $who -eq $SidAdmins) { continue }
    if ($who -ne $AccountSid) { return "it has an entry for $who" }
    if ("$($rule.AccessControlType)" -eq 'Allow' -and (([int64]$rule.FileSystemRights -band $changeRights) -ne 0)) { return "the account may change it ($($rule.FileSystemRights))" }
  }
  $dacl = [System.IO.Directory]::GetAccessControl($Folder)
  foreach ($rule in $dacl.GetAccessRules($true, $true, $sidType)) {
    $who = $rule.IdentityReference.Value
    if ($who -eq 'S-1-5-18' -or $who -eq $SidAdmins -or "$($rule.AccessControlType)" -ne 'Allow') { continue }
    if ((([int64]$rule.PropagationFlags) -band [int64][System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ((([int64]$rule.FileSystemRights) -band [int64]0x10000040) -ne 0) { return "the control folder lets $who delete what is in it ($($rule.FileSystemRights))" }
  }
  return ''
}
function ConvertTo-XmlText([string] $Text) { return [System.Security.SecurityElement]::Escape($Text) }
function New-RunName {
  $bytes = New-Object byte[] 8
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ('NimbleNewtRun-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
}

# ---- the task text -----------------------------------------------------------------------------------------------------------------------------------------------------
# Same shape as the worker's unit (packages/controller/src/release/worker-service-unit.ts): S4U, LeastPrivilege, NO password element, but NO trigger (run on demand) and a 10 minute limit.
function New-ProbeTaskXml([string] $UserId, [string] $Command, [string] $Arguments) {
  $t = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>@@DESCRIPTION@@</Description>
  </RegistrationInfo>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <WakeToRun>false</WakeToRun>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Principals>
    <Principal id="Probe">
      <UserId>@@USER@@</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Actions Context="Probe">
    <Exec>
      <Command>@@COMMAND@@</Command>
      <Arguments>@@ARGUMENTS@@</Arguments>
    </Exec>
  </Actions>
</Task>
'@
  $t = $t.Replace('@@DESCRIPTION@@', (ConvertTo-XmlText 'NimbleNewt standard-account probe (temporary; removed by the script that registered it)'))
  $t = $t.Replace('@@USER@@', (ConvertTo-XmlText $UserId)).Replace('@@COMMAND@@', (ConvertTo-XmlText $Command)).Replace('@@ARGUMENTS@@', (ConvertTo-XmlText $Arguments))
  return $t
}

# ---- the program the task runs, as the account (written into the control folder; pure ASCII; uses .NET and the launcher, no cmdlet that reads a machine setting) -----------------------------
function Get-InnerScriptText {
  return @'
param(
  [Parameter(Mandatory = $true)] [string] $Launcher,
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [string] $ControlDir,
  [Parameter(Mandatory = $true)] [string] $RunName
)
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$Final = [System.IO.Path]::Combine($ControlDir, 'probe-result.json')
$Tmp = [System.IO.Path]::Combine($ControlDir, 'probe-result.tmp')
$ProfilesDir = [System.IO.Path]::Combine($ControlDir, 'profiles')
$Record = [System.IO.Path]::Combine($ProfilesDir, $RunName + '.sid')
$Steps = New-Object System.Collections.ArrayList
$Result = [ordered]@{
  schema = 'nimblenewt.nonadmin-probe/1'; complete = $false; startedUtc = [DateTime]::UtcNow.ToString('o'); endedUtc = $null; runName = $RunName
  steps = $Steps; token = $null; environment = $null; whoami = [ordered]@{}; whoamiFacts = $null; info = $null; check = $null; deleteProfile = $null; fatal = $null
}
function Add-Step([string] $Name, [string] $Status, [string] $Detail) { [void]$Steps.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail }) }
function Save-Result([bool] $Complete) {
  try {
    $Result.complete = $Complete
    $Result.endedUtc = [DateTime]::UtcNow.ToString('o')
    [System.IO.File]::WriteAllText($Tmp, ($Result | ConvertTo-Json -Depth 8), [System.Text.Encoding]::ASCII)
    # the script that waits reads probe-result.json every half second; a copy over it at that moment fails with a sharing violation, so it is tried again (2 s at most)
    $copied = $false
    for ($i = 0; ($i -lt 20) -and (-not $copied); $i++) {
      try { [System.IO.File]::Copy($Tmp, $Final, $true); $copied = $true } catch { [System.Threading.Thread]::Sleep(100) }
    }
  } catch { }
}
function Get-P($Obj, [string] $Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}
function Format-Arg([string] $Text) { return ('"' + $Text + '"') }
# One program with its output captured, a time bound and a kill on timeout. Never throws.
function Invoke-Native([string] $Exe, [string] $Arguments, [int] $TimeoutMs) {
  $r = [ordered]@{ exe = $Exe; arguments = $Arguments; started = $false; exitCode = $null; timedOut = $false; stdout = ''; stderr = ''; error = '' }
  $p = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $r.started = $true
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) { $r.timedOut = $true; try { $p.Kill() } catch { }; [void]$p.WaitForExit(5000) }
    if ($p.HasExited) { $r.exitCode = $p.ExitCode }
    if ($out.Wait(5000)) { $r.stdout = $out.Result }
    if ($err.Wait(5000)) { $r.stderr = $err.Result }
    if ($r.stdout.Length -gt 20000) { $r.stdout = $r.stdout.Substring(0, 20000) }
    if ($r.stderr.Length -gt 20000) { $r.stderr = $r.stderr.Substring(0, 20000) }
  } catch { $r.error = $_.Exception.Message }
  finally { if ($null -ne $p) { $p.Dispose() } }
  return $r
}
# The launcher prints ONE JSON line; take the last non-empty line and parse it, or $null.
function Get-LastJson([string] $Text) {
  $lines = @($Text -split "`n" | Where-Object { $_.Trim().Length -gt 0 })
  if ($lines.Count -eq 0) { return $null }
  try { return ($lines[$lines.Count - 1] | ConvertFrom-Json) } catch { return $null }
}
function Get-TokenFacts {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
  $groups = New-Object System.Collections.ArrayList
  $integrity = ''
  $adminSid = $false
  foreach ($g in $id.Groups) {
    $name = ''
    try { $name = $g.Translate([System.Security.Principal.NTAccount]).Value } catch { $name = '' }
    [void]$groups.Add($g.Value + ' ' + $name)
    if ($g.Value -eq 'S-1-5-32-544') { $adminSid = $true }
    if ($g.Value.StartsWith('S-1-16-')) {
      $level = [int]$g.Value.Substring(7)
      $label = 'other'
      if ($level -eq 4096) { $label = 'Low' } elseif ($level -eq 8192) { $label = 'Medium' } elseif ($level -eq 8448) { $label = 'Medium plus' } elseif ($level -eq 12288) { $label = 'High' } elseif ($level -eq 16384) { $label = 'System' }
      $integrity = $g.Value + ' ' + $label
    }
  }
  return [ordered]@{
    user = $id.Name; sid = $id.User.Value; isSystem = $id.IsSystem; isAnonymous = $id.IsAnonymous; authenticationType = $id.AuthenticationType
    administratorRole = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator); administratorsSidInToken = $adminSid
    integrityLevel = $integrity; sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; groups = $groups
  }
}
function Get-EnvironmentFacts {
  $userProfile = [System.Environment]::GetEnvironmentVariable('USERPROFILE')
  $temp = [System.Environment]::GetEnvironmentVariable('TEMP')
  return [ordered]@{
    userProfile = $userProfile; userProfileExists = ($null -ne $userProfile) -and [System.IO.Directory]::Exists($userProfile)
    temp = $temp; tempExists = ($null -ne $temp) -and [System.IO.Directory]::Exists($temp)
    currentDirectory = [System.IO.Directory]::GetCurrentDirectory(); powershellVersion = $PSVersionTable.PSVersion.ToString()
  }
}
function Get-StepStatus($Run) { if ($Run.started -and -not $Run.timedOut -and $null -ne $Run.exitCode) { return 'ran' } else { return 'failed' } }

try {
  Add-Step 'start' 'ok' ('probe started as ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  Save-Result $false
  try { $Result.token = Get-TokenFacts; Add-Step 'token facts' 'ok' '' } catch { Add-Step 'token facts' 'failed' $_.Exception.Message }
  try { $Result.environment = Get-EnvironmentFacts; Add-Step 'environment facts' 'ok' '' } catch { Add-Step 'environment facts' 'failed' $_.Exception.Message }
  $whoami = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('System'), 'whoami.exe')
  foreach ($flag in @('/user', '/groups', '/priv')) {
    $run = Invoke-Native $whoami $flag 30000
    $Result.whoami[$flag.Substring(1)] = $run
    Add-Step ('whoami ' + $flag) (Get-StepStatus $run) ('exit ' + $run.exitCode)
  }
  # .NET's WindowsIdentity.Groups leaves out the integrity label and every deny-only group (a UAC-filtered administrator's Administrators SID is deny-only), so both are read from
  # whoami's text, by SID (SIDs are not translated; the names and attribute words are)
  $groupsText = [string]$Result.whoami['groups'].stdout
  $label = [regex]::Match($groupsText, 'S-1-16-([0-9]+)')
  $Result.whoamiFacts = [ordered]@{
    integritySid = $(if ($label.Success) { $label.Value } else { '' }); integrityRid = $(if ($label.Success) { [int]$label.Groups[1].Value } else { -1 })
    administratorsListed = [regex]::IsMatch($groupsText, 'S-1-5-32-544(?![0-9])'); groupsRead = ($groupsText.Length -gt 0)
  }
  Save-Result $false
  $nameOk = $RunName -cmatch '^NimbleNewtRun-[0-9a-f]{16}$'
  if (-not $nameOk) { throw 'the run name is not NimbleNewtRun- and sixteen lower-case hex digits' }
  try { [void][System.IO.Directory]::CreateDirectory($ProfilesDir); Add-Step 'profiles folder' 'ok' $ProfilesDir } catch { Add-Step 'profiles folder' 'failed' $_.Exception.Message }
  # info: a throw-away per-run profile, the private window station, and the profile deleted again
  $infoRun = Invoke-Native $Launcher ('info --name ' + $RunName + ' --profile-record ' + (Format-Arg $Record)) 120000
  $infoJson = Get-LastJson $infoRun.stdout
  $Result.info = [ordered]@{ run = $infoRun; json = $infoJson }
  Add-Step 'launcher info' (Get-StepStatus $infoRun) ('exit ' + $infoRun.exitCode)
  Save-Result $false
  # the container SID, from info or (if info died) from the record the launcher wrote first
  $sid = Get-P $infoJson 'containerSid'
  if (($null -eq $sid) -and [System.IO.File]::Exists($Record)) {
    foreach ($line in [System.IO.File]::ReadAllLines($Record)) { if ($line.StartsWith($RunName + ' ')) { $sid = $line.Substring($RunName.Length + 1).Trim() } }
  }
  $sidOk = ($null -ne $sid) -and ([string]$sid -cmatch '^S-1-15-2(-[0-9]+){7}$')
  # check: read only; the SID is derived from the name, --sid is a cross-check
  $checkArgs = 'check --name ' + $RunName + ' --grant ' + (Format-Arg ('rx:' + $InstallDir))
  if ($sidOk) { $checkArgs += ' --sid ' + $sid }
  $checkRun = Invoke-Native $Launcher $checkArgs 60000
  $Result.check = [ordered]@{ run = $checkRun; json = (Get-LastJson $checkRun.stdout) }
  Add-Step 'launcher check' (Get-StepStatus $checkRun) ('exit ' + $checkRun.exitCode)
  Save-Result $false
  # clean-up of the profile: only when info created one and did not delete it, with the launcher's own proof (name, record, SID)
  $created = (Get-P $infoJson 'profile') -eq 'created'
  $settled = ((Get-P $infoJson 'profileDeleted') -eq $true) -and ((Get-P $infoJson 'profileGone') -eq $true)
  if ((-not $settled) -and ($created -or ([System.IO.File]::Exists($Record) -and $null -eq $infoJson)) -and $sidOk) {
    $delRun = Invoke-Native $Launcher ('delete-profile --name ' + $RunName + ' --sid ' + $sid + ' --profile-record ' + (Format-Arg $Record)) 60000
    $Result.deleteProfile = [ordered]@{ run = $delRun; json = (Get-LastJson $delRun.stdout) }
    Add-Step 'launcher delete-profile' (Get-StepStatus $delRun) ('exit ' + $delRun.exitCode)
  } else { Add-Step 'launcher delete-profile' 'not needed' 'info left no profile behind, or no proof was available' }
} catch {
  $Result.fatal = $_.Exception.Message
  Add-Step 'probe' 'failed' $_.Exception.Message
} finally {
  Save-Result $true
}
'@
}

# ---- what the machine says ---------------------------------------------------------------------------------------------------------------------------------------------
function Get-Context {
  $testMode = $false
  if ($script:OverrideUsed) { if (-not $WhatIfPreference) { throw '-ManifestPath and -ControlDir are test options and are only accepted together with -WhatIf.' }; $testMode = $true }
  if (-not $testMode -and $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run this probe from Windows PowerShell 5.1 (powershell.exe), not PowerShell 7: the file it writes for the task is created with a .NET Framework call.' }
  if (-not $testMode -and -not (Test-Admin)) { throw 'This probe needs an elevated (administrator) Windows PowerShell: it registers a task for another account.' }
  if ($ManifestPath -notmatch $SafePath) { throw "The manifest path '$(Clean $ManifestPath)' is not an ordinary full local path." }
  if (-not (Test-Present $ManifestPath)) { throw "No install manifest at $ManifestPath. Run Install-NimbleNewtLauncher.ps1 -Action Install first." }
  if (Test-Reparse $ManifestPath) { throw "$ManifestPath is a link; it is not read." }
  if (([System.IO.FileInfo]$ManifestPath).Length -gt 65536) { throw "$ManifestPath is larger than a manifest can be." }
  $m = Invoke-Read { Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
  if ((Get-Prop $m 'schema') -ne $ManifestSchema) { throw "The manifest is not one the installer wrote (schema is not $ManifestSchema)." }
  $account = [string](Get-Prop $m 'account')
  $installDir = [string](Get-Prop $m 'installDir')
  $dataDir = [string](Get-Prop $m 'dataDir')
  $control = [string](Get-Prop $m 'controlDir')
  $launcher = [string](Get-Prop $m 'launcher')
  $launcherSha = [string](Get-Prop $m 'launcherSha256')
  if ($account -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,19}$') { throw 'The manifest names an account that is not an ordinary local account name.' }
  if ($env:COMPUTERNAME -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,14}$') { throw 'The computer name is not an ordinary name; the task could not name its account safely.' }
  foreach ($p in @($installDir, $dataDir, $control, $launcher)) { if ($p -notmatch $SafePath -or $p -ne [System.IO.Path]::GetFullPath($p).TrimEnd('\')) { throw "The manifest names a path that is not an ordinary full local path: '$(Clean $p)'." } }
  if ($launcherSha -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The manifest has no launcher hash.' }
  if ($dataDir -ine (Split-Path -Parent $ManifestPath) -or $control -ine (Join-Path $dataDir 'native') -or $launcher -ine (Join-Path $installDir 'nn-launcher.exe')) { throw 'The manifest names folders that do not match where it lives (control folder, launcher).' }
  if ($script:ControlBound) { if ($ControlDir -notmatch $SafePath) { throw 'The -ControlDir is not an ordinary full local path.' }; $control = $ControlDir }
  if (-not [System.IO.Directory]::Exists($control)) { throw "The control folder $control does not exist." }
  if (Test-Reparse $control) { throw "The control folder $control is a link." }
  if (-not (Test-Present $launcher) -or (Test-Reparse $launcher)) { throw "The launcher $launcher is missing or a link." }
  if ((Get-Sha256Hex $launcher) -ine $launcherSha) { throw "The launcher $launcher does not have the hash the manifest recorded. Run Install-NimbleNewtLauncher.ps1 -Action Verify." }
  $accountSid = ''
  if ($testMode) { Say '  (test options in use: the account, its group membership and the elevation are not checked)' }
  else {
    $user = Invoke-Read { Get-LocalUser -Name $account -ErrorAction SilentlyContinue }
    if ($null -eq $user) { throw "The local account '$account' does not exist." }
    if (-not $user.Enabled) { throw "The account '$account' is disabled." }
    if ($user.Description -ne $AccountMarker) { throw "The account '$account' is not the one the installer made (marker missing)." }
    $accountSid = $user.SID.Value
    if ($accountSid -ne [string](Get-Prop $m 'accountSid')) { throw 'The account SID differs from the manifest.' }
    # Two independent readings. Get-LocalGroupMember on Windows PowerShell 5.1 fails for a whole group when one member is an orphaned or cloud SID (a known fault of that module), so the
    # account's own group list is also read through the WinNT provider (it never touches the other members). Either one naming Administrators refuses; both unreadable refuses.
    $readings = 0
    $groupError = ''
    try {
      $admins = @(Invoke-Read { Get-LocalGroupMember -SID $SidAdmins })
      $readings++
      foreach ($a in $admins) { if ([string](Get-Prop (Get-Prop $a 'SID') 'Value') -eq $accountSid) { throw "The account '$account' is a member of Administrators: this probe is only meaningful for a standard account." } }
    } catch { if ($_.Exception.Message -like '*is a member of Administrators*') { throw }; $groupError = Clean $_.Exception.Message }
    try {
      $sids = Get-AccountGroupSids $account
      $readings++
      if ($sids -contains $SidAdmins) { throw "The account '$account' is a member of Administrators: this probe is only meaningful for a standard account." }
    } catch { if ($_.Exception.Message -like '*is a member of Administrators*') { throw }; $groupError += ' / ' + (Clean $_.Exception.Message) }
    if ($readings -eq 0) { throw "Could not read the Administrators group or the account's groups ($groupError); the probe does not run on an account it cannot check." }
  }
  if ($null -ne (Invoke-Read { Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue })) { throw "A task named $TaskName already exists. It is not touched; if it is a leftover, remove it in Task Scheduler and run again." }
  return @{ Account = $account; AccountSid = $accountSid; InstallDir = $installDir; Control = $control; Launcher = $launcher; LauncherSha = $launcherSha; TestMode = $testMode }
}

# ---- reading what the account wrote (data, never instructions) ----------------------------------------------------------------------------------------------------------------
# Only a result of THIS run counts: the schema and the per-run name must match (a file left by anything else is ignored).
function Read-Result([string] $Path, [string] $RunName) {
  try {
    if (-not (Test-Present $Path) -or (Test-Reparse $Path)) { return $null }
    if (([System.IO.FileInfo]$Path).Length -gt $MaxResultBytes) { return $null }
    $r = Invoke-Read { Get-Content -LiteralPath $Path -Raw -Encoding Ascii | ConvertFrom-Json }
  } catch { return $null }
  if ((Get-Prop $r 'schema') -ne 'nimblenewt.nonadmin-probe/1' -or [string](Get-Prop $r 'runName') -cne $RunName) { return $null }
  return $r
}
# The Task Scheduler's own COM interface (ITaskService): used to watch, stop and remove the probe task. Method calls only, so the clean-up in `finally` needs no cmdlet and no pipeline
# (after Ctrl+C, PowerShell stops the pipeline and a cmdlet or a function's output inside `finally` can end the block early).
$TaskStateNames = @{ 0 = 'Unknown'; 1 = 'Disabled'; 2 = 'Queued'; 3 = 'Ready'; 4 = 'Running' }
$HrFileNotFound = -2147024894  # 0x80070002: ITaskFolder.GetTask for a name that is not there

# The verdict of plan 12.3's outcome table. Returns @{ Label; Text }. It claims no more than this one run on this machine and build shows.
function Get-Verdict($Result, [string] $RegisterError, [string] $StartError, $TaskResult, [string] $AccountSid, [bool] $Started) {
  if ($RegisterError -ne '') {
    # Task Scheduler names a line and column for a task text it cannot read, e.g. "(12,6):Settings:"; that is a fault in this script, not the answer to plan 12.3 (c)
    if ($RegisterError -match '\(\d+,\d+\)' -or $RegisterError -match '(?i)\bXML\b|schema|malformed') { return @{ Label = 'task text refused (a fault in this script)'; Text = "Windows did not accept the task text: $(Clean $RegisterError 400). This is NOT plan 12.3 (c): the script's task text is wrong. Paste the block; nothing was registered and no password was supplied." } }
    return @{ Label = '(c) registration refused'; Text = "Windows did not register the task without a password: $(Clean $RegisterError 400). If the message asks for a password or a logon, or says access is denied, plan 12.3 (c) holds for this machine; otherwise paste the block. No password was supplied or stored. This is a design decision (plan 12.3, fallback 4), not something to work around." }
  }
  if (-not $Started -and $StartError -eq '') { return @{ Label = 'no verdict: the script stopped before the task started'; Text = 'This script stopped itself before starting the task (see the Note lines): nothing about the account was measured. Fix what the note says and run again.' } }
  if ($StartError -ne '') { return @{ Label = '(d) task did not start'; Text = "The task was registered but could not be started: $(Clean $StartError 400). Last result $(Format-Hresult $TaskResult)." } }
  if ($null -eq $Result) { $hex = Format-Hresult $TaskResult; return @{ Label = '(d) task never ran or ended before writing'; Text = "No result file was written. Task Scheduler's last result was $hex ($(Get-ResultMeaning $hex)). Likely causes: the batch logon right, a deny right or a task-setting problem (a fix, not a design change)." } }
  $token = Get-Prop $Result 'token'
  $facts = Get-Prop $Result 'whoamiFacts'
  $info = Get-Prop (Get-Prop $Result 'info') 'json'
  $why = @()
  if ($null -eq $token) { $why += 'the token facts are missing' }
  if ((Get-Prop $token 'administratorRole') -eq $true -or (Get-Prop $token 'isSystem') -eq $true) { $why += 'an administrator or SYSTEM token' }
  if ($AccountSid -ne '' -and [string](Get-Prop $token 'sid') -ne $AccountSid) { $why += "the task ran as $(Clean (Get-Prop $token 'sid') 80), not the account $AccountSid" }
  if ((Get-Prop $facts 'administratorsListed') -eq $true) { $why += 'whoami lists the Administrators group in the token (enabled or deny-only: the account is an administrator)' }
  if ([int](Get-Prop $facts 'integrityRid') -ge 12288) { $why += "a high or system integrity level ($(Clean (Get-Prop $facts 'integritySid') 40))" }
  if ((Get-Prop $info 'elevated') -eq $true) { $why += 'the launcher reported an elevated token' }
  if ($why.Count -gt 0) { return @{ Label = 'invalid probe'; Text = "This run says nothing about a standard account: $($why -join '; '). Check the account (Verify) before reading any further." } }
  if ($null -eq $info) { return @{ Label = '(e) launcher did not answer'; Text = "The launcher's info call printed no JSON line (see the info exit code and the error text below)." } }
  $stage = [string](Get-Prop $info 'stage')
  $err = Clean (Get-Prop $info 'error') 400
  if ((Get-Prop $info 'ok') -eq $true -and (Get-Prop $info 'windowStation') -eq 'private' -and (Get-Prop $info 'windowStationOk') -eq $true) {
    $gone = ((Get-Prop $info 'profileDeleted') -eq $true) -and ((Get-Prop $info 'profileGone') -eq $true)
    $tail = if ($gone) { 'The per-run profile was deleted again.' } else { "BUT the per-run profile was not confirmed deleted (see delete-profile below): that is a separate fault to fix." }
    return @{ Label = 'OK: profile and private window station work'; Text = "info succeeded: this standard account's S4U task made the container profile and the private window station, on this machine and build only. $tail Not shown: the ten G05 cases (no contained run was made), the reboot with nobody signed in, Task Scheduler's restarts, other Windows editions. Next: register the worker task and run the cases and the reboot test (plan 12.3, step 3)." }
  }
  if ($stage -eq 'grant' -and $err -like 'window objects:*') { return @{ Label = '(b) private window station refused'; Text = "The profile was made but the private window station was not (stage grant: $err). Microsoft's statement that only Administrators may name a window station holds for this account. A design decision: plan 12.3, fallbacks 1 to 5." } }
  if ($stage -eq 'container' -or $stage -eq 'profile') { return @{ Label = '(a) profile creation failed'; Text = "The container profile could not be made by this account's task (stage $($stage): $err). The S4U token may have no usable profile or registry hive. Plan 12.3: load the profile first or use a different logon type." } }
  return @{ Label = '(e) info failed elsewhere'; Text = "info did not succeed (stage '$stage': $err). This is not one of the table's rows; paste the block below." }
}

# ---- main --------------------------------------------------------------------------------------------------------------------------------------------------------------
$script:ControlBound = $PSBoundParameters.ContainsKey('ControlDir')
$script:OverrideUsed = $PSBoundParameters.ContainsKey('ManifestPath') -or $script:ControlBound
$script:Exit = 0
$ctx = $null
Say "NimbleNewt standard-account probe ($(Get-Date -Format s)); changes only the temporary task $TaskName and files it names below, then removes them."
try { $ctx = Get-Context } catch { Say ''; Say "REFUSED: $(Clean $_.Exception.Message 600)"; Say 'Nothing was changed.'; exit 2 }

$userId = "$($env:COMPUTERNAME)\$($ctx.Account)"
$psExe = Join-Path ([System.Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$innerPath = Join-Path $ctx.Control $InnerName
$resultPath = Join-Path $ctx.Control $ResultName
$tmpPath = Join-Path $ctx.Control $ResultTmpName
$profilesPath = Join-Path $ctx.Control $ProfilesName
$runName = New-RunName
$recordPath = Join-Path $profilesPath ($runName + '.sid')
$innerText = Get-InnerScriptText
$innerSha = Get-Sha256HexOfBytes ([System.Text.Encoding]::ASCII.GetBytes($innerText))
foreach ($p in @($psExe, $innerPath, $resultPath, $tmpPath, $profilesPath)) { if ($p -notmatch '^[A-Za-z]:\\[A-Za-z0-9 ._\\()-]+$' -or $p.Contains('"')) { Say "REFUSED: the path '$(Clean $p)' is not an ordinary path."; Say 'Nothing was changed.'; exit 2 } }
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $innerPath + '" -Launcher "' + $ctx.Launcher + '" -InstallDir "' + $ctx.InstallDir + '" -ControlDir "' + $ctx.Control + '" -RunName ' + $runName
$xml = New-ProbeTaskXml $userId $psExe $arguments

Say "Account: $userId ($(if ($ctx.TestMode) { 'account checks skipped: test options' } else { 'checked: exists, enabled, installer-made, not an administrator' }); the launcher hash matches the manifest)."
Say "Control folder: $($ctx.Control); launcher: $($ctx.Launcher); per-run name: $runName"
Say "The program the task runs: $innerPath (sha256 $innerSha, written by this script with its own access list: the account may read and run it, not change, replace or delete it; the hash is checked again before the task starts and after it ends)."
if ($WhatIfPreference) { Say 'The task text that would be registered (no password element, no trigger):'; $xml -split "`n" | ForEach-Object { Say "    $_" } }

# state for the final block
$registerError = ''
$startError = ''
$registerAttempted = $false
$registered = $false
$started = $false
$hashBefore = ''
$hashAfter = ''
$innerAcl = ''
$taskState = ''
$last = $null
$result = $null
$settled = $false
$unregistered = $false
$finished = $false
$taskFolder = $null
$filesLeft = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
$ran = $false
# the profiles folder is also the backend's (packages/worker windows-native-job.ts): it is removed afterwards only if this run made it
$profilesExisted = Test-Present $profilesPath

if ($PSCmdlet.ShouldProcess("task $TaskName and the files probe-inner.ps1, probe-result.json, probe-result.tmp and profiles\ in $($ctx.Control)", "register the temporary standard-account probe task, run it once, read its result, and remove the task and the files it made (probe-result.json is kept)")) {
  $ran = $true
  try {
    if ($ctx.AccountSid -notmatch '^S-1-5-21(-[0-9]+){4}$') { throw 'The account SID is not a local account SID; the program file could not be given its access list.' }
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $taskFolder = $service.GetFolder('\')
    # 1. the program, create-new (never over an existing file or a link), stale leftovers of an earlier run removed by exact name first. It is created WITH its own protected access list:
    #    SYSTEM and Administrators full, the account read and execute only. The account has Modify below the control folder, so without this it could change or replace the file between
    #    the hash check and the task's start; with it, the account can neither write, delete, rename nor re-permission it (it is not the owner, and the folder gives it no delete-child).
    foreach ($stale in @($innerPath, $resultPath, $tmpPath)) { if (-not (Remove-OwnFile $stale)) { throw "A leftover $stale cannot be removed; remove it and run again." } }
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($innerText)
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;' + $ctx.AccountSid + ')')
    $fs = [System.IO.FileStream]::new($innerPath, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
    try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
    $innerAcl = Test-ProgramAcl $innerPath $ctx.Control $ctx.AccountSid
    if ($innerAcl -ne '') { throw "probe-inner.ps1 is not protected from the account: $innerAcl. Nothing was registered." }
    # 2. register: a refusal (a password asked for, access denied) is REPORTED, never worked around. The flag is set BEFORE the call, so a stop (Ctrl+C) right after it still removes the task.
    $registerAttempted = $true
    try { Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Xml $xml -Force:$false | Out-Null; $registered = $true } catch { $registerError = $_.Exception.Message }
    if ($registered) {
      $hashBefore = Get-Sha256Hex $innerPath
      if ($hashBefore -ne $innerSha) { throw 'probe-inner.ps1 changed between writing and starting; the task is not started.' }
      try { Start-ScheduledTask -TaskName $TaskName -TaskPath '\'; $started = $true } catch { $startError = $_.Exception.Message }
    }
    # 3. wait on the task's state and the result file, bounded
    if ($started) {
      $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
      while ($true) {
        $result = Read-Result $resultPath $runName
        if ($null -ne $result -and (Get-Prop $result 'complete') -eq $true) {
          # its last word is written; powershell.exe is still ending. A short bounded wait (20 s) lets the task's own result be read (not 'still running') and the clean-up need not stop it.
          $grace = [DateTime]::UtcNow.AddSeconds(20)
          while (([int]$taskFolder.GetTask($TaskName).State -eq 4) -and ([DateTime]::UtcNow -lt $grace)) { Start-Sleep -Milliseconds 250 }
          break
        }
        $own = $taskFolder.GetTask($TaskName)
        $taskState = [string]$TaskStateNames[[int]$own.State]
        $last = [int64]$own.LastTaskResult
        # ended: not running or queued, and it has run (267011 = not yet run, 267009 = running)
        if (($taskState -eq 'Ready') -and ($last -ne 267011) -and ($last -ne 267009)) { $result = Read-Result $resultPath $runName; break }
        if ([DateTime]::UtcNow -gt $deadline) { [void]$notes.Add("No result within $TimeoutSeconds seconds; the task is stopped and removed below."); break }
        Start-Sleep -Milliseconds 500
      }
      $own = $taskFolder.GetTask($TaskName)
      $taskState = [string]$TaskStateNames[[int]$own.State]
      $last = [int64]$own.LastTaskResult
      $hashAfter = if (Test-Present $innerPath) { Get-Sha256Hex $innerPath } else { 'missing' }
    }
    # is the per-run profile settled (deleted and gone, by info or by delete-profile)? Only then is its record removed.
    $infoJson = Get-Prop (Get-Prop $result 'info') 'json'
    $delJson = Get-Prop (Get-Prop $result 'deleteProfile') 'json'
    $settled = (((Get-Prop $infoJson 'profileDeleted') -eq $true) -and ((Get-Prop $infoJson 'profileGone') -eq $true)) -or (((Get-Prop $delJson 'profileDeleted') -eq $true) -and ((Get-Prop $delJson 'profileGone') -eq $true))
    $finished = $true
  } catch {
    [void]$notes.Add("Stopped by an error: $(Clean $_.Exception.Message 400)")
    $script:Exit = 1
  } finally {
    # 4. clean-up, always, also after Ctrl+C. Written with .NET and COM method calls ONLY (no cmdlet, no function call, no pipeline): when the user presses Ctrl+C, PowerShell stops the
    #    pipeline, and a cmdlet or a function's output inside this block could end it before the task is removed. Each step has its own try, so one failure does not skip the next.
    #    The task: removed only if this run tried to register it AND the task of that name carries this run's random name in its text (Get-Context refused an existing task of that name).
    if ($registerAttempted -and $null -ne $taskFolder) {
      $own = $null; $lookup = ''
      try { $own = $taskFolder.GetTask($TaskName) } catch { if ($_.Exception.GetBaseException().HResult -ne $HrFileNotFound) { $lookup = $_.Exception.GetBaseException().Message } }
      if ($null -eq $own) {
        $unregistered = ($lookup -eq '')
        if ($lookup -ne '') { [void]$notes.Add('Reading the task back failed: ' + $lookup) }
      } elseif (-not ([string]$own.Xml).Contains($runName)) {
        [void]$notes.Add("A task named $TaskName exists whose text does not name $runName; this run did not register it, so it was left alone.")
      } else {
        try { if ([int]$own.State -eq 4) { $own.Stop(0) } } catch { [void]$notes.Add('Stopping the task failed: ' + $_.Exception.GetBaseException().Message) }
        try { $taskFolder.DeleteTask($TaskName, 0) } catch { [void]$notes.Add('Removing the task failed: ' + $_.Exception.GetBaseException().Message) }
        $own = $null; $lookup = ''
        try { $own = $taskFolder.GetTask($TaskName) } catch { if ($_.Exception.GetBaseException().HResult -ne $HrFileNotFound) { $lookup = $_.Exception.GetBaseException().Message } }
        $unregistered = ($null -eq $own) -and ($lookup -eq '')
      }
    }
    # the files this script made, by their exact names. Written out one by one, NO loop: every loop turn checks for Ctrl+C, so after Ctrl+C a loop here would end this block at its
    # first turn (PipelineStoppedException) and skip everything below it.
    try { [System.IO.File]::Delete($innerPath) } catch { }
    $gone = $false
    try { [void][System.IO.File]::GetAttributes($innerPath) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $gone = $true } catch { }
    if (-not $gone) { [void]$filesLeft.Add($innerPath) }
    try { [System.IO.File]::Delete($tmpPath) } catch { }
    $gone = $false
    try { [void][System.IO.File]::GetAttributes($tmpPath) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $gone = $true } catch { }
    if (-not $gone) { [void]$filesLeft.Add($tmpPath) }
    # the profile record is the proof for deleting a profile that survived: it is removed only when the profile is settled (deleted and gone), or when the task never started
    if ($ran -and (-not $started -or $settled)) {
      try { [System.IO.File]::Delete($recordPath) } catch { }
      $gone = $false
      try { [void][System.IO.File]::GetAttributes($recordPath) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $gone = $true } catch { }
      if (-not $gone) { [void]$filesLeft.Add($recordPath) }
      if (-not $profilesExisted) {
        $attr = $null
        try { $attr = [System.IO.File]::GetAttributes($profilesPath) } catch { }
        if ($null -ne $attr) {
          if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { [void]$filesLeft.Add("$profilesPath (a link: left alone)") }
          else { try { [System.IO.Directory]::Delete($profilesPath, $false) } catch { [void]$filesLeft.Add("$profilesPath (not empty or not removable)") } }
        }
      }
    } else {
      # named only when the record is there (a task that never reached info wrote none)
      $gone = $false
      try { [void][System.IO.File]::GetAttributes($recordPath) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $gone = $true } catch { }
      if (-not $gone) { [void]$filesLeft.Add("$recordPath (kept: the profile $runName may remain; this record is the proof for deleting it)") }
    }
    if (-not $finished) { [Console]::WriteLine('Probe stopped before the end. Task ' + $TaskName + ' removed: ' + $unregistered + ' (tried: ' + $registerAttempted + '); files left: ' + ($filesLeft -join ' | ')) }
  }
}

# ---- verdict and the block to paste back -------------------------------------------------------------------------------------------------------------------------------
if (-not $ran) {
  Say ''
  Say 'Nothing was registered or written (-WhatIf, or the question was declined).'
  exit 0
}
$verdict = Get-Verdict $result $registerError $startError $last $ctx.AccountSid $started
$token = Get-Prop $result 'token'
$envf = Get-Prop $result 'environment'
$info = Get-Prop (Get-Prop $result 'info') 'json'
$infoRun = Get-Prop (Get-Prop $result 'info') 'run'
$check = Get-Prop $result 'check'
$del = Get-Prop $result 'deleteProfile'
$delJson = Get-Prop $del 'json'
function Show-Json($Obj, [string[]] $Names) { ($Names | ForEach-Object { "$_=$(Clean (Get-Prop $Obj $_) 200)" }) -join '; ' }
Say ''
Say '=============================== VERDICT ==============================='
Say "  $($verdict.Label)"
Say "  $($verdict.Text)"
Say '=========================== PASTE THIS BLOCK BACK ==========================='
Say "Standard-account probe, $([DateTime]::UtcNow.ToString('s'))Z, plan 12.3"
Say "Verdict: $($verdict.Label)"
Say "Machine: $([System.Environment]::OSVersion.VersionString); edition $(Clean ([Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'EditionID', ''))) build $(Clean ([Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'CurrentBuild', ''))); PowerShell $($PSVersionTable.PSVersion)"
Say "Account: $userId; test options: $($ctx.TestMode)"
Say "Registration: $(if ($registered) { 'accepted (no password supplied)' } else { 'REFUSED: ' + (Clean $registerError 400) })"
Say "Task: state $taskState; LastTaskResult $(Format-Hresult $last) ($(Get-ResultMeaning (Format-Hresult $last))); started $started"
Say "Token as the task ran it: $(Show-Json $token @('user', 'sid', 'isSystem', 'administratorRole', 'administratorsSidInToken', 'integrityLevel', 'sessionId'))"
Say "whoami /groups read by SID: $(Show-Json (Get-Prop $result 'whoamiFacts') @('groupsRead', 'integritySid', 'administratorsListed'))"
Say "Environment: $(Show-Json $envf @('userProfile', 'userProfileExists', 'temp', 'tempExists', 'powershellVersion'))"
Say "info: exit $(Clean (Get-Prop $infoRun 'exitCode')); timedOut $(Clean (Get-Prop $infoRun 'timedOut')); $(Show-Json $info @('ok', 'stage', 'error', 'elevated', 'sessionId', 'containerSid', 'profile', 'windowStation', 'windowStationOk', 'windowStationError', 'profileDeleted', 'profileGone'))"
Say "info stderr: $(Clean (Get-Prop $infoRun 'stderr') 300); launcher start error: $(Clean (Get-Prop $infoRun 'error') 300)"
Say "check: exit $(Clean (Get-Prop (Get-Prop $check 'run') 'exitCode')); $(Show-Json (Get-Prop $check 'json') @('ok', 'stage', 'error', 'clean', 'containerSid'))"
Say "delete-profile: $(if ($null -eq $del) { 'not needed' } else { 'exit ' + (Clean (Get-Prop (Get-Prop $del 'run') 'exitCode')) + '; ' + (Show-Json $delJson @('ok', 'stage', 'error', 'profileDeleted', 'profileGone')) })"
Say "Probe program sha256 $innerSha; access list read+execute only for the account: $(if ($innerAcl -eq '') { $registerAttempted } else { 'NO: ' + (Clean $innerAcl 200) }); unchanged before start: $($hashBefore -eq $innerSha); after the run: $($hashAfter -eq $innerSha)"
foreach ($n in $notes) { Say "Note: $(Clean $n 400)" }
Say "Cleanup: task $TaskName removed: $(if ($registered) { $unregistered } else { 'never registered' }); files left: $(if ($filesLeft.Count -eq 0) { 'none of those this script made' } else { ($filesLeft | ForEach-Object { Clean $_ 200 }) -join ' | ' })"
Say "Kept: $resultPath (the account wrote it; whoami output and the launcher's full lines are in it)"
Say 'Changed on this machine: nothing except the temporary task and the temporary files named above, which were removed (probe-result.json kept). No account, right, existing access list, firewall or setting was touched (the only access list written is the one of its own new probe-inner.ps1); no password was used.'
Say '=========================== END OF BLOCK ==========================='
if ($filesLeft.Count -gt 0 -or ($registerAttempted -and -not $unregistered)) { if ($script:Exit -eq 0) { $script:Exit = 3 } }
elseif ($null -eq $result -and $script:Exit -eq 0) { $script:Exit = 1 }
exit $script:Exit
