import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("through the running controller and the real model interpreter, a one-word reply answers only a question the chat asked and only with exactly one recorded answer, and an agreement that names no proposal asks which when several are open", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-answers-"));
  // The stand-in for the model reads only what the prompt shows it. It copies the owner's words as evidence, as the real one is told to, but it is also careless the way a faulty model can be: for a reply that is not
  // one of the choices it still names the first choice, and for an agreement among several open proposals it names the first one. The chat must not be moved by either.
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const pending = /Pending question (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/.exec(r.user);
    if (pending !== null) {
      const choices = /Choices: (.*)$/.exec(pending[2]!)![1]!.split(" | ");
      const named = choices.find((c) => c.toLowerCase() === owner.toLowerCase().replace(/[.!]+$/, ""));
      return JSON.stringify([{ kind: "answer", turnId: pending[1], choice: named ?? choices[0], evidence: owner, basis: "owner" }]);
    }
    const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
    if (/^(yes|no)\b/i.test(owner) && open.length > 0) return JSON.stringify([{ kind: /^no/i.test(owner) ? "discard_proposal" : "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }]);
    const name = /^make a project (\w+)$/.exec(owner);
    if (name !== null) return JSON.stringify([{ kind: "command", op: "project.create", args: { name: name[1], integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } }, evidence: owner, basis: "owner" }]);
    const bare = /^start a project (\w+)$/.exec(owner);
    if (bare !== null) return JSON.stringify([{ kind: "command", op: "project.create", args: { name: bare[1] }, evidence: owner, basis: "owner" }]);
    return JSON.stringify([{ kind: "none", reason: "nothing to do" }]);
  } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    let m = 0;
    const turn = async (text: string) => (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[];
    const projects = async () => ((await c.api.handle(boot.token, { v: 1, op: "project.list", args: {} } as never)) as any).result.items.map((p: any) => p.name) as string[];

    // (A) a question the chat asked
    const asked = (await turn("start a project Birch"))[0];
    assert.equal(asked.status, "asked", JSON.stringify(asked));
    for (const wrong of ["yes", "ok", "defaults", "human"]) assert.equal((await turn(wrong))[0].code, "untrusted_authority", wrong);
    assert.equal((await c.chat!.context(boot.token)).awaiting !== undefined, true, "still waiting for an answer");
    const next = (await turn("Default."))[0];
    assert.equal(next.status, "asked", JSON.stringify(next));
    assert.equal((await turn("Default"))[0].status, "asked", "and the following questions the same way");
    assert.equal((await turn("tests"))[0].status, "asked");
    assert.equal((await turn("default"))[0].status, "proposed", "after the last question the project is drafted, shown first");
    assert.deepEqual(await projects(), [], "nothing was created by answering");

    // (B) agreement with several open
    assert.equal((await turn("make a project Elm"))[0].status, "proposed");
    assert.equal((await turn("Yes please"))[0].status, "asked", "two or more open: the model's pick is not taken");
    assert.equal((await turn("yes"))[0].status, "asked");
    assert.deepEqual(await projects(), []);
  } finally { await c.close?.(); rmSync(d, { recursive: true, force: true }); }
});
