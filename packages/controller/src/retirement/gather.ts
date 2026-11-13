import { createHash } from "node:crypto";
import type { AssignmentBody } from "../domain/assignment-model.js";
import type { ProjectBody, TaskBody } from "../domain/model.js";
import type { CommandRunner } from "../domain/runner.js";
import type { AgentBody } from "../agents/agents.js";
import type { GrantRecordBody } from "../security/grants.js";
import type { LeaseBody } from "../projects/leases.js";
import type { ResourceBody } from "../projects/resources.js";
import type { ResponsibilityBody } from "../projects/responsibilities.js";
import type { IntegratorLeaseBody } from "../landing/integrator-lease.js";
import { canonicalJson } from "../storage/json.js";
import type { Aggregate } from "../storage/types.js";

/** Most records of one kind a retirement reads before it refuses to answer (it never decides from a partial look). */
export const RETIREMENT_SCAN_LIMIT = 50_000;
/** Most records of one list a single retirement releases; past it the plan has a blocker and the owner narrows the work first. */
export const RETIREMENT_LIST_LIMIT = 200;

export interface Blocker {
  /** `assignment` (a live task), `responsibility` (an active duty answered by the agent), `report` (an active agent still reports to it), `too-many` (a list is longer than one retirement handles), `unreadable` (a look did not finish). */
  readonly kind: "assignment" | "responsibility" | "report" | "too-many" | "unreadable";
  readonly id: string;
  readonly why: string;
}

/** What retiring releases or revokes, by record ID. Everything listed is read now; the retirement acts on exactly this and records it. */
export interface ReleaseLists {
  readonly maintenanceLeases: readonly string[];
  readonly integratorLeases: readonly string[];
  readonly grants: readonly string[];
  readonly resources: readonly string[];
  readonly responsibilities: readonly string[];
  /** An agent's own credential is taken away (and its identity disabled); a project has none. */
  readonly credential: boolean;
}

export interface Plan {
  readonly kind: "agent" | "project";
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly blockers: readonly Blocker[];
  readonly release: ReleaseLists;
  /** What the owner must give back as `confirm`: it covers the record's revision, every blocker and everything released, so what is done is what was shown. */
  readonly digest: string;
}

const FINAL = new Set(["done", "cancelled"]);

/** Every record of a kind that `keep` accepts. `undefined` when there are more records than the scan limit (never a silent cut). */
export async function scan(runner: CommandRunner, kind: string, keep: (a: Aggregate) => boolean): Promise<Aggregate[] | undefined> {
  const out: Aggregate[] = [];
  let after: string | undefined; let seen = 0;
  for (;;) {
    const page = await runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    seen += page.length;
    for (const r of page) if (keep(r)) out.push(r);
    if (page.length < 500) return out;
    if (seen >= RETIREMENT_SCAN_LIMIT) return undefined;
    after = page[page.length - 1]!.id;
  }
}

/** The tasks that are assigned and not finished, by whoever holds them (`owns` decides from the assignment's owner and the task). Used by the plan and by the agent-retire guard. */
export async function liveAssignments(runner: CommandRunner, owns: (owner: { kind: string; id: string }, task: TaskBody) => boolean): Promise<{ items: Blocker[]; complete: boolean }> {
  const found = await scan(runner, "assignment", (a) => { const b = a.body as unknown as AssignmentBody; return b.state === "assigned" && b.owner !== undefined; });
  if (found === undefined) return { items: [], complete: false };
  const items: Blocker[] = [];
  for (const a of found) {
    const b = a.body as unknown as AssignmentBody;
    const task = await runner.get("task", b.taskId);
    const body = task?.body as unknown as TaskBody | undefined;
    if (body === undefined || FINAL.has(body.state) || !owns(b.owner!, body)) continue;
    items.push({ kind: "assignment", id: b.taskId, why: `task "${body.title.slice(0, 80)}" is assigned and ${body.state}; release or transfer it first` });
  }
  return { items, complete: true };
}

const digestOf = (value: unknown): string => createHash("sha256").update(canonicalJson(value as never)).digest("hex").slice(0, 32);

const cap = (kind: string, ids: string[], blockers: Blocker[]): string[] => {
  const sorted = [...ids].sort();
  if (sorted.length > RETIREMENT_LIST_LIMIT) blockers.push({ kind: "too-many", id: kind, why: `${sorted.length} ${kind} would be released, more than one retirement handles (${RETIREMENT_LIST_LIMIT}); release some first` });
  return sorted.slice(0, RETIREMENT_LIST_LIMIT);
};

