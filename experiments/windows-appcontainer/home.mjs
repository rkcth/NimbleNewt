// The home case (one account, not elevated): reads the one-JSON-line-per-step output of `nn-appc-launcher home-probe` and says, in plain words, what it found. Pure logic plus a small CLI:
//   node experiments/windows-appcontainer/home.mjs summarize FILE [--label TEXT]     (markdown on standard output)
// The launcher is native/nn-launcher/src/home.rs (experiment build); the rules for its steps are in homerules.rs. Nothing here runs a program or touches the system.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The ways to give the container a desktop, from the strongest isolation to the weakest, as the probe's groups name them. */
export const OPTIONS = [
  { group: "desktop", title: "a private desktop on the user's own window station, no entry written to the station", writesToStation: false },
  { group: "station-read", title: "a private desktop plus a temporary READ-level entry for the container on WinSta0", writesToStation: true },
  { group: "station-full", title: "a private desktop plus a temporary FULL-level entry for the container on WinSta0", writesToStation: true },
  { group: "inherit", title: "the user's own desktop, inherited (what a normal AppContainer launch does)", writesToStation: false },
];

/** The lines of the probe's output that are JSON objects (anything else, such as a stray message, is ignored). */
export function parseHomeLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try { const o = JSON.parse(t); if (o && o.probe === "home" && typeof o.step === "string") out.push(o); } catch { /* not a probe line */ }
  }
  return out;
}

const byStep = (lines, id) => lines.find((l) => l.step === id);

/** What the child `ui-test` reported (its JSON arrives as the child's standard output), or null. */
export function childReport(line) {
  if (!line || typeof line.childStdout !== "string") return null;
  try { const o = JSON.parse(line.childStdout); return o && o.probe === "ui-test" ? o : null; } catch { return null; }
}

/** How one group came out from its own lines: works / fails / not-run / skipped, from the deciding steps (ui-test and node, without the job's UI limits). */
export function groupVerdict(lines, group) {
  const mine = lines.filter((l) => l.group === group);
  if (mine.length === 0) return "not-run";
  const deciding = mine.filter((l) => /-(ui-test|node)$/.test(l.step) && !l.skipped);
  if (deciding.length === 0) return mine.every((l) => l.skipped) ? "skipped" : "not-run";
  return deciding.every((l) => l.works === true) ? "works" : "fails";
}

/** The judgement of one probe run: facts, per-group verdicts and the strongest option that worked. Claims only what the lines show. */
export function judgeHome(lines) {
  const ctx = byStep(lines, "context");
  const access = byStep(lines, "station-access");
  const profile = byStep(lines, "profile");
  const facts = [];
  if (ctx) {
    facts.push(`token: elevated=${ctx.elevated}, elevation type ${ctx.elevationType ?? "?"}, Administrators group ${ctx.adminGroup ?? "?"}, integrity ${ctx.integrity ?? "?"}, session ${ctx.sessionId}, OS build ${ctx.osBuild}`);
    facts.push(`window station ${ctx.windowStation} (interactive: ${ctx.interactiveStation}), desktop ${ctx.desktop}`);
  }
  if (access && access.station) {
    const s = access.station;
    facts.push(`WinSta0-side: this token ${s.openWithCreateDesktop ? "CAN" : "CANNOT"} open the station with WINSTA_CREATEDESKTOP, and ${s.openWithWriteDac ? "CAN" : "CANNOT"} open it with WRITE_DAC (an open only; nothing was written)`);
    if (s.owner) facts.push(`station owner ${s.owner}${s.ownerIsTokenUser ? " (the token's user)" : s.ownerIsAdministrators ? " (Administrators)" : ""}`);
    if (Array.isArray(s.allApplicationPackagesAllow)) facts.push(s.allApplicationPackagesAllow.length ? `ALL APPLICATION PACKAGES holds allow entries on the station: ${s.allApplicationPackagesAllow.join(", ")}` : "ALL APPLICATION PACKAGES holds NO allow entry on the station");
  }
  if (profile) facts.push(`a throw-away per-run profile was ${profile.ok ? "made, deleted and shown gone" : "NOT cleanly made and deleted"}`);
  const verdicts = Object.fromEntries(OPTIONS.map((o) => [o.group, groupVerdict(lines, o.group)]));
  const best = OPTIONS.find((o) => verdicts[o.group] === "works") ?? null;
  const summary = lines.find((l) => l.step === "summary");
  const entryLeft = summary?.stationEntryLeftBehind === true;
  const keptFolder = typeof summary?.workFolderKept === "string" ? summary.workFolderKept : null;
  const listDiffers = summary?.stationListDiffers === true;
  const stopped = summary?.stopped === true || lines.some((l) => l.skipped === true && /^stopped:/.test(String(l.reason)));
  const closeErrors = lines.flatMap((l) => (l.desktop && Array.isArray(l.desktop.closeErrors) ? l.desktop.closeErrors : []));
  return { facts, verdicts, strongestWorking: best ? best.group : null, entryLeft, keptFolder, listDiffers, stopped, summaryFound: Boolean(summary), closeErrors: closeErrors.length, steps: lines.length };
}

