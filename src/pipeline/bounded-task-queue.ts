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

export async function mapWithConcurrencyUntilError<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  externalSignal?: AbortSignal,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Invalid queue concurrency: ${concurrency}`);
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  let nextIndex = 0;
  let firstError: unknown;
  const results = new Array<R>(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index], index, signal);
      } catch (error) {
        firstError ??= error;
        controller.abort(error);
        return;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError) throw firstError;
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error ? externalSignal.reason : new Error("Task queue aborted.");
  return results;
}
