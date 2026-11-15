import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_CHANNEL_VERSION, encodeMessage, type FromChild, type ToChild } from "@nimblenewt/contracts";
import type { LaunchRequest, RunResult, SandboxRun } from "../sandbox/launcher.js";
import type { HostSecurityEvent } from "../workspace/host.js";
import { localWorkerParts, ownerPolicyOptions, type HostOrder } from "./local.js";

// Card U11d: the local host tells the owner's security hook when (1) the protected loader configuration is not as it was when the attempt's sandbox opened, and (2) the launch finds a place it made for the attempt turned into a link.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn host sec ")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const dir = (name: string): string => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const node = dir("node"); writeFileSync(join(node, "marker"), "x");
const app = { node: { root: node, executable: "bin/node" }, mounts: [] as { host: string; guest: string }[], entry: "/opt/app/main.js" };
const order = (): HostOrder => ({ attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", route: "r", credential: "c", recipe: { revision: "r1", reach: [] } });
const fresh = () => {
  const base = dir(`w${++counter}`);
  const work = { checkout: dir(`w${counter}/checkout`), gitDir: dir(`w${counter}/git`), home: dir(`w${counter}/home`), scratch: dir(`w${counter}/scratch`) };
  const ext = dir(`w${counter}/extensions`);
  writeFileSync(join(ext, "loader.json"), '{"extensions":["tools"]}');
  return { base, work, ext };
};
const build = (w: ReturnType<typeof fresh>, security: (e: HostSecurityEvent) => void | Promise<void>, extra: Record<string, unknown> = {}, launcher?: unknown) => localWorkerParts<unknown>({
  launcher: (launcher ?? { launch: async () => { throw new Error("not launched here"); } }) as never, app, protectedPaths: [], workspace: () => w.work, requireEnforced: false,
  model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
  namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
  security, loaderConfig: { paths: [w.ext] }, ...extra,
});
const eventsOf = () => { const got: HostSecurityEvent[] = []; return { got, sink: (e: HostSecurityEvent) => { got.push(e); } }; };
const link = (target: string, path: string): boolean => { try { symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir"); return true; } catch { return false; } };

test("the loader configuration written while an attempt's sandbox is open is reported once when it closes, as protected-path-touched; an untouched one reports nothing; the close is unchanged", async () => {
  const w = fresh(); const e = eventsOf();
  const p = build(w, e.sink);
  const quiet = await p.sandbox.open(order().recipe, order());
  await quiet.close();
  assert.equal(e.got.length, 0);
  const session = await p.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "loader.json"), '{"extensions":["tools","other"]}');
  await session.close();
  assert.equal(e.got.length, 1);
  assert.equal(e.got[0]!.kind, "protected-path-touched");
  assert.equal(e.got[0]!.projectId, "proj-1");
  assert.match(e.got[0]!.key, /^loader:changed:[0-9a-f]{24}$/);
  assert.ok(!JSON.stringify(e.got).includes(root), "no host path");
  // The next attempt starts from what is there now: the same state is not reported again.
  const next = await p.sandbox.open(order().recipe, order());
  await next.close();
  assert.equal(e.got.length, 1);
});

test("a link put where the loader configuration was, a deletion and a new file are each reported with their own key", async () => {
  const w = fresh(); const e = eventsOf();
  const p = build(w, e.sink);
  const one = await p.sandbox.open(order().recipe, order());
  rmSync(w.ext, { recursive: true });
  await one.close();
  assert.match(e.got[0]!.key, /^loader:removed:/);
  mkdirSync(w.ext);
  const two = await p.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "new.js"), "1");
  await two.close();
  assert.equal(e.got.length, 2);
  assert.notEqual(e.got[0]!.key, e.got[1]!.key);
});

test("a folder swapped for a link is reported as a link", async (t) => {
  const w = fresh(); const e = eventsOf();
  const p = build(w, e.sink);
  const elsewhere = dir(`elsewhere-${counter}`);
  const session = await p.sandbox.open(order().recipe, order());
  renameSync(w.ext, `${w.ext}-moved`);
  if (!link(elsewhere, w.ext)) { await session.close(); return t.skip("this system refuses to make a link here"); }
  await session.close();
  assert.equal(e.got.length, 1);
  assert.match(e.got[0]!.key, /^loader:linked:/);
});

