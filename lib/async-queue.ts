/**
 * A minimal async push/pull queue used to bridge callback-driven streaming
 * (e.g. onToken/onReasoning callbacks fired while reading an SSE response)
 * into an async generator that can `yield` each item as soon as it arrives,
 * rather than buffering everything until the underlying promise settles.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  /**
   * Close the queue with an error. A consumer already waiting on next()
   * is rejected immediately; a consumer that calls next() later gets the
   * error once the buffered items are drained.
   */
  fail(err: unknown): void {
    this.closed = true;
    if (this.waiters.length > 0) {
      while (this.waiters.length > 0) {
        this.waiters.shift()!.reject(err);
      }
      return;
    }
    this.error = err;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }
    if (this.closed) {
      if (this.error) {
        const err = this.error;
        this.error = null;
        throw err;
      }
      return { value: undefined as unknown as T, done: true };
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}
