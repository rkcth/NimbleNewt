# run-g05.ps1 - card G05 / A03b: the ten containment cases on this Windows PC, run from the owner bundle that CI built (artifact windows-g05-owner-bundle).
#
# How to run it (Windows PowerShell 5.1 or PowerShell 7, as your normal account, NOT "Run as administrator"):
#   1. Download the artifact windows-g05-owner-bundle from the workflow run and extract it to a folder of its own in Downloads (NOT on a OneDrive-synced Desktop or Documents folder:
#      the script refuses a folder under OneDrive, whose files can be cloud placeholders and whose raw output would be synced).
#   2. Open a normal PowerShell window in that folder and run:
#        powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-g05.ps1
#      (-ExecutionPolicy Bypass applies to this one PowerShell process only; nothing is changed on the machine.)
#   3. Send the file nn-g05-results.zip it leaves on your Desktop (or in Downloads when there is no Desktop folder).
#
# What it does, in order, and what it never does:
#   - refuses to run elevated (a member of Administrators with an elevated token): the question is what a NORMAL signed-in account can confine;
#   - checks every file of this folder against SHA256SUMS (a missing, extra or changed file stops it before anything runs);
#   - says whether this account may create symbolic links (whoami /priv); without that right the cases that plant a FILE symbolic link may be inconclusive, which is fine;
#   - says whether this is a standard account or an administrator account in a normal (filtered) window (whoami /groups: the Administrators group S-1-5-32-544 is in a filtered token, deny-only);
#     both answers go into the report (containment-evidence.mjs --account-kind, --symlink-right), with the launcher's info, for the release gate;
#   - runs bin\nn-launcher.exe info once (a throw-away per-run container profile, made and deleted again);
#   - runs the ten cases with the bundle's own node.exe and scripts (no network: scripts\offline-guard.mjs is loaded first);
#   - keeps the raw output only under control\raw\ in this folder, and puts copies with names, paths, SIDs and addresses replaced into results\;
#   - refuses to make the zip when results\ (file contents or file names) still holds your account name, computer, domain or network host name, home folder, a ...\Users\ path
#     (also written with / or doubled \\ as in JSON), an account, Azure AD account or logon-session SID, or an IPv4, IPv6 or MAC address (it prints which kind of text, never the text itself);
#   - writes nn-g05-results.zip and prints "N/10 cases hold, M inconclusive".
# It downloads nothing, installs nothing, and changes no security setting, policy, registry value, firewall rule, service or scheduled task.
# Everything it writes is inside this folder, a throw-away folder nn-g05-* under your TEMP (the cases' own files, removed at the end), the container profiles the launcher makes and
# deletes again under your own AppData, and the zip. The confined (sandboxed) run TRIES to create a file g05-x in C:\Windows, C:\Windows\System32, C:\ and C:\Program Files: that must be
# refused; if one ever exists afterwards the run says so (and the case fails). The cases listen on 127.0.0.1 only, on a free port, for the loopback case.
[CmdletBinding()]
param()

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$b = $PSScriptRoot
$script:problems = New-Object System.Collections.Generic.List[string]
$script:systemLeft = @()
function Add-Problem([string] $m) { $script:problems.Add($m); Write-Host "FAILED: $m" }

Write-Host 'NimbleNewt G05 owner run: the ten containment cases on this PC (card A03b).'

# ---------------------------------------------------------------------------------------------- 1. never elevated
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'REFUSED: this PowerShell is elevated (Run as administrator, or an administrator account with User Account Control switched off). Close it, open a NORMAL PowerShell window and run the script again. Nothing was run.'
  exit 2
}
Write-Host 'not elevated: good'

