import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ActivityService } from "./activity.js";

/**
 * A rerun of a replay (card U09b, standing in for card P07's simulation scope, which is not built). A replay itself never reruns anything (`ReplayService` holds no port that could, and `rerunRefused` says so);
 * a rerun is this separate owner-only command, and it runs only inside its own isolated scope: the scope holds no tool, no model, no message port and no effect ledger. It re-walks the steps the record has, from a
 * step on, and writes one `replay-simulation` record of what it would do again and with what outcome, every line labelled simulated. It can inject one provider failure at a step to see what would not be reached.
 * Nothing is run, sent, spent or changed; the owner grants real access separately and nothing here can use it. What it is NOT: a workflow run against simulated tools and events (P07 proper).
 */
export const SIMULATION_LABEL = "Simulated. Nothing was run, sent, spent or changed, and no real access was used; this is a walk through the recorded steps, not a new run.";
export const SIMULATION_LIMITS = { steps: 200, pageRead: 100 } as const;
const KIND = "replay-simulation";
/** What each kind of step would do again, in words. */
const WOULD: Readonly<Record<string, string>> = {
  "tool-call": "make the tool call again", "agent-message": "send the message again", "owner-message": "send the owner's message again", "artifact-version": "publish the artifact again", approval: "ask for the approval again",
  ownership: "hand the task over again", lifecycle: "stop or suspend again", "meeting-decision": "apply the meeting decision again", branch: "open or change the side line again", submission: "submit again",
  compression: "compress the history again", instruction: "be given the instruction again", "source-retrieved": "be given the source again", "model-selected": "select the model route again", "harness-selected": "select the harness again",
};
export interface SimulatedStep { readonly seq: number; readonly kind: string; readonly summary: string; readonly would: string; readonly recordedOutcome: string; readonly simulatedOutcome: "as-recorded" | "failed-injected" | "not-reached"; readonly simulated: true }
export interface SimulationBody {
  readonly taskId: string; readonly projectId: string; readonly by: string; readonly at: string; readonly from: number; readonly failAt?: number;
  readonly scope: { readonly kind: "simulation"; readonly isolated: true; readonly tools: 0; readonly providers: 0; readonly effects: 0 };
  readonly label: string; readonly steps: readonly SimulatedStep[]; readonly truncated: boolean;
}
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export class ReplaySimulationService {
  readonly #runner: CommandRunner;
  readonly #activity: Pick<ActivityService, "steps">;
  private constructor(runner: CommandRunner, activity: Pick<ActivityService, "steps">) { this.#runner = runner; this.#activity = activity; }
  static withEpoch(storage: ControllerStorage, epoch: number, activity: Pick<ActivityService, "steps">, options: RunnerOptions = {}): ReplaySimulationService { return new ReplaySimulationService(new CommandRunner(storage, epoch, options), activity); }

  /** Owner only. Walks the task's recorded steps from `from` (default the first) in an isolated scope and records what it would do again. `failAt` makes that step fail as a provider failure would, so the steps after it are not reached. */
  async simulate(by: Principal, command: NoActor & { taskId: string; from?: number; failAt?: number }): Promise<{ id: string; replayed: boolean; simulation: SimulationBody }> {
    onlyKnown(command, ["commandId", "taskId", "from", "failAt"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner may run a simulation");
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as { projectId: string } | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    const whole = (v: unknown, f: string): number | undefined => (v === undefined ? undefined : typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : invalid(f, "must be a step number from 1"));
    const from = whole(command.from, "from") ?? 1; const failAt = whole(command.failAt, "failAt");
    if (failAt !== undefined && failAt < from) invalid("failAt", "must be a step at or after from");
    const steps: SimulatedStep[] = []; let truncated = false; let failed = false;
    for (let after = from - 1; ; ) {
      const page = await this.#activity.steps(by, taskId, { after, limit: SIMULATION_LIMITS.pageRead });
      for (const s of page.steps) {
        if ("unavailable" in s) continue;
        if (steps.length >= SIMULATION_LIMITS.steps) { truncated = true; break; }
        const hit = failAt === s.seq;
        steps.push({ seq: s.seq, kind: s.kind, summary: redactText(s.summary).slice(0, 200), would: hit ? "fail as a provider failure would (injected)" : failed ? "not be reached after the injected failure" : (WOULD[s.kind] ?? "do it again"), recordedOutcome: s.outcome ?? "not-recorded", simulatedOutcome: hit ? "failed-injected" : failed ? "not-reached" : "as-recorded", simulated: true });
        if (hit) failed = true;
      }
      if (truncated || page.next === undefined) break;
      after = page.next;
    }
    if (failAt !== undefined && !failed) invalid("failAt", "is not a step of this task in the walked range");
    const at = this.#runner.now();
    const body: SimulationBody = { taskId, projectId: task.projectId, by: by.id, at, from, ...(failAt === undefined ? {} : { failAt }), scope: { kind: "simulation", isolated: true, tools: 0, providers: 0, effects: 0 }, label: SIMULATION_LABEL, steps, truncated };
    const id = derivedId("sim", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: KIND, id };
    const r = await this.#runner.command("activity.replay.simulate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, from, ...(failAt === undefined ? {} : { failAt }) },
      build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: JSON.parse(JSON.stringify(body)) as JsonObject }], detail: { taskId, steps: steps.length } }),
    }));
    const stored = (await this.#runner.get(KIND, r.id))!.body as unknown as SimulationBody;
    return { id: r.id, replayed: r.replayed, simulation: stored };
  }

  /** A recorded simulation, for the owner only. */
  async get(by: Principal, id: string): Promise<{ id: string; simulation: SimulationBody }> {
    if (by.kind !== "owner") throw new DomainError("not_found", "no such simulation");
    if (typeof id !== "string" || !/^sim-[a-z2-7]{20}$/.test(id)) throw new DomainError("not_found", "no such simulation");
    const found = await this.#runner.get(KIND, id);
    if (found === undefined) throw new DomainError("not_found", "no such simulation");
    return { id, simulation: found.body as unknown as SimulationBody };
  }
}
