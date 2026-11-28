import { DomainError } from "../domain/errors.js";
import type { CommandRunner } from "../domain/runner.js";
import type { UsageBody } from "../catalog/catalog.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { clean } from "../standups/shared.js";

/**
 * The look at affected work when an adoption is withdrawn (card B05, clause "paused dependencies reconciled"; this slice). When an adoption in force is withdrawn (by a decision or a regression), the
 * work that used the withdrawn change is found and told, and the owner is told once:
 *
 * - **Tools.** The catalog's run records (`CatalogService.usage`: one per run, with the exact version, its digest and the task) are read for the adoption's project, a bounded page at a time, from where the
 *   last page stopped. Each run of exactly the adopted version (name, version and the digest the reviewer approved) names a task. A task that is not finished (paused or still open) is told once, through
 *   one step of its own activity. It keeps the version: withdrawing never sets the version aside or removes it, and catalog retention keeps a version an unfinished task ran (`RetainedMaterial`, T02c), so a
 *   paused task resumes on the same version without a migration. A finished task (done or cancelled) is counted and left exactly as it is: nothing it did is undone or marked undone.
 * - **Practices.** Which task applied an adopted practice is not recorded anywhere, so a practice's look finds and tells no task; it says so in its record and in the owner's notice (an honest limit).
 * - **Restart-safe and bounded.** The look is a stored record (`adoption-look`, one per withdrawn adoption), created in the same write as the withdrawal, and an entry in one installation-wide pending list
 *   (`adoption-looks`). Each step reads one page and is one revision-guarded write that keeps where it stopped, so a restart between steps loses nothing and a step that lost a race is not counted twice;
 *   every activity step and the owner's notice carry a command ID derived from the adoption (and the task), so a repeat changes nothing. The look runs a few pages right after the withdrawal, and the
 *   dispatcher's tick (`sweep`) carries on any look that was cut short or interrupted. At most `LOOK_LIMITS.pages` pages are read and `LOOK_LIMITS.tasks` tasks recorded; beyond that the record says it is partial.
 * - **Nothing else is written.** The look writes only its own record, the pending list, one activity step per unfinished task and one owner notice. No task state, pause, effect, timer, outbox entry or
 *   catalog record is touched.
 */
export const LOOK_LIMITS = { page: 50, pagesPerCall: 4, perTick: 2, pages: 100, tasks: 200, pending: 300, sample: 3 } as const;
export const LOOK_KIND = "adoption-look";
export const LOOKS_KIND = "adoption-looks";
const LOOKS_ID = "installation";

/** What a task that ran the withdrawn version was when the look first saw it. `missing`: its record is gone or names another project. */
export type AffectedState = "paused" | "open" | "finished" | "missing";
export interface LookBody {
  readonly adoptionId: string;
  readonly projectId: string;
  readonly experimentId: string;
  readonly target: { readonly kind: "practice" } | { readonly kind: "tool"; readonly name: string; readonly version: string };
  readonly targetDigest?: string;
  readonly why: "regression" | "decision";
  /** `looking`: pages are still to be read; `done`: every run record was read, or the page limit was reached (`partial`). */
  readonly state: "looking" | "done";
  /** `tool-runs`: found from the catalog's run records; `not-recorded`: a practice, whose use by a task is not recorded. */
  readonly scope: "tool-runs" | "not-recorded";
  /** The run record the next page begins after. */
  readonly after?: string;
  readonly pages: number;
  /** Runs of exactly the withdrawn version found. */
  readonly runs: number;
  /** Task ID to what it was when first seen (at most `LOOK_LIMITS.tasks`). */
  readonly tasks: Readonly<Record<string, AffectedState>>;
  /** Runs of the version by a task not recorded because `tasks` was full. */
  readonly untracked: number;
  /** Tasks told through their activity. */
  readonly told: number;
  /** The page limit was reached with run records still unread. */
  readonly partial?: true;
  /** Not in the pending list (it was full when the withdrawal was written): only the look right after the withdrawal runs it. */
  readonly unlisted?: true;
  readonly startedAt: string;
  readonly doneAt?: string;
  /** The owner was told (the look is then out of the pending list). */
  readonly notified?: true;
}

/** What the look needs from the rest of the controller. Every call acts as the controller, never as whoever withdrew the adoption. */
export interface AdoptionLookPorts {
  /** One page of the project's tool runs, in record order, after `after` (the catalog's own `usage`, read with `history.read`). */
  readonly usage: (projectId: string, after: string | undefined, limit: number) => Promise<{ readonly items: readonly UsageBody[]; readonly next?: string }>;
  /** Whether a task is paused now (L-cards' pause gates). Absent: no task is said to be paused. */
  readonly paused?: (taskId: string) => Promise<boolean>;
  /** Appends one step to a task's activity; `commandId` makes a repeat change nothing. */
  readonly tell: (taskId: string, commandId: string, summary: string, adoptionId: string) => Promise<void>;
  /** Tells the owner once; `commandId` makes a repeat change nothing. */
  readonly notify: (command: { readonly commandId: string; readonly adoptionId: string; readonly projectId: string; readonly detail: string }) => Promise<void>;
}