const cell = (v) => (v === undefined ? "?" : String(v));

/** A markdown report of one probe run. */
export function renderHomeMarkdown(lines, label = "") {
  const j = judgeHome(lines);
  const md = [];
  md.push(`### Home case${label ? `: ${label}` : ""}`);
  md.push("");
  if (j.steps === 0) { md.push("No probe line was found (the probe did not run, or its output was not JSON)."); return md.join("\n") + "\n"; }
  for (const f of j.facts) md.push(`- ${f}`);
  md.push("");
  md.push("| option (strongest isolation first) | writes to WinSta0 | result |");
  md.push("| --- | --- | --- |");
  for (const o of OPTIONS) md.push(`| ${o.title} | ${o.writesToStation ? "a temporary entry, removed" : "no"} | ${j.verdicts[o.group]} |`);
  md.push("");
  md.push(j.strongestWorking
    ? `Strongest option that worked here: **${j.strongestWorking}**. This is one machine, one build and one run; it is not a general finding.`
    : "No option worked here: the launcher would fail closed (no confined run).");
  if (j.entryLeft) md.push("", `**An entry for a throw-away container was left on the window station**: run the \`home-revoke\` command printed on that step's ATTEMPT line (it needs the profile's record, in the \`rec\` folder of ${j.keptFolder ? `\`${j.keptFolder}\`` : "the work folder"}). The ATTEMPT line also prints \`delete-profile\` for the profile, needed only if the launcher was killed.`);
  if (j.listDiffers) md.push("", "**WinSta0's access list did not read back exactly as it was copied before the entry** (the container's entry is gone, but another entry or the descriptor's flags differ: another program may have changed the list meanwhile). Nothing was written back; send this file.");
  if (j.stopped) md.push("", "The run was stopped (Ctrl+C or the window closing): the steps after that point did not run.");
  if (!j.summaryFound) md.push("", "No summary line: the run did not reach its end (stopped, or ended from outside). If an ATTEMPT line was printed for a step that did not finish, run its clean-up command(s).");
  if (j.closeErrors) md.push("", `${j.closeErrors} desktop or station handle(s) could not be closed (see the lines' desktop.closeErrors).`);
  md.push("", "| step | works | exit | note |", "| --- | --- | --- | --- |");
  for (const l of lines) {
    if (!l.group) continue;
    const note = l.skipped ? `skipped: ${l.reason}` : l.ok === false ? `${cell(l.stage)}: ${cell(l.error)}` : (childReport(l) ? "ui-test report below" : "");
    md.push(`| ${l.step} | ${l.skipped ? "-" : cell(l.works)} | ${l.skipped ? "-" : cell(l.childExitCode)} | ${note.replace(/\|/g, "/").slice(0, 200)} |`);
  }
  const reports = lines.map((l) => [l, childReport(l)]).filter(([, r]) => r);
  if (reports.length) {
    md.push("", "What the confined `ui-test` program saw (counts and success only; nothing is read or sent):", "", "| step | desktop | windows seen (visible) | clipboard opens | keyboard hook | global atom | screen pixel |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const [l, r] of reports) md.push(`| ${l.step} | ${cell(r.windowStation)}\\\\${cell(r.desktop)} | ${cell(r.windowsSeen)} (${cell(r.windowsSeenVisible)}) | ${cell(r.openClipboardOk)} | ${cell(r.lowLevelKeyboardHookInstalled)} | ${cell(r.globalAtomAdded)} | ${cell(r.screenPixelReadable)} |`);
  }
  return md.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd !== "summarize" || !file) { console.error("usage: node home.mjs summarize FILE [--label TEXT]"); process.exit(2); }
  const i = rest.indexOf("--label");
  process.stdout.write(renderHomeMarkdown(parseHomeLines(readFileSync(file, "utf8")), i >= 0 ? rest[i + 1] ?? "" : ""));
}
