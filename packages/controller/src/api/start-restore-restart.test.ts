import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { DEFAULT_RESTART_INSTRUCTION } from "../backup/staged-restore.js";
import { startController } from "./index.js";

// Card K01i: after a restore is staged the owner is told how the controller gets restarted, or the host restarts it itself.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Controller = Awaited<ReturnType<typeof startController>>;
type Restart = { automatic?: () => void | Promise<void>; instruction?: string; delayMs?: number };

function rig(restart?: Restart) {
  const d = mkdtempSync(join(tmpdir(), "nn-k01i-rs-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups"), ...(restart === undefined ? {} : { restore: { restart } }) } });
  return { d, open };
}
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

async function stage(c: Controller): Promise<{ token: string; preview: any; applied: any }> {
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  await call(c, boot.token, "project.create", { name: "Garden" }, "p1");
  const name = (await call(c, boot.token, "backup.now", {}, "b1")).result.item.name as string;
  await call(c, boot.token, "project.create", { name: "Late" }, "p2");
  const preview = await call(c, boot.token, "backup.restore.preview", { name });
  const applied = await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1");
  assert.ok(applied.ok, JSON.stringify(applied));
  return { token: boot.token, preview, applied };
}

test("without an automatic restart the owner is told how to restart: in the plan, the apply result and the status, in the host's own words when it gives them (card K01i)", async () => {
  for (const instruction of [undefined, "Run: systemctl restart nimblenewt"]) {
    const r = rig(instruction === undefined ? undefined : { instruction });
    const c = await r.open();
    try {
      const { token, preview, applied } = await stage(c);
      const expected = instruction ?? DEFAULT_RESTART_INSTRUCTION;
      assert.ok(preview.result.item.steps.some((s: string) => s.startsWith("4. You restart the controller") && s.includes(expected)), JSON.stringify(preview.result.item.steps));
      assert.deepEqual(applied.result.item.restart, { automatic: false, instruction: expected });
      const status = await call(c, token, "backup.restore.status", {});
      assert.deepEqual(status.result.item.restart, { automatic: false, instruction: expected });
      assert.equal((await call(c, token, "backup.restore.cancel", {}, "r2")).result.cancelled, true);
      assert.equal((await call(c, token, "backup.restore.status", {})).result.item.restart, undefined, "nothing waits for a restart after a cancel");
    } finally { await c.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
  }
});

test("an automatic restart is called once, after the reply, and the restart swaps the backup in; a failed one is shown with the instruction to restart by hand (card K01i)", async () => {
  const box: { c?: Controller; restarted: number; done?: Promise<void>; fail?: boolean } = { restarted: 0 };
  let finish: () => void = () => undefined;
  box.done = new Promise((resolve) => { finish = resolve; });
  const r = rig({ automatic: async () => {
    box.restarted += 1;
    if (box.fail === true) throw new Error("the service manager refused");
    await box.c!.close(); box.c = await r.open(); finish();
  }, delayMs: 200 });
  box.c = await r.open();
  try {
    const { token, preview, applied } = await stage(box.c);
    assert.ok(preview.result.item.steps.some((s: string) => s.startsWith("4. The controller restarts itself")));
    assert.equal(applied.result.item.restart.automatic, true);
    assert.equal(box.restarted, 0, "the restart waits for the reply to be produced");
    await box.done;
    assert.equal(box.restarted, 1);
    const names = JSON.stringify((await call(box.c, token, "project.list", {})).result);
    assert.ok(names.includes("Garden")); assert.equal(names.includes("Late"), false);
    // The host's restart fails: the owner sees it, and how to restart by hand.
    box.fail = true;
    const again = await call(box.c, token, "backup.restore.preview", { name: (await call(box.c, token, "backup.list", {})).result.items.find((i: any) => i.kind === "manual").name });
    assert.ok((await call(box.c, token, "backup.restore.apply", { name: again.result.item.name, confirm: again.result.item.token }, "r9")).ok);
    for (let i = 0; i < 200 && box.restarted < 2; i++) await new Promise((res) => setTimeout(res, 10));
    await new Promise((res) => setTimeout(res, 10));
    const status = (await call(box.c, token, "backup.restore.status", {})).result.item;
    assert.equal(status.restart.automatic, false);
    assert.match(status.restart.failed, /service manager refused/);
    assert.equal(status.restart.instruction, DEFAULT_RESTART_INSTRUCTION);
  } finally { await box.c?.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});
