export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(callback, { signal } = {}) {
    signal?.throwIfAborted();
    let acquiredFromQueue = false;
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        acquiredFromQueue = true;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (signal?.aborted) {
      if (acquiredFromQueue) this.waiters.shift()?.();
      signal.throwIfAborted();
    }
    this.active++;
    try { return await callback(); }
    finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