# One run at a time on this PC (a manual run and the own runner's job both run as this account): a second run would see the first one's live container profiles as leftovers and
# remove its zip. The lock is a named mutex, released by Windows when this process ends, however it ends.
$script:runLock = $null
foreach ($lockName in @('Global\NimbleNewt-G05-owner-run', 'Local\NimbleNewt-G05-owner-run')) {
  try { $script:runLock = New-Object System.Threading.Mutex($false, $lockName); break } catch { $script:runLock = $null }
}
$locked = $false
if ($null -ne $script:runLock) {
  try { $locked = $script:runLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
}
if (-not $locked) {
  Write-Host 'REFUSED: another run of run-g05.ps1 (a window of yours, or the own runner''s job) is still running on this PC. Wait for it to finish, then run this again. Nothing was run.'
  exit 2
}

# ---------------------------------------------------------------------------------------------- 2. the folder itself
if ([string]::IsNullOrEmpty($b) -or $b -match '^[A-Za-z]:\\?$' -or $b -match '~\d' -or $b.StartsWith('\\')) {
  Write-Host 'REFUSED: run the script from its own extracted folder on a local drive, by its full (not shortened) name. Nothing was run.'
  exit 2
}
# Not under OneDrive: there files can be cloud placeholders (reparse points, which the check below refuses as links) and the raw, unredacted output in control\raw would be synced.
foreach ($od in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
  if ($od -and ($b + '\').StartsWith($od.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host 'REFUSED: this folder is inside OneDrive (a Desktop or Documents folder synced by OneDrive is). Extract the artifact again into a folder in Downloads and run it from there. Nothing was run.'
    exit 2
  }
}
# On a drive with access lists (NTFS or ReFS): the container's access is given and taken away by access lists, which a FAT32 or exFAT drive (a USB stick, an SD card) does not have.
$fsKind = ''
try { $fsKind = (New-Object System.IO.DriveInfo($b)).DriveFormat } catch { $fsKind = '' }
if ($fsKind -and $fsKind -ne 'NTFS' -and $fsKind -ne 'ReFS') {
  Write-Host "REFUSED: this folder is on a $fsKind drive, which has no access lists. Extract the artifact again into a folder in Downloads and run it from there. Nothing was run."
  exit 2
}

function Get-Sha256Hex([string] $path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($path)
  try { $h = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
  return (($h | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Every line of SHA256SUMS ("<64 hex>  <relative/path>") must name a regular file of this folder with that hash, and every file of this folder must be named by a line.
# Not counted: SHA256SUMS itself and the folders control\ and results\ that this script makes. A link or junction anywhere is refused (it could point outside the folder).
function Test-Bundle {
  $bad = New-Object System.Collections.Generic.List[string]
  $sums = Join-Path $b 'SHA256SUMS'
  if (-not [System.IO.File]::Exists($sums)) { $bad.Add('SHA256SUMS is missing'); return ,$bad }
  $listed = @{}
  $n = 0
  foreach ($line in [System.IO.File]::ReadAllLines($sums)) {
    $n++
    if ($line.Length -eq 0) { continue }
    if ($line -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9._@/-]+)$') { $bad.Add("SHA256SUMS line $n is not '<sha256>  <path>'"); continue }
    $hash = $Matches[1]; $rel = $Matches[2]
    if ($rel.StartsWith('/') -or $rel.EndsWith('/') -or @($rel.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or $rel -match '^(control|results)/' -or $rel -eq 'SHA256SUMS') { $bad.Add("SHA256SUMS line $n names a path that is not allowed"); continue }
    $key = $rel.ToLowerInvariant()
    if ($listed.ContainsKey($key)) { $bad.Add("SHA256SUMS names $rel twice"); continue }
    $listed[$key] = $true
    $full = Join-Path $b ($rel -replace '/', '\')
    if (-not [System.IO.File]::Exists($full)) { $bad.Add("missing: $rel"); continue }
    if (([System.IO.File]::GetAttributes($full) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $bad.Add("a link, not a file: $rel"); continue }
    if ((Get-Sha256Hex $full) -cne $hash) { $bad.Add("changed (SHA-256 differs): $rel") }
  }
  if ($listed.Count -eq 0) { $bad.Add('SHA256SUMS lists no file') }
  # every entry of the folder, without following any link or junction
  $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  $stack.Push((New-Object System.IO.DirectoryInfo($b)))
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($e in $dir.GetFileSystemInfos()) {
      $rel = $e.FullName.Substring($b.Length + 1) -replace '\\', '/'
      $isDir = ($e.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
      if (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $bad.Add("a link or junction: $rel"); continue }
      if ($isDir) {
        if ($rel -eq 'control' -or $rel -eq 'results') { continue }
        $stack.Push([System.IO.DirectoryInfo] $e); continue
      }
      if ($rel -eq 'SHA256SUMS') { continue }
      if (-not $listed.ContainsKey($rel.ToLowerInvariant())) { $bad.Add("extra file not in SHA256SUMS: $rel") }
    }
  }
  return ,$bad
}

$check = Test-Bundle
if ($check.Count -gt 0) {
  $check | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  Write-Host "REFUSED: $($check.Count) problem(s) with the bundle's files against SHA256SUMS. Download and extract the artifact again into an EMPTY folder (if a file is missing again, your antivirus may have removed it: its history says). Nothing was run."
  exit 2
}
Write-Host 'bundle check: every file matches SHA256SUMS, nothing extra'

# ---------------------------------------------------------------------------------------------- 3. symbolic links and the kind of account
# whoami's privilege names and SIDs are the same in every display language. A whoami that fails gives $null: the report then says "not recorded" and the release gate refuses it.
function Get-WhoamiText([string[]] $whoamiArgs) {
  $t = $null
  try { $t = (& "$env:SystemRoot\System32\whoami.exe" @whoamiArgs) | Out-String; if ($LASTEXITCODE -ne 0) { $t = $null } } catch { $t = $null }
  if ($null -ne $t -and $t.Trim() -eq '') { $t = $null }
  return $t
}
$linkRight = $null
$privText = Get-WhoamiText @('/priv')
if ($null -eq $privText) {
  Write-Host 'symbolic links: whoami /priv could not be read; the report will say the link right was not recorded.'
} elseif ($privText -match 'SeCreateSymbolicLinkPrivilege') {
  $linkRight = 'yes'
  Write-Host 'symbolic links: this account holds the right to create them (SeCreateSymbolicLinkPrivilege).'
} else {
  $linkRight = 'no'
  Write-Host 'symbolic links: this account does not hold SeCreateSymbolicLinkPrivilege (normal for a non-administrator; Developer Mode also allows links).'
  Write-Host '  The cases that plant a FILE symbolic link may be reported inconclusive. That is expected and fine.'
}
# Not elevated is already shown above (the Administrators role check). The Administrators group SID in the token then means an administrator account in a filtered (normal) window.
$accountKind = $null
$groupsText = Get-WhoamiText @('/groups', '/fo', 'csv', '/nh')
if ($null -eq $groupsText) {
  Write-Host 'account: whoami /groups could not be read; the report will say the account kind was not recorded.'
} elseif ($groupsText -match '"S-1-5-32-544"') {
  $accountKind = 'administrator-filtered'
  Write-Host 'account: an administrator account in a normal (not elevated) window.'
} else {
  $accountKind = 'standard'
  Write-Host 'account: a standard account.'
}

# ---------------------------------------------------------------------------------------------- 4. folders and settings
$launcher = Join-Path $b 'bin\nn-launcher.exe'
$node = Join-Path $b 'node\node.exe'
$control = Join-Path $b 'control'
$raw = Join-Path $control 'raw'
$infoDir = Join-Path $control 'info'
$results = Join-Path $b 'results'
# The folders this script writes (not covered by SHA256SUMS) must be plain folders: a link or junction there would send writes, or the delete below, somewhere else.
function Get-EntryKind([string] $p) {
  # GetAttributes reads the entry itself, never a link's target (a dangling link is still a link)
  if (-not ([System.IO.File]::Exists($p) -or [System.IO.Directory]::Exists($p))) { return 'none' }
  $a = [System.IO.File]::GetAttributes($p)
  if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link' }
  if (($a -band [System.IO.FileAttributes]::Directory) -ne 0) { return 'dir' }
  return 'file'
}
foreach ($d in @($control, $raw, $infoDir, (Join-Path $control 'profiles'), $results)) {
  $kind = Get-EntryKind $d
  if ($kind -eq 'link' -or $kind -eq 'file') {
    Write-Host "REFUSED: $($d.Substring($b.Length + 1)) in this folder is a $kind, not a plain folder. Extract the artifact again into an EMPTY folder. Nothing was run."
    exit 2
  }
}
# Removed with [System.IO.Directory]::Delete, which deletes a link inside without following it (Remove-Item -Recurse in Windows PowerShell 5.1 may follow a directory link).
foreach ($d in @($results, $raw)) { if ((Get-EntryKind $d) -eq 'dir') { [System.IO.Directory]::Delete($d, $true) } }
New-Item -ItemType Directory -Path $control, $raw, $infoDir, $results -Force | Out-Null
$env:NIMBLENEWT_WIN_LAUNCHER = "$b\bin\nn-launcher.exe"
$env:NIMBLENEWT_WIN_CONTROL_DIR = "$b\control"
# The bundle's node must load only the bundle's code: options a user environment may carry for node are not passed on.
foreach ($v in @('NODE_OPTIONS', 'NODE_PATH', 'NODE_PRESERVE_SYMLINKS', 'NODE_REPL_EXTERNAL_MODULE')) { [System.Environment]::SetEnvironmentVariable($v, $null, 'Process') }
# Nor any other NimbleNewt setting this account's environment may carry (NIMBLENEWT_WIN_CONTAINER, NIMBLENEWT_WIN_MAX_RUNS, the retired Windows Sandbox ones ...): the run is the bundle's defaults.
foreach ($v in @([System.Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($v -like 'NIMBLENEWT_*' -and $v -ne 'NIMBLENEWT_WIN_LAUNCHER' -and $v -ne 'NIMBLENEWT_WIN_CONTROL_DIR') { [System.Environment]::SetEnvironmentVariable($v, $null, 'Process') }
}
$utf8 = New-Object System.Text.UTF8Encoding $false

function ConvertTo-WinArg([string] $a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $q = $a -replace '(\\*)"', '$1$1\"'
  $q = $q -replace '(\\+)$', '$1$1'
  return '"' + $q + '"'
}

# Runs a program with its standard output and error captured to two files (never to this console: they may hold personal names), optionally with a file as its standard input.
# A program still running after $minutes is stopped and this throws (the caller counts it as a problem and the clean-up text is printed; the backend's own timeouts normally end a case first).
function Invoke-Captured([string] $exe, [string[]] $argv, [string] $outFile, [string] $errFile, [string] $inFile, [int] $minutes) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = (($argv | ForEach-Object { ConvertTo-WinArg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $b
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8
  if ($inFile) { $psi.RedirectStandardInput = $true }
  $p = [System.Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  if ($inFile) {
    $bytes = [System.IO.File]::ReadAllBytes($inFile)
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.Close()
  }
  if (-not $p.WaitForExit($minutes * 60000)) {
    try { $p.Kill() } catch { }
    [void]$p.WaitForExit(30000)
    if ($o.Wait(30000)) { [System.IO.File]::WriteAllText($outFile, $o.Result, $utf8) }
    if ($e.Wait(30000)) { [System.IO.File]::WriteAllText($errFile, $e.Result, $utf8) }
    throw "it was still running after $minutes minutes and was stopped"
  }
  $p.WaitForExit()
  [System.IO.File]::WriteAllText($outFile, $o.Result, $utf8)
  [System.IO.File]::WriteAllText($errFile, $e.Result, $utf8)
  return $p.ExitCode
}

function Get-Field($obj, [string] $name) {
  if ($null -eq $obj) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# Text put between single quotes in a command printed for pasting: PowerShell ends a single-quoted string at ' and also at the typographic quotes U+2018 to U+201B, so each is doubled.
function ConvertTo-Quoted([string] $t) { return "'" + ($t -replace "['\u2018\u2019\u201A\u201B]", '$0$0') + "'" }

# The cleanup a failed run may need: the per-run container profiles whose record is in this folder and whose profile folder still exists, deleted by the launcher with the record's proof.
function Show-Cleanup {
  Write-Host ''
  Write-Host 'CLEAN-UP. The backend sweeps its own leftovers (grants and profiles recorded under control\profiles) the next time this script runs: running it again is the first step.'
  Write-Host 'A per-run profile that is still there can be deleted by the launcher, with the proof its record file holds (name and SID on its second line):'
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  $launcherQ = ConvertTo-Quoted $launcher
  $shown = 0
  foreach ($dir in @($infoDir, (Join-Path $control 'profiles'))) {
    if (-not [System.IO.Directory]::Exists($dir)) { continue }
    foreach ($rec in [System.IO.Directory]::GetFiles($dir, 'NimbleNewtRun-*.sid')) {
      # only a record the backend or this script names (the wildcard also takes longer extensions and any text in the middle)
      if ([System.IO.Path]::GetFileName($rec) -cnotmatch '^NimbleNewtRun-[0-9a-f]{16}\.sid$') { continue }
      $lines = @([System.IO.File]::ReadAllLines($rec))
      if ($lines.Count -lt 2 -or $lines[1] -cnotmatch '^(NimbleNewtRun-[0-9a-f]{16}) (S-1-15-2-[0-9-]+)$') { continue }
      $pname = $Matches[1]; $psid = $Matches[2]
      if (-not (Test-Path -LiteralPath (Join-Path $packages $pname.ToLowerInvariant()))) { continue }
      Write-Host "  & $launcherQ delete-profile --name $pname --sid $psid --profile-record $(ConvertTo-Quoted $rec)"
      $shown++
    }
  }
  if ($shown -eq 0) {
    Write-Host "  & $launcherQ delete-profile --name NimbleNewtRun-<16 hex> --sid <the SID on the second line of its .sid record> --profile-record <that .sid file under control\info or control\profiles>"
    Write-Host '  (no record here names a profile that still exists)'
  }
  Write-Host 'Leftover-profile check (should list nothing):'
  Write-Host '  Get-ChildItem $env:LOCALAPPDATA\Packages -Filter NimbleNewtRun-*'
  if ($script:systemLeft.Count -gt 0) {
    Write-Host 'A confined write got through: these files were left in system folders (the case fails). Delete each, from an administrator PowerShell if a normal one is refused:'
    foreach ($x in $script:systemLeft) { Write-Host "  Remove-Item -LiteralPath $(ConvertTo-Quoted $x)" }
  }
}

# ---------------------------------------------------------------------------------------------- 5. the launcher's info (one throw-away profile)
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$rb = New-Object byte[] 8
$rng.GetBytes($rb); $rng.Dispose()
$infoName = 'NimbleNewtRun-' + (($rb | ForEach-Object { $_.ToString('x2') }) -join '')
$infoRecord = Join-Path $infoDir "$infoName.sid"
$infoOk = $false
try {
  Write-Host 'launcher info: making and deleting one throw-away container profile ...'
  $code = Invoke-Captured $launcher @('info', '--name', $infoName, '--profile-record', $infoRecord) (Join-Path $raw 'info.stdout.txt') (Join-Path $raw 'info.stderr.txt') $null 10
  $infoJson = $null
  foreach ($l in [System.IO.File]::ReadAllLines((Join-Path $raw 'info.stdout.txt'))) { if ($l.StartsWith('{')) { try { $infoJson = $l | ConvertFrom-Json } catch { $infoJson = $null } } }
  $facts = @('ok', 'elevated', 'windowStation', 'windowStationOk', 'profileDeleted', 'profileGone') | ForEach-Object { "$_=$(Get-Field $infoJson $_)" }
  Write-Host "  launcher info (exit $code): $($facts -join ', ')"
  if ($code -eq 0 -and (Get-Field $infoJson 'ok') -eq $true -and (Get-Field $infoJson 'windowStationOk') -eq $true) { $infoOk = $true }
  else { Add-Problem 'the launcher info did not succeed (see results\info.stdout.txt in the zip); the ten cases are not run' }
} catch { Add-Problem "the launcher info could not be run: $($_.Exception.Message)" }

# ---------------------------------------------------------------------------------------------- 6. the ten cases
$evidenceCode = $null
if ($infoOk) {
  try {
    Write-Host 'the ten cases: running (a few minutes; output is kept, not shown) ...'
    # The report's nativeWindows block (card A03b): the launcher's info output (raw; only its fields are read), the account kind and the link right found above.
    $evidenceArgs = @('--import', './scripts/offline-guard.mjs', 'scripts\containment-evidence.mjs', 'run', '--prebuilt', '--out', $results, '--redact', '--native-info', (Join-Path $raw 'info.stdout.txt'))
    if ($null -ne $accountKind) { $evidenceArgs += @('--account-kind', $accountKind) }
    if ($null -ne $linkRight) { $evidenceArgs += @('--symlink-right', $linkRight) }
    $evidenceCode = Invoke-Captured $node $evidenceArgs (Join-Path $raw 'evidence.stdout.txt') (Join-Path $raw 'evidence.stderr.txt') $null 25
    Write-Host "  the evidence run ended with exit $evidenceCode (0: every case held; 1: a case did not hold or there was no capacity; anything else: it failed)"
    if ($evidenceCode -ne 0 -and $evidenceCode -ne 1) { Add-Problem "the evidence run failed (exit $evidenceCode)" }
  } catch { Add-Problem "the evidence run could not be run: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------------------------- 7. redacted copies of the raw output
foreach ($name in @('info.stdout.txt', 'info.stderr.txt', 'evidence.stdout.txt', 'evidence.stderr.txt')) {
  $src = Join-Path $raw $name
  if (-not [System.IO.File]::Exists($src)) { continue }
  try { [void](Invoke-Captured $node @('scripts\redact-log.mjs') (Join-Path $results $name) (Join-Path $raw "redact-$name") $src 5) }
  catch { Add-Problem "the redacted copy of $name could not be made" }
}

# ---------------------------------------------------------------------------------------------- 8. nothing personal may leave in the zip
# The zip's place: the Desktop Explorer shows (a OneDrive-moved Desktop too), else Downloads, else control\ in this folder (not the folder itself: the next run's bundle check would
# refuse it there as an extra file). An older zip of this name (an earlier run's) is removed first, so a refused run never
# leaves an older zip that looks like this run's.
$dest = [System.Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrEmpty($dest) -or -not [System.IO.Directory]::Exists($dest)) { $dest = Join-Path $env:USERPROFILE 'Downloads' }
if (-not [System.IO.Directory]::Exists($dest)) { $dest = $control }
$zip = Join-Path $dest 'nn-g05-results.zip'
$zipBlocked = $false
try { if ([System.IO.File]::Exists($zip)) { [System.IO.File]::Delete($zip); Write-Host 'removed the nn-g05-results.zip of an earlier run' } }
catch { $zipBlocked = $true; Add-Problem 'the nn-g05-results.zip of an earlier run could not be removed; no new zip is made (delete it and run the script again)' }

# The redaction (scripts\redact-log.mjs and --redact) leaves placeholders such as <user>, <home>, <ip>, S-1-5-21-<domain>-<account>; what is looked for here is the text it should have replaced.
# Per-run container SIDs (S-1-15-2-...) are made from the random per-run profile name, not from this PC or account, and the redaction keeps them on purpose: they are not looked for.
$patterns = New-Object System.Collections.Generic.List[object]
function Add-Pattern([string] $label, [string] $regex) { $patterns.Add(@($label, (New-Object System.Text.RegularExpressions.Regex($regex, ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant))))) }
function Add-WordPattern([string] $label, [string] $word) { if ($word -and $word.Length -ge 2) { Add-Pattern $label ('(?<![A-Za-z0-9])' + [regex]::Escape($word) + '(?![A-Za-z0-9])') } }
# A path matched with any run of \ or / between its parts, so C:\Users\x, C:/Users/x and the JSON form C:\\Users\\x are all found.
function ConvertTo-PathPattern([string] $p) { return ((@($p -split '[\\/]+') | Where-Object { $_ -ne '' } | ForEach-Object { [regex]::Escape($_) }) -join '[\\/]+') }
Add-WordPattern 'your account name (USERNAME)' $env:USERNAME
Add-WordPattern 'the computer name (COMPUTERNAME)' $env:COMPUTERNAME
if ($env:USERDOMAIN -ne $env:COMPUTERNAME) { Add-WordPattern 'the account domain name (USERDOMAIN)' $env:USERDOMAIN }
$dnsName = ''
try { $dnsName = [System.Net.Dns]::GetHostName() } catch { $dnsName = '' }
if ($dnsName -ne $env:COMPUTERNAME) { Add-WordPattern 'the network host name' $dnsName }
foreach ($pair in @(@('your home folder (USERPROFILE)', $env:USERPROFILE), @('your local AppData folder (LOCALAPPDATA)', $env:LOCALAPPDATA), @('your TEMP folder', $env:TEMP))) {
  if ($pair[1]) { Add-Pattern $pair[0] (ConvertTo-PathPattern $pair[1]) }
}
if ($env:USERPROFILE) {
  $leaf = [System.IO.Path]::GetFileName($env:USERPROFILE.TrimEnd('\'))
  if ($leaf -ne $env:USERNAME) { Add-WordPattern 'the name of your home folder' $leaf }
}
Add-Pattern 'a ...\Users\ path' '(?<![A-Za-z])[A-Za-z]:[\\/]+Users[\\/]+'
Add-Pattern 'an account SID (S-1-5-21-...)' 'S-1-5-21-\d'
Add-Pattern 'an Azure AD account SID (S-1-12-1-...)' 'S-1-12-1-\d'
Add-Pattern 'a logon session SID (S-1-5-5-...)' 'S-1-5-5-\d'
Add-Pattern 'an IPv4 address' '\b(?!127\.|0\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b'
Add-Pattern 'an IPv6 address' '(?<![0-9A-F:.])[0-9A-F]{1,4}(?:(?::[0-9A-F]{1,4}){7}|(?::[0-9A-F]{1,4}){0,5}::(?:[0-9A-F]{1,4}:){0,5}[0-9A-F]{1,4})(?![0-9A-F:])'
Add-Pattern 'a MAC address' '(?<![0-9A-F])[0-9A-F]{2}([-:])[0-9A-F]{2}(?:\1[0-9A-F]{2}){4}(?![0-9A-F])'
# The redaction's own placeholders are taken out first (each becomes a blank, so no two pieces join into a word), as its last gate (scrub) does: an account or computer named
# like one of them ("User", "Home", "Host") would otherwise match every placeholder and no zip could ever be made.
$placeholders = New-Object System.Text.RegularExpressions.Regex('<(?:user|host|home|sid|ip|email|domain|account|session|vm|other|withheld: possible personal data)>', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
$found = New-Object System.Collections.Generic.List[string]
foreach ($f in [System.IO.Directory]::GetFiles($results, '*', [System.IO.SearchOption]::AllDirectories)) {
  $text = $placeholders.Replace([System.IO.File]::ReadAllText($f), ' ')
  $rel = $placeholders.Replace($f.Substring($b.Length + 1), ' ')
  # the file's name inside the zip is checked as well as its text
  foreach ($p in $patterns) { if ($p[1].IsMatch($text) -or $p[1].IsMatch($rel)) { $found.Add("$rel contains $($p[0])") } }
}
if ($found.Count -gt 0) {
  foreach ($x in $found) { Write-Host "  $x" }
  Add-Problem 'REFUSED to make the zip: the results still hold the text named above (the text itself is not shown). Nothing was zipped; the results stay in results\ in this folder.'
} elseif ($zipBlocked) {
  Write-Host 'no zip: the older one is still there'
} else {
  # ---------------------------------------------------------------------------------------------- 9. the zip
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($results, $zip)
    Write-Host "wrote nn-g05-results.zip in your $(Split-Path -Leaf $dest) folder: please send that file"
  } catch { Add-Problem "the zip could not be written: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------------------------- 10. the answer
$report = Join-Path $results 'containment-win32.json'
$total = 10; $hold = 0; $inconclusive = 0
if ([System.IO.File]::Exists($report)) {
  try {
    $j = [System.IO.File]::ReadAllText($report) | ConvertFrom-Json
    $cases = @(Get-Field $j 'cases')
    $total = $cases.Count
    $hold = @($cases | Where-Object { (Get-Field $_ 'verdict') -eq 'pass' }).Count
    $inconclusive = @($cases | Where-Object { (Get-Field $_ 'verdict') -eq 'inconclusive' }).Count
  } catch { Add-Problem 'the report could not be read' }
} elseif ($infoOk) { Add-Problem 'the evidence run wrote no report' }
Write-Host ''
Write-Host "$hold/$total cases hold, $inconclusive inconclusive"

# A confined write to a system folder that got through leaves its file (the case fails); the unconfined pairing run never tries these paths.
$script:systemLeft = @(@((Join-Path $env:SystemRoot 'g05-x'), (Join-Path $env:SystemRoot 'System32\g05-x'), 'C:\g05-x', 'C:\Program Files\g05-x') | Where-Object { Test-Path -LiteralPath $_ })
if ($script:systemLeft.Count -gt 0) { Add-Problem "$($script:systemLeft.Count) file(s) named g05-x were left in a system folder" }

$left = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'NimbleNewtRun-*' -ErrorAction SilentlyContinue)
Write-Host "leftover NimbleNewtRun-* container profiles under your AppData: $($left.Count)"
if ($left.Count -gt 0) { Add-Problem "$($left.Count) container profile(s) were left behind" }

if ($script:problems.Count -gt 0) {
  Show-Cleanup
  Write-Host ''
  Write-Host "finished with $($script:problems.Count) problem(s)."
  exit 1
}
Write-Host 'finished: no problems.'
exit 0
