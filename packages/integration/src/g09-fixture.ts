import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  AssignmentService, ContextBranchService, ContinuationService, DeskService, EffectService, GenerationService, HistoryService, InquiryService, PrincipalService, ProjectService, RetrievalService, WaitService,
  type EffectBridge, type EffectRequest, type Grant, type JsonObject, type Principal,
} from "@nimblenewt/controller";
import { type Backend } from "@nimblenewt/controller/testing";
import { PiAdapter, type AdapterTool } from "@nimblenewt/pi-adapter";

// Card G09. This file holds glue only: it wires the production controller services (C05 branches, L05 generation, H04 inquiries, C04 continuation) to the production Pi adapter over durable
// storage and a scripted model. Nothing here decides what a branch, a hold or a resume is; every such answer comes from the services.

export const clock = () => "2026-10-22T10:00:00.000Z";
export const options = { clock, pause: async () => undefined };
let n = 0;
export const cid = (label: string): string => `${label}-${n++}`;

/** A model request reduced to `role: text` lines: the exact context manifest the provider was handed. */
export function manifestOf(messages: readonly unknown[]): string[] {
  return (messages as { role: string; content: unknown }[]).map((message) => {
    const body = typeof message.content === "string" ? message.content
      : (message.content as { type: string; text?: string; name?: string }[]).map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `<call ${part.name}>` : `<${part.type}>`)).join("");
    return `${message.role}: ${body}`;
  });
}

/** A scripted provider, plus the manifest of every request it received, in order. */
export interface Provider {
  readonly models: Models;
  readonly ref: { readonly provider: string; readonly modelId: string };
  readonly seen: string[][];
  /** The next requests are answered with these texts, in order. */
  answers(...texts: string[]): void;
  /** The next requests are answered by these replies, in order; each request is recorded first. */
  script(...replies: (() => ReturnType<typeof fauxAssistantMessage>)[]): void;
}
export function provider(name: string, modelId: string, slow?: { tokensPerSecond: number; tokenSize: number }): Provider {
  const models = createModels();
  const faux = fauxProvider({ provider: name, models: [{ id: modelId }], ...(slow === undefined ? {} : { tokensPerSecond: slow.tokensPerSecond, tokenSize: { min: slow.tokenSize, max: slow.tokenSize } }) });
  models.setProvider(faux.provider);
  const seen: string[][] = [];
  const wrap = (make: () => ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly unknown[] }) => { seen.push(manifestOf(context.messages)); return make(); };
  return {
    models, ref: { provider: name, modelId }, seen,
    answers: (...texts) => faux.setResponses(texts.map((t) => wrap(() => fauxAssistantMessage(t)))),
    script: (...replies) => faux.setResponses(replies.map(wrap)),
  };
}

/** The real Pi adapter over durable JSONL storage in a directory that outlives the adapter. */
export class PiHome {
  readonly dir = mkdtempSync(join(tmpdir(), "nn-g09-"));
  readonly #open: PiAdapter[] = [];
  async open(p: Provider, tools: readonly AdapterTool[] = []): Promise<PiAdapter> {
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(this.dir, BACKGROUND_CONTEXT), models: p.models, model: p.ref, tools });
    this.#open.push(adapter);
    return adapter;
  }
  async close(adapter: PiAdapter): Promise<void> { await adapter.close(); this.#open.splice(this.#open.indexOf(adapter), 1); }
  async dispose(): Promise<void> {
    for (const a of this.#open.splice(0)) await a.close();
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The outside world: every execution, so "never executed" can be counted. */
export class Outside {
  readonly executions: string[] = [];
  bridge(): EffectBridge {
    return { idempotent: true, execute: async (r: EffectRequest): Promise<JsonObject> => { this.executions.push(r.key); return { receipt: `r-${this.executions.length}` }; } };
  }
}

export interface World {
  owner: Principal; ann: Principal; ben: Principal; mgr: Principal; host: Principal;
  a: string; task: string; other: string;
  projects: ProjectService; histories: HistoryService; desks: DeskService; assignments: AssignmentService; effects: EffectService; inquiries: InquiryService;
  continuations: ContinuationService;
  /** New service objects over the same storage, as after a controller restart. */
  branches(): ContextBranchService;
  generation(): GenerationService;
  close(): Promise<void>;
}

export async function openWorld(backend: Backend): Promise<World> {
  const world = await backend.open();
  const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const make = async (kind: "agent" | "host", name: string, grants: Grant[]) => {
    await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
    return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token);
  };
  const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
  const other = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "another task" })).id;
  await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: task, expectedRevision: 1, to: "ready" });
  const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
  await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task, owner: { kind: "agent", id: "ann" } });
  const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
  const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
  const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
  const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
  const effects = EffectService.withEpoch(world.storage, projects.epoch, assignments, { holder: "exec-1", ...options });
  const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
  const continuations = ContinuationService.withEpoch(world.storage, projects.epoch, options);
  const rights: Grant[] = [{ action: "history.*", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "attempt.work", project: a }];
  const ann = await make("agent", "ann", [...rights, { action: "effect.perform", project: a }]);
  const ben = await make("agent", "ben", rights);
  const mgr = await make("agent", "mgr", [{ action: "assignment.manage", project: a }, { action: "assignment.read", project: a }, { action: "attempt.work", project: a }]);
  const host = await make("host", "h1", []);
  return {
    owner, ann, ben, mgr, host, a, task, other, projects, histories, desks, assignments, effects, inquiries, continuations,
    branches: () => ContextBranchService.withEpoch(world.storage, projects.epoch, { histories, retrieval }, options),
    generation: () => GenerationService.withEpoch(world.storage, projects.epoch, { assignments, effects }, options),
    close: () => world.close(),
  };
}

/**
 * Keeps the controller's copy of a task's conversation (the task history the retained-context service forks) in step with the adapter's transcript: one line per message that has text, "role: text".
 * The controller's branch service and the adapter's fork are two records of the same boundary, and the tests compare them.
 */
export class Mirror {
  readonly #done = new Set<number>();
  constructor(private readonly world: World, private readonly taskId: string) {}
  static line(entry: { role: string | undefined; text: string; kind: string }): string | undefined {
    return entry.text === "" || (entry.role !== "user" && entry.role !== "assistant") ? undefined : `${entry.role}: ${entry.text}`;
  }
  async sync(adapter: PiAdapter): Promise<string[]> {
    const lines: string[] = [];
    for (const entry of await adapter.root().transcript()) {
      const line = Mirror.line(entry);
      if (line === undefined) continue;
      lines.push(line);
      if (this.#done.has(entry.id)) continue;
      await this.world.histories.append(this.world.ann, HistoryService.taskScopeId(this.taskId), { commandId: `mirror-${this.taskId}-${entry.id}`, text: line, taskId: this.taskId });
      this.#done.add(entry.id);
    }
    return lines;
  }
}
