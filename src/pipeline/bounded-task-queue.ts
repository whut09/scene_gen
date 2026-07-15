export class BoundedTaskQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Invalid queue concurrency: ${concurrency}`);
  }

  async run<T>(task: () => Promise<T>) {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.pending.shift()?.();
    }
  }
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>) {
  const queue = new BoundedTaskQueue(concurrency);
  return Promise.all(items.map((item, index) => queue.run(() => task(item, index))));
}
