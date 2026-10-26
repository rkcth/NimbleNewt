import { AgentService } from "../../agents/index.js";
import { StateApi } from "../../api/index.js";
import { DeskService, HistoryService, RetrievalService } from "../../context/index.js";
import { AssignmentService } from "../../domain/assignments.js";
import { BlockerService } from "../../domain/blockers.js";
import { ProjectService } from "../../domain/service.js";
import { WaitService } from "../../domain/waits.js";
import type { Backend } from "../../domain/testing/backends.js";
import { InquiryService } from "../../inquiries/index.js";
import { MeetingService } from "../../meetings/index.js";
import { ContractService, WaitGraphService } from "../../planning/index.js";
import { ProjectPlanService, ProjectResourceService, ResponsibilityService } from "../../projects/index.js";
import { PrincipalService, TaskCredentialService, type Grant, type Principal } from "../../security/index.js";
import { ChatService, type ChatDeps } from "../chat.js";
import { CoordinatorService, type CoordinatorModel } from "../coordinator.js";
import { ScriptedInterpreter } from "../interpreter.js";

export const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
export const cid = (label: string): string => `${label}-${n++}`;

/** Everything a chat test needs, over one backend: the services, the owner's token and a way to make agents. */
export async function openWorld(backend: Backend, script: ConstructorParameters<typeof ScriptedInterpreter>[0] = {}, model: CoordinatorModel = { respond: async () => { throw new Error("no model"); } }) {
  const world = await backend.open();
  const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
  const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
  const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
  const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
  const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
  const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
  const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
  const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
  const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
  const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, BlockerService.withEpoch(world.storage, projects.epoch, options), options);
  const taskCredentials = TaskCredentialService.withEpoch(world.storage, projects.epoch, options);
  const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
  const plans = ProjectPlanService.withEpoch(world.storage, projects.epoch, options);
  const responsibilities = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
  const meetings = MeetingService.withEpoch(world.storage, projects.epoch, { inquiries }, { availability: async () => "available", ...options });
  const api = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, resources, plans, responsibilities, meetings });
  const ownerToken = (await principals.bootstrapOwner({ name: "rob" })).token;
  const owner = await principals.authenticate(ownerToken);
  const agent = async (name: string, grants: Grant[]): Promise<{ token: string; principal: Principal }> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants });
    const token = (await principals.issueCredential(owner, `agent:${name}`)).token;
    return { token, principal: await principals.authenticate(token) };
  };
  const interpreter = new ScriptedInterpreter(script);
  let coordinatorToken: string | undefined;
  const profile: { value: string | undefined } = { value: undefined };
  const policy = { effective: async () => (profile.value === undefined ? undefined : { profile: profile.value }) };
  const chatDeps = (over: Partial<ChatDeps> = {}): ChatDeps => ({ principals, api, interpreter, policy, coordinatorToken: async () => coordinatorToken, ...over });
  const chat = (over: Partial<ChatDeps> = {}) => ChatService.withEpoch(world.storage, projects.epoch, chatDeps(over), options);
  const coordinator = async (over: { grants?: Grant[]; model?: CoordinatorModel; routes?: () => Promise<readonly string[]> | readonly string[] } = {}) => {
    const made = await agent("coord", over.grants ?? [{ action: "attempt.work", project: "*" }, { action: "history.*", project: "*" }, { action: "desk.read", project: "*" }]);
    coordinatorToken = made.token;
    const service = CoordinatorService.withEpoch(world.storage, projects.epoch, { chat: chat(), retrieval, inquiries, projects, assignments, api, token: async () => coordinatorToken, model: over.model ?? model, ...(over.routes === undefined ? {} : { routes: over.routes }), principal: () => principals.authenticate(made.token) }, options);
    return { service, principal: made.principal };
  };
  const project = async (name: string, repositories: { id: string; location: string }[] = [{ id: "main", location: "/tmp/x" }]) => (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name, repositories })).id;
  const task = async (projectId: string, title: string, extra: Record<string, unknown> = {}) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title, ...extra } as never)).id;
  return { profile, world, meetings, resources, plans, responsibilities, projects, principals, assignments, desks, retrieval, inquiries, agents, contracts, api, ownerToken, owner, agent, interpreter, chat, coordinator, project, task, close: () => world.close() };
}
export type World = Awaited<ReturnType<typeof openWorld>>;
