import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runBounded } from "./windows-real.js";

/**
 * The program a one-shot scheduled task runs (card wsb-repair): `node windows-task-child.js <private folder>`. It reads `in.json` from the folder, runs the one command it names with an
 * argument list (no shell), and writes `started.txt` (before the command), `out.txt`, `err.txt` and, last and by rename, `code.txt` (the exit code as an unsigned number; none when
 * the command could not be run or ended at its limit). It runs nothing but what `in.json` names, and `in.json` sits in a folder the launcher checked to be private.
 * If `in.json` is gone (the launcher gave up and removed the folder) it runs nothing.
 */
export interface ChildRequest { readonly file: string; readonly args: readonly string[]; readonly cwd?: string; readonly timeoutMs: number }

export function readRequest(text: string): ChildRequest | undefined {
  try {
    const v = JSON.parse(text) as Partial<ChildRequest>;
    if (typeof v.file !== "string" || v.file === "" || !Array.isArray(v.args) || !v.args.every((a) => typeof a === "string")) return undefined;
    if (typeof v.timeoutMs !== "number" || !Number.isFinite(v.timeoutMs) || v.timeoutMs < 1000 || v.timeoutMs > 3_600_000) return undefined;
    if (v.cwd !== undefined && typeof v.cwd !== "string") return undefined;
    return { file: v.file, args: v.args as string[], timeoutMs: v.timeoutMs, ...(v.cwd === undefined ? {} : { cwd: v.cwd }) };
  } catch { return undefined; }
}

const stopTree = (pid: number): Promise<void> => new Promise((resolve) => {
  execFile(`${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, () => { resolve(); });
});

export async function main(dir: string | undefined): Promise<number> {
  if (dir === undefined) return 2;
  const sep = dir.includes("\\") ? "\\" : "/";
  const at = (n: string): string => `${dir}${sep}${n}`;
  let text: string;
  try { text = readFileSync(at("in.json"), "utf8"); } catch { return 2; }
  const req = readRequest(text);
  if (req === undefined) return 2;
  writeFileSync(at("started.txt"), "1");
  const r = await runBounded(req.file, req.args, { ...(req.cwd === undefined ? {} : { cwd: req.cwd }), timeoutMs: req.timeoutMs - 500, env: process.env }, stopTree);
  writeFileSync(at("out.txt"), r.stdout);
  writeFileSync(at("err.txt"), r.stderr);
  // A command that could not be run, or that ended at its limit, has no exit code: no code file, so the launcher says so in plain words instead of inventing one.
  if (r.code !== null && !r.timedOut) { writeFileSync(at("code.tmp"), String(r.code >>> 0)); renameSync(at("code.tmp"), at("code.txt")); }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((c) => { process.exitCode = c; }, () => { process.exitCode = 1; });
}
