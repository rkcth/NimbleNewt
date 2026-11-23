import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "../lifecycle/index.js";
import { StatusService } from "../status/index.js";
import { CHAT_OPS, LIFECYCLE_OPS, acceptedArgs, describe } from "./commands.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options, type ApiExtra, type World } from "./testing/harness.js";

// Pause, resume and stop by free words (chat-control audit, gap 1). Every message goes through the real chat and the real ModelInterpreter; the model is a stand-in that answers from a table, and a check inside it
// fails the test when it hands over a text the owner did not say (a scope name, a reason), except for the messages marked with `lie`: a model that makes something up is the point of those. The stand-in is
// shown the owner's words, the focus and the open proposals only, never an earlier answer of the chat (checked at the end of each case).

after(stopServer);

/** What the runtime reports for a stop: nothing is running, so a stop is graceful; every call is remembered. */
class Runtime implements StopPorts {
  calls: string[] = [];
  items: InventoryItem[] = [];
  async inventory(): Promise<InventoryItem[]> { this.calls.push("inventory"); return this.items; }
  async cleanup() { this.calls.push("cleanup"); return { remaining: [] }; }
  async checkpoint() { this.calls.push("checkpoint"); return { checkpointId: "cp-1", durable: true, artifactsDurable: true }; }
  async terminate(_s: unknown, o: { force: boolean }) { this.calls.push(o.force ? "terminate-force" : "terminate"); return { ended: true, unresolved: [] }; }
}

const callsOf = (c: { rt: Runtime }): string[] => [...c.rt.calls];
const cmd = (op: string, args: Record<string, unknown>, evidence: string, basis = "owner") => ({ kind: "command", op, args, evidence, basis });
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
type Out = { status: string; code?: string; message?: string; question?: string; options?: string[]; proposalId?: string; preview?: string[] | string; shown?: string[] };
type Turn = { outcomes: Out[]; reply: string[] };

