import { connect as netConnect, type Socket } from "node:net";
import type { NameResolver } from "../dispatch/network.js";
import { admit, NetworkRefused, type GrantSource, type NetworkContext } from "./admit.js";
import type { ConnectionBody, GrantView } from "./grants.js";

/**
 * The network relay (card H12i): the one way out of a task's sandbox besides the model relay. The sandbox has no network interface; a forwarder inside it serves a proxy endpoint on its own loopback and sends every connection over the worker channel to
 * the host, which asks this relay. The relay connects only for a destination the task holds a live grant for (see `admit`), to the one address it checked, and it is a plain byte pipe: it adds no credential, no header and no change to what passes. It
 * logs every connection with its bytes. A grant is judged at each connection and again while one is open (every `recheckMs`), so a revoke, or the end of the task, stops open connections and new ones with no restart of anything; a revoke made in
 * this process closes them at once.
 */

export interface TunnelEvents {
  /** A piece of what the destination sent. The pipe waits for the returned promise before it reads more (back-pressure toward the worker's channel). */
  data(chunk: Uint8Array): Promise<void> | void;
  /** The connection is over (whoever ended it). Called once. */
  closed(why: string): void;
}
/** One open connection to a destination. */
export interface Tunnel {
  /** Sends bytes to the destination; resolves when they have been handed to the socket (and it has room again). */
  write(chunk: Uint8Array): Promise<void>;
  /** The task's side has no more to send (the destination may still reply). */
  end(): void;
  /** Ends the connection now. */
  close(): void;
}
/** What a worker host gets for one attempt: it opens connections for the process in the sandbox. A refusal is thrown as `NetworkRefused` (the text goes to the process). */
export interface NetworkOpener {
  open(target: { readonly host: string; readonly port: number }, events: TunnelEvents): Promise<Tunnel>;
  /** Ends every connection of the attempt (the attempt ended or the process was stopped). */
  closeAll(why?: string): void;
}

export interface NetworkRelayOptions {
  readonly grants: GrantSource & { onRevoked?: (listener: (grant: GrantView) => void) => () => void };
  readonly resolve: NameResolver;
  /** Opens the socket to a checked address. Default: `net.connect`. A test points a public-looking address at a loopback server here; the address it is given is always the checked one. */
  readonly dial?: (address: string, port: number) => Socket;
  /** How often an open connection's grant is checked again (default 1000 ms). */
  readonly recheckMs?: number;
  readonly maxOpen?: number;
  readonly connectTimeoutMs?: number;
  readonly idleMs?: number;
  readonly maxLogged?: number;
  /** Told about a failure that is not a refusal (a log that could not be written at the end of a connection). Must not throw. */
  readonly onError?: (message: string) => void;
}

export const NETWORK_RELAY_DEFAULTS = { recheckMs: 1000, maxOpen: 16, connectTimeoutMs: 10_000, idleMs: 300_000 } as const;

interface Live { readonly socket: Socket; readonly grantId: string; close(by: NonNullable<ConnectionBody["endedBy"]>): void }

export class NetworkRelay {
  readonly #o: NetworkRelayOptions;
  readonly #live = new Set<Live>();
  readonly #stop: (() => void) | undefined;

  constructor(options: NetworkRelayOptions) {
    this.#o = options;
    this.#stop = options.grants.onRevoked?.((grant) => { for (const l of [...this.#live]) if (l.grantId === grant.id) l.close("revoked"); });
  }

