import { Readable } from "node:stream";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";

// Shared by the integration tests of the real worker process (cards H12b, H12j): a model endpoint that plays scripted OpenAI-compatible replies, and a fetch that reaches loopback through node:http.
export interface Seen { path: string; auth: string | undefined; body: { model: string; messages: { role: string; content: unknown }[]; [k: string]: unknown } }
export const sse = (delta: object, finish: string | null, usage?: object): string => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;

/** The test process blocks the global fetch (the offline guard), so the relay reaches the loopback endpoint through node:http. */
export const loopbackFetch: typeof globalThis.fetch = (input, init) => new Promise((ok, fail) => {
  const req = httpRequest(String(input), { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) }, (res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
    ok(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode ?? 502, headers }));
  });
  req.on("error", fail);
  init?.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
  req.end(init?.body === undefined ? undefined : Buffer.from(init.body as Buffer));
});

/** A model endpoint that plays the given replies in order: a reply is a tool call or a text. */
export async function endpoint(replies: ({ call: { name: string; args: object } } | { text: string })[]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let at = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers["authorization"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen["body"] });
      const reply = replies[Math.min(at++, replies.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if ("call" in reply) {
        res.write(sse({ role: "assistant", tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }, null));
        res.write(sse({}, "tool_calls", usage));
      } else {
        res.write(sse({ role: "assistant", content: reply.text }, null));
        res.write(sse({}, "stop", usage));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

