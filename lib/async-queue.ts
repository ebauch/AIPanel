/**
 * A minimal async push/pull queue used to bridge callback-driven streaming
 * (e.g. onToken/onReasoning callbacks fired while reading an SSE response)
 * into an async generator that can `yield` each item as soon as it arrives,
 * rather than buffering everything until the underlying promise settles.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: undefined as unknown as T, done: true });
    }
  }

  fail(err: unknown): void {
    this.error = err;
    this.close();
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
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}
