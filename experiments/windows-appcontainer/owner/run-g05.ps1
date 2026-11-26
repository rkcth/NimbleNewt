# run-g05.ps1 - card G05 / A03b: the ten containment cases on this Windows PC, run from the owner bundle that CI built (artifact windows-g05-owner-bundle).
#
# How to run it (Windows PowerShell 5.1 or PowerShell 7, as your normal account, NOT "Run as administrator"):
#   1. Download the artifact windows-g05-owner-bundle from the workflow run and extract it to a folder of its own (for example in Downloads).
#   2. Open a normal PowerShell window in that folder and run:
#        powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-g05.ps1
#      (-ExecutionPolicy Bypass applies to this one PowerShell process only; nothing is changed on the machine.)
#   3. Send the file nn-g05-results.zip it leaves on your Desktop (or in Downloads when there is no Desktop folder).
#
# What it does, in order, and what it never does:
#   - refuses to run elevated (a member of Administrators with an elevated token): the question is what a NORMAL signed-in account can confine;
#   - checks every file of this folder against SHA256SUMS (a missing, extra or changed file stops it before anything runs);
#   - says whether this account may create symbolic links (whoami /priv); without that right the cases that plant a FILE symbolic link may be inconclusive, which is fine;
#   - runs bin\nn-launcher.exe info once (a throw-away per-run container profile, made and deleted again);
#   - runs the ten cases with the bundle's own node.exe and scripts (no network: scripts\offline-guard.mjs is loaded first);
#   - keeps the raw output only under control\raw\ in this folder, and puts copies with names, paths, SIDs and addresses replaced into results\;
#   - refuses to make the zip when results\ still holds your account name, computer name, home folder, a C:\Users\ path, an account or container SID, or an IP or MAC address
#     (it prints which kind of text, never the text itself);
#   - writes nn-g05-results.zip and prints "N/10 cases hold, M inconclusive".
# It downloads nothing, installs nothing, and changes no security setting, policy, registry value, firewall rule, service or scheduled task.
# Everything it writes is inside this folder, the container profiles the launcher makes and deletes again under your own AppData, and the zip.
[CmdletBinding()]
param()

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$b = $PSScriptRoot
$script:problems = New-Object System.Collections.Generic.List[string]
function Add-Problem([string] $m) { $script:problems.Add($m); Write-Host "FAILED: $m" }

Write-Host 'NimbleNewt G05 owner run: the ten containment cases on this PC (card A03b).'

# ---------------------------------------------------------------------------------------------- 1. never elevated
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'REFUSED: this PowerShell is elevated (Run as administrator). Close it, open a NORMAL PowerShell window and run the script again. Nothing was run.'
  exit 2
}
Write-Host 'not elevated: good'

# ---------------------------------------------------------------------------------------------- 2. the folder itself
if ([string]::IsNullOrEmpty($b) -or $b -match '^[A-Za-z]:\\?$' -or $b -match '~\d' -or $b.StartsWith('\\')) {
  Write-Host 'REFUSED: run the script from its own extracted folder on a local drive, by its full (not shortened) name. Nothing was run.'
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
    if ($rel.StartsWith('/') -or $rel.EndsWith('/') -or ($rel.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) -or $rel -match '^(control|results)/' -or $rel -eq 'SHA256SUMS') { $bad.Add("SHA256SUMS line $n names a path that is not allowed"); continue }
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
  Write-Host "REFUSED: $($check.Count) problem(s) with the bundle's files against SHA256SUMS. Download and extract the artifact again into an EMPTY folder. Nothing was run."
  exit 2
}
Write-Host 'bundle check: every file matches SHA256SUMS, nothing extra'

