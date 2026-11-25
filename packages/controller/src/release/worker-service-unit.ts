import { win32 } from "node:path";
import { SERVICE_RESTART, ServiceSpecError, checkServicePath, powershellQuote, windowsArg, xmlEscape } from "./service-units.js";

/**
 * The unit that runs the NimbleNewt WORKER unattended as the local standard account of the native Windows launcher (card A03b, follow-up). A PURE generator, like `service-units.ts`: it touches no file, runs
 * nothing, registers nothing. An ADMINISTRATOR registers the text it returns (the steps say how); nothing in the release code, the installer script or a test does.
 *
 * Why a second unit and not a change to the first: the controller's unit (`generateServiceUnit`, win32) is a logon-triggered task of the person who installs it (InteractiveToken). That stays as it was. The worker
 * is different: it must run with nobody signed in, as `nimblenewt-worker` (made by native/install/Install-NimbleNewtLauncher.ps1: a standard user whose random password is held in memory once and never
 * stored, with the right to log on as a batch job and the interactive, Remote Desktop and network logon rights denied).
 *
 * The principal is therefore S4U (Task Scheduler `<LogonType>S4U</LogonType>`). Microsoft's Principal.LogonType page: "When an S4U logon is used, no password is stored by the system and there is no access to either
 * the network or encrypted files." The limits that follow, stated in every unit's notes: no stored password (so there is no `<Password>` anywhere and the task cannot be run by a password); no network credentials
 * (a network share, a domain resource or a remote API that needs the account's own credentials is out of reach; the worker's own token for the controller travels in its configuration's token file, not as a
 * Windows credential); no access to EFS-encrypted files; the task's process runs in a non-interactive session (Session 0) with no window of its own.
 *
 * Shape of the unit (every item is pinned by a test): a boot trigger with a delay (never a logon trigger: nobody is signed in), the S4U principal with LeastPrivilege, no execution time limit (a worker is long
 * running), a single instance (a second start while it runs is ignored), start when available (a missed boot start runs when the machine can), no battery stop, a bounded restart-on-failure (the same bound as the
 * controller's unit), an explicit working directory, and `node --env-file=<worker.env> <worker entry> --config <worker.json>`. The environment reaches the worker only through `worker.env`; no value is in the XML.
 * Nothing in a unit is a secret: the generator takes paths and a name only.
 *
 * Element order follows the Task Scheduler XSD (https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema): the task's children and the settings are `xs:all` (any order; the
 * declared order is used), a trigger is a sequence (Enabled, then the base elements, then Delay), Exec's Command and WorkingDirectory are limited to 260 characters (checked here).
 */
export interface WorkerServiceSpec {
  /** The task's name: letters, digits, dot, dash, underscore (default `NimbleNewtWorker`). */
  readonly name?: string;
  /** Absolute path of node.exe. */
  readonly node: string;
  /** Absolute path of the worker program (`scripts/remote-worker.mjs` of the installed release). */
  readonly entry: string;
  /** Absolute path of the worker's configuration file (`--config`). It holds no secret: the host credential is a token FILE it names (the account must be able to read that file and nobody else). */
  readonly configFile: string;
  /** Absolute working directory, always set: the account must be able to read it. */
  readonly workingDirectory: string;
  /** `COMPUTER\account` (or `account`) the task runs as: the installer's account (default name `nimblenewt-worker`). SYSTEM, administrator and built-in names are refused. */
  readonly windowsUser: string;
  /** The installer's data folder (its `-DataDir`, default `C:\ProgramData\NimbleNewt`); the unit names `worker.env` in it. */
  readonly dataDir?: string;
}

export const WORKER_SERVICE = {
  defaultName: "NimbleNewtWorker",
  defaultDataDir: "C:\\ProgramData\\NimbleNewt",
  envFileName: "worker.env",
  /** The boot trigger waits this long so the network stack and the disks are up (ISO 8601). */
  bootDelay: "PT1M",
} as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The account: an optional computer (NetBIOS-style) part and a name part with EXACTLY the shape the installer's -AccountName accepts (Install-NimbleNewtLauncher.ps1 ValidatePattern; a test pins the
// two), so the unit can only name an account the installer could have made. A SID string (`S-1-5-18` is SYSTEM; Task Scheduler's UserId accepts SIDs) and the built-in and well-known names are refused,
// case-insensitively, with or without a computer part. A RENAMED built-in Administrator cannot be recognised by name: the installer's Verify and the steps' account are the check for that.
const WIN_USER = /^(?:([A-Za-z0-9][A-Za-z0-9_-]{0,14})\\)?([A-Za-z][A-Za-z0-9_-]{0,19})$/;
const REFUSED_NAME = /^(system|localsystem|administrator|administrators|admin|root|guest|guests|users|everyone|localservice|networkservice|defaultaccount|wdagutilityaccount|defaultuser0|krbtgt|trustedinstaller|interactive|network|batch|service|anonymous|authenticated-users)$/i;
const REFUSED_DOMAIN = /^(nt|builtin|nt-authority|nt-service|nt_authority|nt_service|window-manager|font-driver-host|iis-apppool)$/i;
const SID_LIKE = /^s-\d/i;
const MAX_PATH_TEXT = 260;
const bad = (field: string, message: string): never => { throw new ServiceSpecError(field, message); };

