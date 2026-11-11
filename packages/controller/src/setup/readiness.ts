import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";

/** `done`: set up. `default`: not chosen, the installation's default applies and works. `missing`: nothing yet. `optional`: not needed to start; shown so the owner knows it exists. */
export type ReadinessState = "done" | "default" | "missing" | "optional";

export interface ReadinessItem {
  readonly id: "owner" | "profile" | "project" | "version-control" | "model-route" | "host" | "notifications" | "agent" | "task" | "budgets";
  readonly label: string;
  readonly state: ReadinessState;
  /** Whether a first agent cannot work without it. */
  readonly required: boolean;
  /** What was found, in plain words. */
  readonly detail: string;
  /** The operation or step that sets it up. */
  readonly how: string;
  /**
   * What the chat tells the owner about this step (card U14): the question in plain words, with the recommended answer and what declining it means. The first-run conversation
   * works through the items in order and puts these to the owner one at a time; nothing is applied until the owner answers.
   */
  readonly guide: { readonly question: string; readonly recommended: string; readonly ifDeclined: string };
}

/** The plain-words guide of each step, kept apart from the records so a test can check that every item has one and that none of them names a secret. */
export const SETUP_GUIDE: Readonly<Record<ReadinessItem["id"], ReadinessItem["guide"]>> = {
  owner: { question: "You are the owner of this installation; your credential is kept in this computer's secret store, not in a file you have to guard.", recommended: "Nothing to decide; the launcher makes you the owner the first time it starts.", ifDeclined: "Nothing can be done without an owner." },
  profile: { question: "How much should the team ask you before it acts? Strict asks at every consequential step. Derived lets what you say authorize what it reasonably needs, and still asks about anything wider. Autonomous acts within the rights you have given.", recommended: "Start with strict; after a few approvals the system offers derived.", ifDeclined: "It stays strict, which is safe: nothing consequential happens without you." },
  project: { question: "What is your first project: its name, what it is for, and where its git repository is (a folder on this computer or an address)? A project may also start with no repository at all.", recommended: "Name it and point it at an existing repository.", ifDeclined: "Agents have nothing to work on until a project exists." },
  "version-control": { question: "Where is that repository hosted, and which CI checks it: GitHub, GitLab, a server of your own (which one?), or nowhere (a local repository with no remote)? Nothing here assumes GitHub.", recommended: "Say what you use; if it has no remote say none.", ifDeclined: "The answer stays open; work is still done in the local repository and the project's required checks are the ones you name for landing." },
  "model-route": { question: "Which model should the team use? Give a model server (a local one or a free route is a good start) and its address, and name the credential's name in the secret store if it needs a key. The team needs at least two routes on two different servers, so that losing one does not stop it.", recommended: "A local model plus one free or cheap cloud route as the backup.", ifDeclined: "A paid provider is left out; with no route at all the team cannot run, but the owner's records and views still work." },
  host: { question: "Which machine runs the agents? This computer is the usual first choice.", recommended: "This computer.", ifDeclined: "Tasks can be created and assigned, but nothing runs until a host has announced itself." },
  notifications: { question: "How do you want to hear from the team: the inbox only (nothing leaves this installation), or a named channel with digest times and quiet hours?", recommended: "The inbox to begin with.", ifDeclined: "The inbox stays the only place; nothing leaves the installation." },
  agent: { question: "What should the first agent be called, and what role does it have (author, reviewer, integrator, qa, docs or director)?", recommended: "An author named for the work, with the rights to work in the first project only.", ifDeclined: "No work can be assigned." },
  task: { question: "What is the first thing you want done?", recommended: "A small task you can check quickly.", ifDeclined: "The team waits for the first task; you can add one any time." },
  budgets: { question: "Do you want a ceiling on what a task may spend or how long it may run? None is imposed unless you ask.", recommended: "Leave it off for now.", ifDeclined: "Nothing is held against any task." },
};

export interface Readiness {
  /** True when every required item is `done`. */
  readonly ready: boolean;
  readonly items: readonly ReadinessItem[];
  /** The first required item that is missing, in the order a person sets them up; absent when ready. */
  readonly next?: ReadinessItem["id"];
}

const PAGE = 200;
const MAX_PAGES = 5;

/**
 * What is set up and what is missing before a first agent can work (card U14): a read-only look at the records, owner only. It changes nothing and reads no secret; a count is
 * the most it reports about a project or an agent. A thing the owner chose not to set (the approval profile, the notification channel) shows as `default`, not as a gap.
 */
