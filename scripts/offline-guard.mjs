// Preloaded into every package test process (node --import). A tripwire, not a sandbox:
// it makes non-loopback network use from JavaScript throw so a test cannot silently depend on a
// real service. Worker threads inherit execArgv and Node child processes inherit NODE_OPTIONS, so
// both load this guard too. Non-Node child processes (e.g. curl) are NOT covered; the Linux CI job
// additionally runs the whole suite in a network namespace with no connectivity.
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopback = (host) => typeof host === "string" && (LOOPBACK.has(host) || /^127(\.\d{1,3}){3}$/.test(host));
const refuse = (what) => { throw new Error(`network access is blocked in offline tests (${what})`); };

globalThis.fetch = () => Promise.reject(new Error("network access is blocked in offline tests (fetch)"));

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() hands connect() a pre-normalized [options, callback] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return originalConnect.apply(this, args);
    host = first.host ?? "localhost";
  } else if (typeof first === "string") {
    return originalConnect.apply(this, args); // IPC path
  } else {
    host = typeof args[1] === "string" ? args[1] : "localhost";
  }
  if (!isLoopback(host)) refuse(`connect ${host}`);
  return originalConnect.apply(this, args);
};

function guardDns(target) {
  for (const name of Object.getOwnPropertyNames(target)) {
    const original = target[name];
    if (typeof original !== "function" || !/^(lookup|lookupService|reverse|resolve)/.test(name)) continue;
    Object.defineProperty(target, name, { configurable: true, writable: true, value: function (hostname, ...rest) {
      if (name === "lookup" && isLoopback(hostname)) return original.call(this, hostname, ...rest);
      return refuse(`dns.${name}`);
    } });
  }
}
guardDns(dns);
guardDns(dns.promises);
guardDns(dns.Resolver.prototype);
guardDns(dns.promises.Resolver.prototype);

for (const method of ["send", "connect"]) {
  const original = dgram.Socket.prototype[method];
  dgram.Socket.prototype[method] = function (...args) {
    const address = args.slice(1).find((a) => typeof a === "string"); // send(msg, port, address) / connect(port, address)
    if (address !== undefined && !isLoopback(address)) refuse(`dgram.${method}`);
    return original.apply(this, args);
  };
}

// Named ESM imports (import { resolve4 } from "node:dns") are snapshots; refresh them.
syncBuiltinESMExports();

const self = import.meta.url;
const option = `--import=${self}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(option)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${option}`.trim();
}
