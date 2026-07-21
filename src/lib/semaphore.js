export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(callback) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
    try { return await callback(); }
    finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
