import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "../api/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { WebAssets } from "./door.js";

// Card U07 (finish): the real page in a real browser. It runs only where a Chromium-family browser is found (the NIMBLENEWT_CHROME variable names it; the Playwright cache and the usual Linux names are
// tried), so a machine without one skips it and says why. The browser is driven over its DevTools protocol with Node's own WebSocket (no package), always against a loopback listener of this test's own, with its
// own throw-away profile. It checks what only a browser can: that the page's strict content security policy lets the real script run, the touch layout does not scroll sideways, the HttpOnly cookie is out of
// reach of the page's script, a message sent while offline arrives exactly once, a second browser sees the conversation, a live update arrives without any action, and a signed-out browser goes back to the gate.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

function findBrowser(): string | undefined {
  const named = process.env["NIMBLENEWT_CHROME"];
  if (named !== undefined && named !== "") return existsSync(named) ? named : undefined;
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) { const p = join(cache, d, sub); if (existsSync(p)) return p; }
  } catch { /* no cache */ }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]) if (existsSync(p)) return p;
  return undefined;
}

async function loadAssets(): Promise<WebAssets | undefined> {
  const index = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ui", "dist", "index.js");
  if (!existsSync(index)) return undefined;
  const mod = await import(pathToFileURL(index).href) as { webChatAssets(): WebAssets };
  return mod.webChatAssets();
}

/** A DevTools connection: commands with a session, and the events the test wants to look at. */
class Cdp {
  #id = 0; readonly #pending = new Map<number, { ok: (v: any) => void; bad: (e: Error) => void }>(); readonly events: { method: string; params: any; sessionId?: string }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== undefined) { const p = this.#pending.get(msg.id); this.#pending.delete(msg.id); if (p !== undefined) { if (msg.error !== undefined) p.bad(new Error(JSON.stringify(msg.error))); else p.ok(msg.result); } } else this.events.push(msg);
    });
  }
  static async connect(url: string): Promise<Cdp> { const ws = new WebSocket(url); await new Promise<void>((ok, bad) => { ws.addEventListener("open", () => ok()); ws.addEventListener("error", () => bad(new Error("no DevTools connection"))); }); return new Cdp(ws); }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> { const id = ++this.#id; return new Promise((ok, bad) => { this.#pending.set(id, { ok, bad }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })); }); }
  close(): void { try { this.ws.close(); } catch { /* closed */ } }
}

