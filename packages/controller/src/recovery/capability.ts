import { probeNode, readStandbyLinks, synchronousSettingsText } from "../storage/postgres/index.js";

/**
 * The replicated standby as an optional installation capability (card K04). An installation that does not configure one has none, and nothing here runs. One that does names the
 * standby (its `application_name`), whether commits wait for it, and where the recovery manifest and the standby host's artifact folder are. The PostgreSQL replication itself is the
 * database operator's (PostgreSQL's own streaming replication); this only checks that what is configured is what is running and says so in words.
 */
export type StandbyMode = "asynchronous" | "synchronous";

export interface StandbyConfig {
  /** The standby's `application_name` as the primary lists it. */
  readonly name: string;
  readonly mode: StandbyMode;
  readonly url: string;
  readonly manifestDirectory: string;
  /** The folder of artifact blobs on the standby host. */
  readonly blobDirectory: string;
}

export class StandbyConfigBad extends Error {
  constructor(message: string) { super(message); this.name = "StandbyConfigBad"; }
}

/** `undefined` (or null) means no standby: the capability is off. Anything else must be complete. */
export function parseStandbyConfig(raw: unknown): StandbyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new StandbyConfigBad("standby: must be an object, or absent for no standby");
  const o = raw as Record<string, unknown>;
  const known = ["name", "mode", "url", "manifestDirectory", "blobDirectory"];
  for (const key of Object.keys(o)) if (!known.includes(key)) throw new StandbyConfigBad(`standby.${key}: not a setting`);
  const text = (key: string): string => { const v = o[key]; if (typeof v !== "string" || v.length === 0) throw new StandbyConfigBad(`standby.${key}: required text`); return v; };
  const name = text("name");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new StandbyConfigBad("standby.name: letters, digits and underscores only");
  const mode = o["mode"];
  if (mode !== "asynchronous" && mode !== "synchronous") throw new StandbyConfigBad('standby.mode: "asynchronous" or "synchronous"');
  const url = text("url");
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new StandbyConfigBad("standby.url: must be a postgres:// address");
  return { name, mode, url, manifestDirectory: text("manifestDirectory"), blobDirectory: text("blobDirectory") };
}

/** The plain-words statement of what each mode means for loss: used by the owner guide and by the check below. */
export function describeMode(mode: StandbyMode): string {
  return mode === "synchronous"
    ? "synchronous: a commit is answered only after the standby has the log record on disk, so a write the controller was told succeeded survives losing the primary; if the standby is down, writes wait (and the controller sees them as uncertain) until it returns or the operator changes the setting"
    : "asynchronous: a commit is answered as soon as the primary has it, so the newest writes can be lost with the primary; the loss window is how far the standby is behind, which this measures";
}

export interface InstallationCheck {
  readonly ok: boolean;
  /** One plain sentence per thing found wrong; empty when ok. */
  readonly findings: readonly string[];
  readonly actualSyncState?: string;
  /** For the operator: the setting that makes commits wait for this standby. */
  readonly synchronousSetting: string;
}

/** Checks that the configured standby is what is running: a standby of this primary, streaming, in the configured mode. Reads only; the address is never in the findings. */
export async function verifyStandbyInstallation(options: { readonly primaryUrl: string; readonly standby: StandbyConfig }): Promise<InstallationCheck> {
  const findings: string[] = [];
  let actual: string | undefined;
  const setting = synchronousSettingsText([options.standby.name]);
  try {
    const standby = await probeNode(options.standby.url);
    const primary = await probeNode(options.primaryUrl);
    if (!standby.inRecovery) findings.push("the configured standby is not in recovery: it is a writable database, not a copy of the primary");
    if (standby.systemIdentifier !== primary.systemIdentifier) findings.push("the configured standby is not a copy of this primary (the database system identifiers differ)");
    const { links } = await readStandbyLinks(options.primaryUrl);
    const link = links.find((l) => l.applicationName === options.standby.name);
    if (link === undefined) findings.push(`the primary does not list a standby named ${options.standby.name}: it is not connected`);
    else {
      actual = link.syncState;
      if (link.state !== "streaming") findings.push(`the standby is ${link.state}, not streaming`);
      if (options.standby.mode === "synchronous" && link.syncState !== "sync" && link.syncState !== "quorum") findings.push(`configured synchronous, but the primary treats this standby as ${link.syncState}: commits do not wait for it (set ${setting.split("\n")[0]})`);
      if (options.standby.mode === "asynchronous" && (link.syncState === "sync" || link.syncState === "quorum")) findings.push("configured asynchronous, but the primary makes commits wait for this standby: if it stops, writes stop");
    }
  } catch (error) {
    findings.push(`a node did not answer (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
  }
  return { ok: findings.length === 0, findings, ...(actual === undefined ? {} : { actualSyncState: actual }), synchronousSetting: setting };
}
