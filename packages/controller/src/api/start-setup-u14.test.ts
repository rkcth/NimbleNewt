import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SETUP_GUIDE } from "../setup/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

type R = { ok: boolean; result: any; error?: { code: string; message: string } };

async function world(script: Record<string, unknown[]> = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-u14-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, chat: { interpreter: new ScriptedInterpreter((input) => script[input.text] ?? []) } });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const call = (op: string, args: Record<string, unknown>, commandId?: string, token = boot.token) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<R>;
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, boot, call, done, d };
}

const two = (extra: Record<string, unknown> = {}) => [
  { name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local"], contextTokens: 65536, ...extra },
  { name: "spare", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", credentialName: "spare-key", models: ["free-model"], contextTokens: 32000 },
];

test("a project records where it is hosted and its CI; a repository with no remote and a self-hosted forge are both fine, nothing assumes GitHub, and a bad answer is refused in plain words (card U14)", async () => {
  const w = await world();
  try {
    const gh = await w.call("project.create", { name: "Shop", repositories: [{ id: "shop", location: "/srv/shop" }], versionControl: { host: "github", ci: "GitHub Actions" } }, "p1");
    assert.ok(gh.ok, JSON.stringify(gh));
    const got = (await w.call("project.get", { projectId: gh.result.id })).result.item;
    assert.deepEqual(got.versionControl, { host: "github", ci: "GitHub Actions" });
    const local = await w.call("project.create", { name: "Notes", repositories: [{ id: "notes", location: "/home/me/notes" }], versionControl: { host: "none" } }, "p2");
    assert.ok(local.ok);
    const own = await w.call("project.create", { name: "Lab", repositories: [{ id: "lab", location: "ssh://git.lab.example/lab.git" }], versionControl: { host: "self-hosted", hostName: "Gitea", ci: "Jenkins" } }, "p3");
    assert.ok(own.ok);
    const plain = await w.call("project.create", { name: "Plain" }, "p4");
    assert.equal((await w.call("project.get", { projectId: plain.result.id })).result.item.versionControl, undefined, "not asked is not guessed");
    // Later answers replace the earlier one and keep everything else.
    const rev = (await w.call("project.get", { projectId: plain.result.id })).result.item.revision;
    const up = await w.call("project.update", { projectId: plain.result.id, expectedRevision: rev, versionControl: { host: "gitlab", ci: "GitLab CI" } }, "u1");
    assert.ok(up.ok, JSON.stringify(up));
    const after = (await w.call("project.get", { projectId: plain.result.id })).result.item;
    assert.deepEqual(after.versionControl, { host: "gitlab", ci: "GitLab CI" });
    assert.equal(after.name, "Plain");
    // Refused answers.
    for (const [vc, why] of [[{ host: "bitbucket" }, /host: must be github, gitlab, self-hosted or none/], [{ host: "github", hostName: "X" }, /self-hosted forge only/], [{ host: "none", ci: "Jenkins" }, /no hosted CI/], [{ host: "github", token: "x" }, /not a version control field/], ["github", /must be an object/]] as const) {
      const bad = await w.call("project.create", { name: "Bad", versionControl: vc }, `bad-${JSON.stringify(vc)}`);
      assert.equal(bad.ok, false);
      assert.match(bad.error!.message, why);
    }
  } finally { await w.done(); }
});

test("setup.readiness walks the whole first run in order with a plain question and a recommendation for every step, lists exactly what is open, tracks each project's host and CI answer, reads no secret and declining leaves a step at its default (card U14)", async () => {
  const w = await world();
  try {
    type Item = { id: string; state: string; required: boolean; detail: string; guide: { question: string; recommended: string; ifDeclined: string } };
    const read = async (): Promise<{ ready: boolean; next?: string; items: Item[] }> => (await w.call("setup.readiness", {})).result.item;
    const state = (r: { items: Item[] }, id: string): Item => r.items.find((i) => i.id === id)!;
    const fresh = await read();
    assert.deepEqual(fresh.items.map((i) => i.id), ["owner", "profile", "project", "version-control", "model-route", "host", "notifications", "agent", "task", "budgets"], "the order a person sets things up");
    for (const i of fresh.items) { assert.ok(i.guide.question.length > 20 && i.guide.recommended.length > 5 && i.guide.ifDeclined.length > 5, i.id); assert.deepEqual(i.guide, SETUP_GUIDE[i.id as keyof typeof SETUP_GUIDE]); }
    assert.equal(state(fresh, "version-control").state, "optional");
    assert.equal(state(fresh, "budgets").state, "default");
    assert.equal(fresh.next, "project");
    const project = await w.call("project.create", { name: "Shop" }, "p1");
    let r = await read();
    assert.equal(state(r, "version-control").state, "missing");
    assert.equal(state(r, "version-control").required, false, "an open answer does not stop a first agent");
    assert.match(state(r, "version-control").detail, /0 of 1 project\(s\).*"Shop"/);
    const rev = (await w.call("project.get", { projectId: project.result.id })).result.item.revision;
    await w.call("project.update", { projectId: project.result.id, expectedRevision: rev, versionControl: { host: "none" } }, "u1");
    r = await read();
    assert.equal(state(r, "version-control").state, "done");
    // The view never carries a secret: the whole answer holds none of the words a credential travels under.
    assert.doesNotMatch(JSON.stringify(r), /sk-[A-Za-z0-9]{8}|Bearer |password/);
  } finally { await w.done(); }
});

test("routing.provider.add registers two providers in one step with their addresses and the NAME of a credential, builds the default profile (free and local first), keeps what it was not told about, and refuses one server alone, a pasted key and an address with a password, in plain words (card U14)", async () => {
  const w = await world();
  try {
    const lone = await w.call("routing.provider.add", { providers: [two()[0]] }, "r0");
    assert.equal(lone.ok, false);
    assert.match(lone.error!.message, /needs a backup.*at least two routes on two different servers/);
    assert.equal((await w.call("routing.budgets", {})).result.routes.length, 0, "nothing was changed");

    const ok = await w.call("routing.provider.add", { providers: two() }, "r1");
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.deepEqual(ok.result.routes, ["mine/big-local", "spare/free-model"]);
    const routes = (await w.call("routing.budgets", {})).result.routes.map((r: { route: string; contextTokens: number }) => [r.route, r.contextTokens]);
    assert.deepEqual(routes, [["mine/big-local", 65536], ["spare/free-model", 32000]]);
    const table = await w.c.services.routing.get();
    assert.deepEqual(table?.profiles["default"], ["mine/big-local", "spare/free-model"]);
    assert.equal(table?.roles["coordinator"], "default");
    assert.equal(table?.roles["safety-supervisor"], "default");
    assert.equal(table?.roles["author"], "default");
    const ends = await w.c.services.setupProviders.endpoints();
    assert.deepEqual(ends.map((e) => [e.provider, e.endpoint, e.credentialName]), [["mine", "http://127.0.0.1:8002/v1", undefined], ["spare", "https://free.example.invalid/v1", "spare-key"]]);
    const readiness = (await w.call("setup.readiness", {})).result.item;
    assert.equal(readiness.items.find((i: { id: string }) => i.id === "model-route").state, "done");

    // Adding a paid cloud provider later keeps the others, and puts the paid route after the free ones.
    const paid = await w.call("routing.provider.add", { providers: [{ name: "pricey", location: "cloud", paid: true, endpoint: "https://paid.example.invalid/v1", credentialName: "pricey-key", models: ["top"], contextTokens: 200000 }], expectedRevision: table!.revision }, "r2");
    assert.ok(paid.ok, JSON.stringify(paid));
    assert.deepEqual((await w.c.services.routing.get())?.profiles["default"], ["mine/big-local", "spare/free-model", "pricey/top"]);
    // Replacing a provider replaces its address and its models only.
    const swap = await w.call("routing.provider.add", { providers: [{ ...two()[0], endpoint: "http://127.0.0.1:9000/v1", models: ["other"] }] }, "r3");
    assert.ok(swap.ok, JSON.stringify(swap));
    assert.deepEqual((await w.c.services.routing.get())?.profiles["default"], ["mine/other", "spare/free-model", "pricey/top"]);
    assert.equal((await w.c.services.setupProviders.endpoints()).find((e) => e.provider === "mine")?.endpoint, "http://127.0.0.1:9000/v1");
    // A stale revision is refused.
    const stale = await w.call("routing.provider.add", { providers: two(), expectedRevision: 1 }, "r4");
    assert.equal(stale.error?.code, "stale_revision");

    // Refusals: a key where its name belongs, an address that carries a password, a key-looking name, an unknown field, and a task credential cannot edit providers.
    const bad = async (spec: Record<string, unknown>, why: RegExp) => { const r = await w.call("routing.provider.add", { providers: [{ ...two()[1], ...spec }] }, `bad-${JSON.stringify(spec)}`); assert.equal(r.ok, false, JSON.stringify(spec)); assert.match(r.error!.message, why); assert.doesNotMatch(r.error!.message, /sk-abcdefghijklmnop/); };
    await bad({ credentialName: "sk-abcdefghijklmnopqrstuvwx" }, /NAME of a secret/);
    await bad({ credentialName: "has space" }, /NAME of a secret/);
    await bad({ endpoint: "https://user:pw@free.example.invalid/v1" }, /must not carry a user name, password, query or key/);
    // A key in the path, and a bare `?` or `#` (which leave the parsed query and fragment empty), are refused too.
    await bad({ endpoint: "https://free.example.invalid/v1/sk-abcdefghijklmnopqrstuvwxyz123456" }, /must not carry/);
    await bad({ endpoint: "https://free.example.invalid/v1?" }, /must not carry/);
    await bad({ endpoint: "https://free.example.invalid/v1#" }, /must not carry/);
    await bad({ endpoint: "https://free.example.invalid/v1?key=abc" }, /must not carry/);
    await bad({ endpoint: "ftp://x" }, /http:\/\/ or https:\/\//);
    await bad({ apiKey: "x" }, /not a provider field/);
    await bad({ contextTokens: 0 }, /context window/);
    await bad({ models: [] }, /1 to 20 model names/);
  } finally { await w.done(); }
});

test("through the chat alone an owner on a clean installation reads the setup walk-through, then gets a project on a self-hosted forge, two model providers and a first agent and task, each as a shown proposal that applies only on request; nothing is applied unasked (card U14)", async () => {
  const script: Record<string, unknown[]> = {};
  const w = await world(script);
  const say = (text: string) => w.c.chat!.submit(w.boot.token, { messageId: `m-${Math.random().toString(36).slice(2)}`, text });
  const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  try {
    // The owner asks how to start, in their own words: the model turns it into the setup status view.
    script["I just installed this, where do I begin?"] = [intent("status", { request: { kind: "setup" } }, "I just installed this")];
    const first = await say("I just installed this, where do I begin?");
    const text = first.reply.join("\n");
    assert.match(text, /Not ready for a first agent yet/);
    assert.match(text, /Next to ask: What is your first project/);
    assert.match(text, /Recommended:/);
    assert.match(text, /If you decline:/);

    // The project, on the owner's own forge, with its CI, is drawn up as a proposal; nothing exists yet.
    const words = "My project is called Lab and the repository is ssh://git.lab.example/lab.git on our own Gitea server with Jenkins";
    script[words] = [intent("command", { op: "project.create", args: { name: "Lab", goal: "Lab", repositories: [{ id: "lab", location: "ssh://git.lab.example/lab.git" }], versionControl: { host: "self-hosted", hostName: "Gitea", ci: "Jenkins" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "My project is called Lab")];
    const drawn = await say(words);
    const o = drawn.outcomes[0] as unknown as { status: string; proposalId?: string; preview?: string[] };
    assert.equal(o.status, "proposed", JSON.stringify(drawn));
    assert.equal((await w.call("project.list", {})).result.items.length, 0, "nothing is applied unasked");
    script["yes, create it"] = [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: "yes, create it", basis: "owner" }];
    await say("yes, create it");
    const projects = (await w.call("project.list", {})).result.items;
    assert.equal(projects.length, 1);
    assert.deepEqual(projects[0].versionControl, { host: "self-hosted", hostName: "Gitea", ci: "Jenkins" });

    // Providers: the model gives only words the owner said (the location is a fixed choice); the credential is a NAME.
    const said = "Use my local model at http://127.0.0.1:8002/v1 called big-local with 65536 tokens, and as backup the free route free-model at https://free.example.invalid/v1 with 32000 tokens, its key is stored as spare-key";
    script[said] = [intent("command", { op: "routing.provider.add", args: { providers: [{ name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local"], contextTokens: 65536 }, { name: "spare", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", models: ["free-model"], contextTokens: 32000, credentialName: "spare-key" }] } }, "Use my local model")];
    const prov = await say(said);
    const po = prov.outcomes[0] as unknown as { status: string; proposalId?: string };
    // `mine` and `spare` are names the model chose, not the owner's words: refused rather than guessed.
    assert.notEqual(po.status, "applied");
    assert.equal((await w.c.services.routing.get()), undefined, "the table is untouched");
    const said2 = "Name them mine and spare. Use my local model at http://127.0.0.1:8002/v1 called big-local with 65536 tokens, and as backup the free route free-model at https://free.example.invalid/v1 with 32000 tokens, its key is stored as spare-key";
    script[said2] = [intent("command", { op: "routing.provider.add", args: { providers: [{ name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local"], contextTokens: 65536 }, { name: "spare", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", models: ["free-model"], contextTokens: 32000, credentialName: "spare-key" }] } }, "Name them mine and spare")];
    const prov2 = await say(said2);
    const p2 = prov2.outcomes[0] as unknown as { status: string; proposalId?: string; preview?: string[] };
    assert.equal(p2.status, "proposed", JSON.stringify(prov2));
    assert.equal((await w.c.services.routing.get()), undefined, "shown first in every profile");
    script["go ahead with the models"] = [{ kind: "apply_proposal", proposalId: p2.proposalId, evidence: "go ahead with the models", basis: "owner" }];
    await say("go ahead with the models");
    assert.deepEqual(Object.keys((await w.c.services.routing.get())!.routes).sort(), ["mine/big-local", "spare/free-model"]);

    // The walk-through now points at the host, the next required step, and says what is done.
    const after = (await say("I just installed this, where do I begin?")).reply.join("\n");
    assert.match(after, /A model provider and route: done/);
    assert.match(after, /Version control host and CI of each project: done/);
    assert.match(after, /Next to ask: Which machine runs the agents/);
  } finally { await w.done(); }
});

test("two provider names on one model server are not two servers: the fallback rule judges the recorded addresses, including those of providers already in the table (card U14)", async () => {
  const w = await world();
  try {
    // Both names point at the same server (host and port); losing it would lose the whole list.
    const same = await w.call("routing.provider.add", { providers: [two()[0], { name: "again", location: "local", endpoint: "http://127.0.0.1:8002/v2", models: ["small-local"], contextTokens: 8192 }] }, "s1");
    assert.equal(same.ok, false, JSON.stringify(same));
    assert.match(same.error!.message, /needs a backup.*two different servers/);
    assert.equal(await w.c.services.routing.get(), undefined, "nothing was changed");
    // Upper and lower case name one server.
    const cased = await w.call("routing.provider.add", { providers: [two()[0], { ...two()[1], endpoint: "https://FREE.example.invalid/v1" }, { name: "dup", location: "cloud", paid: false, endpoint: "https://free.example.invalid/other", models: ["x"], contextTokens: 8192 }] }, "s2");
    assert.ok(cased.ok, JSON.stringify(cased));
    // Three routes on two servers are fine. Moving the local provider onto the cloud server would put every entry on one server: refused, judged with the recorded addresses of the
    // providers the step does not name.
    const rev = (await w.c.storage.getAggregate({ kind: "routing-table", id: "routing" }))!.revision;
    const ontoOne = await w.call("routing.provider.add", { providers: [{ ...two()[0], location: "cloud", endpoint: "https://free.example.invalid/v9" }], expectedRevision: rev }, "s3");
    assert.equal(ontoOne.ok, false, JSON.stringify(ontoOne));
    assert.match(ontoOne.error!.message, /two different servers/);
  } finally { await w.done(); }
});

test("in chat a repository's folder or address must be the owner's own words: the fixed choices exempt on provider editing (location) and on projects (host) do not exempt a repository location the model made up (card U14)", async () => {
  const script: Record<string, unknown[]> = {};
  const w = await world(script);
  const say = (text: string) => w.c.chat!.submit(w.boot.token, { messageId: `m-${Math.random().toString(36).slice(2)}`, text });
  const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  try {
    const words = "Make a project called Lab for my code, it has no remote";
    script[words] = [intent("command", { op: "project.create", args: { name: "Lab", goal: "Lab", repositories: [{ id: "lab", location: "/srv/invented/lab" }], versionControl: { host: "none" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "Make a project called Lab")];
    const turn = await say(words);
    const o = turn.outcomes[0] as unknown as { status: string; message?: string };
    assert.notEqual(o.status, "proposed", JSON.stringify(turn));
    assert.notEqual(o.status, "applied", JSON.stringify(turn));
    assert.match(JSON.stringify(turn), /not in your message/);
    // The same project with the folder the owner named, and the forge given as a fixed choice, is drawn up.
    const said = "Make a project called Lab with the repository /srv/lab, it has no remote";
    script[said] = [intent("command", { op: "project.create", args: { name: "Lab", goal: "Lab", repositories: [{ id: "lab", location: "/srv/lab" }], versionControl: { host: "none" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "Make a project called Lab")];
    const ok = await say(said);
    assert.equal((ok.outcomes[0] as unknown as { status: string }).status, "proposed", JSON.stringify(ok));
  } finally { await w.done(); }
});

test("the setup view and provider editing are the owner's only: another principal gets nothing (card U14)", async () => {
  const w = await world();
  try {
    const owner = await w.c.services.principals.authenticate(w.boot.token);
    await w.c.services.principals.enroll(owner, { commandId: "e1", kind: "agent", name: "helper", grants: [] });
    const tok = (await w.c.services.principals.issueCredential(owner, "agent:helper")).token;
    const r = await w.call("routing.provider.add", { providers: two() }, "x1", tok);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "forbidden");
    const s = await w.call("setup.readiness", {}, undefined, tok);
    assert.equal(s.ok, false);
  } finally { await w.done(); }
});