const until = async (what: string, f: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms; let last: unknown;
  for (;;) { try { if (await f()) return; } catch (e) { last = e; } if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last === undefined ? "" : `: ${String(last)}`}`); await new Promise((r) => setTimeout(r, 50)); }
};

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits for the process to end, up to `ms` (the exit event, not a fixed sleep); true when it has ended (or never started). */
const ended = (p: ChildProcess, ms: number): Promise<boolean> => {
  if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true);
  return new Promise((ok) => {
    const done = (): void => { clearTimeout(timer); ok(true); };
    const timer = setTimeout(() => { p.off("exit", done); ok(p.exitCode !== null || p.signalCode !== null); }, ms);
    p.once("exit", done);
  });
};

/** Closes the browser so its helper processes stop writing into the profile: first politely over DevTools (Browser.close), then
 * child.kill() (the platform default: SIGTERM on Linux and macOS, terminate on Windows), then a forced kill. Each step waits for the
 * exit event, bounded. Returns a message when the browser is still running after all of that, otherwise undefined. */
async function closeBrowser(proc: ChildProcess | undefined, cdp: Cdp | undefined): Promise<string | undefined> {
  if (proc === undefined || await ended(proc, 0)) return undefined;
  // The browser may drop the connection before it answers, so the reply is not awaited: the exit event is what counts.
  if (cdp !== undefined && cdp.ws.readyState === WebSocket.OPEN) { try { cdp.send("Browser.close").catch(() => undefined); } catch { /* the connection went away */ } }
  if (await ended(proc, 15_000)) return undefined;
  proc.kill();
  if (await ended(proc, 15_000)) return undefined;
  proc.kill("SIGKILL"); // Node maps this to a forced termination on Windows as well.
  return await ended(proc, 15_000) ? undefined : `the browser (pid ${proc.pid}) did not exit after Browser.close, kill() and a forced kill`;
}

/** Removes the folder. A helper process the browser started can still be finishing a write (ENOTEMPTY), or Windows can still hold a
 * file lock (EBUSY, EPERM), for a moment after the main process ended: those three are retried with a growing wait, about 30 s in all.
 * Any other error, or the same error after the deadline, is returned as a message. */
async function removeFolder(dir: string): Promise<string | undefined> {
  const end = Date.now() + 30_000;
  for (let wait = 100; ; wait = Math.min(wait * 2, 2_000)) {
    try { rmSync(dir, { recursive: true, force: true }); return undefined; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") || Date.now() + wait > end) return `${code ?? "error"}: ${(e as Error).message}`;
    }
    await pause(wait);
  }
}

/** True when the folder is inside the OS temp folder, where the operating system clears leftovers. */
const inTempFolder = (dir: string): boolean => { const r = relative(tmpdir(), dir); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };

const chrome = findBrowser();
test("the real page in a real browser: strict policy, phone layout, sign-in, one delivery after offline, a second browser, a live update and revocation", { skip: chrome === undefined ? "no Chromium-family browser found (set NIMBLENEWT_CHROME)" : false, timeout: 240_000 }, async (t) => {
  const assets = await loadAssets();
  if (assets === undefined) { t.skip("the UI package is not built"); return; }
  const dir = mkdtempSync(join(tmpdir(), "nn-browser-"));
  let proc: ChildProcess | undefined; let cdp: Cdp | undefined; let passed = false;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "n.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter(() => []) }, webChat: { host: "127.0.0.1", network: "loopback", assets, limits: { eventsEveryMs: 100 } },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const door = c.webChat!;
    proc = spawn(chrome!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((ok, bad) => {
      let seen = ""; const timer = setTimeout(() => bad(new Error(`the browser did not start: ${seen.slice(-300)}`)), 30_000);
      proc!.stderr!.on("data", (d: Buffer) => { seen += d.toString(); const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen); if (m !== null) { clearTimeout(timer); ok(m[1]!); } });
      proc!.on("exit", () => bad(new Error(`the browser exited: ${seen.slice(-300)}`)));
    });
    cdp = await Cdp.connect(endpoint);
    const browser = cdp;
    /** A page in its own browsing context (its own cookies and storage), as a phone: a touch screen 390 x 844. */
    const phone = async (): Promise<{ eval<T = unknown>(js: string): Promise<T>; send(m: string, p?: object): Promise<any>; problems: string[]; paused(): string[] }> => {
      const { browserContextId } = await browser.send("Target.createBrowserContext");
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (m: string, p: object = {}): Promise<any> => browser.send(m, p, sessionId);
      await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const problems: string[] = []; const held: string[] = [];
      const scan = (): void => { for (const e of browser.events.splice(0)) {
        if (e.sessionId !== sessionId) { browser.events.push(e); continue; }
        if (e.method === "Fetch.requestPaused") held.push(e.params.requestId);
        if (e.method === "Runtime.exceptionThrown") problems.push(`exception: ${e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text}`);
        if (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !/Failed to load resource/.test(e.params.entry.text)) problems.push(`log: ${e.params.entry.text}`);
        if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") problems.push(`console: ${JSON.stringify(e.params.args)}`);
      } };
      const evaluate = async <T>(js: string): Promise<T> => { const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true }); scan(); if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value as T; };
      return { eval: evaluate, send, get problems() { scan(); return problems; }, paused: () => { scan(); return held.splice(0); } } as never;
    };
    const go = async (p: Awaited<ReturnType<typeof phone>>): Promise<void> => { await p.send("Page.navigate", { url: `${door.url}/` }); await until("the page script", async () => (await p.eval<boolean>("typeof window.NNCore === 'object' && !!document.getElementById('gate')"))); };
    const text = (p: Awaited<ReturnType<typeof phone>>, id: string): Promise<string> => p.eval<string>(`document.getElementById(${JSON.stringify(id)}).textContent`);
    const signIn = async (p: Awaited<ReturnType<typeof phone>>): Promise<void> => {
      await p.eval(`(() => { const s = document.getElementById('secret'); s.value = ${JSON.stringify(boot.token)}; document.getElementById('login').requestSubmit(); })()`);
      await until("the signed-in page", async () => (await p.eval<boolean>("!document.getElementById('app').hidden")));
    };
    const send = (p: Awaited<ReturnType<typeof phone>>, words: string): Promise<unknown> => p.eval(`(() => { const t = document.getElementById('text'); t.value = ${JSON.stringify(words)}; document.getElementById('composer').requestSubmit(); })()`);

    // 1. The strict policy lets the real script run; the gate shows first; nothing threw.
    const a = await phone();
    await go(a);
    await until("the gate", async () => (await a.eval<boolean>("!document.getElementById('gate').hidden && document.getElementById('app').hidden")));
    // 2. Sign in: the app shows, the credential is not kept anywhere the page's script can read, the cookie is not visible to it.
    await signIn(a);
    assert.equal(await a.eval<string>("document.cookie"), "", "the session cookie is HttpOnly");
    assert.equal(await a.eval<boolean>("JSON.stringify([localStorage.length, Object.keys(localStorage)]).includes(" + JSON.stringify(boot.token.split(".")[1]!) + ")"), false, "the secret is not in local storage");
    assert.equal(await a.eval<string>("document.getElementById('secret').value"), "", "the credential field was emptied");
    // 3. The phone layout: nothing scrolls sideways in any tab, every control has a name and a 44 pixel target, tabs and landmarks are there.
    const tabs = await a.eval<string[]>("Array.from(document.querySelectorAll('[data-tab]')).map((b) => b.getAttribute('data-tab'))");
    assert.ok(tabs.includes("cost") && tabs.includes("blockers") && tabs.includes("recovery") && tabs.includes("chat"));
    for (const name of tabs) {
      await a.eval(`document.querySelector('[data-tab="${name}"]').click()`);
      await until(`${name} drawn`, async () => (await a.eval<boolean>(name === "chat" ? "!document.getElementById('chat').hidden" : "!document.getElementById('view').hidden && !/Loading/.test(document.getElementById('view').textContent)")));
      const wide = await a.eval<number>("document.documentElement.scrollWidth - window.innerWidth");
      assert.ok(wide <= 0, `${name}: scrolls sideways by ${wide}px`);
      const bad = await a.eval<string[]>("Array.from(document.querySelectorAll('button:not([hidden])')).filter((b) => b.offsetParent !== null && !(b.textContent.trim() || b.getAttribute('aria-label'))).map((b) => b.outerHTML.slice(0, 80))");
      assert.deepEqual(bad, [], `${name}: a button without a name`);
      const small = await a.eval<string[]>("Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null && (b.getBoundingClientRect().height < 43.5)).map((b) => b.textContent.slice(0, 30))");
      assert.deepEqual(small, [], `${name}: a touch target under 44 pixels`);
    }
    await a.eval("document.querySelector('[data-tab=\"cost\"]').click()");
    await until("the cost view", async () => /Spent so far/.test(await text(a, "view")));
    await a.eval("document.querySelector('[data-tab=\"chat\"]').click()");
    assert.equal(await a.eval<string>("document.documentElement.lang"), "en");
    assert.equal(await a.eval<number>("document.querySelectorAll('main, [role=log], [role=status], [role=tablist]').length > 3 ? 1 : 0"), 1);
    // 4. A message sent while the connection is down waits, and arrives exactly once when it is back.
    await a.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send(a, "/nimblenewt.nothing offline-one");
    await until("the page to say offline", async () => /Offline|waiting|Waiting/.test(await text(a, "net") + await text(a, "log")));
    await a.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await a.eval("window.dispatchEvent(new Event('online'))");
    await until("the message to be delivered", async () => (await a.eval<boolean>("NNCore.createOutbox(localStorage).items().some((i) => i.state === 'done' && /offline-one/.test(i.text))")), 60_000);
    const turns = (await c.chat!.history(boot.token, { limit: 50 })).turns.filter((x) => x.text.includes("offline-one"));
    assert.equal(turns.length, 1, "one turn, however many times the page sent it");
    // 4b. The controller RECEIVED a message but its answer was lost on the way back (the connection dropped after the server did the work): the page sends it again under the same id and the controller
    // answers with the first turn instead of running it twice.
    await a.send("Fetch.enable", { patterns: [{ urlPattern: "*/web/chat", requestStage: "Response" }] });
    await send(a, "/nimblenewt.nothing answer-lost");
    let lost = false;
    await until("the answer to be held", async () => { for (const id of a.paused()) { await a.send("Fetch.failRequest", { requestId: id, errorReason: "ConnectionReset" }); lost = true; } return lost; });
    await a.send("Fetch.disable");
    await until("the page to resend and be answered", async () => (await a.eval<boolean>("NNCore.createOutbox(localStorage).items().some((i) => i.state === 'done' && /answer-lost/.test(i.text))")), 60_000);
    assert.equal((await c.chat!.history(boot.token, { limit: 50 })).turns.filter((x) => x.text.includes("answer-lost")).length, 1, "the resend ran nothing twice");
    // 5. A second browser (its own cookies and storage) signs in and sees the conversation the first one had.
    const b = await phone();
    await go(b); await signIn(b);
    await until("the history on the second browser", async () => /offline-one/.test(await text(b, "log")));
    // 6. A message from the terminal chat shows up on both without any action on the pages.
    await c.chat!.submit(boot.token, { messageId: "term-from-terminal", text: "/nimblenewt.nothing from-the-terminal" });
    await until("the live update on the first browser", async () => /from-the-terminal/.test(await text(a, "log")));
    await until("the live update on the second browser", async () => /from-the-terminal/.test(await text(b, "log")));
    // 7. Revoking every session (the host's stop) takes both back to the gate without a click.
    door.revokeAll("owner:rob");
    await until("the gate again", async () => (await a.eval<boolean>("!document.getElementById('gate').hidden")));
    await until("the gate again on the second", async () => (await b.eval<boolean>("!document.getElementById('gate').hidden")));
    assert.deepEqual(a.problems, [], "no script error or policy violation in the first browser");
    assert.deepEqual(b.problems, [], "no script error or policy violation in the second browser");
    passed = true;
  } finally {
    // The browser is closed and seen to exit BEFORE its profile is removed, so its helpers are not still writing into it. A cleanup
    // problem never hides the test's own failure: it is thrown only when the body passed, and otherwise reported.
    const stuck = await closeBrowser(proc, cdp);
    cdp?.close();
    await c.close();
    const left = stuck === undefined ? await removeFolder(dir) : `not removed because the browser is still running`;
    const report = (m: string): void => { t.diagnostic(m); console.error(m); };
    if (stuck !== undefined) { if (passed) throw new Error(`browser.test cleanup: ${stuck}`); report(`browser.test cleanup: ${stuck}`); }
    if (left !== undefined) {
      const m = `browser.test cleanup: the temporary folder ${dir} was left behind (${left})`;
      if (passed && !inTempFolder(dir)) throw new Error(m);
      report(inTempFolder(dir) ? `${m}; it is in the OS temp folder, so the test is not failed for it` : m);
    }
  }
});

test("the browser test's cleanup helpers: the exit wait is bounded and true only once the process ended; a browser without DevTools is ended by kill(); a missing folder counts as removed", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
  try {
    assert.equal(await ended(child, 200), false, "a running process has not ended (the wait gave up after 200 ms)");
    assert.equal(await closeBrowser(child, undefined), undefined, "kill() ends it and the exit is seen");
    assert.equal(await ended(child, 0), true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  const quick = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 100)"], { stdio: "ignore" });
  assert.equal(await ended(quick, 30_000), true, "the exit event ends the wait");
  assert.equal(quick.exitCode, 3);
  assert.equal(await closeBrowser(undefined, undefined), undefined);
  const gone = join(tmpdir(), `nn-browser-gone-${process.pid}-${Date.now()}`);
  assert.equal(await removeFolder(gone), undefined);
  assert.equal(inTempFolder(join(tmpdir(), "x")), true);
  assert.equal(inTempFolder(tmpdir()), false, "the temp folder itself is not inside it");
  assert.equal(inTempFolder(join(tmpdir(), "..", "elsewhere")), false);
});
