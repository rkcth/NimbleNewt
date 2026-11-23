import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CHAT_OPS, TITLE_KEYS, acceptedArgs } from "./commands.js";
import { ModelInterpreter, type ModelCall } from "./model-interpreter.js";
import { cid, openWorld } from "./testing/harness.js";

// Room in the interpreter prompt (card "prompt headroom"). The operation list used to repeat ", taskTitle, prerequisiteTitle" on every line although only the operations that take a task ID or a prerequisite ID
// can use them; now one sentence in the hand-written part says so and the lines show the keys of their own record. The chat still accepts the keys exactly as before (`acceptedArgs` is unchanged).
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
const SIZE = 150_868;
const CEILING = SIZE + 2_000;
const FLOOR = SIZE - 4_000;

test("the prompt size is pinned: not above the ceiling (growth is a decision) and not far below the floor (a cut must not drop controls)", async () => {
  const n = (await promptText()).length;
  assert.ok(n <= CEILING, `the prompt is ${n} characters, above the pinned ceiling ${CEILING}: raise SIZE on purpose (and say what was added) or make room`);
  assert.ok(n >= FLOOR, `the prompt is ${n} characters, below the pinned floor ${FLOOR}: a cut this large must be checked for dropped controls, then SIZE lowered on purpose`);
});

test("the title keys are one sentence, not on every line, and only the operations that take that ID can use them", async () => {
  const system = await promptText();
  assert.match(system, /Where an argument takes a task ID \(taskId\) or a prerequisite ID \(prerequisiteId\), give the task or prerequisite as taskTitle or prerequisiteTitle instead, in the owner's own words and with no ID/);
  let withTask = 0, withPrerequisite = 0;
  for (const op of Object.keys(CHAT_OPS)) {
    const keys = listed(system, op);
    for (const key of Object.keys(TITLE_KEYS)) assert.ok(!keys.includes(key), `${op} does not repeat ${key}`);
    // The chat still accepts both keys everywhere it did; the line shows the ID argument that they stand in for, where the operation has one.
    for (const [title, id] of Object.entries(TITLE_KEYS)) {
      assert.ok(acceptedArgs(op)!.includes(title), `${op} still accepts ${title}`);
      const real = OPERATIONS.find((o) => o.name === op)!;
      if (id in real.args) assert.ok(keys.includes(id), `${op} lists ${id}, which its operation takes`);
      if (keys.includes(id)) assert.ok(acceptedArgs(op)!.includes(id), `${op} lists ${id} only when the chat accepts it`);
    }
    if (keys.includes("taskId")) withTask++;
    if (keys.includes("prerequisiteId")) withPrerequisite++;
  }
  assert.ok(withTask > 20 && withPrerequisite === 2, `${withTask} operations take a task ID, ${withPrerequisite} a prerequisite ID`);
});

for (const backend of backends) {
  // The stand-in model sees only the prompt and the owner's words. It looks in the prompt for the operation line and for the rule about titles; with no rule it hands over nothing.
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
      if (owner === "Water beans is ready") { const t = take("task.transition", ["taskId"]); if (t !== undefined) intents = [intent("task.transition", { taskTitle: "Water beans", to: "ready" })]; }
      if (owner === "Dig the bed only after Buy seeds is done") { const t = take("dependency.add", ["taskId", "prerequisiteId"]); if (t !== undefined) intents = [intent("dependency.add", { taskTitle: "Dig the bed", prerequisiteTitle: "Buy seeds" })]; }
      if (owner === "Plant the pea shoots is ready") intents = [intent("task.transition", { taskTitle: "Water beans", to: "ready" })];
      if (owner === "rename the garden project") intents = [intent("project.update", { taskTitle: "Water beans", name: "Yard" })];
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

  test(`${backend.name}: a task and a prerequisite named by their titles are still found through the real chat and ModelInterpreter, with the title rule from one sentence of the prompt`, async () => {
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
    const { w, say, beans, state, violations } = await open();
    try {
      const before = await state(beans);
      const a = (await say("Plant the pea shoots is ready")).outcomes[0]!;
      assert.notEqual(a.status, "applied", "a task title the owner did not say is refused");
      assert.equal(await state(beans), before, "nothing changed");
      const b = (await say("rename the garden project")).outcomes[0]!;
      assert.notEqual(b.status, "applied", "a task title on an operation that takes no task is not carried out");
      assert.equal(await state(beans), before);
      assert.ok(violations.length >= 1, "the stand-in's invented title was seen by the guard of this test");
    } finally { await w.close(); }
  });
}
