import { posix, win32 } from "node:path";
import { SUPERVISOR_EXIT } from "./supervisor.js";

/**
 * Service units for the release launcher (card K02, follow-up): a PURE generator. It turns a validated description of one installation into the text of a launchd agent (macOS), a systemd user unit (Linux) or a
 * Task Scheduler task (Windows), plus the exact steps the owner runs to install it. It touches no file, runs nothing, installs nothing and enables nothing; a human decides to run the printed steps.
 *
 * Rules every unit follows:
 * - It runs as the person who installs it (a launchd LaunchAgent, a systemd USER unit, a task for the logged-on user), never as root and never with elevated rights. There is no `User=`/`UserName` to name root.
 * - No secret is ever written into a unit. Environment comes from a file the owner keeps: `EnvironmentFile=` (systemd) or `node --env-file=<file>` (launchd and Windows, which have no such setting; the launcher
 *   passes its environment to the controller unchanged). The generator refuses controller arguments that look like a credential, so a key cannot be pasted into a unit by mistake.
 * - Every path must be absolute, already normalised, and free of control characters (newline, NUL, the Unicode line separators, ...). Each value is then escaped for the format it lands in (XML, the systemd
 *   command line, the Windows command line), and the few paths that land unquoted in a systemd directive must also be plain (no spaces, quotes, backslashes or `$`).
 * - The restart policy follows the launcher's exit codes (`SUPERVISOR_EXIT`): 0 stopped on purpose, 2 blocked, 3 no release and 4 crash loop are NOT restarted (nothing changes until the owner acts, and a
 *   crash loop was already slowed 20 times); 1 (usage or unexpected error) and 5 (another launcher holds the root) are restarted after a delay, rate limited. Only systemd can say this per code. launchd and Task
 *   Scheduler restart on any failure, so for them the delay and the number of tries are the limit (see `SERVICE_RESTART`).
 */
export const SERVICE_PLATFORMS = ["linux", "darwin", "win32"] as const;
export type ServicePlatform = (typeof SERVICE_PLATFORMS)[number];

/** The launcher's exit codes grouped by what a service manager should do. Derived from `SUPERVISOR_EXIT` so a changed code cannot silently drift from the units. */
export const SERVICE_RESTART = {
  /** Never restarted: 0 stopped on purpose, 2 blocked, 3 no active release, 4 crash loop (the owner's notice is written). */
  noRestart: [SUPERVISOR_EXIT.stopped, SUPERVISOR_EXIT.blocked, SUPERVISOR_EXIT.noRelease, SUPERVISOR_EXIT.crashLoop] as readonly number[],
  /** Restarted after the delay: 1 usage or unexpected error (the launcher's own code, not in `SUPERVISOR_EXIT`), 5 another launcher or a leftover controller holds the root. */
  restart: [1, SUPERVISOR_EXIT.locked] as readonly number[],
  /** Seconds a service manager waits before a restart. */
  delaySeconds: 30,
  /** systemd: at most this many starts in `startLimitIntervalSeconds`, then it stops trying (the owner sees `failed`). */
  startLimitBurst: 5,
  startLimitIntervalSeconds: 600,
  /** launchd cannot tell exit codes apart: at least this long between starts. */
  launchdThrottleSeconds: 60,
  /** Task Scheduler cannot tell exit codes apart: this many restarts, this far apart (ISO 8601 duration). */
  windowsRestartCount: 3,
  windowsRestartInterval: "PT1M",
  /** How long a service manager waits for the launcher's own stop (it gives the controller its grace first) before it kills. */
  stopTimeoutSeconds: 90,
} as const;

export type ProtectSystem = "full" | "strict";

