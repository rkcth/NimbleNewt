/** The layers a value can live in, least specific first. A later layer overrides an earlier one, within the limits each setting sets. */
export type LayerKind = "installation" | "team" | "agent" | "task";
export const LAYER_ORDER: readonly LayerKind[] = ["installation", "team", "agent", "task"];

/** When a changed setting starts to count (portability-and-configuration, "Safe configuration changes"). */
export type Effect = "next-request" | "after-current-operation" | "after-restart";

/**
 * One setting the configuration service knows. A `default` setting is overridden by the more specific layer. A `restriction` can only be narrowed by a more specific layer, never widened:
 * a task cannot re-enable what the installation disabled or raise a ceiling the installation set, and the resolver keeps it that way even if a parent changes later.
 */
export interface SettingDefinition {
  /** The setting's name. One segment may be `*`, matching any single name (for example `provider.*.enabled`). */
  readonly key: string;
  readonly kind: "default" | "restriction";
  /** Returns the value in its stored form, or throws a message (a string) saying what is wrong. */
  readonly check: (value: unknown) => unknown;
  /** Restrictions: whether `next` is no wider than `bound`. */
  readonly within?: (next: unknown, bound: unknown) => boolean;
  /** Restrictions: the tighter of two values. */
  readonly meet?: (a: unknown, b: unknown) => unknown;
  /** The value when no layer sets it (`undefined`: unset, which for a restriction means unrestricted). */
  readonly fallback?: unknown;
  readonly effect: Effect;
  readonly description: string;
}

const refuse = (message: string): never => { throw message; };
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : refuse("must be true or false"));
const whole = (min: number, max: number) => (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : refuse(`must be a whole number from ${min} to ${max}`));
const names = (pattern: RegExp, max: number) => (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > max) return refuse(`must be a list of at most ${max} names`);
  const out = v.map((x) => (typeof x === "string" && pattern.test(x) ? x : refuse(`${JSON.stringify(x)} is not an acceptable name`)));
  return [...new Set(out)].sort();
};
const TOOL = /^[a-z][a-z0-9._-]{0,79}$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

// Restriction kinds: how "no wider than" and "the tighter" work for a switch, a ceiling and an allowed-list.
const flag = { within: (n: unknown, b: unknown): boolean => n === false || b === true, meet: (a: unknown, b: unknown): unknown => a === true && b === true };
const ceiling = { within: (n: unknown, b: unknown): boolean => (n as number) <= (b as number), meet: (a: unknown, b: unknown): unknown => Math.min(a as number, b as number) };
const allowed = {
  within: (n: unknown, b: unknown): boolean => (n as string[]).every((x) => (b as string[]).includes(x)),
  meet: (a: unknown, b: unknown): unknown => (a as string[]).filter((x) => (b as string[]).includes(x)),
};

// The P/PC floor, ceiling and target are planning shares, not authority, so a more specific layer simply overrides them (a team may plan differently from the installation).
/** The settings the first release knows. Later cards add theirs (the service takes extra definitions). */
export const DEFAULT_SETTINGS: readonly SettingDefinition[] = [
  { key: "provider.*.enabled", kind: "restriction", check: bool, ...flag, fallback: true, effect: "next-request", description: "Whether a model provider may be used at all. A disabled provider stays disabled for every layer below." },
  { key: "budget.paidAllowed", kind: "restriction", check: bool, ...flag, fallback: true, effect: "next-request", description: "Whether paid routes may be chosen." },
  { key: "grants.maxDays", kind: "default", check: whole(1, 36500), effect: "next-request", description: "The longest a standing grant made from chat may last, in days. Unset means no maximum; a grant with no end is only possible while it is unset." },
  { key: "grants.defaultDays", kind: "default", check: whole(1, 36500), effect: "next-request", description: "How long a standing grant made from chat lasts when the owner does not say. Unset means 30 days." },
  { key: "time.maxMinutes", kind: "restriction", check: whole(1, 10080), ...ceiling, effect: "after-current-operation", description: "The longest an attempt may run, in minutes." },
  { key: "resources.maxCpus", kind: "restriction", check: whole(1, 4096), ...ceiling, effect: "after-current-operation", description: "The most CPUs a task's attempt may take." },
  { key: "resources.maxMemoryMb", kind: "restriction", check: whole(64, 100_000_000), ...ceiling, effect: "after-current-operation", description: "The most memory (MB) a task's attempt may take." },
  { key: "time.checkpointMinutes", kind: "default", check: whole(1, 1440), effect: "after-current-operation", description: "How often a running attempt writes a checkpoint, in minutes; it must be shorter than the longest attempt." },
  { key: "resources.minCpus", kind: "default", check: whole(1, 4096), effect: "after-current-operation", description: "The fewest CPUs an attempt needs; it must not exceed the most it may take." },
  { key: "resources.minMemoryMb", kind: "default", check: whole(64, 100_000_000), effect: "after-current-operation", description: "The least memory (MB) an attempt needs; it must not exceed the most it may take." },
  { key: "permissions.allowedTools", kind: "restriction", check: names(TOOL, 200), ...allowed, effect: "next-request", description: "The tools that may be used; unset means whatever grants allow." },
  // A denial can only grow as the layers get more specific: every layer's list is added to the ones above, so no layer can remove a tool another denied.
  { key: "permissions.deniedTools", kind: "restriction", check: names(TOOL, 200), within: () => true, meet: (a, b) => [...new Set([...(a as string[]), ...(b as string[])])].sort(), fallback: [], effect: "next-request", description: "Tools that may not be used even if allowed. Each layer adds to the list; none can take a tool off it." },
  { key: "workClass.pcFloor", kind: "default", check: whole(0, 100), fallback: 0, effect: "next-request", description: "The least share of capacity planned for production work (P/PC planning), in percent." },
  { key: "workClass.pcCeiling", kind: "default", check: whole(0, 100), fallback: 100, effect: "next-request", description: "The most share of capacity planned for production work, in percent." },
  { key: "workClass.pcTarget", kind: "default", check: whole(0, 100), effect: "next-request", description: "The share aimed at; it must lie between the floor and the ceiling." },
  { key: "routing.fallbackProfile.*", kind: "default", check: (v) => (typeof v === "string" && PROFILE.test(v) ? v : refuse("must be a profile name")), effect: "after-current-operation", description: "The profile to fall back to when a profile has no eligible route." },
  { key: "lifecycle.reloadPreservesPause", kind: "restriction", check: (v) => (v === true ? true : refuse("must stay true")), ...flag, fallback: true, effect: "next-request", description: "Always true: reloading configuration never lifts a pause. Present so it is visible, not so it can be turned off." },
];

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SETTING_KEY = /^[a-z][A-Za-z0-9_-]{0,39}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}){1,3}$/;

