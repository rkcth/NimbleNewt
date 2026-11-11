#!/usr/bin/env node
// Prints the service unit for the NimbleNewt release launcher and the exact steps to install it (card K02 follow-up). It ONLY PRINTS: it never writes a file, installs, enables or starts anything; the owner runs
// the printed steps. Needs `npx tsc --build` first. The unit text and its rules are in packages/controller/src/release/service-units.ts.
//
//   node scripts/nimblenewt-service.mjs print --platform linux|darwin|win32 --root RELEASE_ROOT [options] [-- controller arguments]
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = async (file) => import(pathToFileURL(join(repo, "packages", "controller", "dist", file)).href);

const HELP = `NimbleNewt service unit printer (prints only; installs nothing)

  print --platform linux|darwin|win32 --root DIR [options] [-- controller arguments]

  --platform P         The platform the service will run on (default: this machine's, if it is one of the three). Give paths in that platform's spelling.
  --root DIR           Absolute release root (or NIMBLENEWT_RELEASE_ROOT).
  --node PATH          Absolute path of Node.js (default: the one running this program).
  --launcher PATH      Absolute path of nimblenewt-launcher.mjs (default: the one next to this program).
  --entry FILE         The controller's entry file inside a release (default controller.js).
  --switcher KIND      pointer (default) or symlink (not on Windows).
  --environment-file PATH Absolute path of a KEY=value file with the controller's secrets and settings. Only the path goes into the unit.
  --log-dir DIR        Absolute directory for <name>.log (linux: otherwise the journal; macOS: otherwise discarded; Windows: not used).
  --name NAME          Service name (default nimblenewt).
  --windows-user USER  Windows, required: the account (DOMAIN\\user, as 'whoami' prints it there) whose logon starts the task.
  --protect-system M   Linux, opt-in: full or strict (with --read-write-path DIR, repeatable). Off by default: it stops the
                       controller's bubblewrap sandbox where unprivileged user namespaces are restricted (Ubuntu 23.10+).
  --unit-only          Print only the unit file text.
  Arguments after -- are passed to the controller. Do not put secrets there; they are refused.
Exit codes: 0 printed, 1 refused (the reason is on stderr).
`;

function parse(argv) {
  const cut = argv.indexOf("--");
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const controllerArgs = cut < 0 ? [] : argv.slice(cut + 1);
  const flags = {};
  const positional = [];
  const repeatable = new Set(["read-write-path"]);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    let k = a.slice(2);
    let v;
    const eq = k.indexOf("=");
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); if (k === "unit-only" || k === "help") throw new Error(`--${k} takes no value`); }
    else if (k === "unit-only" || k === "help") v = true;
    else { v = own[i + 1]; i++; if (v === undefined) throw new Error(`--${k} needs a value`); }
    if (repeatable.has(k)) (flags[k] ??= []).push(v);
    else if (k in flags) throw new Error(`--${k} was given twice`);
    else flags[k] = v;
  }
  const known = new Set(["platform", "root", "node", "launcher", "entry", "switcher", "environment-file", "log-dir", "name", "windows-user", "protect-system", "read-write-path", "unit-only", "help"]);
  for (const k of Object.keys(flags)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
  return { flags, positional, controllerArgs };
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, env: process.env, uid: process.getuid?.(), platform: process.platform }) {
  const err = (t) => io.stderr.write(t.endsWith("\n") ? t : `${t}\n`);
  let parsed;
  try { parsed = parse(argv); } catch (error) { err(error.message); return 1; }
  const { flags, positional, controllerArgs } = parsed;
  if (flags.help === true || positional[0] === "help" || positional.length === 0) { err(HELP); return flags.help === true || positional[0] === "help" ? 0 : 1; }
  if (positional[0] !== "print" || positional.length > 1) { err(`unknown command ${positional[0]}\n${HELP}`); return 1; }
  // The units run as the person who installs them; printing steps for root would put the service in root's account.
  if (io.uid === 0) { err("Refusing to print install steps for root: the service must run as an ordinary user. Run this as that user."); return 1; }
  const platform = flags.platform ?? io.platform;
  const root = flags.root ?? io.env.NIMBLENEWT_RELEASE_ROOT;
  if (root === undefined || root === "") { err("--root is required."); return 1; }
  const { generateServiceUnit } = await lib("release/service-units.js");
  try {
    const unit = generateServiceUnit({
      platform,
      root,
      node: flags.node ?? process.execPath,
      launcher: flags.launcher ?? join(repo, "scripts", "nimblenewt-launcher.mjs"),
      controllerArgs,
      ...(flags.entry === undefined ? {} : { entry: flags.entry }),
      ...(flags.switcher === undefined ? {} : { switcher: flags.switcher }),
      ...(flags["environment-file"] === undefined ? {} : { envFile: flags["environment-file"] }),
      ...(flags["log-dir"] === undefined ? {} : { logDir: flags["log-dir"] }),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      ...(flags["windows-user"] === undefined ? {} : { windowsUser: flags["windows-user"] }),
      ...(flags["protect-system"] === undefined ? {} : { protectSystem: flags["protect-system"] }),
      ...(flags["read-write-path"] === undefined ? {} : { readWritePaths: flags["read-write-path"] }),
    });
    if (flags["unit-only"] === true) { io.stdout.write(unit.content); return 0; }
    const out = [
      `# NimbleNewt service unit for ${unit.platform} (${unit.fileName})`,
      "# THIS PROGRAM INSTALLED NOTHING. Read the unit, then run the steps yourself if you agree.",
      "",
      `## Unit (saved as ${unit.installPath})`,
      unit.content.trimEnd(),
      "",
      "## Install steps (you run these)",
      ...unit.steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "## To remove it",
      ...unit.uninstall.map((s) => `- ${s}`),
      "",
      "## Notes",
      ...unit.notes.map((s) => `- ${s}`),
      "",
    ];
    io.stdout.write(out.join("\n"));
    return 0;
  } catch (error) {
    if (error?.name === "ServiceSpecError") { err(`refused: ${error.message}`); return 1; }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`service: ${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
