import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController, type Controller, type StartOptions } from "../api/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { WebAssets } from "./door.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ASSETS: WebAssets = { "/": { type: "text/html; charset=utf-8", body: "<!doctype html><title>t</title>" }, "/app.js": { type: "text/javascript", body: "1" } };
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: any; text: string }
interface World {
  c: Controller; token: string; interpreter: ScriptedInterpreter;
  call(method: string, path: string, o?: { cookie?: string; csrf?: string; body?: unknown; headers?: Record<string, string> }): Promise<Reply>;
  signIn(): Promise<{ cookie: string; csrf: string }>;
}

/** A real controller (SQLite) with the browser door, driven only over HTTP the way the page does. `token` names an owner that already exists (a restart); without it the owner is made. */
async function world(dir: string, o: { token?: string; interpreter?: ScriptedInterpreter; start?: Partial<StartOptions> } = {}): Promise<World> {
  const interpreter = o.interpreter ?? new ScriptedInterpreter(() => []);
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "n.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter }, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS }, ...o.start,
  } as StartOptions);
  const token = o.token ?? (await c.services.principals.bootstrapOwner({ name: "rob" })).token;
  const door = c.webChat!;
  const call: World["call"] = (method, path, x = {}) => new Promise((resolve, reject) => {
    const payload = x.body === undefined ? undefined : JSON.stringify(x.body);
    const headers: Record<string, string> = { host: `127.0.0.1:${door.port}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...(x.cookie === undefined ? {} : { cookie: x.cookie }), ...(x.csrf === undefined ? {} : { "x-nn-csrf": x.csrf }), ...(x.headers ?? {}) };
    const req = request({ host: "127.0.0.1", port: door.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b: Buffer) => chunks.push(b));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body, text }); });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const signIn: World["signIn"] = async () => {
    const reply = await call("POST", "/web/login", { body: { token } });
    assert.equal(reply.status, 200, reply.text);
    return { cookie: String([reply.headers["set-cookie"]].flat()[0]).split(";")[0]!, csrf: reply.body.csrf };
  };
  return { c, token, interpreter, call, signIn };
}
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nn-u08d-")); dirs.push(d); return d; };

const hashTree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${r}/`); walk(p, r); } else out.push(`${r} ${createHash("sha256").update(readFileSync(p)).digest("hex")} ${statSync(p).mtimeMs}`);
    }
  };
  walk(dir, "");
  return out;
};

// ---- card U08: invalid values -------------------------------------------------------------------------------------------------------

test("a value the setting refuses, sent from the page's form, comes back refused with an error that names the setting's path, and the settings view still shows what was in force (card U08)", async () => {
  const w = await world(tmp());
  try {
    const s = await w.signIn();
    let n = 0;
    const post = (path: string, body: unknown) => w.call("POST", path, { cookie: s.cookie, csrf: s.csrf, body, headers: { "idempotency-key": `k-${n++}` } });
    const seen = async (key: string) => (await w.call("GET", "/web/views/admin-settings", { cookie: s.cookie })).body.parts.settings.item.items.find((i: { key: string }) => i.key === key);
    const good = await post("/web/admin/setting", { key: "grants.maxDays", value: 12 });
    assert.equal((await post(`/web/proposals/${good.body.outcomes[0].proposalId}/apply`, {})).body.applied, true);
    const rev = (await seen("grants.maxDays")).source;
    const bad: readonly [Record<string, unknown>, RegExp][] = [
      [{ key: "grants.maxDays", value: 0 }, /^set\.grants\.maxDays: must be a whole number from 1 to 36500$/],
      [{ key: "grants.maxDays", value: "ten" }, /^set\.grants\.maxDays: must be a whole number/],
      [{ key: "grants.defaultDays", value: -1 }, /^set\.grants\.defaultDays: must be a whole number/],
      [{ key: "provider.cloud.enabled", value: "yes" }, /^set\.provider\.cloud\.enabled: must be true or false$/],
    ];
    for (const [body, message] of bad) {
      const r = await post("/web/admin/setting", body);
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.outcomes[0].status, "proposed", "shown first, as every setting is");
      const ap = await post(`/web/proposals/${r.body.outcomes[0].proposalId}/apply`, {});
      assert.equal(ap.status, 200, ap.text);
      assert.equal(ap.body.applied, false, ap.text);
      assert.equal(ap.body.failure.code, "invalid_command");
      assert.match(ap.body.failure.message, message, JSON.stringify(body));
      assert.ok(ap.body.failure.message.includes(String(body["key"])), "the error names the setting's path");
    }
    // A setting that does not exist is refused when it is drawn up, in words that name it and list what exists.
    const nope = await post("/web/admin/setting", { key: "grants.nope", value: 3 });
    assert.equal(nope.body.outcomes[0].status, "refused");
    assert.match(nope.body.outcomes[0].message, /^grants\.nope is not a setting this system has\. Known settings: /);
    // Nothing moved: the value in force is the good one, and the unset ones are still defaults.
    assert.deepEqual([(await seen("grants.maxDays")).value, (await seen("grants.maxDays")).state, (await seen("grants.defaultDays")).state, (await seen("provider.cloud.enabled"))?.state ?? "default"], [12, "set", "default", "default"]);
    assert.deepEqual((await seen("grants.maxDays")).source, rev);
  } finally { await w.c.close(); }
});

