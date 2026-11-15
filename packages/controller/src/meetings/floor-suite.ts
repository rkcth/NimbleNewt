import { AgentService } from "../agents/index.js";
import { DecisionService } from "../decisions/index.js";
import { ProjectService } from "../domain/service.js";
import { backends } from "../domain/testing/backends.js";
import type { Availability } from "../conversations/index.js";
import { PauseService } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { DeskService } from "../context/desks.js";
import { MeetingDeskReadService } from "./desk-reads.js";
import { MeetingFloorService, type FloorDeps, type TurnReply, type TurnRequest } from "./floor.js";
import { FLOOR_DEFAULTS, type FloorSettings } from "./floor-settings.js";
import { MeetingProcedureService, MeetingRecordService, MeetingService, taskUpdateApplier, type ProcedureSettings, type RecordOptions } from "./index.js";

/** What the harness needs to run a facilitated meeting against any storage backend: real services, a scripted model, no network. */
export interface FloorWorld {
  owner: Principal; service: Principal; mgr: Principal; outsider: Principal;
  asA: Principal; asB: Principal; asC: Principal; asD: Principal; asE: Principal;
  pA: string; pB: string; pC: string; pD: string; pE: string; project: string;
  meetings: MeetingService; records: MeetingRecordService; floor: MeetingFloorService; /** The one service that runs a motion; the floor is its members and chair. */ procedure: MeetingProcedureService; procSettings: { current: { -readonly [K in keyof ProcedureSettings]?: ProcedureSettings[K] } }; motion(rec: string, text?: string): Promise<string>; deskReads: MeetingDeskReadService; desks: DeskService; principals: PrincipalService; grants: GrantService; projects: ProjectService;
  storage: import("../storage/types.js").ControllerStorage;
  /** The controller's epoch and clock, for another service over the same storage (the meeting procedure of card M06). */
  epoch: number;
  iso: () => string;
  other: Map<string, Availability>;
  script: Script;
  settings: { current: FloorSettings };
  notices: { recordId: string; kind: string; text: string }[];
  created: { commandId: string; projectId: string; title: string; description: string; owner?: string }[];
  /** Hooks a test sets. */
  hooks: { checkpoint?: (agent: string) => Promise<{ savedAt: string; text: string } | undefined>; sourceRevision?: (cite: { kind: string; id: string }) => Promise<number | undefined>; budget?: (agent: string) => Promise<{ ok: true } | { ok: false; reason: string }>; fireTimer: (() => void)[]; timerMs: number[]; work: string[]; deskNotes?: (agent: string) => string | undefined };
  clock: { now: number; tick(minutes: number): void };
  /** A new floor (and the procedure over it) on the same storage, as after a restart; `w.floor` and `w.procedure` are the new ones. */
  reopen(extra?: Partial<FloorDeps>): MeetingFloorService;
  meet(o?: { roster?: string[]; chair?: string | null; join?: string[]; endsInMinutes?: number }): Promise<{ occ: string; rec: string }>;
  task(title?: string): Promise<{ id: string; revision: number }>;
  principalOf(agent: string): Principal | undefined;
}

/** Replies by kind; every call is logged. A rule returns a reply, or undefined to leave the call to the next rule. */
export class Script {
  readonly calls: TurnRequest[] = [];
  readonly rules: ((r: TurnRequest) => TurnReply | undefined | Promise<TurnReply | undefined>)[] = [];
  readonly gates: Map<string, Promise<void>> = new Map();
  inflight = 0;
  maxInflight = 0;
  on(rule: (r: TurnRequest) => TurnReply | undefined | Promise<TurnReply | undefined>): void { this.rules.unshift(rule); }
  reset(): void { this.rules.length = 0; this.calls.length = 0; this.gates.clear(); }
  of(kind: TurnRequest["kind"]): TurnRequest[] { return this.calls.filter((c) => c.kind === kind); }
  async turn(req: TurnRequest): Promise<TurnReply> {
    this.calls.push(req);
    this.inflight += 1; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      for (const rule of this.rules) { const v = await rule(req); if (v !== undefined) return v; }
      return defaultReply(req);
    } finally { this.inflight -= 1; }
  }
}

