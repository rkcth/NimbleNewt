import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CHAT_OPS, LIFECYCLE_OPS, TITLE_KEYS, acceptedArgs } from "./commands.js";
import { ModelInterpreter, type ModelCall } from "./model-interpreter.js";
import { cid, openWorld } from "./testing/harness.js";

// Room in the interpreter prompt (card "prompt headroom"). The operation list used to repeat ", taskTitle, prerequisiteTitle" on every line although only the operations that take a task ID or a prerequisite ID
// can use them; now the title shows only beside the ID it stands in for (`taskId|taskTitle`, the notation the status list already uses), and one sentence in the hand-written part says how to give it.
// The chat still accepts the keys exactly as before (`acceptedArgs` is unchanged).
// The prompt size is pinned below so that growth is a decision, not an accident: the older test in gaps1.test.ts only caps it at 160,000.

after(stopServer);

const promptText = async (): Promise<string> => {
  let system = "";
  await new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]).interpret({ text: "hello there", quoted: [], focus: {}, proposals: [] });
  return system;
};
/** The argument names the prompt lists for one operation (the text between the brackets of its line). */
const listed = (system: string, op: string): string[] => {
  const m = new RegExp(`(?:^|; |: )${op.replace(/\./g, "\\.")}\\(([^)]*)\\) - `).exec(system);
  assert.ok(m !== null, `${op} is in the prompt`);
  return m[1]!.split(", ").filter((k) => k !== "");
};

// Pin: the prompt is about this long. The ceiling is 2,000 characters above what is now (a card that adds a control fits); the floor is 4,000 below it, so a large cut that dropped controls is seen too. Moving either is a decision.
const SIZE = 154_560; // chat gaps2 154,137; Q02 leftovers +89; P09 landing checks view +334 (2026-11-23); Q02 stale approvals +197 (155,294 measured, 2026-11-26); C08 task-level override clause in the submissions kind +64 (155,678 measured, 2026-11-26); P03b finish: the "(card X)" references dropped from the status kinds' descriptions (-430), a right on one service resource in the grant sentences, `resource` on grant.create and service operations in the tools kind (+360), 156,461 measured (2026-11-26, 70 below what it was); its review: a "(card P09/P10)" reference dropped too (-15), 156,446 measured
const CEILING = SIZE + 2_000;
const FLOOR = SIZE - 4_000;

test("the prompt size is pinned: not above the ceiling (growth is a decision) and not far below the floor (a cut must not drop controls)", async () => {
  const n = (await promptText()).length;
  assert.ok(n <= CEILING, `the prompt is ${n} characters, above the pinned ceiling ${CEILING}: raise SIZE on purpose (and say what was added) or make room`);
  assert.ok(n >= FLOOR, `the prompt is ${n} characters, below the pinned floor ${FLOOR}: a cut this large must be checked for dropped controls, then SIZE lowered on purpose`);
});

