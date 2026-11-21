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
    const going = async (): Promise<{ id: string } | undefined> => { const r = await call(live, "handoff.for-task", { taskId }); return r.ok ? r.result.item : (assert.equal(r.error.code, "not_found", JSON.stringify(r)), undefined); };

    const chat = live.controller.chat!;
    const wrapped = { api: live.controller.api, chat: { submit: async (...a: Parameters<typeof chat.submit>) => { const t = await chat.submit(...a); turns.push(t as unknown as Turn); return t; } } };
    const say = async (step: { you: string; replies: string[] }): Promise<Turn["outcomes"]> => {
      const out: string[] = [];
      const before = turns.length;
      await runTerminalChat({ controller: wrapped as never, ownerToken: live.ownerToken, input: lines([step.you]), write: (t) => out.push(t) });
      const reply = out.join("");
      assert.equal(turns.length, before + 1, `"${step.you}" made one turn: ${reply}`);
      const outcomes = turns.at(-1)!.outcomes;
      assert.ok(!outcomes.some((o) => o.status === "refused"), `"${step.you}" was refused: ${reply}`);
      for (const quote of step.replies) assert.ok(quotedIn(quote, reply), `the guide quotes "${quote}" for "${step.you}", but the chat printed:\n${reply}`);
      if (/^yes\b/.test(step.you)) assert.ok(outcomes.length > 0 && outcomes.every((o) => o.status === "applied"), `"${step.you}" applied what was shown: ${reply}`);
      return outcomes;
    };
    const kinds = (o: Turn["outcomes"]) => o.map((x) => [x.status, x.op ?? null]);

    let prepared: string | undefined;
    for (const step of steps) {
      const outcomes = await say(step);
      // What the guide says about each step: asking for the hand-off moves nothing yet, the package lacks what the example task has not got, and finishing with gaps is shown first.
      if (step.you.startsWith("Hand Add a greeting")) {
        assert.deepEqual(kinds(outcomes), [["applied", "handoff.prepare"]]);
        assert.deepEqual(await holder(), { kind: "agent", id: ann }, "preparing the hand-off moves nothing");
        prepared = (await going())?.id;
        assert.ok(prepared !== undefined, "a hand-off is going on for the task");
      }
      if (step.you.startsWith("Finish handing over")) {
        assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "handing over with gaps is shown first");
        assert.deepEqual(await holder(), { kind: "agent", id: ann }, "nothing moved before the yes");
      }
    }
    // Where the guide says the first conversation ends: the task is Bob's, still ready, the move is in the task's record, and the hand-off is recorded with the gaps the owner accepted.
    const bob = ((await call(live, "agent.list")).result.items as { id: string; friendlyName: string }[]).find((a) => a.friendlyName === "Bob")!;
    assert.deepEqual(await holder(), { kind: "agent", id: bob.id });
    assert.equal((await call(live, "task.get", { taskId })).result.item.state, "ready");
    assert.equal(await going(), undefined, "no hand-off is still going on for the task");
    const done = (await call(live, "handoff.get", { handoffId: prepared })).result.item;
    assert.equal(done.phase, "transferred");
    assert.equal(done.reason, "Ann is away this week");
    assert.deepEqual(done.acceptedGaps.missing, ["acceptanceCriteria", "unfinishedWork", "nextAction"], "the gaps the guide quotes are the ones accepted");
    const moved = async (to: string): Promise<boolean> => ((await call(live, "activity.steps", { taskId })).result.steps as { kind: string; summary: string }[]).some((x) => x.kind === "ownership" && x.summary.includes(to));
    assert.ok(await moved(bob.id), "the move is in the task's record");

    // The further lines: a hand-off back to Ann is prepared and cancelled (the task stays Bob's), a cover until Friday is shown first with its time and dropped, and a takeover by force is shown first and moves the task.
    for (const step of moreSteps) {
      const outcomes = await say(step);
      if (step.you.startsWith("Hand Add a greeting")) { assert.deepEqual(kinds(outcomes), [["applied", "handoff.prepare"]]); assert.ok((await going()) !== undefined); }
      if (step.you.startsWith("Cancel")) { assert.deepEqual(kinds(outcomes), [["applied", "handoff.cancel"]]); assert.equal(await going(), undefined, "the cancelled hand-off is over"); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }, "cancelling moves nothing"); }
      if (step.you.startsWith("Let Ann cover")) { assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "a time to give the task back is shown first"); assert.equal(await going(), undefined, "nothing is prepared before the yes"); }
      if (step.you.startsWith("no,")) { assert.deepEqual(outcomes.map((o) => o.status), ["discarded"]); assert.equal(await going(), undefined); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }); }
      if (step.you.startsWith("Take Add a greeting")) { assert.deepEqual(outcomes.map((o) => o.status), ["proposed"], "a takeover by force is shown first"); assert.deepEqual(await holder(), { kind: "agent", id: bob.id }); }
    }
    assert.deepEqual(await holder(), { kind: "agent", id: ann }, "the takeover gave the task to Ann");
    assert.ok(await moved(ann), "and is in the task's record");
    assert.deepEqual(asked, [...steps, ...moreSteps].map((s) => s.you), "every line went to the model once, and nothing else did");
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