const short = (agent: string): string => agent.slice(-6);
export const defaultReply = (r: TurnRequest): TurnReply => {
  const t = (text: string, visible = 40): TurnReply => ({ text, usage: { visibleTokens: visible, hiddenTokens: 0, inputTokens: Math.ceil(r.prompt.text.length / 4) } });
  switch (r.kind) {
    case "statement": case "blind-statement": return t(`STANCE: for\nSTATEMENT: ${short(r.agent)} thinks the nightly build should move because the cache is warm.\nTLDR: none\nAMEND: none`);
    case "direct-answer": case "direct-continue": case "chair-answer": case "reply": return t(`STANCE: undecided\nSTATEMENT: ${short(r.agent)} answers briefly.\nTLDR: none`);
    case "owner-answer": return t(`ANSWER: ${short(r.agent)} answers the owner.\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none`);
    case "checkpoint-answer": return t(`I recall the build was green when I last looked.`);
    case "ballot": case "revision": return t(`VOTE: yes\nREASON: the cache is warm at that hour.`, 20);
    case "objection": return t("OBJECT: no", 5);
    case "chair-notes": return t("Notes: everyone favours the move; nobody gave numbers.", 30);
    case "chair-questions": return t(`{"questions":[]}`, 10);
    case "chair-summary": return t(`{"points":[]}`, 10);
    case "chair-reminders": return t(`{"reminders":[]}`, 10);
    case "desk-offer": return t(`{"read":[]}`, 10);
    case "desk-excerpts": return t(`{"excerpts":[]}`, 10);
    case "chair-ruling": return t("RULING: proceed\nREASON: the objection is noted.", 15);
    case "casting": return t("CASTING: no\nREASON: no clear majority.", 15);
    case "correction": return t("CORRECTION: none\nCONTRADICTS: no", 10);
    default: return t("ok");
  }
};

let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;