test("a title key shows only beside the ID it stands in for, on exactly the operations that take that ID, and one sentence says how to give it", async () => {
  const system = await promptText();
  assert.match(system, /Where an operation lists taskId\|taskTitle or prerequisiteId\|prerequisiteTitle, give the task or prerequisite as taskTitle or prerequisiteTitle instead, in the owner's own words and with no ID; an operation that lists neither takes no task title\./);
  assert.ok(system.includes("Operations, each as name(args; `a|b` means either): "), "the list says what a|b means, as the status list does");
  let withTask = 0, withPrerequisite = 0;
  for (const op of Object.keys(CHAT_OPS)) {
    const keys = listed(system, op);
    // The chat still accepts both keys everywhere it did; the line shows a title only as `id|title`, where the operation takes that ID, and never the ID or the title alone.
    for (const [title, id] of Object.entries(TITLE_KEYS)) {
      // Pause, resume and stop name their task by scopeKind task with scopeName (they were never chat commands taking a title, and their operations take no taskId), so they take no title key.
      if (LIFECYCLE_OPS.has(op)) assert.ok(!acceptedArgs(op)!.includes(title), `${op} names a task by scopeName, not ${title}`);
      else assert.ok(acceptedArgs(op)!.includes(title), `${op} still accepts ${title}`);
      assert.ok(!keys.includes(title) && !keys.includes(id), `${op} shows neither ${title} nor ${id} on its own`);
      const real = OPERATIONS.find((o) => o.name === op)!;
      if (Object.keys(real.args).some((k) => k.replace(/\?$/, "") === id)) assert.ok(keys.includes(`${id}|${title}`), `${op} lists ${id}|${title}, as its operation takes ${id}`);
      if (keys.includes(`${id}|${title}`)) assert.ok(acceptedArgs(op)!.includes(id), `${op} lists ${id}|${title} only when the chat accepts ${id}`);
      for (const k of keys) if (k !== `${id}|${title}`) assert.ok(!k.split("|").includes(title), `${op}: ${title} is on no other key (${k})`);
    }
    if (keys.includes("taskId|taskTitle")) withTask++;
    if (keys.includes("prerequisiteId|prerequisiteTitle")) withPrerequisite++;
  }
  assert.ok(withTask > 20 && withPrerequisite === 2, `${withTask} operations take a task ID, ${withPrerequisite} a prerequisite ID`);
});

test("the operation lines read as expected, written out by hand (not rebuilt with promptArgs): id|title where the operation takes the ID, no title key elsewhere, no projectName", async () => {
  const system = await promptText();
  for (const line of [
    "; task.transition(taskId|taskTitle, expectedRevision, to) - Move task;",
    "; dependency.add(taskId|taskTitle, prerequisiteId|prerequisiteTitle, responsible) - Add dependency;",
    "; resume.retry(checkId, taskId|taskTitle) - Start the resume check of task over;",
    "; project.update(projectId, expectedRevision, name, goal, state, addRepositories, versionControl) - Change project;",
  ]) assert.ok(system.includes(line), line);
  assert.ok(!/\btaskTitle, prerequisiteTitle\b/.test(system), "the old pair is on no line");
  // The task IDs of a document obligation (implementationRefs, claims) are not taskId: a title never resolved into them, and the line does not invite one.
  assert.ok(!listed(system, "doc.obligation.record").some((k) => /taskId|taskTitle|prerequisite/.test(k)));
});

for (const backend of backends) {
  // The stand-in model sees only the prompt and the owner's words. It uses a title key only when the operation's line shows it beside the ID (`taskId|taskTitle`) and the prompt has the rule about titles; otherwise it hands over nothing.
  const model = (violations: string[]): ModelCall => ({
    complete: async (_route, r) => {
      const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
      const rule = /give the task or prerequisite as taskTitle or prerequisiteTitle instead/.test(r.system);
      const intent = (op: string, args: Record<string, unknown>) => ({ kind: "command", op, args, evidence: owner, basis: "owner" });
      const take = (op: string, keys: string[]): Record<string, string> | undefined => {
        const m = new RegExp(`(?:^|; )${op.replace(/\./g, "\\.")}\\(([^)]*)\\) - `).exec(r.system);
        if (m === null || !rule || !keys.every((k) => m[1]!.split(", ").includes(k))) return undefined;
        return {};
      };
      let intents: unknown[] = [];
      if (owner === "Water beans is ready") { const t = take("task.transition", ["taskId|taskTitle"]); if (t !== undefined) intents = [intent("task.transition", { taskTitle: "Water beans", to: "ready" })]; }
      if (owner === "Dig the bed only after Buy seeds is done") { const t = take("dependency.add", ["taskId|taskTitle", "prerequisiteId|prerequisiteTitle"]); if (t !== undefined) intents = [intent("dependency.add", { taskTitle: "Dig the bed", prerequisiteTitle: "Buy seeds" })]; }
      if (owner === "Plant the pea shoots is ready") intents = [intent("task.transition", { taskTitle: "Water beans", to: "ready" })];
      if (owner === "rename the garden project") intents = [intent("project.update", { taskTitle: "Water beans", name: "Yard" })];
      if (owner === "rename the Garden project to Yard, as in Water beans") intents = [intent("project.update", { projectName: "Garden", taskTitle: "Water beans", name: "Yard" })];
      for (const it of intents as { args: Record<string, unknown> }[]) for (const v of Object.values(it.args)) if (typeof v === "string" && !owner.toLowerCase().includes(v.toLowerCase())) violations.push(`${v} is not in "${owner}"`);
      return JSON.stringify(intents.length === 0 ? [{ kind: "none", reason: "the prompt describes no way to do this" }] : intents);
    },
  });
  const open = async () => {
    const violations: string[] = [];
    const w = await openWorld(backend);
    const chat = w.chat({ interpreter: new ModelInterpreter(model(violations), () => ["test/model"]) });
    const say = (text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const project = await w.project("Garden");
    const beans = await w.task(project, "Water beans");
    const bed = await w.task(project, "Dig the bed");
    const seeds = await w.task(project, "Buy seeds");
    const state = async (taskId: string) => ((await w.api.handle(w.ownerToken, { v: 1, op: "task.get", args: { taskId } } as never)) as unknown as { result: { item: { state: string } } }).result.item.state;
    return { w, say, project, beans, bed, seeds, state, violations };
  };

  test(`${backend.name}: a task and a prerequisite named by their titles are still found through the real chat and ModelInterpreter, from the key on the operation's line and the title rule of the prompt`, async () => {
    const { w, say, beans, bed, seeds, state, violations } = await open();
    try {
      const a = (await say("Water beans is ready")).outcomes[0]!;
      assert.equal(a.status, "applied", JSON.stringify(a));
      assert.equal(await state(beans), "ready");
      const b = (await say("Dig the bed only after Buy seeds is done")).outcomes[0]!;
      assert.equal(b.status, "applied", JSON.stringify(b));
      const deps = (await w.api.handle(w.ownerToken, { v: 1, op: "dependency.list", args: { taskId: bed } } as never)) as unknown as { ok: boolean; result: unknown };
      assert.ok(JSON.stringify(deps.result).includes(seeds), "the dependency on the named prerequisite exists");
      assert.deepEqual(violations, [], "the stand-in handed over only the owner's words");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the title keys are refused as before when the title is not the owner's, and on an operation that takes no task`, async () => {
    const { w, say, project, beans, state, violations } = await open();
    try {
      const before = await state(beans);
      const a = (await say("Plant the pea shoots is ready")).outcomes[0]!;
      assert.notEqual(a.status, "applied", "a task title the owner did not say is refused");
      assert.equal(await state(beans), before, "nothing changed");
      const b = (await say("rename the garden project")).outcomes[0]!;
      assert.notEqual(b.status, "applied", "a task title on an operation that takes no task is not carried out");
      assert.equal(await state(beans), before);
      assert.ok(violations.length >= 1, "the stand-in's invented title was seen by the guard of this test");
      // Every value in the owner's words, so only the operation decides: project.update takes no task, and the title is not carried out.
      const seen = violations.length;
      const c = (await say("rename the Garden project to Yard, as in Water beans")).outcomes[0]!;
      assert.equal(violations.length, seen, "every value was the owner's");
      assert.equal(c.status, "refused", JSON.stringify(c));
      assert.match((c as { message?: string }).message ?? "", /^taskId: is not a field of this command$/, "refused because the operation has no task argument");
      const p = (await w.api.handle(w.ownerToken, { v: 1, op: "project.get", args: { projectId: project } } as never)) as unknown as { result: { item: { name: string } } };
      assert.equal(p.result.item.name, "Garden", "the project keeps its name");
    } finally { await w.close(); }
  });
}
