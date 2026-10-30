import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { sourceLoops } from "../dispatch/loops.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { EventSource } from "../events/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner chooses which event sources are watched: a source turned off is not polled from the next tick, turned on it is again, the choice is the owner's, validated, race-safe and shown first in chat (card H13f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-srcset-"));
  const polls: string[] = [];
  const src = (id: string, type: EventSource["type"]): EventSource => ({ id, type, poll: async ({ state }) => { polls.push(id); return { signals: [], state: state ?? {}, more: false }; } });
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    eventSources: [src("repo", "repository"), src("health", "service-failure" as never)],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const tick = async (): Promise<string[]> => { polls.length = 0; await c.dispatch!.dispatcher.tick(); return [...polls].sort(); };

    // Nothing set: every configured source is watched.
    assert.deepEqual(await tick(), ["health", "repo"]);
    const first = (await call(boot.token, "events.sources.get", {})).result.item;
    assert.deepEqual([first.revision, first.disabled, first.sources.map((s: any) => [s.id, s.enabled])], [0, [], [["repo", true], ["health", true]]]);

    // Owner only; unknown, malformed and stale are refused and change nothing.
    assert.equal((await call(ann, "events.sources.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "events.sources.set", { disabled: ["repo"] }, "s0")).error?.code, "forbidden");
    assert.equal((await call(ann, "events.sources.change", { disable: ["repo"] }, "s0b")).error?.code, "forbidden");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["reop"] }, "s1")).error?.code, "invalid_command", "a typo would turn nothing off");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["bad id"] }, "s2")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.set", {}, "s3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 4 }, "s4")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "events.sources.change", {}, "s5")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.change", { disable: ["repo"], enable: ["repo"] }, "s6")).error?.code, "invalid_command");
    assert.deepEqual(await tick(), ["health", "repo"], "nothing changed");

    // Turned off: not polled from the next tick.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 0 }, "s7")).ok);
    assert.deepEqual(await tick(), ["health"]);
    // The same command ID again does not apply twice.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 0 }, "s7")).ok);

    // In chat the change is shown first, and while it waits another change must survive it.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "stop watching health";
    const shown = await turn("m1", text, [{ kind: "command", op: "events.sources.change", args: { disable: ["health"] }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual(await tick(), ["health"], "nothing changed yet");
    assert.ok((await call(boot.token, "events.sources.change", { enable: ["repo"] }, "s8")).ok);
    assert.deepEqual(await tick(), ["health", "repo"]);
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual(await tick(), ["repo"], "the source turned on meanwhile stays on");
    assert.deepEqual((await call(boot.token, "events.sources.get", {})).result.item.sources.map((s: any) => [s.id, s.enabled]), [["repo", true], ["health", false]]);

    // All off: nothing is polled and the loop does not fail.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo", "health"] }, "s9")).ok);
    assert.deepEqual(await tick(), []);
    assert.ok((await call(boot.token, "events.sources.set", { disabled: [] }, "s10")).ok);
    assert.deepEqual(await tick(), ["health", "repo"]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("when the owner's choice cannot be read no source is polled, and the failure shows (card H13f)", async () => {
  const polled: string[] = [];
  const [loop] = sourceLoops({ run: async (_by, list) => { polled.push(...list.map((s) => s.id as string)); return []; } }, [{ id: "a", type: "file" } as never, { id: "b", type: "file" } as never], async () => { throw new Error("storage unavailable"); });
  await assert.rejects(() => loop!.run({ id: "service:dispatcher", kind: "service" } as never), /storage unavailable/);
  assert.deepEqual(polled as string[], []);
  const [some] = sourceLoops({ run: async (_by, list) => { polled.push(...list.map((s) => s.id as string)); return []; } }, [{ id: "a", type: "file" } as never, { id: "b", type: "file" } as never], async () => new Set(["a"]));
  await some!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.deepEqual(polled, ["b"]);
});