export interface ServiceSpec {
  readonly platform: ServicePlatform;
  /** Short name of the service: letters, digits, dot, dash, underscore (default `nimblenewt`). The launchd label is `local.<name>`. */
  readonly name?: string;
  /** Absolute path of the Node.js binary that runs the launcher. */
  readonly node: string;
  /** Absolute path of `scripts/nimblenewt-launcher.mjs`. */
  readonly launcher: string;
  /** Absolute path of the release root. */
  readonly root: string;
  /** The controller's entry file inside a release (the launcher's `--entry`, default `controller.js`). */
  readonly entry?: string;
  readonly switcher?: "pointer" | "symlink";
  /** Arguments after `--`, given to the controller. */
  readonly controllerArgs?: readonly string[];
  /** Absolute path of a file with KEY=value lines. Referenced, never read or written here. */
  readonly envFile?: string;
  /** Absolute directory for the log file `<name>.log` (stdout and stderr). Without it launchd discards output and systemd uses the journal; Task Scheduler has no log. */
  readonly logDir?: string;
  /** Windows only: `DOMAIN\user` or `user` the task is registered for; default the user who registers it. */
  readonly windowsUser?: string;
  /** systemd: `full` (default; /usr, /boot and /etc read-only) or `strict` (the whole file system read-only except the root, the log directory and `readWritePaths`). */
  readonly protectSystem?: ProtectSystem;
  /** systemd `strict` only: further directories the controller writes (its data directory, for example). */
  readonly readWritePaths?: readonly string[];
}

export interface ServiceUnit {
  readonly platform: ServicePlatform;
  readonly name: string;
  /** The file name the unit is saved under (`nimblenewt.service`, `local.nimblenewt.plist`, `nimblenewt.xml`). */
  readonly fileName: string;
  /** Where the owner saves it, as the platform spells it (`~` is the home directory). */
  readonly installPath: string;
  readonly content: string;
  /** Commands for the owner to run, in order, as lines of text for a person (nothing here is run by this program). */
  readonly steps: readonly string[];
  readonly uninstall: readonly string[];
  /** What the unit cannot do on this platform. */
  readonly notes: readonly string[];
}

export class ServiceSpecError extends Error {
  constructor(readonly field: string, message: string) { super(`${field}: ${message}`); this.name = "ServiceSpecError"; }
}
const bad = (field: string, message: string): never => { throw new ServiceSpecError(field, message); };

