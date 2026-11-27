import { execFile } from "node:child_process";

/*
 * The account signed in at the console of this Windows machine, only so redaction (windows-redact.ts; scripts/redact-log.mjs, scripts/containment-evidence.mjs --redact) can hide its name too
 * when it is not the account this process runs as. Read from WMI (Win32_ComputerSystem.UserName), which an ordinary account may read; nothing is compiled, written or changed.
 * Replaces the Windows Sandbox era session probe (windows-real.ts, removed with the Windows Sandbox backend; owner decision 2026-11-26), which asked WTS first and WMI only as its fallback.
 */

const CONSOLE_USER_SCRIPT = "$ErrorActionPreference = 'Stop'; $u = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName; if ($u) { [Console]::Out.Write([string]$u) }";
export const CONSOLE_PROBE_TIMEOUT_MS = 60_000;

/** The probe's output as an account name (`DOMAIN\user` or `user`), or undefined when it is empty or does not look like one. Pure. */
export function consoleUserFromOutput(stdout: string): string | undefined {
  const name = stdout.trim();
  return name !== "" && name.length <= 200 && !/[\r\n\0]/.test(name) ? name : undefined;
}

/** The account signed in at the console, or undefined (not Windows, nobody signed in, or the lookup failed or took longer than a minute). Never throws. */
export async function windowsConsoleUser(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const powershell = `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return new Promise((resolve) => {
    try {
      execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CONSOLE_USER_SCRIPT], { windowsHide: true, timeout: CONSOLE_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
        resolve(error === null ? consoleUserFromOutput(String(stdout)) : undefined);
      });
    } catch { resolve(undefined); }
  });
}
