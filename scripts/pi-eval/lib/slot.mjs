// An optional machine-wide test slot around the bench's own builds and test runs (card W01).
// On a shared machine the owner may limit how many test runs go at once with a slot command: a program that waits for a
// free slot, runs the command it is given while holding it, and frees it when that command exits (for example a flock
// wrapper). The bench holds a slot only for its own setup build and its grading (the acceptance and shipped suites), never
// while the agent works: the agent's own test runs are part of what is measured and are left as the agent makes them.
// The slot is held by a small child that prints "ready" once the slot command started it and exits when its stdin closes,
// so the wait for a slot does not count against a suite's own time limit.
import { spawn } from "node:child_process";

/** Runs fn() while holding a slot of `slotCommand` (an argv prefix); without one, just runs fn(). */
export async function withSlot(slotCommand, fn, { log = () => {} } = {}) {
  if (!slotCommand || slotCommand.length === 0) return fn();
  const holderScript = 'process.stdout.write("ready\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); process.stdin.on("error", () => process.exit(0));';
  const child = spawn(slotCommand[0], [...slotCommand.slice(1), process.execPath, "-e", holderScript], { stdio: ["pipe", "pipe", "inherit"] });
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; if (buf.includes("ready")) resolve(); });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the test slot command exited (${code}) before granting a slot`)));
  });
  const waited = Date.now() - t0;
  if (waited > 5000) log(`waited ${(waited / 1000).toFixed(0)} s for a test slot`);
  try {
    return await fn();
  } finally {
    child.removeAllListeners("exit");
    const gone = new Promise((r) => child.once("exit", r));
    child.stdin.end();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