/** One turn on a played process: the loader configuration is written during it, then the process dies; returns what the turn answered and what the hook was told when the turn ended (before the sandbox closed). */
async function turnWithWrite(sink: (e: HostSecurityEvent) => void | Promise<void>, got: readonly HostSecurityEvent[]): Promise<{ status: string; error?: string; toldAtTurnEnd: number; toldAtClose: number }> {
  const w = fresh();
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const exit = (extra: Partial<RunResult> = {}) => finish({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", stdoutTruncated: false, ...extra } as RunResult);
  let emit!: (m: FromChild) => void;
  let turnStarted!: () => void;
  const running = new Promise<void>((ok) => { turnStarted = ok; });
  const run = { result, kill: () => exit({ killed: true, exitCode: null }), endInput: () => undefined, write: async (text: string) => {
    for (const m of text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)) {
      if (m.t === "start") queueMicrotask(() => emit({ t: "ready", v: WORKER_CHANNEL_VERSION }));
      if (m.t === "run") turnStarted();
      if (m.t === "close") exit();
    }
  } } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(encodeMessage(m))); return run; } };
  const p = build(w, sink, {}, launcher);
  const session = await p.sandbox.open(order().recipe, order());
  const runtime = await p.runtimes.open(order(), {}, undefined);
  const turn = runtime.run("go", "req-1");
  await running;
  writeFileSync(join(w.ext, "loader.json"), "{}");
  exit({ exitCode: 1, stderr: "killed" });
  const answered = await turn;
  const toldAtTurnEnd = got.length;
  await runtime.close().catch(() => undefined);
  await session.close();
  return { status: answered.status, ...(answered.error === undefined ? {} : { error: answered.error }), toldAtTurnEnd, toldAtClose: got.length };
}

test("a change in the middle of a turn is reported when the turn ends (and not again when the sandbox closes); a hook that throws leaves the turn's answer the same", async () => {
  const e = eventsOf();
  const told = await turnWithWrite(e.sink, e.got);
  assert.equal(told.toldAtTurnEnd, 1, "reported at the end of the turn, not only at the close");
  assert.equal(told.toldAtClose, 1, "the same state is not reported again at the close");
  assert.equal(e.got[0]!.kind, "protected-path-touched");
  const plain = await turnWithWrite(() => undefined, []);
  const thrown = await turnWithWrite(() => { throw new Error("the hook fails"); }, []);
  assert.equal(told.status, "failed");
  assert.deepEqual({ status: thrown.status, error: thrown.error }, { status: plain.status, error: plain.error }, "a throwing hook changes nothing the caller gets");
  assert.match(thrown.error ?? "", /exit code 1/);
});

test("without a hook or without paths nothing is looked at and nothing is reported; a hook that rejects changes nothing", async () => {
  const w = fresh(); const e = eventsOf();
  const none = localWorkerParts<unknown>({
    launcher: { launch: async () => { throw new Error("x"); } } as never, app, protectedPaths: [], workspace: () => w.work,
    model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    security: e.sink,
  });
  const s1 = await none.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "loader.json"), "{}");
  await s1.close();
  assert.equal(e.got.length, 0, "no loaderConfig: nothing looked at");
  const p = build(w, () => Promise.reject(new Error("no")));
  const s2 = await p.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "loader.json"), '{"a":1}');
  await s2.close();
});

test("ownerPolicyOptions hands the controller's security hook to the host", async () => {
  const w = fresh(); const e = eventsOf();
  const options = ownerPolicyOptions({ currentLimits: async () => undefined, bestEffortAllowed: async () => false, recordLaunch: async () => undefined, reportSecurity: (event) => { void e.sink(event as HostSecurityEvent); } });
  assert.equal(typeof options.security, "function");
  assert.equal(ownerPolicyOptions({ currentLimits: async () => undefined, bestEffortAllowed: async () => false, recordLaunch: async () => undefined }).security, undefined);
  const p = build(w, options.security!);
  const s = await p.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "loader.json"), "{}");
  await s.close();
  assert.equal(e.got.length, 1);
});

test("a checkout, home or scratch that was turned into a link is refused as before and reported as a sandbox escape attempt once per place; an ordinary refusal is not", async (t) => {
  const e = eventsOf();
  for (const place of ["checkout", "home", "scratch"] as const) {
    const w = fresh();
    const elsewhere = dir(`elsewhere-${counter}`);
    rmSync(w.work[place], { recursive: true });
    if (!link(elsewhere, w.work[place])) return t.skip("this system refuses to make a link here");
    const p = build(w, e.sink);
    await assert.rejects(p.sandbox.open(order().recipe, order()), /symbolic link/);
    await assert.rejects(p.sandbox.open(order().recipe, order()), /symbolic link/);
  }
  assert.equal(e.got.length, 6, "reported at each refusal; the controller's detectors keep it to one item per key");
  assert.equal(new Set(e.got.map((x) => x.key)).size, 3, "one key per place");
  for (const x of e.got) { assert.equal(x.kind, "sandbox-escape-attempt"); assert.match(x.key, /^sbx:mount-is-link:[0-9a-f]{24}$/); assert.ok(!x.key.includes(root)); }
  // A place that does not exist is a configuration fault, not a tamper sign.
  const quiet = eventsOf();
  const w = fresh();
  rmSync(w.work.home, { recursive: true });
  await assert.rejects(build(w, quiet.sink).sandbox.open(order().recipe, order()), /does not exist/);
  assert.equal(quiet.got.length, 0);
});

