import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { STATUS_KINDS, StatusService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T08:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
type Cite = { kind: string; id?: string; revision?: number };
type Answer = { lines: readonly { text: string; cites: readonly Cite[] }[] } | undefined;
const citesProject = (lines: readonly { cites: readonly Cite[] }[], projectId: string): boolean => lines.every((l) => l.cites.some((x) => x.kind === "project" && x.id === projectId));

for (const backend of backends) {
  interface Ctx { owner: Principal; eve: Principal; project: string; make(standups?: unknown): StatusService }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const contracts = ContractService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "eve", grants: [{ action: "task.read", project: "*" }] });
        const eve = await principals.authenticate((await principals.issueCredential(owner, "agent:eve")).token);
        const make = (standups?: unknown): StatusService => StatusService.withEpoch(world.storage, epoch, { assignments, waits, blockers, contracts, ...(standups === undefined ? {} : { standups: standups as never }) }, options);
        await body({ owner, eve, project, make });
      } finally { await world.close(); }
    });

  suite("acceptance M03h: the standups view tells each stand-up in two lines, the schedule then its meetings, quotes the title, cuts a long roster and counts what it left out", async (c) => {
    const met = { scheduleId: "msc-aaaaaaaaaaaaaaaaaaaa1", revision: 3, title: "Daily stand-up", state: "active", time: "09:00", timeZone: "Europe/Berlin", recurrence: "daily", window: { from: "08:00", to: "10:00" }, durationMinutes: 30, roster: ["agent:ann", "agent:bob"], occurrences: 5, nextAt: "2026-10-23T07:00:00.000Z", nextOccurrenceId: "mto-aaaaaaaaaaaaaaaaaaaa2", nextRevision: 1, lastAt: "2026-10-22T07:00:00.000Z", lastState: "held", lastOccurrenceId: "mto-aaaaaaaaaaaaaaaaaaaa3", lastRevision: 2 };
    const paused = { scheduleId: "msc-aaaaaaaaaaaaaaaaaaaa4", revision: 1, title: 'Friday "review"', state: "paused", time: "10:00", timeZone: "UTC", recurrence: "weekly on Fri", durationMinutes: 45, roster: [] as string[], occurrences: 0 };
    const items = [met, paused];
    let askedLimit: number | undefined;
    const standups = {
      recent: async () => ({ items: [], more: false }),
      overview: async (by: Principal, _p: string, page?: { limit?: number }) => {
        if (by.kind !== "owner") return undefined;
        askedLimit = page?.limit;
        const kept = items.slice(0, page?.limit ?? 10);
        return { items: kept, more: kept.length < items.length, ended: 2 };
      },
    };
    const status = c.make(standups);
    const got = (await status.ask(c.owner, { kind: "standups", projectId: c.project } as never)) as Answer;
    assert.ok(got !== undefined);
    const text = got.lines.map((l) => l.text);
    assert.equal(text.length, 5, JSON.stringify(text));
    // The schedule line.
    assert.ok(text[0]!.startsWith('"Daily stand-up"'), text[0]);
    for (const part of ["active", "daily", "09:00", "Europe/Berlin", "30 minutes", "08:00", "10:00", "agent:ann", "agent:bob"]) assert.ok(text[0]!.includes(part), `${part} in ${text[0]}`);
    // The meetings line.
    for (const part of [met.nextAt, met.lastAt, "held", "5 meetings"]) assert.ok(text[1]!.includes(part), `${part} in ${text[1]}`);
    // A title with quotes in it is shown through quoted(), escaped; no roster names are invented.
    assert.ok(text[2]!.startsWith('"Friday \\"review\\""'), text[2]);
    for (const part of ["paused", "weekly on Fri", "10:00", "UTC", "45 minutes"]) assert.ok(text[2]!.includes(part), `${part} in ${text[2]}`);
    assert.doesNotMatch(text[2]!, /agent:/);
    assert.match(text[3]!, /nothing is planned/);
    assert.match(text[3]!, /not met yet/);
    assert.match(text[3]!, /\b0 meetings\b/);
    assert.match(text[4]!, /\b2 ended\b/);
    assert.ok(citesProject(got.lines, c.project), "every line cites the project");
    assert.ok(got.lines[0]!.cites.some((x) => x.kind === "meeting-schedule" && x.id === met.scheduleId && x.revision === 3), "the schedule line cites the schedule at its revision");
    const meetingCites = got.lines[1]!.cites.filter((x) => x.kind === "meeting").map((x) => x.id);
    assert.ok(meetingCites.includes(met.nextOccurrenceId) && meetingCites.includes(met.lastOccurrenceId), "the meetings line cites both meetings");

    // A page: the source is asked for the owner's limit, and the answer says it cut the rest.
    const limited = (await status.ask(c.owner, { kind: "standups", projectId: c.project, limit: 1 } as never)) as Answer;
    assert.equal(askedLimit, 1);
    const rest = limited!.lines.map((l) => l.text);
    assert.equal(rest.length, 4, JSON.stringify(rest));
    assert.match(rest.slice(2).join("\n"), /more stand-ups/);
    assert.match(rest.slice(2).join("\n"), /\b2 ended\b/);

    // Who may not read it, a missing service, bad requests, a missing project.
    assert.equal(await status.ask(c.eve, { kind: "standups", projectId: c.project } as never), undefined);
    assert.equal(await c.make().ask(c.owner, { kind: "standups", projectId: c.project } as never), undefined, "no stand-up service: the view is not offered");
    await refuses("invalid_command", () => status.ask(c.owner, { kind: "standups", projectId: c.project, limit: 0 } as never));
    await refuses("invalid_command", () => status.ask(c.owner, { kind: "standups", projectId: c.project, limit: 26 } as never));
    await refuses("invalid_command", () => status.ask(c.owner, { kind: "standups", projectId: c.project, agent: "agent:ann" } as never));
    await refuses("invalid_command", () => status.ask(c.owner, { kind: "standups", projectId: "nope!" } as never));
    assert.equal(await status.ask(c.owner, { kind: "standups", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } as never), undefined, "a project that is not there");

    // A long roster: ten names, then a count; an end date is told.
    const crowd = { scheduleId: "msc-aaaaaaaaaaaaaaaaaaaa7", revision: 9, title: "Crowded", state: "active", time: "08:00", timeZone: "UTC", recurrence: "daily", durationMinutes: 15, roster: Array.from({ length: 12 }, (_x, i) => `agent:w${i}`), occurrences: 1, lastAt: "2026-10-22T08:00:00.000Z", lastState: "missed", lastOccurrenceId: "mto-aaaaaaaaaaaaaaaaaaaa8", lastRevision: 4, endsOn: "2026-11-30" };
    const long = c.make({ recent: async () => ({ items: [], more: false }), overview: async () => ({ items: [crowd], more: false, ended: 0 }) });
    const crowdText = ((await long.ask(c.owner, { kind: "standups", projectId: c.project } as never)) as Answer)!.lines.map((l) => l.text);
    assert.equal(crowdText.length, 2, JSON.stringify(crowdText));
    for (let i = 0; i < 10; i++) assert.ok(crowdText[0]!.includes(`agent:w${i}`), `w${i} listed`);
    assert.ok(!crowdText[0]!.includes(crowd.roster[10]!) && !crowdText[0]!.includes(crowd.roster[11]!), "only ten names");
    assert.match(crowdText[0]!, /and 2 more/);
    for (const part of [crowd.lastAt, "missed", "2026-11-30"]) assert.ok(crowdText[1]!.includes(part), `${part} in ${crowdText[1]}`);
    assert.match(crowdText[1]!, /\b1 meeting\b/);
    assert.match(crowdText[1]!, /nothing is planned/);

    // Nothing running: one line saying so, with the ended ones counted.
    const none = c.make({ recent: async () => ({ items: [], more: false }), overview: async () => ({ items: [], more: false, ended: 0 }) });
    const noneText = ((await none.ask(c.owner, { kind: "standups", projectId: c.project } as never)) as Answer)!.lines.map((l) => l.text);
    assert.equal(noneText.length, 1);
    assert.match(noneText[0]!, /no stand-up/i);
    const onlyEnded = c.make({ recent: async () => ({ items: [], more: false }), overview: async () => ({ items: [], more: false, ended: 3 }) });
    const endedText = ((await onlyEnded.ask(c.owner, { kind: "standups", projectId: c.project } as never)) as Answer)!.lines.map((l) => l.text);
    assert.equal(endedText.length, 1);
    assert.match(endedText[0]!, /\b3 ended\b/);
  });

  suite("acceptance M03h: the standups kind is a status kind the interpreter is told about and the API summary names", async () => {
    const kind = STATUS_KINDS["standups"];
    assert.ok(kind !== undefined, "STATUS_KINDS has standups");
    assert.ok(kind.keys.includes("projectId") && kind.keys.includes("limit"));
    const ask = OPERATIONS.find((o) => o.name === "status.ask");
    assert.ok(ask !== undefined && ask.summary.includes("`standups`"), "the status.ask summary names the standups kind");
  });
}