  /** Stops listening for revokes and ends every connection. */
  close(): void { this.#stop?.(); for (const l of [...this.#live]) l.close("attempt"); }

  /** How many connections are open now (all attempts). */
  get open(): number { return this.#live.size; }

  forAttempt(ctx: NetworkContext): NetworkOpener {
    const mine = new Set<Live>();
    const o = this.#o;
    // Connections being admitted or connected count against the cap too (taken before the first wait, so opens at the same moment cannot all pass). `closeAll` (the process ended or was stopped) also ends a connection that was
    // still being made when it was called: each call starts a new generation, and an open begun in an older one is refused. A later process of the same sandbox (a runtime restart) opens connections as before.
    let pending = 0;
    let generation = 0;
    return {
      closeAll: () => { generation++; for (const l of [...mine]) l.close("attempt"); },
      open: async (target, events) => {
        const begun = generation;
        if (mine.size + pending >= (o.maxOpen ?? NETWORK_RELAY_DEFAULTS.maxOpen)) throw new NetworkRefused("too many connections are open for this attempt");
        pending++;
        let counted = true;
        const settle = (): void => { if (counted) { counted = false; pending--; } };
        try {
        const admitted = await admit(o.grants, ctx, target.host, target.port, { resolve: o.resolve, via: "relay", ...(o.maxLogged === undefined ? {} : { maxLogged: o.maxLogged }) });
        if (generation !== begun) {
          await o.grants.logClose(ctx.taskId, admitted.recordId, { outcome: "failed", endedBy: "attempt", bytesToTarget: 0, bytesFromTarget: 0, reason: "the attempt ended before the connection was made" }).catch(() => undefined);
          throw new NetworkRefused("the attempt has ended; no connection is made");
        }
        const socket = (o.dial ?? ((address, port) => netConnect({ host: address, port })))(admitted.address, admitted.port);
        socket.setNoDelay(true);
        let bytesTo = 0; let bytesFrom = 0; let ended = false; let ready = false;
        let endedBy: NonNullable<ConnectionBody["endedBy"]> = "target";
        let timer: ReturnType<typeof setInterval> | undefined;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: "closed" | "failed", reason?: string): void => {
          if (ended) return;
          ended = true;
          clearInterval(timer); clearTimeout(idle);
          mine.delete(live); this.#live.delete(live);
          socket.destroy();
          void o.grants.logClose(ctx.taskId, admitted.recordId, { outcome, endedBy, bytesToTarget: bytesTo, bytesFromTarget: bytesFrom, ...(reason === undefined ? {} : { reason }) }).catch((error: unknown) => { o.onError?.(`a connection record could not be completed: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`); });
          try { events.closed(reason ?? `closed by ${endedBy}`); } catch { /* the pipe is over */ }
        };
        const live: Live = { socket, grantId: admitted.grant.id, close: (by) => { endedBy = by; finish("closed", by === "revoked" ? "the grant was revoked" : by === "ended" ? "the grant ended with its task" : by === "attempt" ? "the attempt ended" : by === "idle" ? "idle too long" : undefined); } };
        settle(); mine.add(live); this.#live.add(live);
        const touch = (): void => { clearTimeout(idle); idle = setTimeout(() => live.close("idle"), o.idleMs ?? NETWORK_RELAY_DEFAULTS.idleMs); idle.unref?.(); };
        touch();
        // The grant is judged again while the connection is open: a revoke made in another process, or the end of the task, is noticed here.
        timer = setInterval(() => {
          void o.grants.check(ctx.taskId, admitted.host, admitted.port).then((c) => {
            if (!c.live) live.close(c.grant?.state === "granted" ? "ended" : "revoked");
          }, () => live.close("error"));
        }, o.recheckMs ?? NETWORK_RELAY_DEFAULTS.recheckMs);
        timer.unref?.();
        socket.on("data", (chunk: Buffer) => {
          bytesFrom += chunk.length; touch();
          socket.pause();
          void Promise.resolve().then(() => events.data(new Uint8Array(chunk))).catch(() => undefined).finally(() => { if (!ended) socket.resume(); });
        });
        socket.on("end", () => { endedBy = "target"; finish("closed"); });
        socket.on("close", () => { if (!ready) finish("failed", "the connection to the destination failed"); else finish("closed"); });
        socket.on("error", (error) => { if (!ready) { endedBy = "error"; finish("failed", `could not connect to ${admitted.host}:${admitted.port} (${(error as NodeJS.ErrnoException).code ?? "error"})`); } else { endedBy = "error"; finish("closed", `the connection broke (${(error as NodeJS.ErrnoException).code ?? "error"})`); } });
        await new Promise<void>((resolve, reject) => {
          const wait = setTimeout(() => { endedBy = "error"; finish("failed", `no answer from ${admitted.host}:${admitted.port} in time`); reject(new NetworkRefused(`no answer from ${admitted.host}:${admitted.port}`)); }, o.connectTimeoutMs ?? NETWORK_RELAY_DEFAULTS.connectTimeoutMs);
          wait.unref?.();
          socket.once("connect", () => { clearTimeout(wait); ready = true; resolve(); });
          socket.once("close", () => { clearTimeout(wait); if (!ready) reject(new NetworkRefused(`could not connect to ${admitted.host}:${admitted.port}`)); });
        });
        // The attempt ended while the connection was being made (its close found nothing of this one yet to end).
        if (generation !== begun && !ended) { live.close("attempt"); throw new NetworkRefused("the attempt has ended; no connection is made"); }
        return {
          write: (chunk) => new Promise<void>((resolve, reject) => {
            if (ended || socket.destroyed) return reject(new Error("the connection is closed"));
            bytesTo += chunk.length; touch();
            socket.write(chunk, (error) => (error === null || error === undefined ? resolve() : reject(error)));
          }),
          end: () => { if (!ended && !socket.destroyed) socket.end(); },
          close: () => { endedBy = "client"; finish("closed"); },
        };
        } finally { settle(); }
      },
    };
  }
}