test("the checkout's .git entry turned into a link is reported as a sandbox escape attempt; a plain .git entry and a missing one are not", async (t) => {
  const e = eventsOf();
  const w = fresh();
  const elsewhere = dir(`elsewhere-${counter}`);
  const ok = await build(w, e.sink).sandbox.open(order().recipe, order());
  await ok.close();
  writeFileSync(join(w.work.checkout, ".git"), "gitdir: elsewhere");
  const ok2 = await build(w, e.sink).sandbox.open(order().recipe, order());
  await ok2.close();
  assert.equal(e.got.length, 0);
  rmSync(join(w.work.checkout, ".git"));
  if (!link(elsewhere, join(w.work.checkout, ".git"))) return t.skip("this system refuses to make a link here");
  await assert.rejects(build(w, e.sink).sandbox.open(order().recipe, order()), /symbolic link/);
  assert.equal(e.got.length, 1);
  assert.match(e.got[0]!.key, /^sbx:protected-entry-is-link:[0-9a-f]{24}$/);
});

test("a read-only input the host's own configuration names that is a link is an ordinary refusal, not a sign of tampering (such inputs are the host's, not the agent's)", async (t) => {
  const e = eventsOf();
  const w = fresh();
  const target = dir(`input-target-${counter}`);
  const inputLink = join(root, `input-link-${counter}`);
  if (!link(target, inputLink)) return t.skip("this system refuses to make a link here");
  const p = build(w, e.sink, { reach: () => ({ readOnly: [{ host: inputLink, guest: "/inputs/x" }] }) });
  const o = { ...order(), recipe: { revision: "r1", reach: ["x"] } };
  await assert.rejects(p.sandbox.open(o.recipe, o), /symbolic link/);
  assert.equal(e.got.length, 0);
});

test("a launch the launcher refuses with the containment marker is reported from the process launch and from a contract check too; one without the marker is not", async () => {
  const w = fresh(); const e = eventsOf();
  const { SandboxError } = await import("../sandbox/errors.js");
  const marked = { launch: async () => { throw new SandboxError("invalid_recipe", "marked", { containment: { what: "mount-is-link", id: "a".repeat(24) } }); } };
  const plain = { launch: async () => { throw new SandboxError("invalid_recipe", "plain"); } };
  const p = build(w, e.sink, {}, marked);
  const session = await p.sandbox.open(order().recipe, order());
  await assert.rejects(p.runtimes.open(order(), {}, undefined), /marked/);
  assert.equal(e.got.length, 1, "the process launch");
  assert.equal(e.got[0]!.key, `sbx:mount-is-link:${"a".repeat(24)}`);
  const check = await p.checks.run("att-1", { run: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 });
  assert.equal(check.state, "not-run");
  assert.equal(e.got.length, 2, "the contract check's launch");
  await session.close();
  const w2 = fresh(); const quiet = eventsOf();
  const p2 = build(w2, quiet.sink, {}, plain);
  const s2 = await p2.sandbox.open(order().recipe, order());
  await assert.rejects(p2.runtimes.open(order(), {}, undefined), /plain/);
  await p2.checks.run("att-1", { run: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 });
  assert.equal(quiet.got.length, 0);
  await s2.close();
});

test("a write the attempt's process makes in its last moments, while the sandbox closes, is seen: the last look is made after the process has ended", async () => {
  const w = fresh(); const e = eventsOf();
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const exit = () => finish({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", stdoutTruncated: false } as RunResult);
  let emit!: (m: FromChild) => void;
  const run = { result, kill: exit, endInput: () => undefined, write: async (text: string) => {
    for (const m of text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)) {
      if (m.t === "start") queueMicrotask(() => emit({ t: "ready", v: WORKER_CHANNEL_VERSION }));
      // The process writes the loader configuration as it is told to close, then ends.
      if (m.t === "close") { writeFileSync(join(w.ext, "loader.json"), "written at the end"); exit(); }
    }
  } } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(encodeMessage(m))); return run; } };
  const p = build(w, e.sink, {}, launcher);
  const session = await p.sandbox.open(order().recipe, order());
  await p.runtimes.open(order(), {}, undefined);
  assert.equal(e.got.length, 0);
  await session.close();
  assert.equal(e.got.length, 1, "the write made while the process ended is reported at the close");
  assert.match(e.got[0]!.key, /^loader:changed:/);
});

test("a look that cannot be made (a folder the host cannot read, more than the bounds) opens and closes the attempt as before and reports nothing", async (t) => {
  const w = fresh(); const e = eventsOf();
  const many = dir(`w${counter}/extensions/many`);
  // More entries than the bound: every look is given up, so nothing is ever compared.
  for (let i = 0; i < 2001; i++) writeFileSync(join(many, `f${i}`), "");
  const p = build(w, e.sink);
  const s = await p.sandbox.open(order().recipe, order());
  writeFileSync(join(w.ext, "loader.json"), "changed but not seen");
  await s.close();
  assert.equal(e.got.length, 0);
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("permission bits do not stop this user here");
  const w2 = fresh();
  const { chmodSync } = await import("node:fs");
  const locked = dir(`w${counter}/extensions/locked`);
  const p2 = build(w2, e.sink);
  const s2 = await p2.sandbox.open(order().recipe, order());
  chmodSync(locked, 0o000);
  try { await s2.close(); } finally { chmodSync(locked, 0o755); }
  assert.equal(e.got.length, 0, "a failed look is not a change");
});