interface Ctx {
  readonly w: World;
  /** The owner says something; what the stand-in understands of it is set with `understands` first. */
  readonly say: (text: string) => Promise<Turn>;
  readonly understands: (text: string, ...intents: unknown[]) => string;
  readonly lie: (text: string) => void;
  readonly rt: Runtime;
  readonly pauses: PauseService;
  readonly chat: ReturnType<World["chat"]>;
  readonly agent: (name: string) => Promise<string>;
  readonly paused: (kind: string, id: string) => Promise<boolean>;
  readonly status: StatusService;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const rt = new Runtime();
      let pauses!: PauseService;
      const extra: ApiExtra = (storage, epoch, built) => {
        pauses = PauseService.withEpoch(storage, epoch, { waits: built.waits }, options);
        return { pauses, stops: StopService.withEpoch(storage, epoch, pauses, rt, options) };
      };
      const w = await openWorld(backend, {}, undefined, extra);
      const prompts: string[] = [];
      const replies: string[] = [];
      const liars = new Set<string>();
      const table = new Map<string, unknown[]>();
      try {
        const status = StatusService.withEpoch(w.world.storage, w.projects.epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, w.projects.epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), contracts: w.contracts, pauses, agents: { list: (by, q) => w.agents.list(by, q) } }, options);
        const stand = {
          complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
            const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)?.[1] ?? "";
            prompts.push(r.user);
            const intents = table.get(text) ?? [{ kind: "none", reason: "not in the table" }];
            // The stand-in never hands over a text the owner did not say (the fixed choices scopeKind and mode excepted).
            if (!liars.has(text)) for (const i of intents as { args?: Record<string, unknown>; request?: Record<string, unknown> }[]) for (const [k, v] of Object.entries({ ...(i.args ?? {}), ...(i.request ?? {}) })) if (typeof v === "string" && !["scopeKind", "mode", "kind"].includes(k)) assert.ok(text.toLowerCase().includes(v.toLowerCase()), `the stand-in made up ${k}=${v} for: ${text}`);
            return JSON.stringify(intents);
          },
        };
        const chat = w.chat({ interpreter: new ModelInterpreter(stand, () => ["stand-in/model"]), status });
        let n = 0;
        const say = async (text: string): Promise<Turn> => {
          const r = await chat.submit(w.ownerToken, { messageId: `lw-${n++}`, text }) as unknown as Turn;
          replies.push(...r.reply, ...r.outcomes.flatMap((o) => [o.message ?? "", o.question ?? ""]));
          return r;
        };
        const agent = async (name: string): Promise<string> => (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name })).id;
        const paused = async (kind: string, id: string): Promise<boolean> => (await pauses.gate(w.owner, { kind, id } as never))?.intent === "pause";
        await body({ w, say, understands: (text, ...intents) => { table.set(text, intents); return text; }, lie: (t) => liars.add(t), rt, pauses, chat, agent, paused, status });
        // The interpreter was shown the owner's words and the open proposals, never what the chat answered earlier.
        for (const reply of replies.filter((r) => r.length > 25)) for (const p of prompts) assert.ok(!p.includes(reply), `an earlier answer reached the interpreter: ${reply}`);
      } finally { await w.close(); }
    });

  const owned = (c: Ctx, op: string, args: Record<string, unknown>, text: string) => c.understands(text, cmd(op, args, text));

  suite("a pause of one agent named in free words applies at once, with a reason of the chat's own when the owner gave none, and touches nobody else", async (c) => {
    const ann = await c.agent("Ann");
    const bob = await c.agent("Bob");
    const text = owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "hold Ann for a moment, I want to look at her work");
    const o = (await c.say(text)).outcomes[0]!;
    assert.equal(o.status, "applied", JSON.stringify(o));
    assert.equal(await c.paused("agent", ann), true);
    assert.equal(await c.paused("agent", bob), false, "nobody else is paused");
    assert.equal(await c.paused("installation", "installation"), false);
    const gate = (await c.pauses.gate(c.w.owner, { kind: "agent", id: ann }))!;
    assert.equal(gate.reason, "requested by the owner in chat", "a reason the owner did not give is not made up as theirs");
    assert.equal(gate.background, "permit", "the chat never denies background work by itself");
    assert.deepEqual(callsOf(c), [], "a pause stops nothing that is running");
    // A reason the owner did say is recorded as they said it.
    const withReason = owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Bob", reason: "checking the invoice" }, "pause Bob, I am checking the invoice");
    assert.equal((await c.say(withReason)).outcomes[0]!.status, "applied");
    assert.equal((await c.pauses.gate(c.w.owner, { kind: "agent", id: bob }))!.reason, "checking the invoice");
  });

  suite("the agent is found by its name in any case, a team by its name, a task by its title in the project in focus, and the plain name of a retired agent names nothing", async (c) => {
    const ann = await c.agent("Ann");
    const old = await c.w.agents.create(c.w.owner, { commandId: cid("ag"), friendlyName: "Carl" });
    await c.w.agents.retire(c.w.owner, { commandId: cid("rt"), agentId: old.id, expectedRevision: old.revision });
    const team = (await c.w.agents.createTeam(c.w.owner, { commandId: cid("tm"), name: "Garden" })).id;
    const p = await c.w.project("Yard");
    const t = await c.w.task(p, "Water beans");
    assert.equal((await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "ANN" }, "freeze ANN please"))).outcomes[0]!.status, "applied");
    assert.equal(await c.paused("agent", ann), true);
    assert.equal((await c.say(owned(c, "lifecycle.pause", { scopeKind: "team", scopeName: "garden" }, "pause the garden team"))).outcomes[0]!.status, "applied");
    assert.equal(await c.paused("team", team), true);
    // A task needs the project it is in.
    const noFocus = (await c.say(owned(c, "lifecycle.pause", { scopeKind: "task", scopeName: "Water beans" }, "pause the Water beans task"))).outcomes[0]!;
    assert.equal(noFocus.status, "asked", JSON.stringify(noFocus));
    await c.chat.setFocus(c.w.ownerToken, { commandId: cid("f"), projectId: p });
    assert.equal((await c.say("pause the Water beans task")).outcomes[0]!.status, "applied");
    assert.equal(await c.paused("task", t), true);
    const gone = (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Carl" }, "pause Carl"))).outcomes[0]!;
    assert.deepEqual([gone.status, gone.code], ["refused", "not_found"], "a retired agent is not an agent to pause");
    assert.equal(await c.paused("agent", old.id), false);
  });

  suite("a pause of everything is shown first and needs the owner's own word for everything; it holds every agent only after the yes", async (c) => {
    await c.agent("Ann");
    const text = owned(c, "lifecycle.pause", { scopeKind: "installation", scopeName: "everything" }, "pause everything");
    const o = (await c.say(text)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal(await c.paused("installation", "installation"), false, "nothing is paused before the yes");
    assert.match(JSON.stringify(o), /whole installation/);
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.equal(await c.paused("installation", "installation"), true);
  });

  suite("resume is shown first and lifts only the scope named; the pause above or beside it is untouched", async (c) => {
    const ann = await c.agent("Ann");
    const bob = await c.agent("Bob");
    await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "pause Ann"));
    await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Bob" }, "pause Bob"));
    const o = (await c.say(owned(c, "lifecycle.resume", { scopeKind: "agent", scopeName: "Ann" }, "let Ann carry on"))).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal(await c.paused("agent", ann), true, "still paused before the yes");
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.equal(await c.paused("agent", ann), false);
    assert.equal(await c.paused("agent", bob), true, "Bob stays paused");
  });

  suite("a stop is always shown first with what it does, ends nothing before the yes, keeps the assignment, and the owner's yes runs it", async (c) => {
    const ann = await c.agent("Ann");
    const p = await c.w.project("Yard");
    const t = await c.w.task(p, "Water beans");
    await c.w.projects.transitionTask({ commandId: cid("r"), actor: "owner:rob", taskId: t, expectedRevision: 1, to: "ready" });
    await c.w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: t, owner: { kind: "agent", id: ann } });
    const before = JSON.stringify(await c.w.assignments.getAssignment(t));
    const o = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "agent", scopeName: "Ann" }, "stop Ann, she is on the wrong track"))).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal(await c.paused("agent", ann), false, "a stop paused nothing before the yes");
    assert.deepEqual(callsOf(c), [], "and ended nothing");
    const shown = JSON.stringify(o);
    assert.match(shown, /Ann/);
    assert.match(shown, /full stop|What a stop does/);
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.equal(await c.paused("agent", ann), true);
    assert.ok(callsOf(c).includes("terminate"), `the work was ended: ${callsOf(c).join(",")}`);
    assert.equal(JSON.stringify(await c.w.assignments.getAssignment(t)), before, "the assignment is untouched");
    assert.equal((await c.w.api.handle(c.w.ownerToken, { v: API_VERSION, op: "task.get", args: { taskId: t } } as never) as any).result.item.state, "ready", "the task is not cancelled");
  });

  suite("a suspend is a stop that checkpoints and ends nothing; a mode other than stop or suspend is refused", async (c) => {
    const ann = await c.agent("Ann");
    const o = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "agent", scopeName: "Ann", mode: "suspend" }, "suspend Ann at a safe point"))).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.match(JSON.stringify(o), /What a suspend does/);
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.ok(callsOf(c).includes("checkpoint") && !callsOf(c).includes("terminate"), callsOf(c).join(","));
    assert.equal(await c.paused("agent", ann), true);
    const odd = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "agent", scopeName: "Ann", mode: "force-stop" }, "stop Ann hard"))).outcomes[0]!;
    assert.deepEqual([odd.status, odd.code], ["refused", "invalid_command"]);
  });

  suite("a stop of everything needs the owner's own word for everything, is shown first, and a bare stop does nothing at all", async (c) => {
    const ann = await c.agent("Ann");
    // The model understood a bare "stop" as no scope, as the whole installation named "stop", or as the whole installation named by a word the owner never said.
    const bare = c.understands("stop", cmd("lifecycle.stop", {}, "stop"));
    const asBare = (await c.say(bare)).outcomes[0]!;
    assert.notEqual(asBare.status, "applied", JSON.stringify(asBare));
    const bare2 = c.understands("stop please", cmd("lifecycle.stop", {}, "stop please"));
    const asBare2 = (await c.say(bare2)).outcomes[0]!;
    assert.equal(asBare2.status, "asked", JSON.stringify(asBare2));
    assert.match(asBare2.question ?? "", /Nothing was done/);
    const guessed = c.understands("stop now", cmd("lifecycle.stop", { scopeKind: "installation", scopeName: "stop" }, "stop now"));
    const asGuessed = (await c.say(guessed)).outcomes[0]!;
    assert.equal(asGuessed.status, "asked", `the order word is not a scope: ${JSON.stringify(asGuessed)}`);
    const madeUp = c.understands("please stop", cmd("lifecycle.stop", { scopeKind: "installation", scopeName: "everything" }, "please stop"));
    c.lie(madeUp);
    const asMadeUp = (await c.say(madeUp)).outcomes[0]!;
    assert.deepEqual([asMadeUp.status, asMadeUp.code], ["refused", "unsupported_value"], "a word the owner did not say is not theirs");
    assert.equal(await c.paused("installation", "installation"), false);
    assert.equal(await c.paused("agent", ann), false);
    assert.deepEqual(callsOf(c), []);
    // Everything, said by the owner: shown first, run on the yes.
    const all = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "installation", scopeName: "everything" }, "stop everything"))).outcomes[0]!;
    assert.equal(all.status, "proposed", JSON.stringify(all));
    assert.match(JSON.stringify(all), /whole installation/);
    assert.equal(await c.paused("installation", "installation"), false);
    assert.equal((await c.chat.applyProposal(c.w.ownerToken, { commandId: cid("ap"), proposalId: all.proposalId! })).applied, true);
    assert.equal(await c.paused("installation", "installation"), true);
  });

  suite("a scope that is not said asks which, an unknown kind asks, two agents of one name ask, an agent and a team of one name ask, and a name nobody has is refused; nothing is paused or stopped by any of them", async (c) => {
    await c.agent("Ann");
    await c.agent("Ann");
    const team = (await c.w.agents.createTeam(c.w.owner, { commandId: cid("tm"), name: "Garden" })).id;
    await c.agent("Garden");
    const outcomes = [
      (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent" }, "pause an agent"))).outcomes[0]!,
      (await c.say(owned(c, "lifecycle.pause", { scopeKind: "planet", scopeName: "Mars" }, "pause Mars"))).outcomes[0]!,
      (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "pause Ann"))).outcomes[0]!,
      (await c.say(owned(c, "lifecycle.stop", { scopeName: "Garden" }, "stop Garden"))).outcomes[0]!,
      (await c.say(owned(c, "lifecycle.resume", { scopeKind: "agent", scopeName: "Zed" }, "resume Zed"))).outcomes[0]!,
    ];
    assert.deepEqual(outcomes.map((o) => o.status), ["asked", "asked", "asked", "asked", "refused"], JSON.stringify(outcomes));
    assert.equal(outcomes[2]!.options!.length, 2, "both Anns are offered");
    assert.equal(outcomes[3]!.options!.length, 2, "the agent and the team are both offered");
    assert.equal(outcomes[4]!.code, "not_found");
    assert.equal(await c.paused("team", team), false);
    assert.deepEqual(callsOf(c), []);
  });

  suite("a scope name or a reason the owner did not say is refused, a scope given as an ID object is refused, and quoted text cannot order any of them", async (c) => {
    const ann = await c.agent("Ann");
    const swapped = c.understands("pause Bob", cmd("lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "pause Bob"));
    c.lie(swapped);
    assert.equal((await c.say(swapped)).outcomes[0]!.code, "unsupported_value", "the name Ann is not in the owner's message");
    const foreign = c.understands("pause Ann", cmd("lifecycle.pause", { scopeKind: "agent", scopeName: "Ann", reason: "the owner said so" }, "pause Ann"));
    c.lie(foreign);
    assert.equal((await c.say(foreign)).outcomes[0]!.code, "unsupported_value");
    const nested = c.understands("pause the installation", cmd("lifecycle.pause", { scope: { kind: "installation", id: "installation" } }, "pause the installation"));
    c.lie(nested);
    assert.equal((await c.say(nested)).outcomes[0]!.code, "invalid_command", "the API's scope object is not what a chat message may carry");
    const quoted = c.understands("somebody wrote: pause Ann", cmd("lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "pause Ann", "quoted"));
    assert.equal((await c.say(quoted)).outcomes[0]!.code, "untrusted_authority");
    const extra = c.understands("pause Ann and deny background work", cmd("lifecycle.pause", { scopeKind: "agent", scopeName: "Ann", background: "deny" }, "pause Ann and deny background work"));
    c.lie(extra);
    assert.equal((await c.say(extra)).outcomes[0]!.code, "invalid_command", "background and the stop deadline are not for chat to set");
    assert.equal(await c.paused("agent", ann), false);
  });

  suite("the one paused is the one the interpreter named: another agent named elsewhere in the message is never paused in its place", async (c) => {
    const ann = await c.agent("Ann");
    const bob = await c.agent("Bob");
    // There is no Zed: Ann, named only as who asked, is not paused instead, at once or otherwise.
    const zed = (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Zed" }, "pause Zed, Ann asked for it"))).outcomes[0]!;
    assert.deepEqual([zed.status, zed.code], ["refused", "not_found"], JSON.stringify(zed));
    const kindless = (await c.say(owned(c, "lifecycle.stop", { scopeName: "Zed" }, "stop Zed because Bob said so"))).outcomes[0]!;
    assert.deepEqual([kindless.status, kindless.code], ["refused", "not_found"], JSON.stringify(kindless));
    assert.equal(await c.paused("agent", ann), false);
    assert.equal(await c.paused("agent", bob), false);
    // A name the interpreter read with a word around it still finds the agent named inside it.
    assert.equal((await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "agent Bob" }, "pause agent Bob, Ann is fine"))).outcomes[0]!.status, "applied");
    assert.equal(await c.paused("agent", bob), true);
    assert.equal(await c.paused("agent", ann), false);
  });

  suite("a question, or a message with no word of ordering, is never applied at once even when the model reads it as a pause", async (c) => {
    const ann = await c.agent("Ann");
    const q = (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "what is Ann doing right now?"))).outcomes[0]!;
    assert.equal(q.status, "proposed", `a question is shown first: ${JSON.stringify(q)}`);
    const idle = (await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "Ann is a good agent"))).outcomes[0]!;
    assert.equal(idle.status, "proposed", JSON.stringify(idle));
    assert.equal(await c.paused("agent", ann), false);
  });

  suite("with two proposals open a bare yes does not choose between a stop and a resume; naming one does", async (c) => {
    const ann = await c.agent("Ann");
    const bob = await c.agent("Bob");
    const one = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "agent", scopeName: "Ann" }, "stop Ann"))).outcomes[0]!;
    const two = (await c.say(owned(c, "lifecycle.stop", { scopeKind: "agent", scopeName: "Bob" }, "stop Bob"))).outcomes[0]!;
    assert.deepEqual([one.status, two.status], ["proposed", "proposed"]);
    const yes = c.understands("yes", { kind: "apply_proposal", proposalId: one.proposalId, evidence: "yes", basis: "owner" });
    const answer = (await c.say(yes)).outcomes[0]!;
    assert.equal(answer.status, "asked", `a bare yes with two open asks which: ${JSON.stringify(answer)}`);
    assert.equal(await c.paused("agent", ann), false);
    assert.equal(await c.paused("agent", bob), false);
  });

  suite("a message from anyone but the owner cannot pause, resume or stop, by chat or by the API", async (c) => {
    const ann = await c.agent("Ann");
    const intruder = await c.w.agent("intruder", [{ action: "task.read", project: "*" }]);
    const text = owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann" }, "pause Ann");
    const typed = await c.w.chat().submit(intruder.token, { messageId: cid("x"), text }).then((r) => JSON.stringify(r), (e: unknown) => String(e));
    assert.ok(!/"status":"applied"/.test(typed), typed);
    assert.equal(await c.paused("agent", ann), false);
    for (const [op, args] of [["lifecycle.pause", { scope: { kind: "agent", id: ann }, reason: "x" }], ["lifecycle.stop", { scope: { kind: "agent", id: ann }, mode: "stop", reason: "x" }], ["lifecycle.resume", { scope: { kind: "agent", id: ann }, reason: "x" }]] as const) {
      const r = await c.w.api.handle(intruder.token, { v: API_VERSION, op, commandId: cid("c"), args } as never) as any;
      assert.equal(r.ok, false, `${op} by a non-owner: ${JSON.stringify(r)}`);
    }
    assert.equal(await c.paused("agent", ann), false);
    assert.deepEqual(callsOf(c), []);
    // The read of what is paused is the owner's too: an agent with other rights is told nothing about the gates.
    await c.pauses.pause(c.w.owner, { commandId: cid("pz"), scope: { kind: "agent", id: ann }, reason: "secret reason" });
    // Review: asked of the status view itself (this world's API has no status view), an agent is not told "not paused" about a scope that is paused either; the view is missing for it,
    // even for an agent with the right to read agents, which may read the gates themselves.
    const reader = await c.w.agent("reader", [{ action: "agent.read", project: "*" }]);
    for (const who of [intruder.principal, reader.principal]) {
      for (const request of [{ kind: "lifecycle" }, { kind: "lifecycle", scopeKind: "agent", scopeId: ann }, { kind: "lifecycle", scopeKind: "installation", scopeId: "installation" }] as const) {
        const seen = await c.status.ask(who, request as never);
        assert.equal(seen, undefined, `${who.id}: ${JSON.stringify(seen)}`);
      }
    }
    assert.match((await c.status.ask(c.w.owner, { kind: "lifecycle", scopeKind: "agent", scopeId: ann } as never))!.lines.map((l) => l.text).join("\n"), /is paused.*reason "secret reason"/, "the owner reads it");
  });

  suite("what is paused is answered in free words for the installation and every agent, for one agent by name, and for the whole installation", async (c) => {
    const ann = await c.agent("Ann");
    await c.agent("Bob");
    await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Ann", reason: "checking" }, "pause Ann, checking"));
    const all = await c.say(c.understands("what is paused?", ask({ kind: "lifecycle" }, "what is paused?")));
    assert.equal(all.outcomes[0]!.status, "answered", JSON.stringify(all.outcomes));
    const text = all.reply.join("\n");
    assert.match(text, /The whole installation is not paused/);
    assert.match(text, /"Ann".*is paused.*reason "checking"/s);
    assert.ok(!/"Bob"/.test(text), "an agent that is not paused is not listed");
    assert.match(text, /2 active agents checked; 1 scope is paused/);
    const one = await c.say(c.understands("is Ann paused?", ask({ kind: "lifecycle", scopeKind: "agent", scopeName: "Ann" }, "is Ann paused?")));
    assert.match(one.reply.join("\n"), new RegExp(`Agent ${ann}.* is paused`));
    const bob = await c.say(c.understands("is Bob paused?", ask({ kind: "lifecycle", scopeKind: "agent", scopeName: "Bob" }, "is Bob paused?")));
    assert.match(bob.reply.join("\n"), /is not paused/);
    const whole = await c.say(c.understands("is everything paused?", ask({ kind: "lifecycle", scopeKind: "installation" }, "is everything paused?")));
    assert.match(whole.reply.join("\n"), /The whole installation is not paused/);
    await c.say(owned(c, "lifecycle.pause", { scopeKind: "agent", scopeName: "Bob" }, "pause Bob"));
    const none = await c.say(c.understands("is Zed paused?", ask({ kind: "lifecycle", scopeKind: "agent", scopeName: "Zed" }, "is Zed paused?")));
    assert.equal(none.outcomes[0]!.status, "refused", "a name nobody has is not read as not paused");
  });

  suite("the tables: the three operations are chat commands that take a flat scope, the interpreter prompt names them and the status kind", async (c) => {
    void c;
    for (const op of LIFECYCLE_OPS) {
      assert.ok(CHAT_OPS[op] !== undefined, op);
      const accepted = acceptedArgs(op)!;
      assert.ok(accepted.includes("scopeKind") && accepted.includes("scopeName") && !accepted.includes("scope"), `${op}: ${accepted.join(",")}`);
      assert.ok(!accepted.includes("deadlineMs") && !accepted.includes("spendBudget") && !accepted.includes("background") && !accepted.includes("taskTitle"), `${op}: ${accepted.join(",")}`);
    }
    assert.deepEqual([CHAT_OPS["lifecycle.pause"]!.mode, CHAT_OPS["lifecycle.resume"]!.mode, CHAT_OPS["lifecycle.stop"]!.mode], ["apply", "propose", "propose"]);
    assert.equal(describe("lifecycle.stop", { scope: { kind: "agent", id: "agt-x" }, mode: "stop", reason: "r" }, { "agt-x": "Ann" }), 'Stop (mode stop or suspend): scope=agent "Ann", mode=stop, reason=r');
    let system = "";
    await new ModelInterpreter({ complete: async (_r, r) => { system = r.system; return "[]"; } }, () => ["a/b"]).interpret({ text: "hi", quoted: [], focus: {}, proposals: [] });
    for (const want of ["lifecycle.pause(reason, scopeKind, scopeName)", "lifecycle.resume(reason, scopeKind, scopeName)", "lifecycle.stop(mode, reason, scopeKind, scopeName)", "To pause, resume or stop work", "status kind lifecycle", "lifecycle(taskId|taskTitle, scopeKind, scopeId|scopeName)"]) assert.ok(system.includes(want), want);
    assert.ok(!system.includes("those use the stop and pause controls"));
  });
}
