/**
 * Everything the Windows Sandbox backend does to the machine, behind one interface (card A03b): starting programs, reading the package, the sign-in session and the registry,
 * and the file system. The real implementation is `windows-real.ts` (only meaningful on Windows); the unit tests use a simulated one, so the rules run on any OS.
 * Nothing here can write a registry value, create an account or store a credential: automatic sign-in is configured by the owner locally, never by this program.
 */
export interface WindowsPackageInfo {
  /** The package name, for example `MicrosoftWindows.WindowsSandbox`. */
  readonly name: string;
  /** The hash of the signing publisher, for example `8wekyb3d8bbwe` for Microsoft. */
  readonly publisherId: string;
  readonly version: string;
  readonly installLocation: string;
}

export interface WindowsSession {
  /** The user signed in on the physical console right now, `DOMAIN\name`; absent when nobody is. */
  readonly consoleUser?: string;
  /** True when Windows reports that console session as locked. Absent when it could not be determined. */
  readonly locked?: boolean;
}

export interface WindowsAutologon {
  readonly enabled: boolean;
  readonly user?: string;
  /** True when a password sits in the clear in the registry (never its value). Such a setup is refused. */
  readonly plaintextPasswordStored: boolean;
}

export interface WindowsLockTask {
  readonly present: boolean;
  readonly enabled: boolean;
  /** The program the task runs. */
  readonly executable?: string;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface WindowsHost {
  readonly platform: string;
  env(name: string): string | undefined;
  /** This process's id (for the lock file). */
  readonly pid: number;
  pidAlive(pid: number): boolean;

  exists(path: string): boolean;
  /** True when the path is, or passes through, a symbolic link, a junction or any other reparse point (its real path differs from the path). */
  isLinkOrJunction(path: string): boolean;
  mkdirp(path: string): void;
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  /** Creates the file only if it does not exist yet; false when it does. */
  createExclusive(path: string, text: string): boolean;
  /** Renames a file; throws when the source does not exist (the move is the atomic step). */
  rename(from: string, to: string): void;
  /** The names directly inside a directory; empty when it does not exist. */
  listDir(path: string): string[];
  /** Removes a file or directory tree; no error when it is already gone. */
  remove(path: string): void;

  findPackage(): Promise<WindowsPackageInfo | undefined>;
  /** Whether the file carries a valid Authenticode signature, and by whom. */
  signature(path: string): Promise<{ readonly valid: boolean; readonly subject?: string }>;
  session(): Promise<WindowsSession>;
  autologon(): Promise<WindowsAutologon>;
  lockTask(taskName: string): Promise<WindowsLockTask>;
  /** The accounts other than SYSTEM, Administrators and TrustedInstaller that can write to the path (from its ACL). */
  writableBy(path: string): Promise<readonly string[]>;
  /** Starts a program (no shell) and waits for it. Used for wsb.exe and icacls.exe. */
  run(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number }): Promise<ProcessResult>;
}