// ---- card U08: a fresh install is configured through the browser's door alone, and the settings survive a restart ---------------------------------------

test("a fresh install is configured entirely through the browser's door (the Administration pages and the chat tab), with no source edited and no file of the target repository touched, and the settings are there after a restart (card U08)", async () => {
  const dir = tmp();
  const repo = tmp();
  writeFileSync(join(repo, "README.md"), "target repository\n"); mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src", "a.txt"), "a\n");
  const repoBefore = hashTree(repo);
  const cwdBefore = process.cwd();
  const cwd = tmp();
  process.chdir(cwd);
  const script: Record<string, unknown[]> = {};
  const store = new Map<string, string>();
  const adminSecrets = { store: { kind: "test-store", resolve: async (name: string) => store.get(name), set: async (name: string, value: string) => { store.set(name, value); } } };
  let w = await world(dir, { interpreter: new ScriptedInterpreter(script), start: { adminSecrets } as never });
  let token: string;
  try {
    token = w.token;
    let s = await w.signIn();
    let n = 0;
    const post = (path: string, body: unknown) => w.call("POST", path, { cookie: s.cookie, csrf: s.csrf, body, headers: { "idempotency-key": `k-${n++}` } });
    const get = (view: string) => w.call("GET", `/web/views/${view}`, { cookie: s.cookie });
    const say = async (text: string, intents: unknown[]) => { script[text] = intents; const r = await post("/web/chat", { messageId: `m-${n++}`, text }); assert.ok(r.status === 201 || r.status === 200, r.text); return r; };
    const apply = async (r: Reply): Promise<any[]> => { const out: any[] = []; for (const o of r.body.outcomes) if (o.status === "proposed") { const a = await post(`/web/proposals/${o.proposalId}/apply`, {}); assert.equal(a.body.applied, true, a.text); out.push(a.body); } return out; };
    const readiness = async () => Object.fromEntries((await get("admin-setup")).body.parts.readiness.item.items.map((i: { id: string; state: string }) => [i.id, i.state]));

    // 0. The First run page: nothing but the owner is set up; the approval profile is the default.
    assert.deepEqual(await readiness(), { owner: "done", profile: "default", project: "missing", "version-control": "optional", "model-route": "missing", host: "missing", notifications: "default", agent: "missing", task: "optional", budgets: "default" });

    // 1. The chat tab asks the profile question first (the same question as the page), and the owner answers to switch.
    const q = await say("help me get started", [{ kind: "status", request: { kind: "setup" }, evidence: "get started", basis: "owner" }]);
    assert.match(q.text, /How much should the team ask you before it acts\? A new installation starts in strict/);
    assert.match(q.text, /Do you want to switch from strict to derived\?/);
    const sw = await say("Yes, switch to the derived profile", [{ kind: "policy_edit", change: { type: "profile", to: "derived" }, evidence: "switch to the derived profile", basis: "owner" }]);
    await apply(sw);
    assert.equal((await readiness())["profile"], "done");
    assert.match((await get("admin-setup")).body.parts.readiness.item.items.find((i: { id: string }) => i.id === "profile").detail, /^derived/);

    // 2. Providers. The Providers page's form adds one provider; a team needs two routes on two servers in one step, so on a fresh install the form's single provider is refused in plain words, and the chat adds both.
    const one = await post("/web/admin/provider", { name: "local-a", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["m1"], contextTokens: 32768 });
    assert.equal(one.body.outcomes[0].status, "proposed");
    const refused = await post(`/web/proposals/${one.body.outcomes[0].proposalId}/apply`, {});
    assert.equal(refused.body.applied, false);
    assert.match(refused.body.failure.message, /at least two routes on two different servers/);
    assert.equal((await readiness())["model-route"], "missing", "a refused provider changed nothing");
    const twoText = "Add two model servers: local-a, a local server at http://127.0.0.1:8002/v1 with the model m1 and a 32768 token window, and cloud-b, a cloud server at https://api.example.test/v1 with the model big and a 65536 token window that costs money, with its key named cloud-b-key";
    await apply(await say(twoText, [{ kind: "command", op: "routing.provider.add", args: { providers: [{ name: "local-a", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["m1"], contextTokens: 32768 }, { name: "cloud-b", location: "cloud", endpoint: "https://api.example.test/v1", models: ["big"], contextTokens: 65536, paid: true, credentialName: "cloud-b-key" }] }, evidence: twoText, basis: "owner" }]));
    assert.equal((await readiness())["model-route"], "done");

    // 3. The Secrets page: the key is entered write-only; the page shows only that it is set.
    const sec = (await get("admin-secrets")).body.parts.secrets.item;
    assert.deepEqual(sec.items.map((i: { name: string; state: string }) => [i.name, i.state]), [["cloud-b-key", "not set"]]);
    const put = await w.call("PUT", "/web/secrets/cloud-b-key", { cookie: s.cookie, csrf: s.csrf, body: { value: "sk-LEAK-0123456789abcdef" } });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual((await get("admin-secrets")).body.parts.secrets.item.items.map((i: { name: string; state: string }) => [i.name, i.state]), [["cloud-b-key", "set"]]);
    assert.doesNotMatch(JSON.stringify((await get("admin-secrets")).body) + JSON.stringify((await get("admin-providers")).body), /sk-LEAK/);

    // 4. The Settings page: a limit on standing grants.
    await apply(await post("/web/admin/setting", { key: "grants.maxDays", value: 30 }));

    // 5. The chat: the project (landing left to the installation default), the first agent and "run agents on this computer".
    const pt = "My project is called Garden and its repository main is at " + repo + "; use the default for how finished work lands";
    const proj = await say(pt, [{ kind: "command", op: "project.create", args: { name: "Garden", repositories: [{ id: "main", location: repo }], integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } }, evidence: pt, basis: "owner" }]);
    await apply(proj);
    const at = "Create an agent called Ann with the role author";
    await apply(await say(at, [{ kind: "command", op: "agent.create", args: { friendlyName: "Ann", roles: ["author"] }, evidence: at, basis: "owner" }]));
    const ht = "Yes, run the agents on this computer";
    await apply(await say(ht, [{ kind: "command", op: "host.local.set", args: { enabled: true }, evidence: ht, basis: "owner" }]));
    const done = await readiness();
    assert.deepEqual([done["project"], done["model-route"], done["agent"], done["profile"]], ["done", "done", "done", "done"]);
    const setup = (await get("admin-setup")).body.parts.readiness.item;
    assert.deepEqual([setup.ready, setup.next], [false, "host"], "everything a browser can set is set; the host joins at the next start, when a worker announces itself");
    assert.match(setup.items.find((i: { id: string }) => i.id === "host").detail, /this computer|next start/i);

    // The Migration page's compatibility part reads the same way on a real controller: the runtime in use is supported, no host has announced itself, and no migration waits.
    const compat = (await get("admin-migration")).body.parts.compat;
    assert.equal(compat.error, undefined, JSON.stringify(compat));
    assert.deepEqual([compat.item.status, compat.item.runtime.node.supported, compat.item.hosts, compat.item.migration.pending], ["compatible", true, [], []]);
    assert.deepEqual(compat.item.runtime.protocol, { min: 1, max: 2 });

    // 6. A restart: the controller is stopped and started again on the same database; the page reads the same settings.
    await w.c.close();
    w = await world(dir, { token, interpreter: new ScriptedInterpreter({}), start: { adminSecrets } as never });
    s = await w.signIn();
    const settings = (await get("admin-settings")).body.parts.settings.item.items;
    const maxDays = settings.find((i: { key: string }) => i.key === "grants.maxDays");
    assert.deepEqual([maxDays.value, maxDays.state, maxDays.source.layer], [30, "set", "installation"]);
    assert.deepEqual(Object.fromEntries((await get("admin-setup")).body.parts.readiness.item.items.map((i: { id: string; state: string }) => [i.id, i.state])), { ...done });
    const providers = (await get("admin-providers")).body.parts.providers.item.items;
    assert.deepEqual(providers.map((p: { name: string; enabled: boolean; secret: string }) => [p.name, p.enabled, p.secret]), [["cloud-b", true, "set"], ["local-a", true, "none needed"]]);
    assert.equal((await get("admin-setup")).body.parts.readiness.item.items.find((i: { id: string }) => i.id === "profile").detail.startsWith("derived"), true, "the approval profile survived the restart");
    // The agent and the project are still there, as the owner's chat reads them.
    const roster = await w.call("POST", "/web/chat", { cookie: s.cookie, csrf: s.csrf, body: { messageId: "m-r", text: "who are my agents?" }, headers: { "idempotency-key": "r-1" } });
    assert.ok(roster.status < 500, roster.text);
    assert.equal((await get("admin-team")).body.parts.agents.items.some((a: { friendlyName: string }) => a.friendlyName === "Ann"), true);
  } finally {
    process.chdir(cwdBefore);
    await w.c.close().catch(() => undefined);
  }
  // Nothing was written outside the controller's own database: not in the working directory (where source would be), not in the target repository.
  assert.deepEqual(readdirSync(cwd), [], "no file appeared in the working directory");
  assert.deepEqual(hashTree(repo), repoBefore, "no file of the target repository was created, changed or removed");
  assert.deepEqual(readdirSync(dir).filter((f) => !/^(n\.sqlite|\.nn-reserve$)/.test(f)), [], "the data directory holds only the database and the controller's own disk reserve");
});