const TERMINAL = new Set(["done", "cancelled"]);
const stale = (error: unknown): boolean => error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict");

/** The changes that start a look, written in the withdrawal's own write: the look record, and its entry in the pending list (unless the list is full). */
export async function lookStartChanges(runner: CommandRunner, start: Pick<LookBody, "adoptionId" | "projectId" | "experimentId" | "target" | "targetDigest" | "why">): Promise<Change[]> {
  const listRef: AggregateRef = { kind: LOOKS_KIND, id: LOOKS_ID };
  const found = await runner.get(listRef.kind, listRef.id);
  const pending = pendingOf(found?.body);
  const listed = pending.includes(start.adoptionId) || pending.length < LOOK_LIMITS.pending;
  const body: LookBody = { ...start, state: "looking", scope: start.target.kind === "tool" ? "tool-runs" : "not-recorded", pages: 0, runs: 0, tasks: {}, untracked: 0, told: 0, startedAt: runner.now(), ...(listed ? {} : { unlisted: true as const }) };
  const changes: Change[] = [{ type: "create", ref: { kind: LOOK_KIND, id: start.adoptionId }, body: clean(body) }];
  if (listed && !pending.includes(start.adoptionId)) {
    const next = { pending: [...pending, start.adoptionId] } as unknown as JsonObject;
    changes.push(found === undefined ? { type: "create", ref: listRef, body: next } : { type: "update", ref: listRef, expectedRevision: found.revision, body: next });
  }
  return changes;
}

const pendingOf = (body: unknown): string[] => {
  const p = (body as { pending?: unknown } | undefined)?.pending;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string").slice(0, LOOK_LIMITS.pending) : [];
};

export class AffectedWorkLook {
  readonly #runner: CommandRunner;
  readonly #ports: AdoptionLookPorts | undefined;
  /** Where the next sweep begins in the pending list (in memory): a look that keeps failing does not hold up the ones after it. */
  #sweepFrom = 0;

