import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher } from "../sandbox/launcher.js";
import { attemptSandbox } from "../sandbox/attempt.js";
import { CHECKOUT_TOOL_LIMITS, cutMiddle, runCheckoutCall, type CheckoutAnswer, type CheckoutCall, type CheckoutRunContext } from "./checkout-tool.js";

// Card W09b. Like the launcher's own tests, these start real confined processes: skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), and on any system but Linux (the worker host is Linux only).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));

test("a long text is cut to its start and its end, and says how much was left out", () => {
  assert.deepEqual(cutMiddle("short", 10, 4), { text: "short", truncated: false });
  const cut = cutMiddle("a".repeat(30) + "b".repeat(30), 20, 5);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.startsWith("aaaaa\n[... 40 characters left out ...]\n") && cut.text.endsWith("b".repeat(15)), cut.text);
});

describe("the checkout tool in a sandbox of its own (card W09b)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-co-")));
  const checkout = join(root, "checkout"), outside = join(root, "outside"), dataDir = join(root, "data"), home = join(root, "home"), scratch = join(root, "scratch");
  let launcher: SandboxLauncher;
  let usable = false;
  let ctx: CheckoutRunContext;
  const tracked = new Set<unknown>();

  before(async () => {
    for (const d of [checkout, outside, dataDir, home, scratch, join(root, "runs"), join(checkout, "src")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(checkout, "src", "a.txt"), "hello\nworld\n");
    writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n");
    writeFileSync(join(outside, "secret.txt"), "outside secret\n");
    writeFileSync(join(dataDir, "controller.db"), "the controller's data\n");
    writeFileSync(join(home, "pi"), "the agent's own conversation store\n");
    symlinkSync(join(outside, "secret.txt"), join(checkout, "link-out"));
    symlinkSync(outside, join(checkout, "dir-out"));
    symlinkSync("src/a.txt", join(checkout, "link-in"));
    symlinkSync("/usr/bin/env", join(checkout, "link-sys"));
    symlinkSync("/usr/lib", join(checkout, "dir-sys"));
    process.env["NN_TEST_SECRET"] = "must-not-reach-the-tool";
    launcher = await SandboxLauncher.create({ protectedPaths: [dataDir], audit: () => undefined });
    usable = process.platform === "linux" && launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    const planned = attemptSandbox({ checkout, gitDir: join(root, "git"), home, scratch, readOnly: [{ host: nodeRoot, guest: "/opt/node" }] }, { protectedPaths: [dataDir] });
    // The host may not be able to enforce every limit (a CI container): best effort, as the script runner's own tests do; the product reads the owner's setting.
    ctx = { launcher, recipe: planned.recipe, limits: { memoryMb: 512 }, bestEffort: true, node: "/opt/node/bin/node", base: join(root, "runs"), track: (run, started) => { if (started) tracked.add(run); else tracked.delete(run); } };
  });
  after(async () => { delete process.env["NN_TEST_SECRET"]; await launcher?.stop().catch(() => undefined); rmSync(root, { recursive: true, force: true }); });

  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`bubblewrap or a node install it can mount is unusable: ${launcher.capacity.reason ?? nodeRoot}`); await fn(); }); };
  const call = (c: CheckoutCall, more: Partial<CheckoutRunContext> = {}, signal: AbortSignal = new AbortController().signal): Promise<CheckoutAnswer> => runCheckoutCall({ ...ctx, ...more }, c, signal);
  const factsOf = (a: CheckoutAnswer): Record<string, unknown> => (a.ok ? a.facts : {});
  const okBody = (a: CheckoutAnswer): string => { assert.equal(a.ok, true, JSON.stringify(a)); return (a as { body: string }).body; };
  const refused = (a: CheckoutAnswer, pattern: RegExp): void => { assert.equal(a.ok, false, JSON.stringify(a)); assert.match((a as { reason: string }).reason, pattern); };

  ifUsable("read, write (making folders), edit and run work in the checkout, and a folder reads as its entries without .git", async () => {
    assert.equal(okBody(await call({ action: "read", path: "src/a.txt" })), "hello\nworld\n");
    const wrote = await call({ action: "write", path: "src/new/b.mjs", text: "console.log('b is', 1);\n" });
    assert.deepEqual(wrote, { ok: true, body: "", facts: { path: "src/new/b.mjs", chars: 24, created: true } });
    assert.equal(readFileSync(join(checkout, "src", "new", "b.mjs"), "utf8"), "console.log('b is', 1);\n");
    assert.deepEqual(factsOf(await call({ action: "edit", path: "src/new/b.mjs", old: "1", text: "2" })), { path: "src/new/b.mjs", chars: 24, line: 1 });
    writeFileSync(join(checkout, "src", "three.txt"), "one\ntwo\nthree\n");
    assert.equal(factsOf(await call({ action: "edit", path: "src/three.txt", old: "three", text: "3" }))["line"], 3);
    const ran = await call({ action: "run", command: "node src/new/b.mjs && pwd && echo to-stderr >&2; exit 3" });
    assert.equal(ran.ok, true);
    assert.equal(okBody(ran), "b is 2\n/work\n[stderr]\nto-stderr\n");
    assert.equal(factsOf(ran).exitCode, 3);
    assert.deepEqual(okBody(await call({ action: "read", path: "src" })).split("\n"), ["a.txt", "new/", "three.txt"]);
    const top = okBody(await call({ action: "read", path: "." })).split("\n");
    assert.ok(top.includes("src/") && !top.includes(".git"), top.join(","));
    refused(await call({ action: "write", path: ".", text: "x" }), /give the path of a file/);
    // A link inside the checkout to a file inside it is read through.
    assert.equal(okBody(await call({ action: "read", path: "link-in" })), "hello\nworld\n");
    assert.equal(tracked.size, 0, "every run was let go once it ended");
  });

  ifUsable("a path outside the checkout is refused before anything is read or written: .., an absolute path, .git", async () => {
    refused(await call({ action: "read", path: "../outside/secret.txt" }), /not inside your checkout/);
    refused(await call({ action: "read", path: "/etc/passwd" }), /not inside your checkout/);
    refused(await call({ action: "write", path: "../escaped.txt", text: "x" }), /not inside your checkout/);
    refused(await call({ action: "write", path: "src/../../escaped.txt", text: "x" }), /not inside your checkout/);
    refused(await call({ action: "read", path: ".git" }), /\.git is not one of your checkout's files/);
    refused(await call({ action: "write", path: ".git/config", text: "x" }), /\.git is not one of your checkout's files/);
    assert.equal(existsSync(join(root, "escaped.txt")), false);
    assert.equal(readFileSync(join(checkout, ".git"), "utf8"), "gitdir: /elsewhere\n");
  });

  ifUsable("a link that leads out of the checkout is refused for read, write and edit, and the file it points at is not touched", async () => {
    // A link to a host path outside: the sandbox does not even show its target. A link to a path the sandbox does show (a system file): the tool refuses it.
    refused(await call({ action: "read", path: "link-out" }), /does not exist|leads outside your checkout/);
    refused(await call({ action: "read", path: "link-sys" }), /leads outside your checkout/);
    refused(await call({ action: "write", path: "link-sys", text: "x" }), /is a link|leads outside/);
    refused(await call({ action: "write", path: "dir-sys/planted", text: "x" }), /leads outside your checkout/);
    refused(await call({ action: "write", path: "link-out", text: "overwritten" }), /is a link|leads outside/);
    refused(await call({ action: "edit", path: "link-out", old: "outside", text: "changed" }), /is a link|leads outside|does not exist/);
    refused(await call({ action: "edit", path: "link-sys", old: "a", text: "b" }), /is a link|leads outside/);
    refused(await call({ action: "write", path: "dir-out/planted.txt", text: "x" }), /leads outside your checkout|does not exist|no such file/);
    refused(await call({ action: "read", path: "dir-out/secret.txt" }), /leads outside your checkout|does not exist|no such file/);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "outside secret\n");
    assert.equal(existsSync(join(outside, "planted.txt")), false);
  });

  ifUsable("an edit needs old to occur exactly once, and a missing file is said plainly", async () => {
    writeFileSync(join(checkout, "twice.txt"), "x x\n");
    refused(await call({ action: "edit", path: "twice.txt", old: "x", text: "y" }), /more than once/);
    refused(await call({ action: "edit", path: "twice.txt", old: "z", text: "y" }), /does not occur/);
    refused(await call({ action: "read", path: "missing.txt" }), /does not exist/);
    assert.equal(readFileSync(join(checkout, "twice.txt"), "utf8"), "x x\n");
  });

  ifUsable("a command has no network, no host environment, and writes nowhere but the checkout (the controller's data, the agent's home and the files outside are out of reach)", async () => {
    const out = okBody(await call({ action: "run", command: [
      `node -e "const c=process.getBuiltinModule('net').connect(80,'192.0.2.1'); c.on('error',e=>console.log('net', e.code)); c.on('connect',()=>console.log('net connected'))"`,
      `env | grep -c NN_TEST_SECRET || true`,
      `echo x > /etc/nn-planted 2>/dev/null && echo etc-written || echo etc-refused`,
      `ls ${JSON.stringify(dataDir)} 2>/dev/null && echo data-seen || echo data-hidden`,
      `cat ${JSON.stringify(join(outside, "secret.txt"))} 2>/dev/null || echo outside-hidden`,
      `cat /home/agent/pi 2>/dev/null || echo home-empty`,
      `echo planted > /home/agent/planted; echo planted > /scratch/planted; echo kept > /work/inside.txt`,
    ].join("\n") }));
    assert.match(out, /^net E[A-Z]+$/m);
    assert.doesNotMatch(out, /net connected|must-not-reach/);
    assert.match(out, /^0$/m, "no host variable reaches the command");
    assert.match(out, /etc-refused/);
    assert.match(out, /data-hidden/);
    assert.match(out, /outside-hidden/);
    assert.match(out, /home-empty/, "the agent's own home (its conversation store) is not this call's home");
    assert.equal(readFileSync(join(checkout, "inside.txt"), "utf8"), "kept\n");
    assert.equal(existsSync(join(home, "planted")), false);
    assert.equal(existsSync(join(scratch, "planted")), false);
    assert.equal(readFileSync(join(home, "pi"), "utf8"), "the agent's own conversation store\n");
    assert.deepEqual(readdirSync(join(root, "runs")), [], "the call's own home and scratch are removed");
  });

  ifUsable("oversized output is cut to its start and its end and said to be cut", async () => {
    const a = await call({ action: "run", command: "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo the-end" });
    const body = okBody(a);
    assert.equal(factsOf(a).truncated, true);
    assert.ok(body.length <= CHECKOUT_TOOL_LIMITS.bodyChars + 80, String(body.length));
    assert.match(body, /characters left out/);
    assert.ok(body.trimEnd().endsWith("the-end"));
    writeFileSync(join(checkout, "big.txt"), "b".repeat(100_000));
    const read = await call({ action: "read", path: "big.txt" });
    assert.equal(factsOf(read).truncated, true);
    assert.equal(factsOf(read).chars, 100_000);
  });

  ifUsable("a fork bomb and a command that runs too long are ended at the time limit, and the next call works", async () => {
    const t0 = Date.now();
    const bomb = await call({ action: "run", command: "bomb() { bomb | bomb & }; bomb; sleep 60" }, { limits: { memoryMb: 512, wallTimeMs: 3000 } });
    assert.equal(bomb.ok, true);
    assert.ok(factsOf(bomb).timedOut || factsOf(bomb).exitCode !== 0, JSON.stringify(factsOf(bomb)));
    const slow = await call({ action: "run", command: "sleep 30" }, { limits: { memoryMb: 512, wallTimeMs: 2000 } });
    assert.equal(factsOf(slow).timedOut, true);
    assert.ok(Date.now() - t0 < 30_000, "both ended at their limit");
    assert.equal(okBody(await call({ action: "run", command: "echo still-fine" })), "still-fine\n");
  });

  ifUsable("a call that changes the checkout and is stopped while it runs says it may have acted; a stopped read does not", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 700);
    await assert.rejects(call({ action: "run", command: "echo started > /work/started.txt; sleep 30" }, {}, ctl.signal), (e: Error & { mayHaveActed?: boolean }) => e.mayHaveActed === true && /may have changed the checkout/.test(e.message));
    const r = new AbortController();
    r.abort();
    await assert.rejects(call({ action: "read", path: "src/a.txt" }, {}, r.signal), (e: Error & { mayHaveActed?: boolean }) => e.mayHaveActed !== true);
    assert.equal(tracked.size, 0);
  });

  // First review of card W09b.
  ifUsable("Git's name anywhere in a path is refused in any case (a repository there is one the host's git could look into), and a folder read hides it in any case", async () => {
    for (const path of ["sub/.git/config", "Sub/.GiT/config", ".GIT/hooks/pre-commit", "a/b/../.git"]) {
      refused(await call({ action: "write", path, text: "[filter \"x\"]\n\tclean = touch /work/ran\n" }), /\.git is not one of your checkout's files/);
      refused(await call({ action: "read", path }), /\.git is not one of your checkout's files/);
    }
    assert.equal(existsSync(join(checkout, "sub")), false, "no folder was made for a refused write");
    mkdirSync(join(checkout, "hides", ".GIT"), { recursive: true });
    assert.equal(okBody(await call({ action: "read", path: "hides" })), "");
  });

  ifUsable("a pipe in the checkout is refused at once instead of waiting until the call's time is up, for a read and a write", async () => {
    assert.equal(factsOf(await call({ action: "run", command: "mkfifo /work/pipe" })).exitCode, 0);
    const t0 = Date.now();
    refused(await call({ action: "read", path: "pipe" }, { limits: { memoryMb: 512, wallTimeMs: 20_000 } }), /is not a file/);
    assert.equal((await call({ action: "write", path: "pipe", text: "x" }, { limits: { memoryMb: 512, wallTimeMs: 20_000 } })).ok, false);
    assert.ok(Date.now() - t0 < 10_000, `the pipe was waited on (${Date.now() - t0} ms)`);
  });

  ifUsable("a long file whose answer is mostly escapes still comes back, cut, and a file that is not UTF-8 is said so on a read and refused for an edit, its bytes untouched", async () => {
    writeFileSync(join(checkout, "quotes.txt"), "\"\\\n".repeat(1_200_000));
    const read = await call({ action: "read", path: "quotes.txt" });
    assert.equal(read.ok, true, JSON.stringify(read).slice(0, 300));
    assert.equal(factsOf(read).truncated, true);
    assert.equal(factsOf(read).chars, 3_600_000);
    assert.ok(okBody(read).length <= CHECKOUT_TOOL_LIMITS.bodyChars + 80);
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x80, 0x42]);
    writeFileSync(join(checkout, "bin.dat"), bytes);
    assert.equal(factsOf(await call({ action: "read", path: "bin.dat" })).notText, true);
    refused(await call({ action: "edit", path: "bin.dat", old: "A", text: "Z" }), /not UTF-8 text/);
    assert.deepEqual(readFileSync(join(checkout, "bin.dat")), bytes);
    assert.equal(factsOf(await call({ action: "read", path: "src/a.txt" })).notText, undefined);
  });

  ifUsable("a call is not started when the checkout's disk is under the reserve, and a command that brings it under the reserve is stopped and says so", async () => {
    refused(await call({ action: "run", command: "echo never > /work/never.txt" }, { diskReserveBytes: Number.MAX_SAFE_INTEGER }), /has less than .* MB free; nothing was run/);
    assert.equal(existsSync(join(checkout, "never.txt")), false);
    const free = (s: { bavail: number; bsize: number }): number => s.bavail * s.bsize;
    const before = free(await statfs(checkout));
    const t0 = Date.now();
    // 64 MiB under what is free now: the command writes 4 MiB at a time, slowly, up to 400 MiB.
    const a = await call({ action: "run", command: "for i in $(seq 1 100); do head -c 4194304 /dev/zero >> /work/fill.bin; sleep 0.05; done; echo all-written" }, { diskReserveBytes: before - 64 * 1048576, limits: { memoryMb: 512, wallTimeMs: 60_000 } });
    try {
      assert.equal(factsOf(a).diskFull, true, JSON.stringify(a).slice(0, 300));
      assert.match(okBody(a), /stopped: the disk your checkout is on fell under/);
      assert.doesNotMatch(okBody(a), /all-written/);
      assert.ok(statSync(join(checkout, "fill.bin")).size < 400 * 1048576);
      assert.ok(Date.now() - t0 < 30_000);
    } finally { rmSync(join(checkout, "fill.bin"), { force: true }); }
  });

  ifUsable("a process a command leaves running in the background ends with the call and never acts after it", async () => {
    const a = await call({ action: "run", command: "(sleep 2; echo late > /work/late-1) & disown; setsid sh -c 'sleep 2; echo late > /work/late-2' </dev/null >/dev/null 2>&1 & nohup sh -c 'sleep 2; echo late > /work/late-3' >/dev/null 2>&1 & echo started" });
    assert.equal(okBody(a), "started\n");
    assert.ok(Number(factsOf(a).ms) < 2000, "the call did not wait for its background processes");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    for (const n of [1, 2, 3]) assert.equal(existsSync(join(checkout, `late-${n}`)), false, `background process ${n} outlived its call`);
  });
});