// Control characters (C0, DEL, C1), the Unicode line and paragraph separators, byte order marks and the XML-forbidden non-characters. Nothing legitimate in a path or an argument is among them.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff\ud800-\udfff]/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEXT = 1024;
const MAX_ARGS = 32;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WIN_USER = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,62}\\)?[A-Za-z0-9][A-Za-z0-9._ -]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
/** A value that looks like a credential; the unit takes none (the environment file does). */
const SECRETISH = /(secret|token|passw|api[-_]?key|credential|private[-_]?key|bearer|authorization)/i;
/** Well-known shapes of a key itself: OpenAI-style, GitHub, AWS access key, a JSON web token. */
const SECRET_VALUE = /(\bsk-[A-Za-z0-9_-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const SECRET_REFERENCE = /(file|path|name|dir)$/i;
/** Lines of the install steps that could end a here-document or here-string early. */
const HEREDOC_END = "NIMBLENEWT_UNIT_END";

function text(field: string, value: unknown): string {
  if (typeof value !== "string" || value === "") return bad(field, "must be a non-empty string");
  if (value.length > MAX_TEXT) bad(field, `must be at most ${MAX_TEXT} characters`);
  if (FORBIDDEN_CHARS.test(value)) bad(field, "must not contain control characters, line breaks or invalid characters");
  return value;
}

/** An absolute, already normalised path in the target platform's spelling (the platform of the machine the service runs on, not the one printing it). */
export function checkServicePath(platform: ServicePlatform, field: string, value: unknown): string {
  const v = text(field, value);
  if (platform === "win32") {
    if (!/^[A-Za-z]:\\/.test(v)) bad(field, "must be an absolute path on a drive, such as C:\\NimbleNewt (UNC and \\\\?\\ paths are refused)");
    if (win32.normalize(v) !== v) bad(field, "must be normalised (backslashes only, no '.', '..' or doubled separators)");
    if (v.length > 3 && v.endsWith("\\")) bad(field, "must not end with a separator");
    const rest = v.slice(3);
    if (/[<>:"|?*%]/.test(rest)) bad(field, 'contains a character Windows does not allow in a name or expands in a task (< > : " | ? * %)');
    for (const part of rest.split("\\")) {
      if (part === "") continue;
      if (/[ .]$/.test(part) || WIN_RESERVED.test(part)) bad(field, `${part.slice(0, 40)} is not a valid Windows name`);
    }
    return v;
  }
  if (!v.startsWith("/")) bad(field, "must be an absolute path (starting with /)");
  if (v !== "/" && (v.endsWith("/") || posix.normalize(v) !== v)) bad(field, "must be normalised (no '.', '..', doubled or trailing separators)");
  return v;
}
/** A path that a systemd directive reads unquoted (EnvironmentFile, StandardOutput=append:, ReadWritePaths): plain characters only, so no splitting, unquoting or expansion can change it. `%` is allowed and doubled. */
function plainPath(platform: ServicePlatform, field: string, value: unknown): string {
  const v = checkServicePath(platform, field, value);
  if (!/^\/[A-Za-z0-9_@%+=:,./-]*$/.test(v)) bad(field, "for a systemd unit this path may only use letters, digits and _ @ % + = : , . / - (no spaces, quotes, backslashes or $)");
  return v;
}

function argument(field: string, value: unknown): string {
  const v = text(field, value);
  // Node.js itself reads --env-file anywhere on its command line, so an argument like that would load a file into the launcher.
  if (/^--env-file(-if-exists)?(=|$)/.test(v)) bad(field, "Node.js would read --env-file itself; name the environment file in the service settings");
  if (SECRETISH.test(v) && !SECRET_REFERENCE.test(v.replace(/=.*$/s, ""))) bad(field, "looks like a credential or names one; put secrets in the environment file, never in a unit");
  if (SECRET_VALUE.test(v)) bad(field, "looks like a key; put secrets in the environment file, never in a unit");
  if (/:\/\/[^/\s@]*:[^/\s@]*@/.test(v)) bad(field, "contains a user name and password in an address; put the credential in the environment file");
  return v;
}

// ---- escaping for each target format ----

/** XML text or attribute content. */
export function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
/** One word of a systemd command line: double-quoted, with `\`, `"` escaped and `%` and `$` doubled (systemd expands specifiers and variables otherwise). A lone `;` is a command separator and is refused. */
export function systemdWord(s: string): string {
  if (s === ";") bad("argument", "a lone ';' separates commands in a systemd command line");
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`;
}
/** One argument of a Windows command line, quoted the way CommandLineToArgvW reads it. */
export function windowsArg(s: string): string {
  if (s === "") return '""';
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') { out += "\\".repeat(backslashes * 2 + 1) + '"'; } else out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}
/** A POSIX shell word, single-quoted. */
export function shellQuote(s: string): string { return `'${s.replaceAll("'", "'\\''")}'`; }
/** A PowerShell single-quoted string. */
export function powershellQuote(s: string): string { return `'${s.replaceAll("'", "''")}'`; }

interface Checked {
  readonly platform: ServicePlatform;
  readonly name: string;
  readonly node: string;
  readonly launcher: string;
  readonly root: string;
  readonly entry: string;
  readonly switcher: "pointer" | "symlink";
  readonly controllerArgs: readonly string[];
  readonly envFile?: string;
  readonly logDir?: string;
  readonly windowsUser?: string;
  readonly protectSystem: ProtectSystem;
  readonly readWritePaths: readonly string[];
}

export function checkServiceSpec(spec: ServiceSpec): Checked {
  const p = spec.platform;
  if (!SERVICE_PLATFORMS.includes(p)) bad("platform", `must be one of ${SERVICE_PLATFORMS.join(", ")}`);
  const name = spec.name ?? "nimblenewt";
  if (typeof name !== "string" || !NAME.test(name)) bad("name", "must be 1 to 64 letters, digits, '.', '-' or '_', starting with a letter or digit");
  const entry = text("entry", spec.entry ?? "controller.js");
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.split(/[\\/]/).includes("..") || entry.includes("\\") || /[\s"'$`%]/.test(entry)) bad("entry", "must be a plain path inside the release (no '..', drive, spaces or quotes)");
  const switcher = spec.switcher ?? "pointer";
  if (switcher !== "pointer" && switcher !== "symlink") bad("switcher", "must be pointer or symlink");
  if (p === "win32" && switcher === "symlink") bad("switcher", "a symlink pointer needs a privilege on Windows; use pointer");
  const args = spec.controllerArgs ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) bad("controllerArgs", `must be a list of at most ${MAX_ARGS} arguments`);
  const controllerArgs = args.map((a, i) => argument(`controllerArgs[${i}]`, a));
  if (p === "win32") controllerArgs.forEach((a, i) => { if (a.includes("%")) bad(`controllerArgs[${i}]`, "'%' is expanded by Windows; not allowed in a task argument"); });
  const rw = spec.readWritePaths ?? [];
  if (rw.length > 0 && (p !== "linux" || spec.protectSystem !== "strict")) bad("readWritePaths", "only meaningful for a systemd unit with protectSystem 'strict'");
  if (rw.length > 32) bad("readWritePaths", "at most 32 directories");
  if (spec.protectSystem !== undefined && p !== "linux") bad("protectSystem", "systemd only");
  if (spec.protectSystem !== undefined && spec.protectSystem !== "full" && spec.protectSystem !== "strict") bad("protectSystem", "must be full or strict");
  if (spec.windowsUser !== undefined && p !== "win32") bad("windowsUser", "Windows only");
  const windowsUser = spec.windowsUser === undefined ? undefined : text("windowsUser", spec.windowsUser);
  if (windowsUser !== undefined && (!WIN_USER.test(windowsUser) || /^(system|administrator|root|localsystem|nt authority\\.*|builtin\\.*)$/i.test(windowsUser))) bad("windowsUser", "must be an ordinary account name (DOMAIN\\user or user); SYSTEM and administrator accounts are refused");
  const linux = p === "linux";
  // Under ProtectSystem=strict the root is listed in ReadWritePaths, which systemd splits and expands: it must be plain.
  if (linux && spec.protectSystem === "strict") plainPath(p, "root", spec.root);
  const path = (field: string, value: unknown): string => (linux ? plainPath(p, field, value) : checkServicePath(p, field, value));
  return {
    platform: p,
    name,
    node: checkServicePath(p, "node", spec.node),
    launcher: checkServicePath(p, "launcher", spec.launcher),
    root: checkServicePath(p, "root", spec.root),
    entry,
    switcher,
    controllerArgs,
    ...(spec.envFile === undefined ? {} : { envFile: path("envFile", spec.envFile) }),
    ...(spec.logDir === undefined ? {} : { logDir: path("logDir", spec.logDir) }),
    ...(windowsUser === undefined ? {} : { windowsUser }),
    protectSystem: spec.protectSystem ?? "full",
    readWritePaths: rw.map((v, i) => plainPath(p, `readWritePaths[${i}]`, v)),
  };
}

/** The launcher's own argument list (everything after the script path), the same on every platform. */
function launcherArgs(c: Checked): string[] {
  return ["--root", c.root, "--entry", c.entry, "--switcher", c.switcher, ...(c.controllerArgs.length === 0 ? [] : ["--", ...c.controllerArgs])];
}
/** `node [--env-file=FILE] launcher.mjs ...` as an argument vector. */
function commandVector(c: Checked, withEnvFile: boolean): string[] {
  return [c.node, ...(withEnvFile && c.envFile !== undefined ? [`--env-file=${c.envFile}`] : []), c.launcher, ...launcherArgs(c)];
}
const logFile = (c: Checked, sep: string): string | undefined => (c.logDir === undefined ? undefined : `${c.logDir}${sep}${c.name}.log`);

// ---- systemd ----

function systemdUnit(c: Checked): ServiceUnit {
  const pct = (s: string): string => s.replaceAll("%", "%%");
  const log = logFile(c, "/");
  const strict = c.protectSystem === "strict";
  const writable = [c.root, ...(c.logDir === undefined ? [] : [c.logDir]), ...c.readWritePaths];
  const lines = [
    "# Generated by nimblenewt-service.mjs. It holds no secrets: keep them in the environment file named below.",
    "[Unit]",
    `Description=NimbleNewt release launcher (${c.name})`,
    `StartLimitIntervalSec=${SERVICE_RESTART.startLimitIntervalSeconds}`,
    `StartLimitBurst=${SERVICE_RESTART.startLimitBurst}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${commandVector(c, false).map(systemdWord).join(" ")}`,
    ...(c.envFile === undefined ? [] : [`EnvironmentFile=${pct(c.envFile)}`]),
    // Restart on a crash of the launcher itself (1, a signal) and on 5; never after a stop on purpose (0), blocked (2), no release (3) or a crash loop (4).
    "Restart=on-failure",
    `RestartPreventExitStatus=${SERVICE_RESTART.noRestart.filter((n) => n !== 0).join(" ")}`,
    `RestartSec=${SERVICE_RESTART.delaySeconds}`,
    // The launcher stops its controller in order (SIGTERM, grace, SIGKILL); systemd signals the launcher only, and kills what is left when the stop takes too long.
    "KillMode=mixed",
    "KillSignal=SIGTERM",
    `TimeoutStopSec=${SERVICE_RESTART.stopTimeoutSeconds}`,
    ...(log === undefined ? [] : [`StandardOutput=append:${pct(log)}`, `StandardError=append:${pct(log)}`]),
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    `ProtectSystem=${c.protectSystem}`,
    ...(strict ? [`ReadWritePaths=${writable.map((w) => `"${pct(w)}"`).join(" ")}`] : []),
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  const fileName = `${c.name}.service`;
  const dir = '"$HOME/.config/systemd/user"';
  const target = `${dir}/${fileName}`;
  const content = lines.join("\n");
  hereDocGuard(content);
  return {
    platform: "linux", name: c.name, fileName, installPath: `~/.config/systemd/user/${fileName}`, content,
    steps: [
      "Run these as YOUR user (not root, not sudo). Nothing below has been run by this program.",
      `test -x ${shellQuote(c.node)} && test -f ${shellQuote(c.launcher)} && test -d ${shellQuote(c.root)}`,
      ...(c.envFile === undefined ? [] : [`test -f ${shellQuote(c.envFile)} && chmod 600 ${shellQuote(c.envFile)}   # your KEY=value lines; the unit only names this file`]),
      ...(c.logDir === undefined ? [] : [`mkdir -p -m 700 ${shellQuote(c.logDir)}`]),
      `mkdir -p ${dir}`,
      `cat > ${target} <<'${HEREDOC_END}'\n${content}${HEREDOC_END}`,
      `systemd-analyze --user verify ${target}`,
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${fileName}`,
      `systemctl --user status ${fileName}`,
      "loginctl enable-linger \"$USER\"   # optional: keep it running when you are logged out",
    ],
    uninstall: [`systemctl --user disable --now ${fileName}`, `rm ${target}`, "systemctl --user daemon-reload"],
    notes: [
      `Exit codes: ${SERVICE_RESTART.noRestart.join(", ")} are never restarted (0 stopped on purpose, 2 blocked, 3 no release, 4 crash loop: nothing changes until you act; restart by hand with 'systemctl --user restart ${fileName}'). 1 and 5 are restarted after ${SERVICE_RESTART.delaySeconds} s, at most ${SERVICE_RESTART.startLimitBurst} starts in ${SERVICE_RESTART.startLimitIntervalSeconds} s.`,
      "Hardening: NoNewPrivileges, PrivateTmp (the controller and its workers see a private /tmp), ProtectSystem, RestrictSUIDSGID, RestrictRealtime, LockPersonality, UMask 0077.",
      ...(strict ? [] : ["ProtectSystem=full keeps /usr, /boot and /etc read-only and leaves your home and data directories writable; use protectSystem 'strict' with the controller's data directories as read-write paths for more."]),
      ...(log === undefined ? ["Output goes to the journal: journalctl --user -u " + fileName] : [`Output is appended to ${log}; rotate it yourself (logrotate or similar), nothing here does.`]),
    ],
  };
}

// ---- launchd ----

function plistString(s: string): string { return `<string>${xmlEscape(s)}</string>`; }
function launchdPlist(c: Checked): ServiceUnit {
  const label = `local.${c.name}`;
  const log = logFile(c, "/");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Generated by nimblenewt-service.mjs. It holds no secrets: keep them in the environment file named in ProgramArguments (Node's env-file option). -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>", `  ${plistString(label)}`,
    "  <key>ProgramArguments</key>", "  <array>", ...commandVector(c, true).map((a) => `    ${plistString(a)}`), "  </array>",
    "  <key>WorkingDirectory</key>", `  ${plistString(c.root)}`,
    "  <key>RunAtLoad</key>", "  <true/>",
    // Restart only after a failure: an exit 0 (a stop on purpose, SIGTERM from launchctl) stays down. launchd cannot separate the other codes.
    "  <key>KeepAlive</key>", "  <dict>", "    <key>SuccessfulExit</key>", "    <false/>", "  </dict>",
    "  <key>ThrottleInterval</key>", `  <integer>${SERVICE_RESTART.launchdThrottleSeconds}</integer>`,
    "  <key>ExitTimeOut</key>", `  <integer>${SERVICE_RESTART.stopTimeoutSeconds}</integer>`,
    "  <key>Umask</key>", "  <integer>63</integer>",
    ...(log === undefined ? [] : ["  <key>StandardOutPath</key>", `  ${plistString(log)}`, "  <key>StandardErrorPath</key>", `  ${plistString(log)}`]),
    "</dict>",
    "</plist>",
    "",
  ];
  const fileName = `${label}.plist`;
  const dir = '"$HOME/Library/LaunchAgents"';
  const target = `${dir}/${fileName}`;
  const content = lines.join("\n");
  hereDocGuard(content);
  return {
    platform: "darwin", name: c.name, fileName, installPath: `~/Library/LaunchAgents/${fileName}`, content,
    steps: [
      "Run these as YOUR user (not root, not sudo). Nothing below has been run by this program.",
      `test -x ${shellQuote(c.node)} && test -f ${shellQuote(c.launcher)} && test -d ${shellQuote(c.root)}`,
      ...(c.envFile === undefined ? [] : [`test -f ${shellQuote(c.envFile)} && chmod 600 ${shellQuote(c.envFile)}   # your KEY=value lines; the plist only names this file`]),
      ...(c.logDir === undefined ? [] : [`mkdir -p -m 700 ${shellQuote(c.logDir)}`]),
      `mkdir -p ${dir}`,
      `cat > ${target} <<'${HEREDOC_END}'\n${content}${HEREDOC_END}`,
      `plutil -lint ${target}`,
      `launchctl bootstrap "gui/$(id -u)" ${target}`,
      `launchctl print "gui/$(id -u)/${label}"`,
    ],
    uninstall: [`launchctl bootout "gui/$(id -u)/${label}"`, `rm ${target}`],
    notes: [
      "A LaunchAgent: it runs as you, in your login session, from login on (not at boot before anyone logs in).",
      `launchd restarts the launcher after any failure, at least ${SERVICE_RESTART.launchdThrottleSeconds} s apart, and cannot tell the launcher's exit codes apart: a blocked (2), no-release (3) or crash-loop (4) exit is retried every ${SERVICE_RESTART.launchdThrottleSeconds} s until you fix the cause or run 'launchctl bootout'. An exit 0 is not restarted.`,
      ...(c.envFile === undefined ? ["No environment file named: the controller gets launchd's minimal environment."] : ["The environment file is read by 'node --env-file' (a missing file stops the launcher at once)."]),
      ...(log === undefined ? ["No log directory named: launchd discards the output."] : [`Output is appended to ${log}; rotate it yourself (newsyslog or similar).`]),
    ],
  };
}

// ---- Windows Task Scheduler ----

function windowsTask(c: Checked): ServiceUnit {
  const args = [...(c.envFile === undefined ? [] : [`--env-file=${c.envFile}`]), c.launcher, ...launcherArgs(c)].map(windowsArg).join(" ");
  const user = c.windowsUser === undefined ? [] : [`      <UserId>${xmlEscape(c.windowsUser)}</UserId>`];
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    "<!-- Generated by nimblenewt-service.mjs. It holds no secrets: keep them in the environment file named in Arguments (Node's env-file option). -->",
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>", `    <Description>${xmlEscape(`NimbleNewt release launcher (${c.name})`)}</Description>`, "  </RegistrationInfo>",
    "  <Triggers>", "    <LogonTrigger>", "      <Enabled>true</Enabled>", ...user, "    </LogonTrigger>", "  </Triggers>",
    "  <Principals>", '    <Principal id="Author">', ...(c.windowsUser === undefined ? [] : [`      <UserId>${xmlEscape(c.windowsUser)}</UserId>`]), "      <LogonType>InteractiveToken</LogonType>", "      <RunLevel>LeastPrivilege</RunLevel>", "    </Principal>", "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    `    <RestartOnFailure><Interval>${SERVICE_RESTART.windowsRestartInterval}</Interval><Count>${SERVICE_RESTART.windowsRestartCount}</Count></RestartOnFailure>`,
    "  </Settings>",
    '  <Actions Context="Author">', "    <Exec>", `      <Command>${xmlEscape(c.node)}</Command>`, `      <Arguments>${xmlEscape(args)}</Arguments>`, `      <WorkingDirectory>${xmlEscape(c.root)}</WorkingDirectory>`, "    </Exec>", "  </Actions>",
    "</Task>",
    "",
  ];
  const fileName = `${c.name}.xml`;
  const content = lines.join("\n");
  hereDocGuard(content);
  return {
    platform: "win32", name: c.name, fileName, installPath: `Task Scheduler task '${c.name}' (no file is needed)`, content,
    steps: [
      "Run these in a normal (NOT 'Run as administrator') PowerShell as YOUR user. Nothing below has been run by this program.",
      `if (-not ((Test-Path -LiteralPath ${powershellQuote(c.node)}) -and (Test-Path -LiteralPath ${powershellQuote(c.launcher)}) -and (Test-Path -LiteralPath ${powershellQuote(c.root)}))) { throw 'node, launcher or release root is missing' }`,
      ...(c.envFile === undefined ? [] : [`if (-not (Test-Path -LiteralPath ${powershellQuote(c.envFile)})) { throw 'environment file is missing' }   # your KEY=value lines; the task only names this file`]),
      `$xml = @'\n${content}'@`,
      `Register-ScheduledTask -TaskName ${powershellQuote(c.name)} -Xml $xml`,
      `Start-ScheduledTask -TaskName ${powershellQuote(c.name)}`,
      `Get-ScheduledTaskInfo -TaskName ${powershellQuote(c.name)}`,
    ],
    uninstall: [`Stop-ScheduledTask -TaskName ${powershellQuote(c.name)}`, `Unregister-ScheduledTask -TaskName ${powershellQuote(c.name)} -Confirm:$false`],
    notes: [
      "Runs as the user who registers it, with ordinary rights (LeastPrivilege), when that user logs on. It is a scheduled task, not a Windows service; a real service would need an administrator and a service wrapper this project does not ship.",
      `Task Scheduler restarts after any failure, ${SERVICE_RESTART.windowsRestartCount} times, ${SERVICE_RESTART.windowsRestartInterval} apart, and cannot tell the launcher's exit codes apart: a blocked (2), no-release (3) or crash-loop (4) exit is retried that few times, then stays down until you start the task. An exit 0 is not restarted.`,
      "The launcher's log lines go to stderr, which a task does not keep. Its records (launcher-state.json and the owner's notices) are the log on Windows.",
      "Stopping the launcher on Windows ends the controller's process tree with taskkill; this has not been tested on a real Windows machine.",
    ],
  };
}

function hereDocGuard(content: string): void {
  if (content.split("\n").some((l) => l === HEREDOC_END || l === "'@")) bad("content", "contains a line that would end the install step's here-document early");
}

/** Generates the unit for `spec`. Throws `ServiceSpecError` for anything that is not safe to write. */
export function generateServiceUnit(spec: ServiceSpec): ServiceUnit {
  const c = checkServiceSpec(spec);
  switch (c.platform) {
    case "linux": return systemdUnit(c);
    case "darwin": return launchdPlist(c);
    case "win32": return windowsTask(c);
  }
}