# ---------------------------------------------------------------------------------------------- 3. symbolic links
$privText = ''
try { $privText = (& "$env:SystemRoot\System32\whoami.exe" /priv) | Out-String } catch { $privText = '' }
if ($privText -match 'SeCreateSymbolicLinkPrivilege') {
  Write-Host 'symbolic links: this account holds the right to create them (SeCreateSymbolicLinkPrivilege).'
} else {
  Write-Host 'symbolic links: this account does not hold SeCreateSymbolicLinkPrivilege (normal for a non-administrator; Developer Mode also allows links).'
  Write-Host '  The cases that plant a FILE symbolic link may be reported inconclusive. That is expected and fine.'
}

# ---------------------------------------------------------------------------------------------- 4. folders and settings
$launcher = Join-Path $b 'bin\nn-launcher.exe'
$node = Join-Path $b 'node\node.exe'
$control = Join-Path $b 'control'
$raw = Join-Path $control 'raw'
$infoDir = Join-Path $control 'info'
$results = Join-Path $b 'results'
foreach ($d in @($results, $raw)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
New-Item -ItemType Directory -Path $control, $raw, $infoDir, $results -Force | Out-Null
$env:NIMBLENEWT_WIN_LAUNCHER = "$b\bin\nn-launcher.exe"
$env:NIMBLENEWT_WIN_CONTROL_DIR = "$b\control"
$utf8 = New-Object System.Text.UTF8Encoding $false

function ConvertTo-WinArg([string] $a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $q = $a -replace '(\\*)"', '$1$1\"'
  $q = $q -replace '(\\+)$', '$1$1'
  return '"' + $q + '"'
}

# Runs a program with its standard output and error captured to two files (never to this console: they may hold personal names), optionally with a file as its standard input.
function Invoke-Captured([string] $exe, [string[]] $argv, [string] $outFile, [string] $errFile, [string] $inFile) {
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

# The cleanup a failed run may need: the per-run container profiles whose record is in this folder and whose profile folder still exists, deleted by the launcher with the record's proof.
function Show-Cleanup {
  Write-Host ''
  Write-Host 'CLEAN-UP. The backend sweeps its own leftovers (grants and profiles recorded under control\profiles) the next time this script runs: running it again is the first step.'
  Write-Host 'A per-run profile that is still there can be deleted by the launcher, with the proof its record file holds (name and SID on its second line):'
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  $shown = 0
  foreach ($dir in @($infoDir, (Join-Path $control 'profiles'))) {
    if (-not [System.IO.Directory]::Exists($dir)) { continue }
    foreach ($rec in [System.IO.Directory]::GetFiles($dir, 'NimbleNewtRun-*.sid')) {
      $lines = @([System.IO.File]::ReadAllLines($rec))
      if ($lines.Count -lt 2 -or $lines[1] -cnotmatch '^(NimbleNewtRun-[0-9a-f]{16}) (S-1-15-2-[0-9-]+)$') { continue }
      $pname = $Matches[1]; $psid = $Matches[2]
      if (-not (Test-Path -LiteralPath (Join-Path $packages $pname.ToLowerInvariant()))) { continue }
      Write-Host "  & '$launcher' delete-profile --name $pname --sid $psid --profile-record '$rec'"
      $shown++
    }
  }
  if ($shown -eq 0) {
    Write-Host "  & '$launcher' delete-profile --name NimbleNewtRun-<16 hex> --sid <the SID on the second line of its .sid record> --profile-record <that .sid file under control\info or control\profiles>"
    Write-Host '  (no record here names a profile that still exists)'
  }
  Write-Host 'Leftover-profile check (should list nothing):'
  Write-Host '  Get-ChildItem $env:LOCALAPPDATA\Packages -Filter NimbleNewtRun-*'
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
  $code = Invoke-Captured $launcher @('info', '--name', $infoName, '--profile-record', $infoRecord) (Join-Path $raw 'info.stdout.txt') (Join-Path $raw 'info.stderr.txt') $null
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
    $evidenceCode = Invoke-Captured $node @('--import', './scripts/offline-guard.mjs', 'scripts\containment-evidence.mjs', 'run', '--prebuilt', '--out', $results, '--redact') (Join-Path $raw 'evidence.stdout.txt') (Join-Path $raw 'evidence.stderr.txt') $null
    Write-Host "  the evidence run ended with exit $evidenceCode (0: every case held; 1: a case did not hold or there was no capacity; anything else: it failed)"
    if ($evidenceCode -ne 0 -and $evidenceCode -ne 1) { Add-Problem "the evidence run failed (exit $evidenceCode)" }
  } catch { Add-Problem "the evidence run could not be started: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------------------------- 7. redacted copies of the raw output
foreach ($name in @('info.stdout.txt', 'info.stderr.txt', 'evidence.stdout.txt', 'evidence.stderr.txt')) {
  $src = Join-Path $raw $name
  if (-not [System.IO.File]::Exists($src)) { continue }
  try { [void](Invoke-Captured $node @('scripts\redact-log.mjs') (Join-Path $results $name) (Join-Path $raw "redact-$name") $src) }
  catch { Add-Problem "the redacted copy of $name could not be made" }
}

# ---------------------------------------------------------------------------------------------- 8. nothing personal may leave in the zip
$patterns = New-Object System.Collections.Generic.List[object]
function Add-Pattern([string] $label, [string] $regex) { $patterns.Add(@($label, (New-Object System.Text.RegularExpressions.Regex($regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)))) }
if ($env:USERNAME -and $env:USERNAME.Length -ge 2) { Add-Pattern 'your account name (USERNAME)' ('(?<![A-Za-z0-9])' + [regex]::Escape($env:USERNAME) + '(?![A-Za-z0-9])') }
if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 2) { Add-Pattern 'the computer name (COMPUTERNAME)' ('(?<![A-Za-z0-9])' + [regex]::Escape($env:COMPUTERNAME) + '(?![A-Za-z0-9])') }
if ($env:USERPROFILE) { Add-Pattern 'your home folder (USERPROFILE)' ([regex]::Escape($env:USERPROFILE)) }
Add-Pattern 'a C:\Users\ path' ([regex]::Escape('C:\Users\'))
Add-Pattern 'an account SID (S-1-5-21-)' 'S-1-5-21-'
Add-Pattern 'a container SID (S-1-15-2-)' 'S-1-15-2-'
Add-Pattern 'an IPv4 address' '\b(?!127\.|0\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b'
Add-Pattern 'a MAC address' '(?<![0-9A-F])[0-9A-F]{2}([-:])[0-9A-F]{2}(?:\1[0-9A-F]{2}){4}(?![0-9A-F])'
$found = New-Object System.Collections.Generic.List[string]
foreach ($f in [System.IO.Directory]::GetFiles($results, '*', [System.IO.SearchOption]::AllDirectories)) {
  $text = [System.IO.File]::ReadAllText($f)
  $rel = $f.Substring($b.Length + 1)
  foreach ($p in $patterns) { if ($p[1].IsMatch($text)) { $found.Add("$rel contains $($p[0])") } }
}
$zip = $null
if ($found.Count -gt 0) {
  foreach ($x in $found) { Write-Host "  $x" }
  Add-Problem 'REFUSED to make the zip: the results still hold the text named above (the text itself is not shown). Nothing was zipped; the results stay in results\ in this folder.'
} else {
  # ---------------------------------------------------------------------------------------------- 9. the zip
  $dest = Join-Path $env:USERPROFILE 'Desktop'
  if (-not [System.IO.Directory]::Exists($dest)) { $dest = Join-Path $env:USERPROFILE 'Downloads' }
  if (-not [System.IO.Directory]::Exists($dest)) { $dest = $b }
  $zip = Join-Path $dest 'nn-g05-results.zip'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ([System.IO.File]::Exists($zip)) { [System.IO.File]::Delete($zip) }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($results, $zip)
    Write-Host "wrote nn-g05-results.zip in your $(Split-Path -Leaf $dest) folder: please send that file"
  } catch { $zip = $null; Add-Problem "the zip could not be written: $($_.Exception.Message)" }
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
