import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "@nimblenewt/config";
import { launch, runTerminalChat, setupGreeting, STANDARD_ROLES, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";

// Card D01: the owner's user guide (docs/nimblenewt/user-guide.md) is kept true by running it. The example conversation in the guide is fed, line by line, to the real launcher and the real terminal chat; the
// model behind the chat is a scripted stand-in (no model is called), so the test proves that every step the guide shows exists, is shown first where the guide says so, and ends where the guide says it ends,
// and that every reply the guide quotes is what the chat really prints. The typed recovery orders of the guide are run with the model down.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GUIDE = join(repository, "docs", "nimblenewt", "user-guide.md");
const guide = (): string => readFileSync(GUIDE, "utf8").replace(/\r\n/g, "\n");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const start = { facts, filesystem: ext4 } as const;
const memorySecrets = (seed: Record<string, string> = {}): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
async function* lines(items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }

/** The fenced blocks that directly follow each HTML marker `<!-- d01:NAME -->` in the guide. */
function blocksAfter(text: string, name: string): string[] {
  const marker = `<!-- d01:${name} -->`;
  const out: string[] = [];
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    const m = /^\s*```[a-z]*\n([\s\S]*?)```/.exec(text.slice(at + marker.length));
    assert.ok(m !== null, `the ${name} marker is not directly followed by a fenced block`);
    out.push(m[1]!);
  }
  assert.ok(out.length > 0, `the guide has no ${marker} marker`);
  return out;
}

/** The conversation: each `You:` line, with the `NimbleNewt:` lines that follow it until the next `You:`. */
function conversation(block: string): { you: string; replies: string[] }[] {
  const out: { you: string; replies: string[] }[] = [];
  for (const line of block.split("\n")) {
    const you = /^You: (.+)$/.exec(line);
    const said = /^NimbleNewt: (.+)$/.exec(line);
    if (you !== null) out.push({ you: you[1]!.trim(), replies: [] });
    else if (said !== null) { assert.ok(out.length > 0, "a reply before anything was said"); out.at(-1)!.replies.push(said[1]!.trim()); }
    else assert.ok(line.trim() === "", `a conversation line must start with "You: " or "NimbleNewt: ": ${line}`);
  }
  return out;
}