export class SetupReadinessService {
  readonly #storage: ControllerStorage;
  private constructor(storage: ControllerStorage) { this.#storage = storage; }

  static withEpoch(storage: ControllerStorage, _epoch: number): SetupReadinessService { return new SetupReadinessService(storage); }

  async #each(kind: string, visit: (id: string, body: Record<string, unknown>) => void): Promise<boolean> {
    let afterId: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.#storage.listAggregates(kind, { ...(afterId === undefined ? {} : { afterId }), limit: PAGE });
      for (const a of page) { afterId = a.id; visit(a.id, a.body as unknown as Record<string, unknown>); }
      if (page.length < PAGE) return true;
    }
    return false; // more than the pages read; counts are then "at least"
  }

  async check(owner: Principal): Promise<Readiness> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not read the setup readiness`);
    const s = this.#storage;
    const items: Omit<ReadinessItem, "guide">[] = [];
    const plural = (n: number, one: string, more: string, capped: boolean): string => `${capped ? "at least " : ""}${n} ${n === 1 ? one : more}`;

    const installation = await s.getAggregate({ kind: "installation", id: "installation" });
    items.push({ id: "owner", label: "Owner identity and credential", required: true, state: installation === undefined ? "missing" : "done", detail: installation === undefined ? "this installation has no owner yet" : `owner principal ${String((installation.body as { ownerId?: unknown }).ownerId ?? "")}`, how: "PrincipalService.bootstrapOwner (once), then keep the token it returns" });

    const policy = await s.getAggregate({ kind: "approval-policy", id: "installation" });
    const chosen = (policy?.body as { profile?: unknown } | undefined)?.profile;
    items.push({ id: "profile", label: "Approval profile", required: false, state: typeof chosen === "string" ? "done" : "default", detail: typeof chosen === "string" ? `${chosen}` : "strict (the default for a new installation; nothing has been chosen)", how: "ask in chat to switch to derived or autonomous (strict, derived or autonomous)" });

    let projects = 0; let withRepository = 0;
    const completeP = await this.#each("project", (_id, body) => { if (body["state"] === "archived") return; projects++; if (Array.isArray(body["repositories"]) && body["repositories"].length > 0) withRepository++; });
    items.push({ id: "project", label: "A project", required: true, state: projects > 0 ? "done" : "missing", detail: projects === 0 ? "no project yet" : `${plural(projects, "active project", "active projects", !completeP)}, ${withRepository} with a repository bound`, how: "project.create, then resource.bind for its repository" });

    const table = (await s.getAggregate({ kind: "routing-table", id: "routing" }))?.body as { providers?: Record<string, { enabled?: boolean }>; routes?: Record<string, unknown> } | undefined;
    const enabled = Object.entries(table?.providers ?? {}).filter(([, p]) => p.enabled === true).map(([name]) => name);
    const routes = Object.keys(table?.routes ?? {}).filter((r) => enabled.includes(r.split("/")[0]!));
    items.push({ id: "model-route", label: "A model provider and route", required: true, state: routes.length > 0 ? "done" : "missing", detail: table === undefined ? "no routing table" : routes.length > 0 ? `${enabled.length} enabled provider(s), ${routes.length} usable route(s)` : "the routing table has no route on an enabled provider", how: "routing.provider.add (an owner command, also reached by chat): a provider, its address and models; or the configuration document's models section read by the launcher" });

    let hosts = 0; let announced = 0;
    const completeH = await this.#each("principal", (_id, body) => { if (body["kind"] === "host" && body["state"] === "active") hosts++; });
    await this.#each("host-record", () => { announced++; });
    items.push({ id: "host", label: "A host to run agents on", required: true, state: hosts > 0 && announced > 0 ? "done" : "missing", detail: hosts === 0 ? "no host enrolled" : announced === 0 ? `${plural(hosts, "host", "hosts", !completeH)} enrolled, none has announced itself` : `${plural(hosts, "host", "hosts", !completeH)} enrolled, ${announced} announced`, how: "host.local.set enabled true to run agents on this computer (it counts from the next start), or credential.issue kind host for a host on another machine, which then announces itself" });

    const notices = (await s.getAggregate({ kind: "notification-settings", id: "installation" }))?.body as { channel?: unknown; channelName?: unknown } | undefined;
    items.push({ id: "notifications", label: "How you are notified", required: false, state: notices === undefined ? "default" : "done", detail: notices === undefined ? "the inbox (nothing leaves the installation)" : notices.channel === "external" ? `external channel ${String(notices.channelName ?? "")}` : "the inbox", how: "notifications.configure" });

    let agents = 0;
    const completeA = await this.#each("agent", (_id, body) => { if (body["state"] === "active") agents++; });
    items.push({ id: "agent", label: "A first agent", required: true, state: agents > 0 ? "done" : "missing", detail: agents === 0 ? "no active agent" : plural(agents, "active agent", "active agents", !completeA), how: "agent.create, grant.create for its rights, then credential.issue kind agent for its credential" });

    let tasks = 0;
    const completeT = await this.#each("task", () => { tasks++; });
    items.push({ id: "task", label: "A first task", required: false, state: tasks > 0 ? "done" : "optional", detail: tasks === 0 ? "no task yet" : plural(tasks, "task", "tasks", !completeT), how: "task.create, task.transition, task.assign" });

    // Where the repository is hosted and which CI checks it, per project (card U14): optional, so a project without an answer shows as open without stopping the first agent.
    let asked = 0; const unasked: string[] = [];
    await this.#each("project", (_id, body) => { if (body["state"] === "archived") return; if (body["versionControl"] === undefined) unasked.push(String(body["name"] ?? "")); else asked++; });
    items.splice(items.findIndex((i) => i.id === "project") + 1, 0, { id: "version-control", label: "Version control host and CI of each project", required: false, state: projects === 0 ? "optional" : unasked.length === 0 ? "done" : "missing", detail: projects === 0 ? "no project yet" : unasked.length === 0 ? `${asked} project(s) with a host and CI recorded` : `${asked} of ${asked + unasked.length} project(s) have a host and CI recorded; open: ${unasked.slice(0, 5).map((n) => `"${n.slice(0, 60)}"`).join(", ")}${unasked.length > 5 ? ` and ${unasked.length - 5} more` : ""}`, how: "project.update with versionControl { host: github, gitlab, self-hosted or none; ci }" });
    items.push({ id: "budgets", label: "Budgets and time limits", required: false, state: "default", detail: "none are imposed; a task with no budget has nothing held against it", how: "model-budget.set and the budget operations, only if you want a ceiling" });

    const next = items.find((i) => i.required && i.state !== "done")?.id;
    return { ready: next === undefined, items: items.map((i) => ({ ...i, guide: SETUP_GUIDE[i.id] })), ...(next === undefined ? {} : { next }) };
  }
}
