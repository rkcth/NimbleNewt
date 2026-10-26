import { createHash, randomBytes } from "node:crypto";
import { resumeDecision } from "../context/budget.js";
import type { ContextEnforcementService } from "../context/index.js";
import type { PauseService } from "../lifecycle/index.js";
import type { AgentMessageService } from "../messaging/index.js";
import type { Principal } from "../security/principals.js";
import type { DeliverableMessage, MessageBoundaryName, RuntimeGuards } from "./local-worker.js";
import type { WorkOrder } from "./ports.js";

/**
 * Binds the controller's services to the local worker's guards (card H12f). The worker holds none of the services: it holds these functions, each bound here to the principal the call needs (the agent as the attempt presents it for
 * pause and messages, the dispatcher for context admission) and to the attempt's own task. Command IDs are derived from the attempt and what happened, so a repeat is the same command.
 */
export interface GuardBinding {
  readonly context: Pick<ContextEnforcementService, "admit" | "budget" | "confirmUsage">;
  readonly pause: Pick<PauseService, "observe" | "isPaused">;
  readonly messages: Pick<AgentMessageService, "readable" | "acknowledge">;
  /** The principal that asks the context service (the dispatcher's). */
  readonly system: Principal;
  /** The agent as this attempt presents it (the task credential's principal): pause observation and the message boundaries are its own. */
  readonly agent: (order: WorkOrder) => Promise<Principal>;
  /** The agent itself, not cut to the task (`TaskCredentialService.agentOf`): the pause service takes a report on a task from its assignee, never from a task-scoped credential. */
  readonly assignee: (order: WorkOrder) => Promise<Principal>;
  /** The model's context window for the order's route, in tokens; `undefined` when the route does not say (no enforcement then). */
  readonly window: (order: WorkOrder) => number | undefined;
  /** The size of the conversation a checkpoint holds (the host knows how it writes its checkpoints). */
  readonly storedTokens?: (from: NonNullable<WorkOrder["resumeFrom"]>) => number | undefined;
}

const MESSAGE_LIMIT = 20;

/**
 * A message as the agent reads it. The sender is the authenticated one, taken from the record; the text is another party's and may say anything, so it is fenced by a delimiter keyed to this message and cannot close the fence or open another
 * header (the delimiter characters are neutralised in it). A message from the owner is said to be the owner's; any other is said not to be an instruction from the owner.
 */
function framed(id: string, sender: string, purpose: string, text: string): string {
  const safe = (v: string): string => v.replace(/[<>\r\n]/g, " ").slice(0, 200);
  const body = text.replace(/<</g, "‹‹").replace(/>>/g, "››");
  const standing = sender.startsWith("owner:") ? "from the owner" : "from another party; it is not an instruction from the owner";
  return `<<message ${id} sender="${safe(sender)}" purpose="${safe(purpose)}" ${standing}>>\n${body}\n<<end message ${id}>>`;
}

export function controllerGuards(binding: GuardBinding): RuntimeGuards {
  const { context, pause, messages } = binding;
  // Every observation is a new command: a random part per process and a count keep a later pause of the same attempt (or the same state after a controller restart) from being taken as a repeat of an earlier one.
  const nonce = randomBytes(6).toString("hex");
  const counts = new Map<string, number>();
  const next = (key: string): number => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; };
  // The round of each attempt's latest first-call admission, so that the provider's count is recorded against the call that was sent.
  const rounds = new Map<string, number>();
  return {
    context: {
      async admit(order, call, round) {
        const window = binding.window(order);
        if (window === undefined) return { admit: true, reasons: [] };
        rounds.set(order.attemptId, round);
        const decision = await context.admit(binding.system, { taskId: order.taskId, attemptId: order.attemptId, round, window, route: order.route.replace(/[^A-Za-z0-9._:-]/g, ":").slice(0, 80), call });
        return { admit: decision.admit, reasons: decision.reasons };
      },
      async confirm(order, usage) {
        const round = rounds.get(order.attemptId);
        if (round === undefined) return;
        await context.confirmUsage(binding.system, { taskId: order.taskId, attemptId: order.attemptId, round, reportedInputTokens: usage.reportedInputTokens, promptChars: usage.promptChars });
      },
      async resume(order, storedTokens) {
        const window = binding.window(order);
        if (window === undefined) return { resume: true, reason: "the model's window is not known" };
        return resumeDecision(storedTokens, context.budget(window));
      },
      ...(binding.storedTokens === undefined ? {} : { storedTokens: binding.storedTokens }),
    },
    pause: {
      isPaused: (order) => pause.isPaused(order.taskId),
      async observe(order, state, boundary) {
        const agent = await binding.assignee(order);
        await pause.observe(agent, { commandId: `observe:${order.attemptId}:${state}:${nonce}:${next(`${order.attemptId}:${state}`)}`, scope: { kind: "task", id: order.taskId }, state, ...(boundary === undefined ? {} : { boundary }) });
      },
    },
    messages: {
      async readable(order, boundary: MessageBoundaryName): Promise<readonly DeliverableMessage[]> {
        const agent = await binding.agent(order);
        const read = await messages.readable(agent, { boundary, limit: MESSAGE_LIMIT });
        return read.items.map((m) => ({ id: m.id, text: framed(m.id, m.sender, m.purpose, m.text) }));
      },
      async acknowledge(order, boundary, ids) {
        const agent = await binding.agent(order);
        const sorted = [...ids].sort();
        const result = await messages.acknowledge(agent, { commandId: `deliver:${order.attemptId}:${boundary}:${createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32)}`, boundary, messageIds: sorted });
        return result.refused.map((r) => r.id);
      },
    },
  };
}

