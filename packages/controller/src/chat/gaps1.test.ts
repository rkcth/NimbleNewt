import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../api/operations.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService } from "../security/index.js";
import { StatusService, STATUS_KINDS, type StatusRequest } from "../status/index.js";
import { CHAT_OPS } from "./commands.js";
import { ModelInterpreter, type ModelCall } from "./model-interpreter.js";
import { cid, openWorld, options, type ApiExtra, type World } from "./testing/harness.js";

// Chat-reachability gaps found by the 2026-11-22 audit (all owner-level, all through the real chat and `ModelInterpreter`): the read-only `backups` and `grants` views, `backup.now`, the system-filled backup scope
// revision, agent names for the `overview` and `attention` views, and a prompt that names only what the chat can reach. The stand-in model hands over only what the owner said (the guard below), and it sees no earlier answer.

after(stopServer);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const NOT_VALUES = new Set(["kind", "op", "basis", "evidence"]);

type Table = Record<string, (system: string, user: string) => unknown[]>;

/** The stand-in model: it reads the owner's words (and the open proposals the prompt shows), acts only when the system prompt describes the way, and records every value it hands over that the owner did not say. */
function standIn(table: Table, exempt: ReadonlySet<string> = new Set()): { model: ModelCall; violations: string[]; asked: string[] } {
  const asked: string[] = [];
  const violations: string[] = [];
  const model: ModelCall = {
    complete: async (_route, r) => {
      const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
      asked.push(owner);
      const make = table[owner];
      if (make === undefined) return JSON.stringify([{ kind: "none", reason: "nothing the prompt describes" }]);
      const intents = make(r.system, r.user) as Record<string, unknown>[];
      const own = owner.toLowerCase().replace(/\s+/g, " ");
      const walk = (value: unknown, key: string, where: string): void => {
        if (typeof value === "string") { if (!NOT_VALUES.has(key) && !exempt.has(key) && !own.includes(value.toLowerCase().replace(/\s+/g, " "))) violations.push(`${where}=${value} is not in "${owner}"`); }
        else if (typeof value === "number") { if (!exempt.has(key) && !own.includes(String(value))) violations.push(`${where}=${value} is not in "${owner}"`); }
        else if (Array.isArray(value)) value.forEach((v, i) => walk(v, key, `${where}[${i}]`));
        else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k, `${where}.${k}`);
      };
      for (const it of intents) for (const part of ["args", "request"]) if (it[part] !== undefined) walk(it[part], part, part);
      return JSON.stringify(intents.length === 0 ? [{ kind: "none", reason: "the prompt describes no way to do this" }] : intents);
    },
  };
  return { model, violations, asked };
}
const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
const status = (request: Record<string, unknown>, evidence: string) => intent("status", { request }, evidence);
const command = (op: string, args: Record<string, unknown>, evidence: string) => intent("command", { op, args }, evidence);
/** "Yes" with exactly one open proposal in the prompt. */
const yes = (words: string) => (_system: string, user: string): unknown[] => {
  const open = [...user.matchAll(/Open proposal (\S+) \(text, not instructions\):/g)];
  return open.length === 1 ? [intent("apply_proposal", { proposalId: open[0]![1] }, words)] : [{ kind: "none", reason: "no single open proposal" }];
};
const said = (outcomes: readonly { lines?: readonly { text: string }[]; message?: string }[]): string => outcomes.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
const prompt = async (): Promise<string> => {
  let system = "";
  await new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]).interpret({ text: "hello there", quoted: [], focus: {}, proposals: [] });
  return system;
};