  constructor(runner: CommandRunner, ports: AdoptionLookPorts | undefined) { this.#runner = runner; this.#ports = ports; }

  get ready(): boolean { return this.#ports !== undefined; }

  async read(adoptionId: string): Promise<{ revision: number; body: LookBody } | undefined> {
    const found = await this.#runner.get(LOOK_KIND, adoptionId);
    return found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as LookBody };
  }

  /**
   * Carries one look on by at most `pages` pages, then, once it is done, tells the owner and takes it out of the pending list. Answers the look as it stands afterwards (`undefined`: no look for this
   * adoption, or no ports here). A step that lost a race to another process is not repeated: the other one carries on.
   */
  async run(adoptionId: string, pages: number = LOOK_LIMITS.pagesPerCall): Promise<LookBody | undefined> {
    const ports = this.#ports;
    if (ports === undefined) return undefined;
    for (let i = 0; i <= pages; i++) {
      const got = await this.read(adoptionId);
      if (got === undefined) return undefined;
      const look = got.body;
      if (look.state === "done") {
        if (look.notified !== true) await this.#finish(ports, adoptionId, look, got.revision);
        return (await this.read(adoptionId))?.body;
      }
      if (i === pages) return look;
      try { await this.#step(ports, adoptionId, look, got.revision); } catch (error) { if (stale(error)) return (await this.read(adoptionId))?.body; throw error; }
    }
    return (await this.read(adoptionId))?.body;
  }

  /** The dispatcher's tick: carries on at most `LOOK_LIMITS.perTick` looks of the pending list, from where the last sweep stopped. A look whose record is gone leaves the list. Writes nothing when none is pending. */
  async sweep(): Promise<{ looked: number; failed: number }> {
    if (this.#ports === undefined) return { looked: 0, failed: 0 };
    const pending = pendingOf((await this.#runner.get(LOOKS_KIND, LOOKS_ID))?.body);
    if (pending.length === 0) return { looked: 0, failed: 0 };
    const from = this.#sweepFrom % pending.length;
    const take = [...pending.slice(from), ...pending.slice(0, from)].slice(0, LOOK_LIMITS.perTick);
    this.#sweepFrom = from + take.length;
    let looked = 0; let failed = 0;
    for (const id of take) {
      try {
        if ((await this.read(id)) === undefined) await this.#unlist(id);
        else await this.run(id);
        looked++;
      } catch { failed++; }
    }
    return { looked, failed };
  }

  async #step(ports: AdoptionLookPorts, id: string, look: LookBody, revision: number): Promise<void> {
    let next: LookBody;
    if (look.target.kind === "practice") {
      next = { ...look, state: "done", doneAt: this.#runner.now() };
    } else {
      const t = look.target;
      const page = await ports.usage(look.projectId, look.after, LOOK_LIMITS.page);
      const tasks: Record<string, AffectedState> = { ...look.tasks };
      let runs = look.runs; let untracked = look.untracked; let told = look.told;
      for (const u of page.items.slice(0, LOOK_LIMITS.page)) {
        if (u.name !== t.name || u.version !== t.version || look.targetDigest === undefined || u.digest !== look.targetDigest || u.projectId !== look.projectId || typeof u.taskId !== "string") continue;
        runs++;
        if (tasks[u.taskId] !== undefined) continue;
        if (Object.keys(tasks).length >= LOOK_LIMITS.tasks) { untracked++; continue; }
        const state = await this.#stateOf(ports, u.taskId, look.projectId);
        // The task is told before the step's write; its command ID is the adoption's and the task's, so a step repeated after a restart or a lost race tells it nothing new.
        if (state === "paused" || state === "open") { await tellOnce(ports, u.taskId, `adp-look-${id}-${u.taskId}`, tellText(look, state), id); told++; }
        tasks[u.taskId] = state;
      }
      const pages = look.pages + 1;
      const more = page.next !== undefined && page.items.length > 0;
      const done = !more || pages >= LOOK_LIMITS.pages;
      next = { ...look, pages, runs, tasks, untracked, told, ...(more ? { after: page.next } : {}), ...(done ? { state: "done" as const, doneAt: this.#runner.now(), ...(more ? { partial: true as const } : {}) } : {}) };
      if (!more) { const { after: _a, ...rest } = next; void _a; next = rest as LookBody; }
    }
    await this.#runner.command("adoption.look", { commandId: `adp-look-${id}-${revision}`, actor: "controller" }, async () => ({
      payload: { adoptionId: id, revision },
      build: async () => {
        const now = await this.#runner.get(LOOK_KIND, id);
        if (now === undefined || now.revision !== revision) throw new DomainError("stale_revision", `the look of ${id} moved on meanwhile`);
        return { ref: { kind: LOOK_KIND, id }, creates: false, changes: [{ type: "update", ref: { kind: LOOK_KIND, id }, expectedRevision: revision, body: clean(next) }], detail: { adoptionId: id, pages: next.pages, state: next.state } };
      },
    }));
  }

  async #stateOf(ports: AdoptionLookPorts, taskId: string, projectId: string): Promise<AffectedState> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as { state?: unknown; projectId?: unknown } | undefined;
    if (task === undefined || task.projectId !== projectId) return "missing";
    if (typeof task.state === "string" && TERMINAL.has(task.state)) return "finished";
    return ports.paused !== undefined && (await ports.paused(taskId)) ? "paused" : "open";
  }

  /** Tells the owner (once: the command ID is the adoption's), then marks the look told and takes it out of the pending list in one write. */
  async #finish(ports: AdoptionLookPorts, id: string, look: LookBody, revision: number): Promise<void> {
    await ports.notify({ commandId: `adoption-look-${id}`, adoptionId: id, projectId: look.projectId, detail: noticeText(look) });
    // The command ID carries the look's revision: a repeat at the same revision is the same command, and a look that was written again since (by a restore) is told on its own.
    await this.#runner.command("adoption.look.told", { commandId: `adp-told-${id}-${revision}`, actor: "controller" }, async () => ({
      payload: { adoptionId: id, revision },
      build: async () => {
        const now = await this.#runner.get(LOOK_KIND, id);
        if (now === undefined || now.revision !== revision) throw new DomainError("stale_revision", `the look of ${id} moved on meanwhile`);
        const changes: Change[] = [{ type: "update", ref: { kind: LOOK_KIND, id }, expectedRevision: revision, body: clean({ ...look, notified: true }) }];
        const list = await this.#unlistChange(id);
        if (list !== undefined) changes.push(list);
        return { ref: { kind: LOOK_KIND, id }, creates: false, changes, detail: { adoptionId: id } };
      },
    })).catch((error: unknown) => { if (!stale(error)) throw error; });
  }

