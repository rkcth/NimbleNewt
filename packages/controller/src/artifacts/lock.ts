/**
 * A read-write lock for one process: any number of shared holders, or one exclusive holder, in arrival order (a waiting exclusive request
 * is not starved by later shared ones). Publication holds it shared from the first byte stored until the manifest is committed; orphan
 * cleanup holds it exclusive, so cleanup never sees a blob that a publication in this process has stored but not yet recorded.
 */
export class ReadWriteLock {
  #readers = 0;
  #writing = false;
  readonly #queue: { write: boolean; go: () => void }[] = [];

  shared<T>(run: () => Promise<T>): Promise<T> { return this.#run(false, run); }
  exclusive<T>(run: () => Promise<T>): Promise<T> { return this.#run(true, run); }

  async #run<T>(write: boolean, run: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => { this.#queue.push({ write, go }); this.#grant(); });
    try {
      return await run();
    } finally {
      if (write) this.#writing = false; else this.#readers -= 1;
      this.#grant();
    }
  }

  #grant(): void {
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined || this.#writing) return;
      if (next.write ? this.#readers > 0 : false) return;
      this.#queue.shift();
      if (next.write) this.#writing = true; else this.#readers += 1;
      next.go();
      if (next.write) return;
    }
  }
}
