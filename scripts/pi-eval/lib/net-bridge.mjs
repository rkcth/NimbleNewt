#!/usr/bin/env node
// The agent's one way to the model (W01 follow-up "w01iso", second review). The bench starts every agent in a network
// namespace of its own (lib/isolation.mjs, bwrapPrefix), where only a loopback device exists: the host's loopback
// services, the tailnet and the internet are out of reach. This program runs first inside that namespace: it listens on
// 127.0.0.1:<port> there, forwards each connection to the bench's key proxy through its unix socket (bound into the
// sandbox), then starts the agent and ends with it (its exit status, or the signal that ended it). Signals it receives
// are passed on to the agent.
// Usage: net-bridge.mjs <proxy socket> <port> -- <agent argv...>
import { spawn } from "node:child_process";
import net from "node:net";

const [socketPath, portText, dash, ...argv] = process.argv.slice(2);
const port = Number(portText);
if (!socketPath || !Number.isInteger(port) || port <= 0 || port > 65_535 || dash !== "--" || argv.length === 0) {
  process.stderr.write("usage: net-bridge.mjs <proxy socket> <port> -- <command...>\n");
  process.exit(2);
}

/** At most this many connections at once (the proxy itself takes 32); more are refused at once. */
const BRIDGE_MAX_CONNECTIONS = 64;

// Half-open both ways: a client that ends its side after the request (shutdown of writing) still gets the whole answer.
// A side that closes lets the other finish writing what it holds, then closes it (destroySoon); an error closes both.
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on("error", kill); upstream.on("error", kill);
  client.on("close", () => upstream.destroySoon());
  upstream.on("close", () => client.destroySoon());
  client.pipe(upstream); upstream.pipe(client);
});
server.maxConnections = BRIDGE_MAX_CONNECTIONS;
server.on("error", (e) => { process.stderr.write(`net-bridge: the model route could not be opened on 127.0.0.1:${port} (${e.code ?? e.message})\n`); process.exit(1); });
server.listen(port, "127.0.0.1", () => {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  const pass = (sig) => () => { try { child.kill(sig); } catch { /* gone */ } };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, pass(sig));
  child.on("error", (e) => { process.stderr.write(`net-bridge: ${argv[0]}: ${e.message}\n`); process.exit(127); });
  child.on("exit", (code, signal) => {
    server.close();
    if (signal) { for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(sig); process.kill(process.pid, signal); }
    process.exit(code ?? 1);
  });
});