/** Runs `body` once for each storage backend with a fresh world. */
export function floorSuite(test: (name: string, run: () => Promise<void>) => unknown, name: string, body: (w: FloorWorld) => Promise<void>, o: { agents?: number } = {}): void {
  for (const backend of backends) {
    test(`${backend.name}: ${name}`, async () => {
      const clock = { now: Date.parse("2026-11-14T08:00:00.000Z"), tick(minutes: number): void { this.now += minutes * 60_000; } };
      const iso = (): string => new Date(clock.now).toISOString();
      const options = { clock: iso, pause: async () => undefined };
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const grants = GrantService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (kind: "agent" | "host", nm: string, g: { action: string; project: string }[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const agentIds: string[] = [];
        const names = ["A", "B", "C", "D", "E", ...Array.from({ length: Math.max(0, (o.agents ?? 5) - 5) }, (_, i) => `X${i}`)];
        for (const nm of names) agentIds.push((await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id);
        const ids = agentIds.map((i) => `agent:${i}`);
        const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
        const logins = new Map<string, Principal>();
        for (const id of ids) {
          await grants.grant(owner, { commandId: cid("g"), grantee: id, action: "desk.write", project, source: "direct", basis: "test" } as never);
          logins.set(id, await login(id));
        }
        const [pA, pB, pC, pD, pE] = ids as [string, string, string, string, string];
        const other = new Map<string, Availability>();
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { availability: pauses.availability, ...options });
        const decisions = DecisionService.withEpoch(world.storage, epoch, {}, options);
        const authority = async (id: string): Promise<Principal | undefined> => {
          const p = await principals.get(id);
          return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, iso());
        };
        const recOptions: RecordOptions = { ...options, authority, appliers: { "task.update": taskUpdateApplier(projects) }, shareable: async () => false };
        const records = MeetingRecordService.withEpoch(world.storage, epoch, { meetings, decisions }, recOptions);
        const deskReads = MeetingDeskReadService.withEpoch(world.storage, epoch, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const service = await enroll("host", "floorhost", [{ action: "meeting.manage", project }, { action: "meeting.read", project }]);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project }]);
        const outsider = await enroll("agent", "zed", []);
        const script = new Script();
        const settings = { current: { ...FLOOR_DEFAULTS } as FloorSettings };
        const notices: FloorWorld["notices"] = [];
        const created: FloorWorld["created"] = [];
        const hooks: FloorWorld["hooks"] = { fireTimer: [], timerMs: [], work: [] };
        const deps = (extra: Partial<FloorDeps> = {}): FloorDeps => ({
          records, deskReads, meetings, runner: script, service, principalOf: async (a) => logins.get(a), settings: async () => settings.current,
          budget: async (a) => (hooks.budget === undefined ? { ok: true } : hooks.budget(a)),
          followUps: { create: async (i) => { created.push(i); const t = await projects.createTask({ commandId: i.commandId, actor: owner.id, projectId: i.projectId, title: i.title.slice(0, 150), description: i.description }); return { id: t.id }; } },
          checkpointOf: async (a) => hooks.checkpoint?.(a), sourceRevision: async (c) => hooks.sourceRevision?.(c),
          notifyOwner: async (n) => { notices.push(n); }, work: { release: async (_r, a) => { hooks.work.push(`release ${a.join(",")}`); }, recall: async (_r, a) => { hooks.work.push(`recall ${a}`); } },
          deskNotes: async (a) => hooks.deskNotes?.(a), timer: (ms, fire) => { hooks.timerMs.push(ms); hooks.fireTimer.push(fire); return () => undefined; },
          ...extra,
        });
        const procSettings: FloorWorld["procSettings"] = { current: {} };
        const compose = (extra: Partial<FloorDeps> = {}): { floor: MeetingFloorService; procedure: MeetingProcedureService } => {
          let procedure: MeetingProcedureService | undefined;
          const floor = MeetingFloorService.withEpoch(world.storage, epoch, deps({ procedure: () => procedure, ...extra }), options);
          procedure = MeetingProcedureService.withEpoch(world.storage, epoch, records, { ...options, settings: async () => procSettings.current, floor: floor.asMembers(), chair: floor.asChair(), actAs: async (a: string) => logins.get(a),
            followUp: async (t) => { const made = await projects.createTask({ commandId: t.commandId, actor: owner.id, projectId: t.projectId, title: t.title, description: t.description }); created.push({ commandId: t.commandId, projectId: t.projectId, title: t.title, description: t.description, owner: t.agent }); return { taskId: made.id }; } });
          return { floor, procedure };
        };
        const first = compose();
        const floor = first.floor;
        const meet = async (m: { roster?: string[]; chair?: string | null; join?: string[]; endsInMinutes?: number } = {}): Promise<{ occ: string; rec: string }> => {
          const roster = m.roster ?? [pA, pB, pC];
          const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster, durationMinutes: m.endsInMinutes ?? 60 })).id;
          const chair = m.chair === null ? undefined : (m.chair ?? pD);
          const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, ...(chair === undefined ? {} : { chair }) })).id;
          for (const a of m.join ?? roster) await records.join(logins.get(a)!, { commandId: cid("j"), recordId: rec });
          return { occ, rec };
        };
        const self = {} as FloorWorld;
        Object.assign(self, {
          owner, service, mgr, outsider, asA: logins.get(pA)!, asB: logins.get(pB)!, asC: logins.get(pC)!, asD: logins.get(pD)!, asE: logins.get(pE)!, pA, pB, pC, pD, pE, project, meetings, records, floor, deskReads, desks, principals, grants, projects,
          storage: world.storage, epoch, iso, other, script, settings, notices, created, hooks, clock, procedure: first.procedure, procSettings,
          motion: async (rec: string, text = "Move the nightly build to 01:00 because the cache is warm then.") => (await records.move(logins.get(pD)!, { commandId: cid("mo"), recordId: rec, text })).id,
          reopen: (extra = {}) => { const c = compose(extra); self.floor = c.floor; self.procedure = c.procedure; return c.floor; },
          meet, task: async (title = "Write the guide") => { const t = await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title }); return { id: t.id, revision: t.revision }; },
          principalOf: (a: string) => logins.get(a),
        });
        await body(self);
      } finally { await world.close(); }
    });
  }
}
