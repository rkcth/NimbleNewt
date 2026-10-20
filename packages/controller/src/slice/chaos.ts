import type { ControllerStorage } from "../storage/types.js";

/** Thrown at the crash point and by everything the "dead" process tries afterwards. A real process would simply be gone. */
export class Crash extends Error {
  constructor(readonly point: string) {
    super(`crashed at ${point}`);
    this.name = "Crash";
  }
}

/**
 * Counts the durable boundaries of a run and kills the run at one of them (card S09). Every call to `hit(label)` is a boundary: a place where
 * a process could die with some effects done and others not. In a numbered run the hit with index `crashAt` kills the process: from then on
 * every hit and every wrapped storage call throws `Crash`, so nothing the code does after the "death" (error handlers, other steps) can touch
 * the database or the outside world. `revive` is the restart. `kill` replaces the throw with a real SIGKILL for child-process runs.
 */
export class Chaos {
  readonly labels: string[] = [];
  #crashAt: number | undefined;
  #dead: Crash | undefined;
  constructor(crashAt?: number, private readonly kill?: () => void) { this.#crashAt = crashAt; }

  get crashed(): boolean { return this.#dead !== undefined; }

  /** Throws if the process has died: everything outside the database (the blob folder, the conversation) checks this before it acts. */
  alive(): void { if (this.#dead !== undefined) throw this.#dead; }

  hit(label: string): void {
    if (this.#dead !== undefined) throw this.#dead;
    const index = this.labels.length;
    this.labels.push(label);
    if (this.#crashAt === index) {
      this.#dead = new Crash(`${index}:${label}`);
      this.kill?.();
      throw this.#dead;
    }
  }

  /** The process is back: no more crashes, and the dead state is cleared. */
  revive(): void {
    this.#crashAt = undefined;
    this.#dead = undefined;
  }

  /** The storage as the running process sees it: every write-like call (including taking the epoch) is a boundary before and after, and a dead process can do nothing. */
  wrap(storage: ControllerStorage): ControllerStorage {
    const guarded = new Set(["applyOperation", "claimDeliveries", "retryDelivery", "claimDueTimers", "acquireEpoch"]);
    return new Proxy(storage, {
      get: (target, name, receiver) => {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = (value as (...a: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          if (this.#dead !== undefined) throw this.#dead;
          if (!guarded.has(String(name))) return method(...args);
          const input = args[0] as { operationId?: string; destination?: string } | undefined;
          const tag = String(name) + (input?.operationId === undefined ? input?.destination === undefined ? "" : `:${input.destination}` : `:${input.operationId.split(":")[0]}`);
          this.hit(`before ${tag}`);
          const result = await method(...args);
          this.hit(`after ${tag}`);
          return result;
        };
      },
    });
  }
}
