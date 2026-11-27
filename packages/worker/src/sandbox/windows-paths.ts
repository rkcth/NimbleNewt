import { win32 } from "node:path";
import { SandboxError } from "./errors.js";

/*
 * Windows path rules the native launcher's recipe check uses (windows-native-plan.ts, windows-native-job.ts, windows-native.ts). Moved here unchanged from windows-plan.ts when the Windows Sandbox
 * backend was removed (owner decision 2026-11-26: keep the AppContainer launcher, no Windows Sandbox).
 */

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };

/**
 * Windows paths compare without regard to case, by the volume's upper-case table. `toLowerCase` alone misses letters whose upper case is a plain ASCII one (dotless `ı` and `I`, long `ſ` and `S`,
 * final `ς` and `Σ`), so `C:\\Program Fıles` could pass a comparison with `C:\\Program Files` that the volume may treat as the same folder. Upper case first, then lower: such letters compare equal
 * (a few more spellings compare equal than on the volume, which only refuses more).
 */
export const foldWin = (p: string): string => p.toUpperCase().toLowerCase();
const lower = foldWin;
/** A path part Windows opens as a device (CON, NUL, COM1, LPT1, CONIN$ and the like, with or without an extension) instead of a file or folder. */
export const isWindowsDeviceName = (segment: string): boolean => /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)\s*(\..*)?$/i.test(segment);
/** Windows paths compare without regard to case. */
export const overlapsWin = (a: string, b: string): boolean => { const x = lower(a), y = lower(b); return x === y || x.startsWith(y + "\\") || y.startsWith(x + "\\"); };
const insideWin = (path: string, dir: string): boolean => lower(path).startsWith(lower(dir) + "\\");

/** A host path the confined program will be given. Absolute, local, normalised, not a drive root, not part of the system or program files, not a short (8.3) alias. */
export function checkWindowsHostPath(label: string, path: unknown, env: (name: string) => string | undefined): string {
  if (typeof path !== "string" || path.length === 0) return bad(`${label}: must be a path`);
  if (!/^[A-Za-z]:\\/.test(path)) return bad(`${label}: must be a local absolute path such as C:\\dir (not relative, not a network path, not \\\\?\\): ${path}`);
  if (/[<>"|?*\u0000-\u001f]/.test(path) || path.indexOf(":", 2) !== -1) return bad(`${label}: ${path} holds a character that is not allowed in a shared path (including alternate data streams)`);
  if (win32.normalize(path) !== path || path.endsWith("\\") || path.split("\\").some((s) => s === ".." || s === "." || s === "" || /~\d/.test(s) || /[. ]$/.test(s))) return bad(`${label}: must be normalised, with no "..", trailing dot or space, or short-name (~1) segment: ${path}`);
  if (path.split("\\").slice(1).some(isWindowsDeviceName)) return bad(`${label}: ${path} has a part Windows opens as a device (CON, NUL, COM1 and the like)`);
  const forbidden: string[] = [];
  const sysDrive = env("SystemDrive") ?? "C:";
  for (const name of ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]) { const v = env(name); if (v !== undefined && v !== "") forbidden.push(v); }
  forbidden.push(`${sysDrive}\\Windows`, `${sysDrive}\\Program Files`, `${sysDrive}\\Program Files (x86)`, `${sysDrive}\\ProgramData`, `${sysDrive}\\Users`, `${sysDrive}\\Recovery`, `${sysDrive}\\System Volume Information`);
  for (const f of forbidden) {
    // The folder itself or anything that contains it is refused; a folder inside Windows or Program Files is refused too. (A folder inside ProgramData or Users is fine: those are where per-job folders live.)
    const isSystemTree = /\\(windows|program files|program files \(x86\)|recovery|system volume information)$/i.test(f) || ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].some((n) => env(n) === f);
    if (lower(path) === lower(f) || lower(f).startsWith(lower(path) + "\\")) return bad(`${label}: ${path} is or contains ${f}`);
    if (isSystemTree && insideWin(path, f)) return bad(`${label}: ${path} is inside ${f}`);
  }
  return path;
}