/** The definition a concrete key falls under, or undefined. An exact definition wins over a pattern. */
export function definitionFor(key: string, definitions: readonly SettingDefinition[]): SettingDefinition | undefined {
  if (!SETTING_KEY.test(key)) return undefined;
  const parts = key.split(".");
  const exact = definitions.find((d) => d.key === key);
  if (exact !== undefined) return exact;
  return definitions.find((d) => {
    const p = d.key.split(".");
    return p.length === parts.length && p.every((seg, i) => seg === "*" ? SEGMENT.test(parts[i]!) : seg === parts[i]);
  });
}

/** Problems with the combination of effective values (not with any one value). Each is a sentence for the person who set them. */
export interface CombineContext {
  /** Profile names in the routing table now, when there is one. */
  readonly profiles?: readonly string[];
}
export type Combiner = (effective: Readonly<Record<string, unknown>>, context: CombineContext) => string[];

export const DEFAULT_COMBINERS: readonly Combiner[] = [
  (e) => {
    const floor = (e["workClass.pcFloor"] as number | undefined) ?? 0;
    const ceiling = (e["workClass.pcCeiling"] as number | undefined) ?? 100;
    const out: string[] = [];
    if (floor > ceiling) out.push(`workClass.pcFloor (${floor}) is above workClass.pcCeiling (${ceiling})`);
    const target = e["workClass.pcTarget"] as number | undefined;
    if (target !== undefined && (target < floor || target > ceiling)) out.push(`workClass.pcTarget (${target}) is outside the floor and ceiling (${floor} to ${ceiling})`);
    return out;
  },
  (e) => {
    const out: string[] = [];
    const maxMinutes = e["time.maxMinutes"] as number | undefined;
    const checkpoint = e["time.checkpointMinutes"] as number | undefined;
    if (maxMinutes !== undefined && checkpoint !== undefined && checkpoint >= maxMinutes) out.push(`time.checkpointMinutes (${checkpoint}) is not shorter than time.maxMinutes (${maxMinutes}), so an attempt would end before its first checkpoint`);
    for (const [min, max, what] of [["resources.minCpus", "resources.maxCpus", "CPUs"], ["resources.minMemoryMb", "resources.maxMemoryMb", "memory"]] as const) {
      const lo = e[min] as number | undefined; const hi = e[max] as number | undefined;
      if (lo !== undefined && hi !== undefined && lo > hi) out.push(`${min} (${lo}) is above ${max} (${hi}): no attempt could get the ${what} it needs`);
    }
    return out;
  },
  (e) => {
    const allowedTools = e["permissions.allowedTools"] as string[] | undefined;
    const denied = (e["permissions.deniedTools"] as string[] | undefined) ?? [];
    if (allowedTools === undefined) return [];
    const both = allowedTools.filter((t) => denied.includes(t));
    const out: string[] = both.length > 0 ? [`${both.join(", ")} ${both.length === 1 ? "is" : "are"} both allowed and denied`] : [];
    if (allowedTools.length > 0 && allowedTools.every((t) => denied.includes(t))) out.push("every allowed tool is also denied, so no tool could be used");
    return out;
  },
  (e, ctx) => {
    // Fallback profiles: each must exist (when a routing table does) and following them must never come back to where it started.
    const next = new Map<string, string>();
    for (const [key, value] of Object.entries(e)) if (key.startsWith("routing.fallbackProfile.") && typeof value === "string") next.set(key.slice("routing.fallbackProfile.".length), value);
    const out: string[] = [];
    for (const [from, to] of next) {
      if (ctx.profiles !== undefined && (!ctx.profiles.includes(from) || !ctx.profiles.includes(to))) out.push(`the fallback ${from} -> ${to} names a profile that is not in the routing table`);
      const seen = new Set([from]);
      for (let at = to; ; at = next.get(at)!) {
        if (seen.has(at)) { out.push(`the fallbacks starting at ${from} go round in a circle`); break; }
        seen.add(at);
        if (!next.has(at)) break;
      }
    }
    return [...new Set(out)];
  },
];
