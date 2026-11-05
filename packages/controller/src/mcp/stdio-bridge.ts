import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable, Writable } from "node:stream";

/**
 * The stdio entry for a local MCP client (card T05b). A client that starts a program and talks to it through standard input and output cannot reach the controller's HTTP door directly. This bridge reads one JSON-RPC
 * message per line from its input, sends each to the controller's `/mcp` door as the credential's owner, and writes each answer as one line to its output. It holds no state, opens no database and adds no way in: the
 * door's own checks (credential kind, per-principal allowance, the chat switch, size bound, Origin) apply to every message. The credential comes from the environment, never from an argument (arguments show in process
 * lists), and appears in no output.
 */
export const STDIO_LIMITS = {
  /** One message line; the door refuses a body over 64 KiB, so a longer line is answered here without being sent. */
  line: 64 * 1024,
  /** One answer from the door. */
  reply: 4 * 1024 * 1024,
  /** Time allowed for one request to be answered. */
  requestMs: 120_000,
  /** The longest credential accepted. */
  token: 512,
} as const;

/** Codes of the errors this bridge writes itself (JSON-RPC's range for implementation-defined server errors). */
const BRIDGE_ERROR = -32000;
const TOO_LARGE = -32600;

export interface Door { readonly url: URL; readonly token: string }
export interface DoorReply { readonly status: number; readonly text: string }
export type SendToDoor = (door: Door, body: string) => Promise<DoorReply>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The door's address: http or https, no user name or password in it, and a credential never travels over plain http to another machine. Throws a plain Error naming the problem. */
export function checkDoorUrl(value: unknown): URL {
  if (typeof value !== "string" || value === "") throw new Error("the door's address is missing (NIMBLENEWT_MCP_URL, or the first argument)");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("the door's address is not a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the door's address must start with http:// or https://");
  if (url.username !== "" || url.password !== "") throw new Error("the door's address must not carry a user name or password; the credential comes from NIMBLENEWT_TOKEN");
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) throw new Error("a credential is sent only over https unless the controller is on this machine (use https:// or a loopback address)");
  url.search = ""; url.hash = "";
  return url;
}

/** The credential: present, one visible token, and nothing that could split a header. */
export function checkToken(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("the credential is missing (NIMBLENEWT_TOKEN)");
  if (value.length > STDIO_LIMITS.token || !/^[\x21-\x7e]+$/.test(value)) throw new Error("the credential in NIMBLENEWT_TOKEN is not a single printable token");
  return value;
}

/** The real request to the door, over node's own http or https client. */
export const sendToDoor: SendToDoor = (door, body) => new Promise<DoorReply>((resolve, reject) => {
  const request = door.url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = request(door.url, {
    method: "POST", timeout: STDIO_LIMITS.requestMs,
    headers: { authorization: `Bearer ${door.token}`, "content-type": "application/json", accept: "application/json", "content-length": String(Buffer.byteLength(body)) },
  }, (res: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (d: Buffer) => { size += d.length; if (size > STDIO_LIMITS.reply) { req.destroy(new Error("the answer is too large")); return; } chunks.push(d); });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("the controller did not answer in time")));
  req.on("error", reject);
  req.end(body);
});

const REFUSALS: Readonly<Record<number, string>> = {
  401: "the credential was not accepted",
  403: "this credential may not use the door",
  404: "the MCP door is switched off, or the address is wrong",
  413: "the message is too large",
  415: "the controller refused the message type",
  429: "too many requests; try again shortly",
  503: "the controller is busy or in maintenance; try again shortly",
};

const idOf = (line: string): string | number | null => {
  try { const m = JSON.parse(line) as { id?: unknown }; return typeof m?.id === "string" || typeof m?.id === "number" ? m.id : null; } catch { return null; }
};
const isNotification = (line: string): boolean => {
  try { const m = JSON.parse(line) as { id?: unknown; method?: unknown }; return typeof m === "object" && m !== null && !Array.isArray(m) && m.id === undefined && typeof m.method === "string"; } catch { return false; }
};
const failure = (id: string | number | null, code: number, message: string): string => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Runs the bridge until `input` ends and every message has been answered. Messages are sent one at a time, in order. Standard output carries protocol messages only; anything for a person goes to `error`.
 */
export async function runStdioBridge(options: { url: string; token: string; input: Readable; output: Writable; error?: Writable; send?: SendToDoor }): Promise<void> {
  const door: Door = { url: checkDoorUrl(options.url), token: checkToken(options.token) };
  const send = options.send ?? sendToDoor;
  const say = (text: string): void => { options.error?.write(`${text}\n`); };
  const write = (line: string): void => { options.output.write(`${line}\n`); };

  const handle = async (line: string): Promise<void> => {
    const notification = isNotification(line);
    const id = idOf(line);
    let reply: DoorReply;
    try { reply = await send(door, line); } catch {
      // The reason is not copied: it is node's own text for a refused or dropped connection, and says nothing the person can act on beyond this.
      if (notification) say("a notification could not be delivered: the controller could not be reached"); else write(failure(id, BRIDGE_ERROR, "the controller could not be reached"));
      return;
    }
    if (reply.status === 202) return;
    if (reply.status === 200) {
      let parsed: unknown;
      try { parsed = JSON.parse(reply.text); } catch { parsed = undefined; }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) write(JSON.stringify(parsed));
      else if (!notification) write(failure(id, BRIDGE_ERROR, "the controller's answer was not a JSON-RPC message"));
      return;
    }
    const why = REFUSALS[reply.status] ?? `the controller refused the message (HTTP ${reply.status})`;
    if (notification) say(`a notification was refused: ${why}`); else write(failure(id, BRIDGE_ERROR, why));
  };

  let pending = "";
  let skipping = false;
  let chain: Promise<void> = Promise.resolve();
  const queue = (line: string): void => { chain = chain.then(() => handle(line)); };
  await new Promise<void>((resolve, reject) => {
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => {
      pending += chunk;
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        if (skipping) { skipping = false; continue; } // the rest of a line already refused as too long
        if (line.trim() === "") continue;
        if (line.length > STDIO_LIMITS.line) { write(failure(null, TOO_LARGE, `a message is at most ${STDIO_LIMITS.line} characters`)); continue; }
        queue(line);
      }
      if (pending.length > STDIO_LIMITS.line) { if (!skipping) write(failure(null, TOO_LARGE, `a message is at most ${STDIO_LIMITS.line} characters`)); skipping = true; pending = ""; }
    });
    options.input.on("end", () => {
      const rest = pending.replace(/\r$/, "");
      if (!skipping && rest.trim() !== "") queue(rest);
      resolve();
    });
    options.input.on("error", reject);
  });
  await chain;
}