/** A quoted reply holds fragments of the real reply joined by "...": each fragment must appear in the reply, in order. */
function quotedIn(quote: string, reply: string): boolean {
  const flat = reply.replace(/\s+/g, " ");
  const parts = quote.split("...").map((p) => p.trim()).filter((p) => p.length > 0);
  assert.ok(parts.length > 0, `the quote "${quote}" holds no words`);
  let from = 0;
  for (const part of parts) {
    const at = flat.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/**
 * The guide's install lines, run as written: the shell steps are the ones the repository really uses, `init` runs with exactly the guide's options (into a fresh data folder instead of ~/.nimblenewt) and
 * must write a configuration the launcher accepts, and the `secret set` line names the secret the `init` line asked for. `secret set` itself is not run (it would write to this machine's real secret store);
 * the tests give the launcher a store in memory instead. Returns the configuration `start` would load.
 */
async function installFromGuide(dir: string): Promise<LauncherConfig> {
  const all = blocksAfter(guide(), "install").join("\n").replace(/\\\n\s*/g, "").split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
  for (const step of ["npm ci", "npx tsc --build", "node scripts/nimblenewt.mjs start"]) assert.ok(all.includes(step), `the guide's install steps include ${step}`);
  const clone = all.find((x) => x.startsWith("git clone "));
  assert.ok(clone !== undefined && /^git clone https:\/\/github\.com\/[\w-]+\/NimbleNewt\.git$/.test(clone), "the guide clones the NimbleNewt repository");
  assert.ok(all.includes(`cd ${/\/(\w+)\.git$/.exec(clone)![1]}`), "and goes into the folder git makes");
  // The address only works for everyone once the repository is published (card D03); the guide must say so right after the install lines, and offer the address the owner was given instead.
  const afterInstall = guide().split("<!-- d01:install -->")[1]!.split("<!-- d01:install -->")[0]!;
  assert.match(afterInstall, /publication \(card D03\)/, "the guide says the clone address depends on publication");
  assert.match(afterInstall, /use that instead/, "and what to do with another address");
  // What the guide tells the owner to look for at start ("Secrets are kept in: ...") is what the launcher prints.
  assert.match(guide(), /"Secrets are kept in: \.\.\."/);
  assert.ok(readFileSync(join(repository, "scripts", "nimblenewt.mjs"), "utf8").includes("out(`Secrets are kept in: ${reason}.`)"), "the launcher prints where secrets are kept");
  const { main } = await import(pathToFileURL(join(repository, "scripts", "nimblenewt.mjs")).href) as { main: (argv: string[], io: unknown) => Promise<number> };
  const launcher = all.filter((x) => x.startsWith("node scripts/nimblenewt.mjs ")).map((x) => x.split(/\s+/).slice(2));
  assert.deepEqual(launcher.map((a) => a.slice(0, a[0] === "secret" ? 2 : 1).join(" ")), ["init", "secret set", "start"], "the guide runs init, secret set and start, in that order");
  const init = launcher[0]!;
  let said = "";
  const io = { stdin: { isTTY: false }, stdout: { write: (t: string) => { said += t; } }, stderr: { write: (t: string) => { said += t; } }, env: {} };
  assert.equal(await main([...init, "--data", dir], io), 0, said);
  const named = [init.indexOf("--backup-key-secret"), init.indexOf("--model-key-secret")].filter((i) => i >= 0).map((i) => init[i + 1]);
  assert.deepEqual(launcher[1]!.slice(2), named, "the secret the guide sets is the one init names");
  assert.match(said, new RegExp(`secret set ${named[0]}`), "init itself tells the owner to set that secret");
  const loaded = loadConfig(readFileSync(join(dir, "nimblenewt.config.json"), "utf8"));
  assert.ok(loaded.ok, JSON.stringify(loaded));
  return loaded.config as unknown as LauncherConfig;
}
const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
type Turn = { outcomes: { status: string; proposalId?: string; op?: string }[] };
const call = (l: { controller: { api: { handle: (t: string, r: never) => Promise<unknown> } }; ownerToken: string }, op: string, args: Record<string, unknown> = {}, commandId?: string) =>
  l.controller.api.handle(l.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;

// What the stand-in model answers to each line of the guide's conversation. A real model reads the same words; this table is the "understanding", so that the test checks everything after it: that the
// steps exist, are shown first, are applied on the owner's yes and end where the guide says. A line added to or changed in the guide without a matching entry here fails the test, and so does an entry here
// that the guide no longer has.
const RIGHTS = ["attempt.work", "effect.perform", "review.request", "task.read", "desk.write", "desk.read", "message.receive"];
const TASK = "Add a greeting to the README";
function understanding(lastProposals: () => string[]): Record<string, () => unknown[]> {
  const yes = (words: string) => () => lastProposals().map((proposalId) => ({ kind: "apply_proposal", proposalId, evidence: words, basis: "owner" }));
  const rights = "Let Ann work on Garden";
  const project = "My project is called Garden. Its code is in /home/me/garden and we keep it on our own Gitea server with Woodpecker CI.";
  return {
    "help me get started": () => [intent("status", { request: { kind: "setup" } }, "help me get started")],
    "Stay on strict for now": () => [{ kind: "policy_edit", change: { type: "profile", to: "strict" }, evidence: "Stay on strict", basis: "owner" }],
    "yes, keep it": yes("yes, keep it"),
    [project]: () => [intent("command", { op: "project.create", args: { name: "Garden", goal: "Garden", repositories: [{ id: "garden", location: "/home/me/garden" }], versionControl: { host: "self-hosted", hostName: "Gitea", ci: "Woodpecker CI" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "My project is called Garden")],
    "yes, make it": yes("yes, make it"),
    "Run the agents on this computer": () => [intent("command", { op: "host.local.set", args: { enabled: true } }, "Run the agents on this computer")],
    "yes, do that": yes("yes, do that"),
    "Add an agent called Ann as an author": () => [intent("command", { op: "agent.create", args: { friendlyName: "Ann", roles: ["author"] } }, "Add an agent called Ann")],
    "yes, add her": yes("yes, add her"),
    // One plain sentence asks for the bundle of Ann's role (author); the chat lists the rights it stands for.
    [rights]: () => [intent("command", { op: "grant.create", args: { agentName: "Ann", projectName: "Garden", bundle: "roles" } }, rights)],
    "yes, give them": yes("yes, give them"),
    [`Add a task to Garden: ${TASK}`]: () => [intent("command", { op: "task.create", args: { title: TASK, projectName: "Garden" } }, "Add a task to Garden")],
    "yes, add it": yes("yes, add it"),
    [`${TASK} is ready for work, give it to Ann`]: () => [intent("command", { op: "task.transition", args: { taskTitle: TASK, to: "ready" } }, "ready for work"), intent("command", { op: "task.assign", args: { taskTitle: TASK, agentName: "Ann" } }, "give it to Ann")],
    "yes, go ahead": yes("yes, go ahead"),
    "What is waiting for me?": () => [intent("status", { request: { kind: "needs_you" } }, "What is waiting for me?")],
  };
}

test("the guide's example conversation, run line by line through the launcher and the terminal chat, takes an empty installation to a first task given to an agent, and every reply it quotes is real (card D01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-"));
  const turns: Turn[] = [];
  const lastProposals = (): string[] => (turns.at(-1)?.outcomes ?? []).flatMap((o) => (o.status === "proposed" && o.proposalId !== undefined ? [o.proposalId] : []));
  const table = understanding(lastProposals);
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    asked.push(text);
    const intents = table[text]?.() ?? [{ kind: "none", reason: "not in the guide" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const steps = conversation(blocksAfter(guide(), "conversation")[0]!);
  const secrets = memorySecrets({ "backup-key": "backup-secret-value" });
  // The guide and the table say the same lines, in the same order.
  assert.deepEqual(steps.map((s) => s.you), Object.keys(table), "the guide's conversation and the test's table of what the model understands differ: update both together");
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const config = await installFromGuide(dir);
    const live = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch });
    l = live;
    assert.equal(live.ownerCreated, true, "the first start makes the owner");
    // The greeting the guide describes: the setup list with its marks.
    const greeting = await setupGreeting(live.controller, live.ownerToken);
    for (const mark of ["[x]", "[-]", "[ ]"]) assert.ok(greeting.includes(mark), `the greeting shows ${mark}`);
    const chat = live.controller.chat!;
    const wrapped = { api: live.controller.api, chat: { submit: async (...a: Parameters<typeof chat.submit>) => { const t = await chat.submit(...a); turns.push(t as unknown as Turn); return t; } } };
    for (const step of steps) {
      const out: string[] = [];
      const before = turns.length;
      await runTerminalChat({ controller: wrapped as never, ownerToken: live.ownerToken, input: lines([step.you]), write: (t) => out.push(t) });
      const reply = out.join("");
      assert.equal(turns.length, before + 1, `"${step.you}" made one turn: ${reply}`);
      assert.ok(!turns.at(-1)!.outcomes.some((o) => o.status === "refused"), `"${step.you}" was refused: ${reply}`);
      for (const quote of step.replies) assert.ok(quotedIn(quote, reply), `the guide quotes "${quote}" for "${step.you}", but the chat printed:\n${reply}`);
      // "yes" applies exactly what was shown, and something was shown before every "yes".
      if (/^yes\b/.test(step.you)) assert.ok(turns.at(-1)!.outcomes.length > 0 && turns.at(-1)!.outcomes.every((o) => o.status === "applied"), `"${step.you}" applied what was shown: ${reply}`);
    }
    assert.deepEqual(asked, steps.map((s) => s.you), "every line went to the model once, and nothing else did");

    // Where the guide says the conversation ends: a project on its own forge, the host asked for, Ann with her rights in Garden only, the task ready and given to her.
    const project = (await call(live, "project.list")).result.items[0];
    assert.deepEqual([project.name, project.versionControl], ["Garden", { host: "self-hosted", hostName: "Gitea", ci: "Woodpecker CI" }]);
    assert.equal((await call(live, "host.local.get")).result.item.enabled, true);
    const ann = (await call(live, "agent.list")).result.items[0];
    assert.deepEqual([ann.friendlyName, ann.roles], ["Ann", ["author"]]);
    const grants = ((await call(live, "grant.list", { limit: 100 })).result.items as { grantee: string; action: string; project: string; state: string }[]).filter((g) => g.grantee === `agent:${ann.id}`);
    // "Let Ann work on Garden" gave the author template's rights, which hold the seven a task needs to run on the worker host (the U14e test's list).
    const author = STANDARD_ROLES.find((r) => r.name === "author")!.capabilities;
    assert.deepEqual(grants.map((g) => g.action).sort(), [...author].sort());
    for (const right of RIGHTS) assert.ok(author.includes(right), `the author bundle holds ${right}`);
    assert.ok(grants.every((g) => g.project === project.id && g.state === "active"), "each right is in Garden only");
    const task = (await call(live, "task.list", { projectId: project.id })).result.items[0];
    assert.deepEqual([task.title, task.state], [TASK, "ready"]);
    assert.deepEqual((await call(live, "assignment.get", { taskId: task.id })).result.item.owner, { kind: "agent", id: ann.id });
    const ready = (await call(live, "setup.readiness")).result.item;
    assert.deepEqual(ready.items.filter((i: { required: boolean; state: string }) => i.required && i.state !== "done").map((i: { id: string }) => i.id), ["host"], "only the host is left, and it joins at the next start");
    assert.match(ready.items.find((i: { id: string }) => i.id === "host").detail, /joins when the controller is started again/);
    l = undefined; await live.close();

    // "Press Ctrl-D and start again": the same owner, nothing asked again, and the answers are still there. (That the host then runs the task in a sandbox is the U14e test's; it needs bubblewrap.)
    const again = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch });
    l = again;
    assert.equal(again.ownerCreated, false);
    assert.equal((await call(again, "task.list", { projectId: project.id })).result.items[0].state, "ready");
    assert.equal((await call(again, "setup.readiness")).result.item.items.find((i: { id: string }) => i.id === "profile").state, "done", "the strict answer was recorded, so it is not asked again");
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// What the stand-in model answers to each line of the guide's hand-off conversation (the section "Handing a task to another agent"). As above, a line added to or changed in the guide without a matching
// entry here fails the test, and so does an entry here that the guide no longer has.
function handoffUnderstanding(lastProposals: () => string[]): Record<string, () => unknown[]> {
  const yes = (words: string) => () => lastProposals().map((proposalId) => ({ kind: "apply_proposal", proposalId, evidence: words, basis: "owner" }));
  const hand = "Hand Add a greeting to the README over to Bob, Ann is away this week";
  return {
    "Add an agent called Bob as an author": () => [intent("command", { op: "agent.create", args: { friendlyName: "Bob", roles: ["author"] } }, "Add an agent called Bob")],
    "yes, add him": yes("yes, add him"),
    "Let Bob work on Garden": () => [intent("command", { op: "grant.create", args: { agentName: "Bob", projectName: "Garden", bundle: "roles" } }, "Let Bob work on Garden")],
    "yes, give them": yes("yes, give them"),
    [hand]: () => [intent("command", { op: "handoff.prepare", args: { taskTitle: TASK, toAgentName: "Bob", reason: "Ann is away this week" } }, hand)],
    "In Garden, how is the hand-off of Add a greeting to the README going?": () => [{ kind: "switch_focus", projectName: "Garden", evidence: "In Garden", basis: "owner" }, intent("status", { request: { kind: "handoff", taskTitle: TASK } }, "how is the hand-off of Add a greeting to the README going?")],
    "Finish handing over Add a greeting to the README, gaps and all": () => [intent("command", { op: "handoff.complete", args: { taskTitle: TASK, acceptGaps: true } }, "Finish handing over Add a greeting to the README, gaps and all")],
    "yes, hand it over": yes("yes, hand it over"),
  };
}

// The guide's three further hand-off lines (cancel, cover for a while, take over by force), said once the task is Bob's.
function handoffMoreUnderstanding(lastProposals: () => string[], friday: string): Record<string, () => unknown[]> {
  const back = "Hand Add a greeting to the README back to Ann, Bob is needed elsewhere";
  const cover = "Let Ann cover Add a greeting to the README until Friday, Bob is needed elsewhere";
  const force = "Take Add a greeting to the README over for Ann, Bob is not answering";
  return {
    [back]: () => [intent("command", { op: "handoff.prepare", args: { taskTitle: TASK, toAgentName: "Ann", reason: "Bob is needed elsewhere" } }, back)],
    "Cancel the hand-off of Add a greeting to the README": () => [intent("command", { op: "handoff.cancel", args: { taskTitle: TASK } }, "Cancel the hand-off of Add a greeting to the README")],
    [cover]: () => [intent("command", { op: "handoff.prepare", args: { taskTitle: TASK, toAgentName: "Ann", reason: "Bob is needed elsewhere", returnAt: friday } }, cover)],
    "no, drop that": () => lastProposals().map((proposalId) => ({ kind: "discard_proposal", proposalId, evidence: "no, drop that", basis: "owner" })),
    [force]: () => [intent("command", { op: "handoff.takeover", args: { taskTitle: TASK, toAgentName: "Ann", reason: "Bob is not answering" } }, force)],
    "yes, take it over": () => lastProposals().map((proposalId) => ({ kind: "apply_proposal", proposalId, evidence: "yes, take it over", basis: "owner" })),
  };
}

test("the guide's hand-off conversations, run line by line through the launcher and the terminal chat, move the example's task from Ann to Bob with its package, cancel, discard a cover and take it back by force, and every reply they quote is real (card D01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-handoff-"));
  const turns: Turn[] = [];
  const lastProposals = (): string[] => (turns.at(-1)?.outcomes ?? []).flatMap((o) => (o.status === "proposed" && o.proposalId !== undefined ? [o.proposalId] : []));
  // "until Friday": the stand-in reads it as a time three days ahead (a real model works the date out; the chat shows it before anything is done).
  const friday = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const first = handoffUnderstanding(lastProposals);
  const more = handoffMoreUnderstanding(lastProposals, friday);
  const table = { ...first, ...more };
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    asked.push(text);
    const intents = table[text]?.() ?? [{ kind: "none", reason: "not in the guide" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const steps = conversation(blocksAfter(guide(), "handoff")[0]!);
  const moreSteps = conversation(blocksAfter(guide(), "handoff-more")[0]!);
  assert.deepEqual(steps.map((s) => s.you), Object.keys(first), "the guide's hand-off conversation and the test's table of what the model understands differ: update both together");
  assert.deepEqual(moreSteps.map((s) => s.you), Object.keys(more), "the guide's further hand-off lines and the test's table differ: update both together");
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const live = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch });
    l = live;
    // Where the guide's first conversation ends (made here through the API): Garden, Ann the author with her role's rights there, and the task ready and given to her.
    const project = (await call(live, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const ann = (await call(live, "agent.create", { friendlyName: "Ann", roles: ["author"] }, "a1")).result.id as string;
    for (const action of STANDARD_ROLES.find((r) => r.name === "author")!.capabilities) assert.ok((await call(live, "grant.create", { grantee: `agent:${ann}`, action, project, basis: "Let Ann work on Garden" }, `g-${action}`)).ok);
    const taskId = (await call(live, "task.create", { projectId: project, title: TASK }, "t1")).result.id as string;
    assert.ok((await call(live, "task.transition", { taskId, to: "ready", expectedRevision: 1 }, "tr1")).ok);
    assert.ok((await call(live, "task.assign", { taskId, owner: { kind: "agent", id: ann } }, "as1")).ok);
    const holder = async (): Promise<unknown> => (await call(live, "assignment.get", { taskId })).result.item.owner;
    // Whether the task's work is held (paused): a hand-off holds it while it is prepared and lets go when it ends, so the task is free for work again.
    const held = async (): Promise<boolean> => (await call(live, "lifecycle.status", { scope: { kind: "task", id: taskId } })).result.item.intent === "pause";
    const going = async (): Promise<{ id: string } | undefined> => { const r = await call(live, "handoff.for-task", { taskId }); return r.ok ? r.result.item : (assert.equal(r.error.code, "not_found", JSON.stringify(r)), undefined); };

    const chat = live.controller.chat!;
    const wrapped = { api: live.controller.api, chat: { submit: async (...a: Parameters<typeof chat.submit>) => { const t = await chat.submit(...a); turns.push(t as unknown as Turn); return t; } } };
    const say = async (step: { you: string; replies: string[] }): Promise<{ outcomes: Turn["outcomes"]; reply: string }> => {
      const out: string[] = [];
      const before = turns.length;
      await runTerminalChat({ controller: wrapped as never, ownerToken: live.ownerToken, input: lines([step.you]), write: (t) => out.push(t) });
      const reply = out.join("");
      assert.equal(turns.length, before + 1, `"${step.you}" made one turn: ${reply}`);
      const outcomes = turns.at(-1)!.outcomes;
      assert.ok(!outcomes.some((o) => o.status === "refused"), `"${step.you}" was refused: ${reply}`);
      for (const quote of step.replies) assert.ok(quotedIn(quote, reply), `the guide quotes "${quote}" for "${step.you}", but the chat printed:\n${reply}`);
      if (/^yes\b/.test(step.you)) assert.ok(outcomes.length > 0 && outcomes.every((o) => o.status === "applied"), `"${step.you}" applied what was shown: ${reply}`);
      return { outcomes, reply };
    };
    const agentId = async (name: string): Promise<string> => ((await call(live, "agent.list")).result.items as { id: string; friendlyName: string }[]).find((a) => a.friendlyName === name)!.id;
    const kinds = (o: Turn["outcomes"]) => o.map((x) => [x.status, x.op ?? null]);

    let prepared: string | undefined;
    for (const step of steps) {
      const { outcomes, reply } = await say(step);
      // The guide: Bob needs rights in Garden first, or the hand-off is refused.
      if (step.you === "yes, add him") {
        const early = await call(live, "handoff.prepare", { taskId, to: { kind: "agent", id: await agentId("Bob") }, reason: "before Bob has rights" }, "early");
        assert.ok(!early.ok && /no right to work in the task's project/.test(early.error.message), `a hand-off to Bob before he has rights in Garden is refused: ${JSON.stringify(early)}`);
        assert.equal(await going(), undefined);
      }
      // What the guide says about each step: asking for the hand-off moves nothing yet, the package lacks what the example task has not got, and finishing with gaps is shown first.
      if (step.you.startsWith("Hand Add a greeting")) {
        assert.deepEqual(kinds(outcomes), [["applied", "handoff.prepare"]]);
        assert.deepEqual(await holder(), { kind: "agent", id: ann }, "preparing the hand-off moves nothing");
        prepared = (await going())?.id;
        assert.ok(await held(), "Ann's work on the task is brought to a stop while the hand-off is prepared");
        assert.ok(prepared !== undefined, "a hand-off is going on for the task");
      }
      // The guide: the answer names agents by their IDs.
      if (step.you.startsWith("In Garden")) assert.ok(reply.includes(ann) && reply.includes(await agentId("Bob")), `the hand-off status names Ann and Bob by ID: ${reply}`);
      if (step.you.startsWith("Finish handing over")) {
        assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "handing over with gaps is shown first");
        // The guide says this is shown first in every profile, not only on strict (the example's profile): the reason given is the accepted gaps, not the profile.
        assert.ok(reply.includes("(it changes what someone may do or where work is done)") && !reply.includes("strict profile"), `handing over with gaps is shown first for its own reason, whatever the profile: ${reply}`);
        assert.deepEqual(await holder(), { kind: "agent", id: ann }, "nothing moved before the yes");
      }
    }
    // Where the guide says the first conversation ends: the task is Bob's, still ready, the move is in the task's record, and the hand-off is recorded with the gaps the owner accepted.
    const bob = { id: await agentId("Bob") };
    assert.deepEqual(await holder(), { kind: "agent", id: bob.id });
    assert.equal((await call(live, "task.get", { taskId })).result.item.state, "ready");
    assert.equal(await held(), false, "the hand-off's hold is lifted, so Bob can work on the task");
    assert.equal(await going(), undefined, "no hand-off is still going on for the task");
    const done = (await call(live, "handoff.get", { handoffId: prepared })).result.item;
    assert.equal(done.phase, "transferred");
    assert.equal(done.reason, "Ann is away this week");
    assert.deepEqual(done.acceptedGaps.missing, ["acceptanceCriteria", "unfinishedWork", "nextAction"], "the gaps the guide quotes are the ones accepted");
    // The latest move in the task's record, which must name the new holder as the one the task went to.
    const lastMove = async (): Promise<{ summary: string; manifest?: { refs?: { kind: string; id: string }[] } } | undefined> => ((await call(live, "activity.steps", { taskId })).result.steps as { kind: string; summary: string }[]).filter((x) => x.kind === "ownership").at(-1);
    const moved = async (to: string): Promise<boolean> => (await lastMove())?.summary.includes(`to agent ${to}.`) === true;
    assert.ok(await moved(bob.id), "the move is in the task's record");

    // The further lines: a hand-off back to Ann is prepared and cancelled (the task stays Bob's), a cover until Friday is shown first with its time and dropped, and a takeover by force is shown first and moves the task.
    for (const step of moreSteps) {
      const { outcomes, reply } = await say(step);
      if (step.you.startsWith("Hand Add a greeting")) { assert.deepEqual(kinds(outcomes), [["applied", "handoff.prepare"]]); assert.ok((await going()) !== undefined); }
      if (step.you.startsWith("Cancel")) { assert.deepEqual(kinds(outcomes), [["applied", "handoff.cancel"]]); assert.equal(await going(), undefined, "the cancelled hand-off is over"); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }, "cancelling moves nothing"); assert.equal(await held(), false, "and lifts the cancelled hand-off's hold"); }
      if (step.you.startsWith("Let Ann cover")) { assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "a time to give the task back is shown first"); assert.ok(reply.includes(friday), `the proposal shows the time the task goes back (${friday}): ${reply}`); assert.equal(await going(), undefined, "nothing is prepared before the yes"); }
      if (step.you.startsWith("no,")) { assert.deepEqual(outcomes.map((o) => o.status), ["discarded"]); assert.equal(await going(), undefined); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }); }
      if (step.you.startsWith("Take Add a greeting")) { assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "a takeover by force is shown first"); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }); }
    }
    assert.deepEqual(await holder(), { kind: "agent", id: ann }, "the takeover gave the task to Ann");
    assert.ok(await moved(ann), "and is in the task's record");
    // The guide: the takeover is recorded as a forced one.
    const forcedId = (await lastMove())?.manifest?.refs?.find((r) => r.kind === "handoff")?.id;
    assert.ok(forcedId !== undefined && forcedId !== prepared, "the takeover's move names its own hand-off");
    const forced = (await call(live, "handoff.get", { handoffId: forcedId })).result.item;
    assert.deepEqual([forced.mode, forced.phase, forced.reason], ["forced", "transferred", "Bob is not answering"], "the takeover is recorded as a forced one, with the owner's reason");
    assert.ok(forced.exception !== undefined, "and as an exception");
    assert.deepEqual(asked, [...steps, ...moreSteps].map((s) => s.you), "every line went to the model once, and nothing else did");
    // The guide: `/nimblenewt.agent-list {}` shows which ID is whose.
    const listed: string[] = [];
    await runTerminalChat({ controller: wrapped as never, ownerToken: live.ownerToken, input: lines(["/nimblenewt.agent-list {}"]), write: (t) => listed.push(t) });
    const list = listed.join("").replace(/\r\n/g, "\n");
    const json = /Ran nimblenewt\.agent-list:\n([\s\S]*)$/.exec(list)?.[1];
    assert.ok(json !== undefined, `the agent list ran:\n${list}`);
    const items = (JSON.parse(json) as { items: { id: string; friendlyName: string }[] }).items;
    for (const [name, id] of [["Ann", ann], ["Bob", bob.id]] as const) assert.ok(items.some((a) => a.id === id && a.friendlyName === name), `the agent list shows ${name} with the ID ${id}:\n${list}`);
    assert.equal(asked.length, steps.length + moreSteps.length, "a typed command is not read by the model");
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("with every model server down, each typed recovery order in the guide runs as written, with no model call, and the guide's quoted answers are real (card D01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-down-"));
  let modelCalls = 0;
  const down: typeof globalThis.fetch = async () => { modelCalls++; throw new TypeError("fetch failed: connection refused"); };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    l = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch: down });
    const live = l;
    // Something to act on, made through the API (how it was made does not matter to the orders).
    const project = (await call(live, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const taskId = (await call(live, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const agentId = (await call(live, "agent.create", { friendlyName: "Ann", roles: ["author"] }, "a1")).result.id as string;
    const grant = (await call(live, "grant.create", { grantee: `agent:${agentId}`, action: "task.read", project, basis: "Ann reads Garden" }, "g1")).result;
    const fill = (line: string): string => line.replace(/TASK-ID/g, taskId).replace(/AGENT-ID/g, agentId).replace(/GRANT-ID/g, grant.id).replace(/"expectedRevision": 1/, `"expectedRevision": ${grant.revision}`).replace(/PROVIDER-NAME/g, "backup");
    const say = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: live.controller, ownerToken: live.ownerToken, input: lines([text]), write: (t) => out.push(t) }); return out.join(""); };

    // A message in plain words: the model is down, and the chat says so in the words the guide quotes.
    const plain = await say("pause everything please");
    for (const block of blocksAfter(guide(), "model-down")) for (const { replies } of conversation(`You: (plain words)\n${block}`)) for (const q of replies) assert.ok(quotedIn(q, plain), `the guide quotes "${q}", the chat printed:\n${plain}`);
    const tried = modelCalls;
    assert.ok(tried > 0, "the chat did try the model");

    const orders = blocksAfter(guide(), "recovery").flatMap((b) => b.split("\n").map((x) => x.trim()).filter((x) => x.length > 0));
    assert.ok(orders.length >= 10, "the guide's typed orders were read");
    const ran: string[] = [];
    for (const order of orders) {
      const line = fill(order);
      const turn = await live.controller.chat!.submit(live.ownerToken, { messageId: `order-${ran.length}`, text: line }) as unknown as { outcomes: { status: string; code?: string; message?: string; shown?: string[] }[] };
      const o = turn.outcomes[0]!;
      if (order.startsWith("/exclude ")) {
        // The short form is shown as its full line, which is the next line of the guide.
        assert.equal(o.code, "needs_confirmation", JSON.stringify(o));
        const next = fill(orders[orders.indexOf(order) + 1]!);
        assert.ok(o.message!.endsWith(next), `the guide's next line is the full form NimbleNewt shows: ${o.message}`);
      } else {
        assert.equal(o.status, "applied", `${line}: ${JSON.stringify(o)}`);
        // "Each stop answer says how far it got: Received, Accepted, and whether it has taken effect yet."
        if (order.startsWith("/nimblenewt.lifecycle-") && !order.startsWith("/nimblenewt.lifecycle-status")) {
          for (const stage of ["Received: yes", "Accepted: yes", "Effected: "]) assert.ok((o.shown ?? []).some((x) => x.startsWith(stage)), `${line} says ${stage}: ${JSON.stringify(o.shown)}`);
        }
      }
      ran.push(order.split(" ")[0]!);
    }
    assert.equal(modelCalls, tried, "no typed order asked the model");
    // They took effect: the stopped task is kept (not cancelled), the right is revoked and the installation is no longer paused.
    assert.notEqual((await call(live, "task.get", { taskId })).result.item.state, "cancelled");
    assert.equal(((await call(live, "grant.list", { limit: 100 })).result.items as { id: string; state: string }[]).find((g) => g.id === grant.id)!.state, "revoked");
    assert.equal((await call(live, "lifecycle.status", { scope: { kind: "installation", id: "installation" } })).result.item.intent, "active");
    assert.ok(ran.includes("/nimblenewt.lifecycle-force") && ran.includes("/nimblenewt.grant-revoke") && ran.includes("/nimblenewt.routing-reenable"));

    // A key typed into the chat: the refusal the guide quotes, and nothing reaches the model.
    const key = ["s", "k-", "abcdefghijklmnop", "qrstuvwxyz123456"].join("");
    const refused = await say(`my key is ${key} please use it`);
    for (const block of blocksAfter(guide(), "key-refusal")) for (const { replies } of conversation(`You: (a key)\n${block}`)) for (const q of replies) assert.ok(quotedIn(q, refused), `the guide quotes "${q}", the chat printed:\n${refused}`);
    assert.ok(!refused.includes(key));
    assert.equal(modelCalls, tried);
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// The views the guide's "Checking on finished work" section describes. Each is one status kind; the section's block lists the kind and a sentence to say. The test below asks every sentence of the block through the
// real chat (a scripted stand-in plays the model, so the table below is only its "understanding") and fails when a listed kind is not a real status kind, when the chat does not answer it, or when a kind that
// section has to cover is missing from the guide.
const FINISHED_WORK_KINDS = ["submissions", "submissions_project", "qa", "qa_project", "defects", "defect_risks", "docs", "task_docs", "landing_queue", "landing_settings"];
const statusKindsInSource = (): Set<string> => {
  const source = readFileSync(join(repository, "packages", "controller", "src", "status", "status.ts"), "utf8");
  const union = /export type StatusRequest =([\s\S]*?)\n\nexport|export type StatusRequest =([\s\S]*?);\n/.exec(source)?.[0] ?? "";
  return new Set([...union.matchAll(/readonly kind: "([a-z_]+)"/g)].map((m) => m[1]!));
};
const finishedWorkLines = (): { kind: string; say: string }[] => blocksAfter(guide(), "status-kinds")[0]!.split("\n").map((x) => x.trim()).filter((x) => x.length > 0).map((x) => {
  const m = /^([a-z_]+)\s+"(.+)"$/.exec(x);
  assert.ok(m !== null, `a status-kinds line is a kind and a quoted sentence: ${x}`);
  return { kind: m[1]!, say: m[2]! };
});

test("the guide's Meetings section describes each owner control of scheduling and calling meetings, and names a status kind that exists (card chat meetings)", () => {
  const whole = guide();
  const from = whole.indexOf("\n## Meetings");
  assert.ok(from >= 0, "the guide has the Meetings section");
  const next = whole.indexOf("\n## ", from + 1);
  const text = whole.slice(from, next < 0 ? undefined : next);
  for (const word of ["**Schedule a meeting.**", "**Change a schedule.**", "**Call a meeting now.**", "**See the meetings.**", "shown to you first and happens only when you agree", "ending a schedule cannot be undone", "asked to stop at a safe point and join", "paused or unavailable ones are not woken", "30 minutes unless you said a length", "a day that has already passed is refused", "Naming agents replaces who attends", "the meetings after 10"]) assert.ok(text.includes(word), `the Meetings section says: ${word}`);
  assert.ok(statusKindsInSource().has("meetings"), "the meetings view the section tells about is a real status kind");
});

test("every status view the guide's finished-work section lists is a real status kind, is described in full, and is answered by the chat for the words the guide shows (card D01)", async () => {
  const rows = finishedWorkLines();
  const real = statusKindsInSource();
  assert.ok(real.size > 30, "the status kinds were read from the source");
  assert.deepEqual([...rows.map((l) => l.kind)].sort(), [...FINISHED_WORK_KINDS].sort(), "the guide lists exactly the finished-work views this test knows");
  for (const l of rows) assert.ok(real.has(l.kind), `${l.kind} is not a status kind`);
  // Each view and each owner control the section names is described in the prose of that section (from its heading to the next one of the same level), in words.
  const whole = guide();
  const from = whole.indexOf("\n## Checking on finished work");
  assert.ok(from >= 0, "the guide has the finished-work section");
  const next = whole.indexOf("\n## ", from + 1);
  const text = whole.slice(from, next < 0 ? undefined : next);
  // The views and controls are the section's bold terms (a plain word such as "withdraw" would still be found inside "withdrawn" after the control itself was dropped).
  for (const word of ["**Submissions**", "the commit that a reviewer's approval asks for by itself was refused, failed or was left unsure", "**Code waiting in a project.**", "**QA**", "**Defects**", "**unfinished defects**", "**Documents of a task.**", "**The landing queue**", "**Landing settings**", "**reserved place**", "moved to the back of the queue by the controller", "**escalated to you**", "**accept it as is**", "**let the repair go on**", "**withdraw**", "**correct**", "**A director's check before landing.**", "**Release after a reviewer's approval.**", "**committed the approved code**", "*permit commit*", "*plain commit*", "*not made yet*", "*could not be read just now*", "commit the approved parser fix", "when the task's newest code is approved and not committed yet", "proposes nothing", "(in task \"<the task's title>\")", "**release**", "no longer count", "**Documents of a project.**", "30 documents at a time", "Asking for the next ones", "does not remember which page you saw last", "**stale**", "**unverified**", "No documentation obligations are recorded for this project", "To verify:", "**Who reviews, and how approvals are counted.**", "**Keeping a tool for yourself.**", "**review policy**", "*independence required*", "`review.repairCycles`", "always ask me before git-push in Garden", "reserve git-commit for me in this project"]) assert.ok(text.includes(word), `the guide's finished-work section does not mention "${word}"`);

  const dir = mkdtempSync(join(tmpdir(), "nn-d01-work-"));
  // The stand-in reads the owner's words the way the interpreter prompt asks a model to: a task view names the task by its title (the chat finds it in the project in focus), and a project view
  // ("... in Garden") moves the focus to the project the owner named, its evidence the owner's own phrase naming it (the word before the name and the name: a phrase not in the sentence is refused, and that refusal
  // fails the row rather than leaving the focus an earlier row set), then asks for the view of the project in focus. No ID is handed over: the chat resolves both from the owner's words.
  const TASK_KINDS = new Set(["submissions", "qa", "defects", "task_docs"]);
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const said = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    const row = rows.find((l) => l.say === said);
    const intents = row === undefined ? [{ kind: "none", reason: "not in the guide" }]
      : TASK_KINDS.has(row.kind) ? [intent("status", { request: { kind: row.kind, taskTitle: TASK } }, row.say)]
      : [{ kind: "switch_focus", projectName: "Garden", evidence: /\S+ Garden\b/.exec(row.say)?.[0] ?? "Garden", basis: "owner" }, intent("status", { request: { kind: row.kind } }, row.say)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    l = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch });
    const live = l;
    const project = (await call(live, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(live, "task.create", { projectId: project, title: TASK }, "t1")).result.id as string;
    // Every project sentence of the block names Garden, so the focus is on it once one of them was asked; the task sentences are asked after them (the owner's focus is kept between conversations).
    const ordered = [...rows.filter((r) => !TASK_KINDS.has(r.kind)), ...rows.filter((r) => TASK_KINDS.has(r.kind))];
    for (const r of ordered) if (!TASK_KINDS.has(r.kind)) assert.match(r.say, /\bGarden\b/, `${r.kind}: a project view's sentence names the project`);
    const firstLines = new Map<string, string>();
    for (const row of ordered) {
      // What the view itself says, read through the state API with the IDs the chat should have found.
      const view = await call(live, "status.ask", { request: TASK_KINDS.has(row.kind) ? { kind: row.kind, taskId: task } : { kind: row.kind, projectId: project } });
      assert.equal(view.ok, true, `${row.kind}: the view answers through the state API: ${JSON.stringify(view)}`);
      const viewLines = (view.result.item.lines as { text: string }[]).map((x) => x.text);
      assert.ok(viewLines.length > 0, `${row.kind}: the view has lines`);
      firstLines.set(row.kind, viewLines[0]!);
      const out: string[] = [];
      await runTerminalChat({ controller: live.controller, ownerToken: live.ownerToken, input: lines([row.say]), write: (t) => out.push(t) });
      const printed = out.join("").replace(/\s+/g, " ");
      assert.ok(!/not in the guide|Which project do you mean|invalid_command|not_found|not a phrase of your own message/i.test(printed), `${row.kind}: the chat did not answer the guide's words:\n${printed}`);
      // The chat's answer is the view's own text (the first line, whitespace folded), not only some reply of the stand-in.
      assert.ok(printed.includes(viewLines[0]!.replace(/\s+/g, " ")), `${row.kind}: the chat did not print the view's answer "${viewLines[0]}":\n${printed}`);
    }
    // The views answer differently on this project (so a sentence routed to the wrong kind could not pass by printing another view's words).
    // The words the guide quotes for the project documents view are the first line the view prints on a project that tracks none.
    assert.ok(firstLines.get("docs")!.startsWith("No documentation obligations are recorded for this project"), `docs first line: ${firstLines.get("docs")}`);
    // On a project with no documents the project view and the task view read the same empty list and say the same sentence; every other pair differs.
    assert.equal(firstLines.get("task_docs"), firstLines.get("docs"));
    assert.equal(new Set(firstLines.values()).size, FINISHED_WORK_KINDS.length - 1, `the views' answers are told apart: ${JSON.stringify([...firstLines])}`);
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// The toolbox maintainers' view of the guide (card T08, eighth slice): the three sentences are asked through the real launcher and chat, a stand-in plays the model and sees only the owner's words of the message (a tool
// name and a page offset can only come from them), and what the guide says about the answer is true of it.
test("the guide's toolbox maintainer sentences are answered by the chat with the view's own text, a tool and a page come only from the owner's words, and what the section says about the view is true (card T08)", async () => {
  const whole = guide();
  const rows = blocksAfter(whole, "toolbox-maintainers")[0]!.split("\n").map((x) => x.trim()).filter((x) => x.length > 0).map((x) => { const m = /^toolbox_maintainers\s+"(.+)"$/.exec(x); assert.ok(m !== null, x); return m[1]!; });
  assert.deepEqual(rows, ["Who maintains the toolbox?", "Who can approve the proposals for the lint tool?", "Who maintains the toolbox, after the first 10?"]);
  assert.ok(statusKindsInSource().has("toolbox_maintainers"), "toolbox_maintainers is a real status kind");
  const from = whole.indexOf("\n## Shared tools: who may decide what agents propose");
  assert.ok(from >= 0, "the guide has the section");
  const next = whole.indexOf("\n## ", from + 1);
  const text = whole.slice(from, next < 0 ? undefined : next);
  for (const word of ["**toolbox**", "**maintain the toolbox**", "let Ann maintain the toolbox", "not to a role or a title", "never decides its own proposal", "**Who maintains the toolbox.**", "every project", "made for those projects alone", "not counted for it", "reads \"at least\"", "ten at a time", "after the first 10", "only you decide", "read-only", "only you can ask", "toolbox proposals view"]) assert.ok(text.includes(word), `the guide's section does not mention "${word}"`);
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-toolbox-"));
  let system = "";
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const said = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const tool = /\bfor the (\w+) tool\b/.exec(said)?.[1];
    const skipped = /\bafter the first (\d+)\b/.exec(said)?.[1];
    const intents = rows.includes(said) ? [intent("status", { request: { kind: "toolbox_maintainers", ...(tool === undefined ? {} : { name: tool }), ...(skipped === undefined ? {} : { after: Number(skipped) }) } }, said)] : [{ kind: "none", reason: "not in the guide" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    l = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch });
    const live = l;
    const ask = async (say: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: live.controller, ownerToken: live.ownerToken, input: lines([say]), write: (t) => out.push(t) }); return out.join("").replace(/\s+/g, " "); };
    // Nobody holds the right yet: the view says so (and that then only the owner decides).
    const none = await ask(rows[0]!);
    assert.match(none, /No agent holds toolbox\.manage now: only the owner decides toolbox proposals\./);
    // Ann is given the right for every project by the owner's own request: she is listed by name with her ID, the reach and the count.
    const ann = (await call(live, "agent.create", { friendlyName: "Ann" }, "ag-ann")).result.id as string;
    assert.equal((await call(live, "grant.create", { grantee: `agent:${ann}`, action: "toolbox.manage", project: "*", basis: "the owner asked" }, "gr-ann")).ok, true);
    const listed = await ask(rows[0]!);
    assert.match(listed, new RegExp(`"Ann" \\(agent:${ann}\\) holds toolbox\\.manage for every project, so it may decide proposals for any shared tool; no proposal waits for a decision it may make\\.`));
    assert.match(system, /toolbox_maintainers \(name: one tool in the owner.s own words; it shows 10 at a time, so the next ones are after 10, then after 20\)/, "the prompt tells the model about the kind");
    // The sentence that names no shared tool that exists is not answered with a list; one that names a count past the end shows nothing more.
    assert.ok(!/Ann/.test(await ask(rows[1]!)), "a tool that does not exist lists no maintainer");
    assert.match(await ask(rows[2]!), /There are no more maintainers to show\./);
    // Asking changed nothing: the view is the same afterwards.
    assert.equal((await ask(rows[0]!)).replace(/As of \S+/, ""), listed.replace(/As of \S+/, ""));
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// The review policy paragraph of the guide (card D01, sixth slice): the owner's sentences for keeping a tool for themselves are asked through the real chat (a scripted stand-in plays the model, as above), and what the
// guide says about it is true of what the chat does: the reply says the tool will always ask the owner, asking again changes nothing, and releasing it from chat is refused.
test("the guide's review policy sentences keep a tool for the owner through the chat, once, and the chat never gives it back (card D01)", async () => {
  const whole = guide();
  const from = whole.indexOf("- **Keeping a tool for yourself.**");
  assert.ok(from >= 0, "the guide has the paragraph");
  const para = whole.slice(from, whole.indexOf("\n- ", from + 3));
  const said = [...para.matchAll(/"((?:always ask me|reserve)[^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(said, ["always ask me before git-push in Garden", "reserve git-commit for me in this project"]);
  const release = "Stop reserving git-push, give it back to the agents";
  const focus = "Let's work on Garden";
  let system = "";
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-rev-"));
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    system = body.messages.find((m) => m.role === "system")?.content ?? "";
    // The shape the interpreter prompt asks for: the project named in the owner's words goes in the change (projectName), the evidence is their words copied exactly; a release is the same object with type unreserve.
    const tool = text.includes("git-push") ? "git-push" : "git-commit";
    const change = { type: text === release ? "unreserve" : "reserve", tool, ...(text.includes("in Garden") ? { projectName: "Garden" } : {}) };
    const intents = text === focus ? [{ kind: "switch_focus", projectName: "Garden", evidence: focus, basis: "owner" }] : text === release || said.includes(text) ? [{ kind: "policy_edit", change, evidence: text, basis: "owner" }] : [{ kind: "none", reason: "not in the guide" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    l = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch });
    const live = l;
    await call(live, "project.create", { name: "Garden" }, "p1");
    const ask = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: live.controller, ownerToken: live.ownerToken, input: lines([text]), write: (t) => out.push(t) }); return out.join("").replace(/\s+/g, " "); };
    const first = await ask(said[0]!);
    // A real model learns this shape only from the interpreter prompt: it gives the change, both of the guide's sentences, and what to answer for a release.
    for (const want of ['{"kind":"policy_edit","change":{"type":"reserve"', "type unreserve", ...said]) assert.ok(system.includes(want), `the interpreter prompt does not carry ${want}`);
    assert.match(first, /git-push will always ask you/, first);
    assert.ok(!/refused|not applied|not in the guide/i.test(first), first);
    const again = await ask(said[0]!);
    assert.match(again, /reserved for you already/, `asking again changes nothing:\n${again}`);
    await ask(focus);
    const second = await ask(said[1]!);
    assert.match(second, /git-commit will always ask you/, `the project in focus is used:\n${second}`);
    const back = await ask(release);
    assert.match(back, /only lowered by you directly, never by chat, and there is no control for that yet/, `the chat does not give a reserved tool back:\n${back}`);
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// The documents view's paging sentences (card Q03 slice 9): the model never sees an earlier answer, so the interpreter prompt gives it a rule it can apply from the owner's words alone (the next documents
// are after 30, the third page after 60, a number the owner gives is used as said). The guide's quoted sentences go through the real interpreter and the real chat (a stand-in plays the model, applying that
// rule), and each answer is the state API's own page for that number.
test("the guide's sentences for the next documents reach the right page through the chat, with the number taken from the owner's words (card Q03)", async () => {
  const whole = guide();
  const from = whole.indexOf("- **Documents of a project.**");
  assert.ok(from >= 0, "the guide has the paragraph");
  const para = whole.slice(from, whole.indexOf("\n- ", from + 3));
  const said = [...para.matchAll(/"((?:show me the next|show the documents after|the third page)[^"]*)"/g)].map((m) => m[1]!);
  assert.deepEqual(said, ["show me the next documents", "show the documents after 60", "the third page of documents"]);
  const focus = "Let's work on Garden";
  let system = "";
  const dir = mkdtempSync(join(tmpdir(), "nn-d01-docs-"));
  // The prompt's rule, read the way a model is asked to: a number the owner gives, else 30 for each page before the one asked for.
  const afterFrom = (text: string): number => { const n = /after (\d+)/.exec(text); if (n !== null) return Number(n[1]); return /third page/.test(text) ? 60 : 30; };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const intents = text === focus ? [{ kind: "switch_focus", projectName: "Garden", evidence: focus, basis: "owner" }] : said.includes(text) ? [intent("status", { request: { kind: "docs", after: afterFrom(text) } }, text)] : [{ kind: "none", reason: "not in the guide" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    l = await launch({ config: await installFromGuide(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch });
    const live = l;
    const project = (await call(live, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(live, "task.create", { projectId: project, title: "Export" }, "t1")).result.id as string;
    const made = (await call(live, "agent.create", { friendlyName: "Dora", roles: ["docs"] }, "a1")).result.id as string;
    const keeper = made.startsWith("agent:") ? made : `agent:${made}`;
    const granted = await call(live, "grant.create", { grantee: keeper, action: "task.read", project, basis: "Dora keeps Garden's documents" }, "g1");
    assert.equal(granted.ok, true, JSON.stringify(granted));
    for (let i = 1; i <= 61; i++) {
      const r = await call(live, "doc.obligation.record", { projectId: project, title: `Export page ${i}`, location: `docs/export-${i}.md`, audience: "user", owner: keeper, applicableVersion: "1.0", implementationRefs: [task] }, `o${i}`);
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const ask = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: live.controller, ownerToken: live.ownerToken, input: lines([text]), write: (t) => out.push(t) }); return out.join("").replace(/\s+/g, " "); };
    await ask(focus);
    // A real model learns the rule only from the interpreter prompt.
    for (const want of ["You do not see earlier answers", '"show me the next documents"', "the second page is after 30, the third page after 60", '"the documents after 60" is after 60']) assert.ok(system.includes(want), `the interpreter prompt does not carry ${want}`);
    const want = { "show me the next documents": [30, "Showing documents 31 to 60 of 61"], "show the documents after 60": [60, "Showing documents 61 to 61 of 61"], "the third page of documents": [60, "Showing documents 61 to 61 of 61"] } as const;
    for (const text of said) {
      const [after, line] = want[text as keyof typeof want];
      const printed = await ask(text);
      const view = await call(live, "status.ask", { request: { kind: "docs", projectId: project, after } });
      const viewLines = (view.result.item.lines as { text: string }[]).map((x) => x.text.replace(/\s+/g, " "));
      assert.equal(viewLines[1], `${line}, in the same order (flagged ones first).`, `${text}: ${JSON.stringify(viewLines.slice(0, 2))}`);
      assert.ok(!/not in the guide|refused|invalid_command|not_found/i.test(printed), `${text}:\n${printed}`);
      // The chat prints the page the state API gives for that number: its counts, where it starts, and its first document.
      for (const shownLine of viewLines.slice(0, 3)) assert.ok(printed.includes(shownLine), `${text}: the chat did not print "${shownLine}":\n${printed}`);
    }
  } finally { await l?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