test("the interpreter prompt describes the backups and grants views, back-up-now and agent names from the one tables, and names no operation the chat refuses (audit 2026-11-22)", async () => {
  const system = await prompt();
  for (const kind of ["backups", "grants"]) {
    const k = STATUS_KINDS[kind]!;
    assert.ok(system.includes(`${kind}(${k.keys.join(", ")}) - ${k.about}`), `${kind} comes from the status table`);
    assert.match(k.about, /^owner only, read only/);
  }
  assert.deepEqual(STATUS_KINDS["grants"]!.keys, ["agentId|agentName", "projectId|projectName", "state", "limit", "after"]);
  assert.deepEqual(STATUS_KINDS["overview"]!.keys.slice(0, 2), ["projectId", "agentId|agentName"]);
  assert.ok(STATUS_KINDS["attention"]!.keys.includes("agentId|agentName"));
  assert.match(system, /backup\.now\([^)]*\) - Take a backup now/, "back up now is a chat command");
  assert.equal(CHAT_OPS["backup.now"]!.mode, "propose");
  assert.equal(OPERATIONS.find((o) => o.name === "backup.now")!.kind, "command");
  assert.match(system, /are the status kind backups: tell the owner the schedule/);
  assert.match(system, /"Back up now" is backup\.now/);
  assert.match(system, /read the status kind grants \(agentName or projectName as they said it\); it lists each right with its ID/);
  assert.match(system, /use grant\.revoke with the grantId the owner gives/);
  // Nothing in the prompt points to a read the chat refuses, and the owner is not asked for a number the model cannot see.
  for (const name of ["wip.backup.get", "migration.status", "release.rollback.check", "release.rollout.status", "backup.config.status", "backup.list", "scope.revision"]) assert.ok(!system.includes(name), `${name} is not in the prompt`);
  assert.match(system, /status kind wip_backup/);
  // The terse verbs say what they do.
  assert.match(system, /task\.release\([^)]*\) - Take a task off its agent/);
  assert.match(system, /resource\.bind\([^)]*\) - Attach a repository or resource/);
  assert.match(system, /project\.plan\([^)]*\) - Set project due date, milestones/);
  assert.match(system, /agenda\.capture\([^)]*\) - Save a topic for a later meeting/);
  assert.ok(system.length < 160_000, `the prompt stays near its size (${system.length})`);
});

