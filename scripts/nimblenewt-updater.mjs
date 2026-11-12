#!/usr/bin/env node
// The NimbleNewt updater (card K02 follow-up): installs an already built, authorised release from a source directory into the release root, verifies it, and announces it to the launcher. No network, no
// database, no model. Like the launcher it is not part of any release. It does not start or stop anything. Needs `npx tsc --build` first.
//
//   node scripts/nimblenewt-updater.mjs stage --root RELEASE_ROOT --source DIR --digest SHA256 [--announce] [--switch] [--switcher pointer|symlink]
//
// Without --announce it only installs releases/<id> (read-only, verified). --announce tells the launcher the release may run (Launcher.expect). --switch (needs --announce) also moves the pointer, which the
// launcher follows the next time it starts a controller. Exit codes: 0 done, 1 refused or failed (reason on stderr).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = async (file) => import(pathToFileURL(join(repo, "packages", "controller", "dist", file)).href);

const HELP = `NimbleNewt updater

  stage --root DIR --source DIR --digest SHA256 [--announce] [--switch] [--switcher pointer|symlink]

  --root DIR      The release root (must exist). Or NIMBLENEWT_RELEASE_ROOT.
  --source DIR    A verified release directory: its files plus MANIFEST.json (as release.stage leaves them).
  --digest HEX    The SHA-256 of that MANIFEST.json, from whoever authorised the release. A different manifest is refused.
  --announce      Tell the launcher the release may run.
  --switch        With --announce: also move the pointer to it (the launcher follows at its next start).
  --switcher K    pointer (default) or symlink.
  An existing releases/<id> is never overwritten.
`;

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  const err = (t) => io.stderr.write(t.endsWith("\n") ? t : `${t}\n`);
  const flags = {};
  const positional = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith("--")) { positional.push(a); continue; }
      let k = a.slice(2);
      let v;
      const eq = k.indexOf("=");
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); if (["announce", "switch", "help"].includes(k)) throw new Error(`--${k} takes no value`); }
      else if (["announce", "switch", "help"].includes(k)) v = true;
      else { v = argv[i + 1]; i++; if (v === undefined) throw new Error(`--${k} needs a value`); }
      if (!["root", "source", "digest", "announce", "switch", "switcher", "help"].includes(k)) throw new Error(`unknown option --${k}`);
      if (k in flags) throw new Error(`--${k} was given twice`);
      flags[k] = v;
    }
  } catch (error) { err(safeMessage(error, 2000)); return 1; }
  if (flags.help === true || positional[0] === "help") { err(HELP); return 0; }
  if (positional[0] !== "stage" || positional.length > 1) { err(HELP); return 1; }
  const root = flags.root ?? io.env.NIMBLENEWT_RELEASE_ROOT;
  if (root === undefined || flags.source === undefined || flags.digest === undefined) { err("--root, --source and --digest are required."); return 1; }
  if (flags.switch === true && flags.announce !== true) { err("--switch needs --announce."); return 1; }
  if (flags.switcher !== undefined && flags.switcher !== "pointer" && flags.switcher !== "symlink") { err("--switcher must be pointer or symlink."); return 1; }
  const { stageRelease, announceRelease } = await lib("release/updater.js");
  try {
    const staged = await stageRelease({ root, source: flags.source, digest: flags.digest });
    io.stdout.write(`${staged.reused ? "already installed" : "installed"} ${staged.id} (${staged.files} files, ${staged.bytes} bytes) at ${staged.dir}\n`);
    if (flags.announce === true) {
      const r = await announceRelease({ root, release: staged, ...(flags.switcher === undefined ? {} : { switcher: flags.switcher }), switchPointer: flags.switch === true });
      io.stdout.write(`announced ${staged.id} to the launcher${r.switched ? "; the pointer now names it (the launcher follows at its next start)" : "; the pointer is unchanged"}\n`);
      // The controller's activation record was not changed (this program never opens the database): release.status reports the pointer as diverged, and an interrupted release.activate from that state is
      // left unresolved for the owner. Said every time, on stderr, so it is not missed.
      if (r.switched) err(`warning: the controller's activation record still names its previous current release; release.status will show the pointer as diverged until the controller activates a release itself. Prefer release.stage / release.activate while the controller runs.`);
    }
    return 0;
  } catch (error) {
    if (error?.name === "UpdaterError") { err(`refused (${error.code}): ${safeMessage(error, 2000)}`); return 1; }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`updater: ${safeMessage(error, 2000)}\n`); process.exitCode = 1; });
}
