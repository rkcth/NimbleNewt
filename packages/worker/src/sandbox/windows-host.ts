/**
 * Everything the Windows Sandbox backend does to the machine, behind one interface (card A03b): starting programs, reading the package, the sign-in session and the registry,
 * and the file system. The real implementation is `windows-real.ts` (only meaningful on Windows); the unit tests use a simulated one, so the rules run on any OS.
 * Nothing here can write a registry value, create an account or store a credential: automatic sign-in is configured by the owner locally, never by this program.
 */
export interface WindowsPackageInfo {
  /** The package name, for example `MicrosoftWindows.WindowsSandbox`. */
  readonly name: string;
  /** The hash of the signing publisher, for example `cw5n1h2txyewy` (Microsoft, packages that are part of Windows) or `8wekyb3d8bbwe` (Microsoft, Store packages). */
  readonly publisherId: string;
  /** The package family name as Windows reports it (`PackageFamilyName`): `<name>_<publisherId>`. */
  readonly familyName: string;
  readonly version: string;
  readonly installLocation: string;
  /** How Windows says the package itself is signed (`SignatureKind`: None, Developer, Enterprise, Store or System). Absent when not reported. */
  readonly signatureKind?: string;
  /** The package's state as Windows reports it (`Status`: Ok, or a problem such as Tampered or Modified). Absent when not reported. */
  readonly status?: string;
  /** Whether Windows marks the package as one that cannot be removed (`NonRemovable`, part of the system image). Absent when not reported as a true/false value. Recorded only. */
  readonly nonRemovable?: boolean;
  /** Whether the package is a framework package (`IsFramework`). Absent when not reported as a true/false value. Recorded only. */
  readonly isFramework?: boolean;
}

/** One entry of an access list, read by SID (the same in every language). */
export interface WindowsAccessEntry {
  /** The account's SID, exactly as Windows reports it, for example `S-1-5-18`. */
  readonly sid: string;
  /** True for an allow entry, false for a deny entry. */
  readonly allow: boolean;
  /** The access mask as an unsigned 32-bit number (FileSystemRights, generic rights included). */
  readonly rights: number;
  /** Inherited from the parent folder (icacls `(I)`). */
  readonly inherited: boolean;
  /** Passed on to files created inside (icacls `(OI)`). */
  readonly objectInherit: boolean;
  /** Passed on to folders created inside (icacls `(CI)`). */
  readonly containerInherit: boolean;
  /** Passed on one level only (icacls `(NP)`). */
  readonly noPropagate: boolean;
  /** Inherit-only: gives nothing on the object itself, only shapes what is inside (icacls `(IO)`). */
  readonly inheritOnly: boolean;
}

/** What `Get-AuthenticodeSignature` says about one file. */
export interface WindowsSignature {
  /** True only when the status is exactly `Valid`. */
  readonly valid: boolean;
  /** The signer certificate's subject, when there is a signer certificate. */
  readonly subject?: string;
  /** The status name, for example Valid, NotSigned, HashMismatch, NotTrusted or UnknownError. */
  readonly status?: string;
  /** Windows' own explanation, shortened, with the file's path replaced by `<file>`. */
  readonly statusMessage?: string;
  /** Authenticode (signed inside the file), Catalog (signed through an installed catalog) or None. Absent where PowerShell does not report it. */
  readonly signatureType?: string;
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
  /** Whether the file carries a valid Authenticode signature, by whom, and if not, why not. */
  signature(path: string): Promise<WindowsSignature>;
  session(): Promise<WindowsSession>;
  autologon(): Promise<WindowsAutologon>;
  lockTask(taskName: string): Promise<WindowsLockTask>;
  /** The accounts other than SYSTEM, Administrators and TrustedInstaller that can write to the path (from its ACL). */
  writableBy(path: string): Promise<readonly string[]>;
  /**
   * The path's access list by SID (`Get-Acl`). Optional and recorded only, by the real-run findings: no trust decision reads it yet (the decisions use `writableBy`). Throws when
   * the list cannot be read or is not in the expected form.
   */
  accessEntries?(path: string): Promise<readonly WindowsAccessEntry[]>;
  /** The SID of the path's owner (for example `S-1-5-18`), read from its security descriptor. Throws when it cannot be read or is not a SID. */
  ownerSid(path: string): Promise<string>;
  /** Starts a program (no shell) and waits for it. Used for wsb.exe and icacls.exe. */
  run(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number }): Promise<ProcessResult>;
}