/** What retiring an agent would do, read now. Undefined for an agent that does not exist. */
export async function planAgent(runner: CommandRunner, agentId: string): Promise<Plan | undefined> {
  const found = await runner.get("agent", agentId);
  if (found === undefined) return undefined;
  const agent = found.body as unknown as AgentBody;
  const principalId = agent.principalId;
  const blockers: Blocker[] = [];
  const mine = (id: string): boolean => id === agentId || id === principalId;
  const live = await liveAssignments(runner, (owner) => owner.kind === "agent" && mine(owner.id));
  if (!live.complete) blockers.push({ kind: "unreadable", id: "assignment", why: "the assignments could not all be read, so nothing is retired on a guess" });
  blockers.push(...live.items);
  const agents = await scan(runner, "agent", (a) => { const b = a.body as unknown as AgentBody; return b.state === "active" && b.supervisorId === agentId; });
  if (agents === undefined) blockers.push({ kind: "unreadable", id: "agent", why: "the agents could not all be read" });
  for (const a of agents ?? []) blockers.push({ kind: "report", id: a.id, why: `${a.id} still reports to this agent; move it first` });
  const duties = await scan(runner, "responsibility", (a) => { const b = a.body as unknown as ResponsibilityBody; return b.state !== "retired" && b.ownerId !== undefined && mine(b.ownerId); });
  if (duties === undefined) blockers.push({ kind: "unreadable", id: "responsibility", why: "the responsibilities could not all be read" });
  for (const d of duties ?? []) blockers.push({ kind: "responsibility", id: d.id, why: `it answers for responsibility "${(d.body as unknown as ResponsibilityBody).title.slice(0, 80)}"; give it to another agent or retire the responsibility first` });
  const leases = await scan(runner, "maintenance-lease", (a) => { const b = a.body as unknown as LeaseBody; return b.state === "held" && b.holderId !== undefined && mine(b.holderId); });
  const integrator = await scan(runner, "integrator-lease", (a) => { const b = a.body as unknown as IntegratorLeaseBody; return b.state === "held" && mine(b.holder); });
  const grants = await scan(runner, "grant-record", (a) => { const b = a.body as unknown as GrantRecordBody; return b.state === "active" && b.grantee === principalId; });
  if (leases === undefined || integrator === undefined || grants === undefined) blockers.push({ kind: "unreadable", id: "release", why: "the leases or grants could not all be read" });
  const principal = await runner.get("principal", principalId);
  const release: ReleaseLists = {
    maintenanceLeases: cap("maintenance leases", (leases ?? []).map((a) => a.id), blockers),
    integratorLeases: cap("integrator leases", (integrator ?? []).map((a) => a.id), blockers),
    grants: cap("grants", (grants ?? []).map((a) => a.id), blockers),
    resources: [], responsibilities: [],
    credential: (principal?.body as { credential?: unknown } | undefined)?.credential !== undefined,
  };
  const sorted = [...blockers].sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1));
  return { kind: "agent", id: agentId, name: agent.friendlyName, revision: found.revision, blockers: sorted, release, digest: digestOf({ kind: "agent", id: agentId, state: agent.state, blockers: sorted.map((b) => `${b.kind}:${b.id}`), release }) };
}

/** What archiving a project would do, read now. Undefined for a project that does not exist. */
export async function planProject(runner: CommandRunner, projectId: string): Promise<Plan | undefined> {
  const found = await runner.get("project", projectId);
  if (found === undefined) return undefined;
  const project = found.body as unknown as ProjectBody;
  const blockers: Blocker[] = [];
  const live = await liveAssignments(runner, (_owner, task) => task.projectId === projectId);
  if (!live.complete) blockers.push({ kind: "unreadable", id: "assignment", why: "the assignments could not all be read, so nothing is archived on a guess" });
  blockers.push(...live.items);
  const duties = await scan(runner, "responsibility", (a) => { const b = a.body as unknown as ResponsibilityBody; return b.projectId === projectId && b.state !== "retired"; });
  const leases = await scan(runner, "maintenance-lease", (a) => { const b = a.body as unknown as LeaseBody; return b.projectId === projectId && b.state === "held"; });
  const integrator = await scan(runner, "integrator-lease", (a) => { const b = a.body as unknown as IntegratorLeaseBody; return b.projectId === projectId && b.state === "held"; });
  const resources = await scan(runner, "project-resource", (a) => { const b = a.body as unknown as ResourceBody; return b.projectId === projectId && b.state === "bound"; });
  const grants = await scan(runner, "grant-record", (a) => { const b = a.body as unknown as GrantRecordBody; return b.project === projectId && b.state === "active"; });
  if ([duties, leases, integrator, resources, grants].some((x) => x === undefined)) blockers.push({ kind: "unreadable", id: "release", why: "the responsibilities, leases, resources or grants could not all be read" });
  const release: ReleaseLists = {
    maintenanceLeases: cap("maintenance leases", (leases ?? []).map((a) => a.id), blockers),
    integratorLeases: cap("integrator leases", (integrator ?? []).map((a) => a.id), blockers),
    grants: cap("grants", (grants ?? []).map((a) => a.id), blockers),
    resources: cap("resource bindings", (resources ?? []).map((a) => a.id), blockers),
    responsibilities: cap("responsibilities", (duties ?? []).map((a) => a.id), blockers),
    credential: false,
  };
  const sorted = [...blockers].sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1));
  return { kind: "project", id: projectId, name: project.name, revision: found.revision, blockers: sorted, release, digest: digestOf({ kind: "project", id: projectId, state: project.state, blockers: sorted.map((b) => `${b.kind}:${b.id}`), release }) };
}