/** Printable ASCII only, and none of `^ ` $ ; ! #` on top of what `checkServicePath` refuses (< > : " | ? * %): the paths are also printed into PowerShell steps and read by people. `'` and `&` are allowed and escaped. */
function workerPath(field: string, value: unknown): string {
  const v = checkServicePath("win32", field, value);
  if (!/^[\x20-\x7e]+$/.test(v)) bad(field, "must use printable ASCII characters only");
  if (/[\^`$;!#]/.test(v)) bad(field, "must not contain ^ ` $ ; ! or #");
  if (v.length > MAX_PATH_TEXT) bad(field, `must be at most ${MAX_PATH_TEXT} characters (Task Scheduler's limit for a command and a working directory)`);
  return v;
}

export interface WorkerServiceUnit {
  readonly name: string;
  /** `NimbleNewtWorker.xml`. */
  readonly fileName: string;
  readonly installPath: string;
  /** The task definition (XML). */
  readonly content: string;
  /** Steps for an ADMINISTRATOR, as lines of text (nothing here runs them). */
  readonly steps: readonly string[];
  readonly uninstall: readonly string[];
  /** What the unit cannot do or what is unproven. */
  readonly notes: readonly string[];
}

export function generateWorkerServiceUnit(spec: WorkerServiceSpec): WorkerServiceUnit {
  const name = spec.name ?? WORKER_SERVICE.defaultName;
  if (typeof name !== "string" || !NAME.test(name)) bad("name", "must be 1 to 64 letters, digits, '.', '-' or '_', starting with a letter or digit");
  const node = workerPath("node", spec.node);
  const entry = workerPath("entry", spec.entry);
  const configFile = workerPath("configFile", spec.configFile);
  const workingDirectory = workerPath("workingDirectory", spec.workingDirectory);
  const dataDir = workerPath("dataDir", spec.dataDir ?? WORKER_SERVICE.defaultDataDir);
  const envFile = workerPath("envFile", win32.join(dataDir, WORKER_SERVICE.envFileName));
  // The installer refuses these in the values it writes to worker.env; the file it wrote therefore never sits at such a path.
  if (/['=]/.test(envFile)) bad("dataDir", "must not contain ' or = (the installer refuses them in its own folders)");
  if (typeof spec.windowsUser !== "string" || spec.windowsUser === "") bad("windowsUser", "is required: the installer's account, as COMPUTER\\nimblenewt-worker");
  const um = WIN_USER.exec(spec.windowsUser);
  if (um === null || SID_LIKE.test(um[2]!) || REFUSED_NAME.test(um[2]!) || (um[1] !== undefined && (SID_LIKE.test(um[1]) || REFUSED_DOMAIN.test(um[1])))) bad("windowsUser", "must be the installer's account, as COMPUTER\\user or user (a name the installer's -AccountName accepts: a letter, then up to 19 letters, digits, '_' or '-'); SIDs, SYSTEM, administrator, service and built-in accounts are refused");
  const user = spec.windowsUser;

  const args = [`--env-file=${envFile}`, entry, "--config", configFile].map(windowsArg).join(" ");
  const r = SERVICE_RESTART;
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    "<!-- Generated by nimblenewt-service.mjs (print-worker). No secret and no password is in it: the account has none stored (S4U), the environment is the file named in Arguments (Node's env-file option). Registered by an administrator, never by this program. -->",
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>", `    <Description>${xmlEscape(`NimbleNewt worker (${name}), runs as ${user} without a stored password (S4U)`)}</Description>`, "  </RegistrationInfo>",
    "  <Triggers>", "    <BootTrigger>", "      <Enabled>true</Enabled>", `      <Delay>${WORKER_SERVICE.bootDelay}</Delay>`, "    </BootTrigger>", "  </Triggers>",
    "  <Settings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    `    <RestartOnFailure><Interval>${r.windowsRestartInterval}</Interval><Count>${r.windowsRestartCount}</Count></RestartOnFailure>`,
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <WakeToRun>false</WakeToRun>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    "  <Principals>", '    <Principal id="Worker">', `      <UserId>${xmlEscape(user)}</UserId>`, "      <LogonType>S4U</LogonType>", "      <RunLevel>LeastPrivilege</RunLevel>", "    </Principal>", "  </Principals>",
    '  <Actions Context="Worker">', "    <Exec>", `      <Command>${xmlEscape(node)}</Command>`, `      <Arguments>${xmlEscape(args)}</Arguments>`, `      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`, "    </Exec>", "  </Actions>",
    "</Task>",
    "",
  ];
  const content = lines.join("\n");
  if (content.split("\n").some((l) => l === "'@")) bad("content", "contains a line that would end the install step's here-string early");
  const fileName = `${name}.xml`;
  const q = powershellQuote(name);
  return {
    name, fileName, installPath: `Task Scheduler task '${name}' (no file is needed with Register-ScheduledTask)`, content,
    steps: [
      "Run these in an ELEVATED PowerShell (Run as administrator): registering a boot-triggered task for another account's S4U logon needs an administrator, and the unit itself asks for no more than LeastPrivilege. Nothing below has been run by this program. Run native\\install\\Install-NimbleNewtLauncher.ps1 first (it makes the account, the launcher and worker.env).",
      `if (-not ((Test-Path -LiteralPath ${powershellQuote(node)}) -and (Test-Path -LiteralPath ${powershellQuote(entry)}) -and (Test-Path -LiteralPath ${powershellQuote(configFile)}) -and (Test-Path -LiteralPath ${powershellQuote(envFile)}) -and (Test-Path -LiteralPath ${powershellQuote(workingDirectory)}))) { throw 'node, worker entry, worker configuration, worker.env or working directory is missing' }`,
      `$xml = @'\n${content}'@`,
      `Register-ScheduledTask -TaskName ${q} -Xml $xml   # the account is the S4U principal in the XML: add no user and no password option`,
      `Start-ScheduledTask -TaskName ${q}`,
      `Get-ScheduledTaskInfo -TaskName ${q}`,
      `.\\native\\install\\Install-NimbleNewtLauncher.ps1 -Action Verify   # also reports the task's principal and trigger`,
    ],
    uninstall: [`Stop-ScheduledTask -TaskName ${q}`, `Unregister-ScheduledTask -TaskName ${q} -Confirm:$false`],
    notes: [
      `Registered by an administrator only (a boot trigger and another account's principal need one). It runs as ${user}, which the installer made a standard user: logon type S4U, run level LeastPrivilege, NO stored password and no password element.`,
      "OPEN, registration: Microsoft's 'Security Contexts for Tasks' page lists registering a task 'under the security context of a different user's account' with the S4U logon type among the cases where an administrator must supply a password, and the account's password is not kept by anyone. Whether Register-ScheduledTask -Xml with this S4U principal and no user or password option is accepted is therefore UNPROVEN (the own-hardware proof's first registration shows it). If Windows refuses it, do not work around it here: the fallbacks are in the plan (12.3), and a stored password is a design change.",
      "S4U limits (Microsoft, Principal.LogonType): no password is stored by the system and there is no access to the network or to encrypted files. The worker cannot use this account's own credentials on another computer; its connection to the controller uses the host token file named in its configuration.",
      "The task runs in a non-interactive session (Session 0): no window, nobody signed in needed. Whether an S4U task can create the AppContainer profile and run the launcher with its private window station AS A NON-ADMINISTRATOR is UNPROVEN (Microsoft says only Administrators may name a window station; plan 12.2 risk 6). A failed run says so with stage 'grant'; see the own-hardware proof procedure in the plan.",
      `Starts at boot after ${WORKER_SERVICE.bootDelay}; one instance at a time; no execution time limit. Task Scheduler restarts after a failure ${r.windowsRestartCount} times, ${r.windowsRestartInterval} apart, and cannot tell exit codes apart; after that it stays down until an administrator starts the task. An exit 0 is not restarted.`,
      "The environment comes only from worker.env (the installer's four NIMBLENEWT_WIN_* names). A missing worker.env stops node at once. No log file: the worker's own records are the log.",
      "The text declares UTF-16 as Task Scheduler exports do; Register-ScheduledTask -Xml takes a PowerShell string. To register with schtasks instead, save the text with 'Set-Content -Encoding Unicode' and run 'schtasks /Create /TN <name> /XML <file>' (name no run-as user and no password). That route was not tested.",
    ],
  };
}