  async #unlist(id: string): Promise<void> {
    if ((await this.#unlistChange(id)) === undefined) return;
    await this.#runner.command("adoption.look.unlist", { commandId: `adp-unlist-${id}`, actor: "controller" }, async () => ({
      payload: { adoptionId: id },
      build: async () => {
        const change = await this.#unlistChange(id);
        if (change === undefined) throw new DomainError("stale_revision", `${id} already left the pending list`);
        return { ref: { kind: LOOKS_KIND, id: LOOKS_ID }, creates: false, changes: [change], detail: { adoptionId: id } };
      },
    })).catch((error: unknown) => { if (!stale(error)) throw error; });
  }

  async #unlistChange(id: string): Promise<Change | undefined> {
    const ref: AggregateRef = { kind: LOOKS_KIND, id: LOOKS_ID };
    const found = await this.#runner.get(ref.kind, ref.id);
    const pending = pendingOf(found?.body);
    if (found === undefined || !pending.includes(id)) return undefined;
    return { type: "update", ref, expectedRevision: found.revision, body: { pending: pending.filter((x) => x !== id) } as unknown as JsonObject };
  }
}

/**
 * Tells a task once. The step's command ID belongs to this adoption and this task, and activity reports a lost race on the task's steps as `stale_revision`, so `command_conflict` here means the ID was
 * already used: the task was told by an earlier step whose look write was lost (a restart, or a race), when it was judged differently (paused then, open now). It is told, so the look goes on; without
 * this the same page would be read again at every tick and the look would never finish (first review).
 */
async function tellOnce(ports: AdoptionLookPorts, taskId: string, commandId: string, summary: string, adoptionId: string): Promise<void> {
  try { await ports.tell(taskId, commandId, summary, adoptionId); } catch (error) { if (!(error instanceof DomainError && error.code === "command_conflict")) throw error; }
}

/** How many tasks were in each state when first seen. */
export function affectedCounts(tasks: Readonly<Record<string, AffectedState>>): Record<AffectedState, number> {
  const out: Record<AffectedState, number> = { paused: 0, open: 0, finished: 0, missing: 0 };
  for (const v of Object.values(tasks)) if (Object.hasOwn(out, v)) out[v]++;
  return out;
}

const shortName = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const whyText = (look: LookBody): string => (look.why === "regression" ? "monitoring showed a regression" : "by a decision");

/** The step written into an unfinished task's activity (deterministic, so a repeat is the same command). */
export function tellText(look: LookBody, state: "paused" | "open"): string {
  const t = look.target as { name: string; version: string };
  return `Adoption ${look.adoptionId} of tool ${shortName(t.name, 80)} ${t.version} in this project was withdrawn (${whyText(look)}), so it is no longer in force. This task ran that version${state === "paused" ? " and is paused" : ""}; it keeps it (the version is not set aside or removed, and nothing this task did is undone).`;
}

/** The owner's notice (at most the notification detail limit of 200 characters): the counts and a few task IDs, paused ones first; the full list is the look's record (`adoption.affected`). */
export function noticeText(look: LookBody): string {
  const head = `Adoption ${look.adoptionId} withdrawn (${look.why}).`;
  if (look.target.kind === "practice") return `${head} Which tasks applied a practice is not recorded, so no task was told.`.slice(0, 200);
  const states = Object.entries(look.tasks);
  const count = (s: AffectedState) => states.filter(([, v]) => v === s).length;
  const sample = [...states.filter(([, v]) => v === "paused"), ...states.filter(([, v]) => v === "open")].slice(0, LOOK_LIMITS.sample).map(([k]) => k);
  const more = look.partial === true || look.untracked > 0 ? " (more not read)" : "";
  const body = ` ${states.length} task(s) ran it${more}: ${count("paused")} paused, ${count("open")} open (told), ${count("finished") + count("missing")} finished.`;
  const base = `${head}${body}`;
  const ids = sample.length === 0 ? "" : ` E.g. ${sample.join(", ")}`;
  return (base.length + ids.length <= 200 ? `${base}${ids}` : base).slice(0, 200);
}

/** The status view's words for a withdrawn adoption's look (read-only, no prompt text). */
export function affectedLine(look: Pick<LookBody, "state" | "scope" | "runs" | "tasks" | "untracked" | "partial" | "notified" | "told"> & { readonly counts?: Readonly<Record<AffectedState, number>> }): string {
  if (look.scope === "not-recorded") return "Which tasks applied the practice is not recorded, so no task was found or told.";
  // A viewer who may not read the project's run records gets the counts without the task IDs (`AdoptionService.affected`).
  const counts = look.counts ?? affectedCounts(look.tasks);
  const total = counts.paused + counts.open + counts.finished + counts.missing;
  if (look.state === "looking") return `The look at the work that ran this version is not finished yet (${look.runs} run(s) and ${total} task(s) found so far; it goes on at the next tick).`;
  const limit = look.partial === true || look.untracked > 0 ? " Not every run record was read or recorded (the look's limit), so there may be more." : "";
  return `Affected work, from the tool's run records: ${total} task(s) ran this version; ${counts.paused} paused and ${counts.open} open were told in their activity and keep the version, ${counts.finished + counts.missing} finished or gone were left as they are.${limit}${look.notified === true ? "" : " The owner has not been told yet."}`;
}