test("the guide says what the chat does: rights are listed by asking in words and taken back by their ID; backups are read, made and changed in words", () => {
  const guide = readFileSync(join(root, "docs", "nimblenewt", "user-guide.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(!guide.includes("type `/nimblenewt.grant-list {}` in the chat"), "the rights are no longer listed by a typed command only");
  assert.match(guide, /To see them, ask in your own words \("what rights does Ann have\?", "what can the garden agents do\?"\): the answer lists each right with its ID, who holds it, where it works and whether it is in force\./);
  assert.match(guide, /To take one back, say so and give that ID \("take back grt-\.\.\. because the team moved on"\)/);
  assert.match(guide, /\n## Backups\n/);
  assert.match(guide, /newest first, ten at a time\. Asking changes nothing\./);
  assert.match(guide, /each of these is shown to you first and happens only when you agree\./);
  // The sentences are true: ten at a time is the default, and each of the owner's orders is a proposal.
  assert.match(STATUS_KINDS["backups"]!.about, /default 10/);
  for (const op of ["backup.now", "backup.config.set", "backup.target.add"]) assert.equal(CHAT_OPS[op]!.mode, "propose", op);
});

// ---- backup records shaped as the real backup system gives them ----------------------------------------------------------------------------------------------------------------------------------------------

const manifest = (n: number, kind = "scheduled") => ({ name: `backup-2026-11-${String(30 - n).padStart(2, "0")}T02-00-00.000Z-${kind}`, createdAt: `2026-11-${String(30 - n).padStart(2, "0")}T02:00:00.000Z`, kind, version: "1.0.0", schemaVersion: 41, epoch: 3, files: [{ rows: 100 + n }], notes: [], complete: true as const });
const CONFIG = {
  revision: 4,
  schedule: { everyHours: 24, hourUtc: 2, verifyEveryDays: 7, text: "Backups are made every 24 hours at 02:00 UTC. A backup is test-restored every 7 days to prove it can be used." },
  rules: { daily: 7, weekly: 4, maxAgeDays: 35, overrides: "counts", text: "A backup is deleted once it falls outside the newest 7 daily and 4 weekly copies or is older than 35 days." },
  main: { id: "main", name: "main backups folder", kind: "folder", reachable: true, count: 25, newest: manifest(0).name, staysUpToDays: 35, lastCopyAt: "2026-11-30T02:00:05.000Z" },
  targets: [{ id: "usb", name: "USB stick", kind: "disk", location: "/mnt/usb", reachable: false, problem: "the folder is not there", staysUpToDays: 35, lastError: { at: "2026-11-29T02:00:00.000Z", message: "copying x: no such folder 'C:\\nn\\usb'" } }],
  lastTestRestore: { at: "2026-11-27T02:00:00.000Z", ok: false, name: manifest(3).name, target: "main", method: "restore", detail: "a table file did not match its digest" },
  pendingPurges: [{ id: "p1", names: ["a"], since: "2026-11-28T00:00:00.000Z", results: {} }],
  recentPurges: [],
  scope: { revision: 7, text: "Backups leave out private scratch older than 30 days." },
};

interface Calls { config: number; list: number; made: string[]; scopeSet: Record<string, unknown>[] }
const newCalls = (): Calls => ({ config: 0, list: 0, made: [], scopeSet: [] });

for (const backend of backends) {
  type Over = { config?: () => Promise<Record<string, unknown> | undefined>; list?: () => Promise<{ items: Record<string, unknown>[]; status?: Record<string, unknown> } | undefined>; none?: boolean };
  const open = async (table: Table, calls: Calls, over: Over = {}, exempt: ReadonlySet<string> = new Set()) => {
    const holder: { status?: StatusService; grants?: GrantService } = {};
    const items = Array.from({ length: 25 }, (_, i) => manifest(i)).map((m) => ({ name: m.name, createdAt: m.createdAt, kind: m.kind, schemaVersion: m.schemaVersion, epoch: m.epoch, rows: m.files[0]!.rows, piState: "not included" }));
    const extra: ApiExtra = (storage, epoch, built) => {
      holder.status = StatusService.withEpoch(storage, epoch, {
        assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts,
        ...(over.none === true ? {} : { backups: { config: over.config ?? (async () => { calls.config++; return CONFIG as unknown as Record<string, unknown>; }), list: over.list ?? (async () => { calls.list++; return { items, status: { root: "/srv/nn/backups", lastError: { at: "2026-11-26T02:00:00.000Z", message: "the disk was full in /srv/nn/backups/tmp, writing '/var/tmp/nn/rows.jsonl'" } } }; }) } }),
      }, options);
      holder.grants = GrantService.withEpoch(storage, epoch, options);
      return {
        grants: holder.grants, status: holder.status,
        backups: { backUpNow: async () => ({ manifest: manifest(0) }), backUpFor: async (id: string) => { calls.made.push(id); return { manifest: manifest(0, "manual") }; }, list: async () => [], status: async () => ({}) } as never,
        backupSystem: { status: async () => CONFIG } as never,
        backupConfig: { get: async () => ({ revision: 4 }) } as never,
        backupScope: { get: async () => CONFIG.scope, set: async (_p: unknown, c: Record<string, unknown>) => { calls.scopeSet.push(c); return { revision: 8, changed: true, wider: false, text: "ok", ...c }; } } as never,
      };
    };
    const w = await openWorld(backend, {}, undefined, extra);
    const stand = standIn(table, exempt);
    const seen: StatusRequest[] = [];
    const chat = w.chat({ interpreter: new ModelInterpreter(stand.model, () => ["test/model"]), status: { ask: (by, request) => { seen.push(request); return holder.status!.ask(by, request); } } });
    const say = (text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
    return { w, chat, say, seen, audit, holder, stand };
  };
  const suite = (name: string, body: () => Promise<void>) => test(`${backend.name}: ${name}`, body);

  suite("the owner asks how backups are set and which exist, in free words: the settings once, then the backups newest first a page at a time, from the same two reads; nothing is made, and what the model handed over was the owner's words", async () => {
    const calls = newCalls();
    const q1 = "how are my backups doing?";
    const q2 = "which backups do I have? show me 5 at a time";
    const next = (name: string) => `which backups do I have? show me 5 at a time, after ${name}`;
    const names = Array.from({ length: 25 }, (_, i) => manifest(i).name);
    const table: Table = {
      [q1]: (system) => (/backups\(limit, after\)/.test(system) ? [status({ kind: "backups" }, q1)] : []),
      [q2]: () => [status({ kind: "backups", limit: 5 }, q2)],
      [next(names[4]!)]: () => [status({ kind: "backups", limit: 5, after: names[4] }, next(names[4]!))],
      [next("backup-nothing")]: () => [status({ kind: "backups", limit: 5, after: "backup-nothing" }, next("backup-nothing"))],
      "how are my backups doing, 99 at a time": () => [status({ kind: "backups", limit: 99 }, "how are my backups doing, 99 at a time")],
    };
    const { w, say, audit, stand } = await open(table, calls);
    try {
      const before = await audit();
      const a = await say(q1);
      assert.equal(a.outcomes[0]!.status, "answered", JSON.stringify(a.outcomes));
      const t = said(a.outcomes as never);
      assert.match(t, /^Backups are made every 24 hours at 02:00 UTC\. A backup is test-restored every 7 days to prove it can be used\./);
      assert.match(t, /What is kept: A backup is deleted once it falls outside the newest 7 daily and 4 weekly copies/);
      assert.match(t, /USB stick \(disk, "\/mnt\/usb"\): cannot be reached \("the folder is not there"\)/);
      assert.match(t, /main backups folder \(folder\): can be reached; holds 25 backups/);
      assert.match(t, /The last test restore \(2026-11-27T02:00:00\.000Z, [^)]*\) FAILED: "a table file did not match its digest"/);
      assert.match(t, /1 delete of named backups is not finished on every place and will be retried\./);
      assert.match(t, /What backups leave out: Backups leave out private scratch older than 30 days\./);
      assert.match(t, /The last backup attempt failed \(2026-11-26T02:00:00\.000Z\): "the disk was full in the backups folder\/tmp, writing \(a path\)"/);
      assert.match(t, /last problem 2026-11-29T02:00:00\.000Z: "copying x: no such folder \(a path\)"/);
      assert.doesNotMatch(t, /\/srv\/nn|\/var\/tmp|nn\\usb/, "no host path from a failure's words is shown");
      assert.equal((t.match(/^backup-2026/gm) ?? []).length, 10, "ten backups by default");
      assert.match(t, new RegExp(`15 older backups follow; ask for more after ${names[9]}\\.`));
      assert.ok(a.outcomes[0]!.lines!.every((l) => l.cites.length > 0), "every line cites a record");
      const t2 = said((await say(q2)).outcomes as never);
      assert.equal((t2.match(/^backup-2026/gm) ?? []).length, 5);
      assert.match(t2, new RegExp(`20 older backups follow; ask for more after ${names[4]}\\.`));
      const third = said((await say(next(names[4]!))).outcomes as never);
      assert.doesNotMatch(third, /Backups are made|What is kept/, "a later page is the backups only");
      assert.deepEqual(third.match(/^backup-2026-[^:]*/gm), names.slice(5, 10), "the page begins right after the one named");
      const gone = (await say(next("backup-nothing"))).outcomes[0]!;
      assert.equal(gone.status, "answered");
      assert.match(said([gone] as never), /No backup is called "backup-nothing" now/);
      const big = (await say("how are my backups doing, 99 at a time")).outcomes[0]!;
      assert.equal(big.status, "refused", "more than 50 at a time is refused");
      assert.equal(await audit(), before, "reading backups writes nothing");
      assert.deepEqual(stand.violations, [], "the stand-in model handed over only the owner's words");
    } finally { await w.close(); }
  });

  suite("a read that fails is said in one line; no backups set up and every caller but the owner is not found, with nothing read; an agent's status.ask is refused", async () => {
    const calls = newCalls();
    const q = "how are my backups doing?";
    const table: Table = { [q]: () => [status({ kind: "backups" }, q)] };
    const broken = await open(table, calls, { config: async () => { throw new Error("disk exploded at /srv/secret/path"); } });
    try {
      const r = await broken.say(q);
      assert.equal(said(r.outcomes as never), "The backups cannot be read right now.");
      assert.doesNotMatch(JSON.stringify(r), /exploded|secret\/path/, "the host's error text is not shown");
    } finally { await broken.w.close(); }
    const none = await open(table, calls, { none: true });
    try {
      assert.notEqual((await none.say(q)).outcomes[0]!.status, "applied");
      assert.equal(await none.holder.status!.ask(none.w.owner, { kind: "backups" }), undefined, "not offered without backups");
    } finally { await none.w.close(); }
    const full = await open(table, calls);
    try {
      const ann = await full.w.agent("ann", [{ action: "*", project: "*" }]);
      assert.equal(await full.holder.status!.ask(ann.principal, { kind: "backups" }), undefined);
      const asked = (await full.w.api.handle(ann.token, { v: 1, op: "status.ask", args: { request: { kind: "backups" } } } as never)) as { ok: boolean; error?: { code: string } };
      assert.equal(asked.ok, false);
      assert.ok(["forbidden", "not_found"].includes(asked.error!.code), JSON.stringify(asked));
      assert.equal(calls.config + calls.list, 0, "no backup record was read for a caller that is not the owner");
      await assert.rejects(full.holder.status!.ask(full.w.owner, { kind: "backups", limit: 0 }), /limit/);
      await assert.rejects(full.holder.status!.ask(full.w.owner, { kind: "backups", extra: 1 } as never), /extra/);
    } finally { await full.w.close(); }
  });

  suite("'back up now' is a command the owner gives in free words: it is shown first, nothing is made before the yes, one backup is made, a second yes makes none, and an agent is refused", async () => {
    const calls = newCalls();
    const q = "please take a backup right now";
    const table: Table = { [q]: (system) => (/backup\.now\(/.test(system) ? [command("backup.now", {}, q)] : []), "Yes, do that.": yes("Yes, do that") };
    const { w, say, stand } = await open(table, calls);
    try {
      const shown = (await say(q)).outcomes[0]!;
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.match(shown.message ?? "", /a backup copies your data \(less what you chose to leave out of backups\) to this machine and then to every place backups go, older backups past your keep rules are removed as usual, and it takes room and time, so it is shown first/);
      assert.deepEqual(calls.made, [], "nothing is made before the owner agrees");
      const done = (await say("Yes, do that.")).outcomes[0]!;
      assert.equal(done.status, "applied", JSON.stringify(done));
      assert.equal(calls.made.length, 1);
      const again = (await say("Yes, do that.")).outcomes[0]!;
      assert.notEqual(again.status, "applied", "no proposal is open, so a second yes makes nothing");
      assert.equal(calls.made.length, 1);
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      const refused = (await w.api.handle(ann.token, { v: 1, op: "backup.now", commandId: cid("b"), args: {} } as never)) as { ok: boolean; error?: { code: string } };
      assert.equal(refused.error?.code, "forbidden");
      assert.equal(calls.made.length, 1);
      assert.deepEqual(stand.violations, []);
    } finally { await w.close(); }
  });

  suite("choosing what backups leave out: the system fills the revision it expects (the model is never asked for it), so the owner's words suffice, and a number the model invents is replaced", async () => {
    const calls = newCalls();
    const q = "leave scratch older than 30 days out of my backups";
    const invented = "leave out chat words older than 90 days from my backups";
    const table: Table = {
      [q]: (system) => (/backup\.scope\.set\(scratchDays, transcriptDays, logDays, expectedRevision/.test(system) && !/take expectedRevision/.test(system) ? [command("backup.scope.set", { scratchDays: 30 }, q)] : []),
      [invented]: () => [command("backup.scope.set", { transcriptDays: 90, expectedRevision: 99 }, invented)],
      "Yes, do that.": yes("Yes, do that"),
    };
    const { w, say, stand } = await open(table, calls, {}, new Set(["expectedRevision"]));
    try {
      const shown = (await say(q)).outcomes[0]!;
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.deepEqual(calls.scopeSet, []);
      assert.equal((await say("Yes, do that.")).outcomes[0]!.status, "applied");
      assert.equal(calls.scopeSet[0]!["scratchDays"], 30);
      assert.equal(calls.scopeSet[0]!["expectedRevision"], 7, "the revision came from the system's own read");
      const second = (await say(invented)).outcomes[0]!;
      assert.equal(second.status, "proposed", JSON.stringify(second));
      assert.equal((await say("Yes, do that.")).outcomes[0]!.status, "applied");
      assert.equal(calls.scopeSet[1]!["expectedRevision"], 7, "an invented revision is replaced by the system's");
      assert.deepEqual(stand.violations, []);
    } finally { await w.close(); }
  });

  suite("the standing rights are listed in free words by agent, by project and by state, a page at a time, each with its ID; the ID in the owner's words takes one back (shown first); reading writes nothing; unknown and ambiguous names are not guessed", async () => {
    const calls = newCalls();
    const ids: Record<string, string> = {};
    const table: Table = {};
    const ask = (text: string, request: Record<string, unknown>): void => { table[text] = () => [status(request, text)]; };
    ask("what rights does Ann have?", { kind: "grants", agentName: "Ann" });
    ask("what can agents do in the Garden project?", { kind: "grants", projectName: "Garden" });
    ask("which rights are revoked?", { kind: "grants", state: "revoked" });
    ask("list my rights, 1 at a time", { kind: "grants", limit: 1 });
    ask("what rights does Zed have?", { kind: "grants", agentName: "Zed" });
    ask("what rights does Cat have?", { kind: "grants", agentName: "Cat" });
    ask("what rights are there in the Nowhere project?", { kind: "grants", projectName: "Nowhere" });
    ask("what is Zed doing?", { kind: "overview", agentName: "Zed" });
    ask("which rights are sleeping?", { kind: "grants", state: "sleeping" });
    const { w, say, seen, audit, holder, stand } = await open(table, calls);
    try {
      const garden = await w.project("Garden"), shed = await w.project("Shed");
      const ann = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" })).id;
      const bob = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Bob" })).id;
      await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Cat" });
      await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Cat" });
      const give = async (name: string, grantee: string, action: string, project: string, extra: Record<string, unknown> = {}) => { ids[name] = (await holder.grants!.grant(w.owner, { commandId: cid("g"), grantee: `agent:${grantee}`, action, project, source: "direct", basis: `the owner said ${name}`, ...extra } as never)).id; };
      await give("ann-update-garden", ann, "task.update", garden);
      await give("ann-read-everywhere", ann, "task.read", "*");
      await give("ann-ended", ann, "task.update", shed, { expiresAt: "2026-10-01T00:00:00.000Z" });
      await give("bob-update-shed", bob, "task.update", shed);
      await give("bob-old", bob, "task.read", garden);
      await holder.grants!.revoke(w.owner, { commandId: cid("rv"), grantId: ids["bob-old"]!, expectedRevision: 1, reason: "the garden is closed" });
      const before = await audit();
      const run = async (text: string) => { const r = await say(text); return { o: r.outcomes[0]!, t: said(r.outcomes as never) }; };

      const a = await run("what rights does Ann have?");
      assert.equal(a.o.status, "answered", JSON.stringify(a.o));
      assert.match(a.t, /^3 active rights for agent:/);
      for (const id of [ids["ann-update-garden"]!, ids["ann-read-everywhere"]!, ids["ann-ended"]!]) assert.match(a.t, new RegExp(`${id}: agent:${ann} may `));
      assert.match(a.t, /task\.update in project proj-[a-z0-9]+; in force, until you take it back\./);
      assert.match(a.t, /task\.read in every project; in force/);
      assert.match(a.t, /ended 2026-10-01T00:00:00\.000Z/);
      assert.doesNotMatch(a.t, new RegExp(ids["bob-update-shed"]!), "another agent's right is not listed");
      assert.doesNotMatch(a.t, new RegExp(ids["bob-old"]!), "a taken-back right is not among the active ones");
      assert.ok(a.o.lines!.every((l) => l.cites.length > 0));
      assert.equal(seen.at(-1)!["agentId" as never], ann, "the name became the agent's ID");
      assert.equal(seen.at(-1)!["agentName" as never], undefined, "the name never reaches the status service");

      const g = await run("what can agents do in the Garden project?");
      assert.match(g.t, new RegExp(ids["ann-update-garden"]!));
      assert.match(g.t, new RegExp(ids["ann-read-everywhere"]!), "a right for every project counts in a project");
      assert.doesNotMatch(g.t, new RegExp(`${ids["bob-update-shed"]!}|${ids["ann-ended"]!}`), "rights for another project are left out");
      assert.equal(seen.at(-1)!["projectId" as never], garden);

      const rv = await run("which rights are revoked?");
      assert.match(rv.t, new RegExp(`${ids["bob-old"]!}: agent:${bob} may task\\.read in project ${garden}; taken back .*"the garden is closed"`));
      assert.doesNotMatch(rv.t, new RegExp(ids["ann-update-garden"]!));

      const first = await run("list my rights, 1 at a time");
      const firstIds = first.t.match(/grt-[a-z2-7]{20}(?=: )/g)!;
      assert.equal(firstIds.length, 1);
      assert.match(first.t, new RegExp(`More rights follow; ask for them after ${firstIds[0]}`));
      const pageText = `list my rights, 1 at a time, after ${firstIds[0]}`;
      table[pageText] = () => [status({ kind: "grants", limit: 1, after: firstIds[0] }, pageText)];
      const second = await run(pageText);
      assert.notEqual(second.t.match(/grt-[a-z2-7]{20}(?=: )/)![0], firstIds[0], "the next page starts after the one named");

      assert.deepEqual([(await run("what rights does Zed have?")).o.code], ["not_found"]);
      assert.equal((await run("what rights does Cat have?")).o.status, "asked", "two agents of one name are asked about");
      assert.equal((await run("what rights are there in the Nowhere project?")).o.code, "not_found");
      assert.equal((await run("what is Zed doing?")).o.code, "not_found");
      assert.equal((await run("which rights are sleeping?")).o.status, "refused");

      // The rights view creates nothing, and nobody but the owner is shown any right.
      assert.equal(await audit(), before, "reading rights writes nothing");
      const outsider = await w.agent("dan", [{ action: "*", project: "*" }]);
      assert.equal(await holder.status!.ask(outsider.principal, { kind: "grants" }), undefined, "not the owner: not found");
      const asked = (await w.api.handle(outsider.token, { v: 1, op: "status.ask", args: { request: { kind: "grants" } } } as never)) as { ok: boolean; error?: { code: string } };
      assert.ok(!asked.ok && ["forbidden", "not_found"].includes(asked.error!.code));

      // The ID the view showed, said in the owner's own words, takes the right back: shown first, applied on the yes, and the view then lists it as taken back.
      const take = `take back ${ids["ann-read-everywhere"]!} because the team moved on`;
      table[take] = (system) => (/use grant\.revoke with the grantId the owner gives/.test(system) ? [command("grant.revoke", { grantId: ids["ann-read-everywhere"]!, reason: "the team moved on" }, take)] : []);
      table["Yes, take it back."] = yes("Yes, take it back");
      const proposed = (await say(take)).outcomes[0]!;
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.equal((await holder.grants!.getGrant(ids["ann-read-everywhere"]!))!.state, "active", "still in force until the yes");
      assert.equal((await say("Yes, take it back.")).outcomes[0]!.status, "applied");
      assert.equal((await holder.grants!.getGrant(ids["ann-read-everywhere"]!))!.state, "revoked");
      assert.match((await run("which rights are revoked?")).t, new RegExp(ids["ann-read-everywhere"]!));
      assert.deepEqual(stand.violations, [], "the stand-in model handed over only the owner's words");
    } finally { await w.close(); }
  });

  suite("a long list of rights is read in bounded pages; the overview and attention views take an agent's name, and an ID the owner wrote beside it decides", async () => {
    const calls = newCalls();
    const table: Table = {};
    const { w, say, holder, seen, stand } = await open(table, calls);
    try {
      const garden = await w.project("Garden");
      const ann = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" })).id;
      const bob = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Bob" })).id;
      const mk = async (agent: string, title: string) => {
        const taskId = await w.task(garden, title);
        await w.projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId, expectedRevision: 1, to: "ready" });
        await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: { kind: "agent", id: agent } });
      };
      await mk(ann, "Dig the bed"); await mk(bob, "Paint the shed");
      for (let i = 0; i < 55; i++) await holder.grants!.grant(w.owner, { commandId: cid("g"), grantee: `agent:${ann}`, action: "task.read", project: garden, source: "direct", basis: `batch ${i}` } as never);
      const big = (await holder.status!.ask(w.owner, { kind: "grants", limit: 50 }))!;
      assert.equal(big.lines.filter((l) => /^grt-/.test(l.text)).length, 50);
      assert.match(big.lines.at(-1)!.text, /^More rights follow; ask for them after grt-/);
      const rest = (await holder.status!.ask(w.owner, { kind: "grants", limit: 50, after: /^(grt-[a-z2-7]{20})/.exec(big.lines.at(-2)!.text)![1]! }))!;
      assert.equal(rest.lines.filter((l) => /^grt-/.test(l.text)).length, 5);
      await assert.rejects(holder.status!.ask(w.owner, { kind: "grants", limit: 51 }), /limit/);
      await assert.rejects(holder.status!.ask(w.owner, { kind: "grants", after: "grt-nonsense" }), /after/);

      const q1 = "what is Ann working on?";
      const q2 = "does anything need a look for Bob?";
      const both = `what is Ann working on, I mean ${bob}`;
      table[q1] = (system) => (/overview\(projectId, agentId\|agentName, state, execution, limit\)/.test(system) ? [status({ kind: "overview", agentName: "Ann" }, q1)] : []);
      table[q2] = (system) => (/attention\(projectId, agentId\|agentName,/.test(system) ? [status({ kind: "attention", agentName: "Bob" }, q2)] : []);
      table[both] = () => [status({ kind: "overview", agentName: "Ann", agentId: bob }, both)];
      const a = await say(q1);
      assert.equal(a.outcomes[0]!.status, "answered", JSON.stringify(a.outcomes));
      assert.match(said(a.outcomes as never), /Dig the bed/);
      assert.doesNotMatch(said(a.outcomes as never), /Paint the shed/, "only Ann's work");
      assert.deepEqual([seen.at(-1)!["agentId" as never], seen.at(-1)!["agentName" as never]], [ann, undefined]);
      const b = await say(q2);
      assert.equal(b.outcomes[0]!.status, "answered", JSON.stringify(b.outcomes));
      assert.deepEqual([seen.at(-1)!["agentId" as never], seen.at(-1)!["agentName" as never]], [bob, undefined]);
      assert.equal((await say(both)).outcomes[0]!.status, "answered");
      assert.equal(seen.at(-1)!["agentId" as never], bob);
      assert.deepEqual(stand.violations, []);
    } finally { await w.close(); }
  });

  // One look reads at most 2000 rights (ten pages of 200). On the reference store only: 2001 rights on every backend would take minutes, and the limit is the status service's own count, not the store's.
  if (backend.name === "reference store") suite("a look that reads 2000 rights without filling a page stops there and names where to go on; asking again after that ID reads the rest", async () => {
    const { w, holder } = await open({}, newCalls());
    try {
      const garden = await w.project("Garden");
      const ann = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" })).id;
      const cy = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Cy" })).id;
      for (let i = 0; i < 2001; i++) await holder.grants!.grant(w.owner, { commandId: cid("g"), grantee: `agent:${ann}`, action: "task.read", project: garden, source: "direct", basis: `batch ${i}` } as never);
      const ids: string[] = [];
      for (let page = await w.world.storage.listAggregates("grant-record", { limit: 1000 }); page.length > 0; page = await w.world.storage.listAggregates("grant-record", { afterId: page.at(-1)!.id, limit: 1000 })) ids.push(...page.map((r) => r.id));
      assert.equal(ids.length, 2001);
      const stop = ids[1999]!;
      const first = (await holder.status!.ask(w.owner, { kind: "grants", agentId: cy }))!;
      assert.match(first.lines[0]!.text, /^No active right for agent:/);
      assert.equal(first.lines.at(-1)!.text, `The look stopped after 2000 records; ask again after ${stop}, or narrow the question by agent or project.`);
      const on = (await holder.status!.ask(w.owner, { kind: "grants", agentId: cy, after: stop }))!;
      assert.deepEqual(on.lines.map((l) => l.text), [`No active right for agent:${cy} follows that one.`], "the rest is read, and nothing says it stopped");
      const anns = (await holder.status!.ask(w.owner, { kind: "grants", agentId: ann, after: stop }))!;
      assert.equal(anns.lines.filter((l) => l.text.startsWith(`${ids[2000]}: agent:${ann} may task.read`)).length, 1, "the one right after the stop is found");
    } finally { await w.close(); }
  });
}
