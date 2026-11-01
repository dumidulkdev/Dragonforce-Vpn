/** Serializes network changes; a newer request cancels any older connection attempt. */
export class ConnectionQueue {
  private pending: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();

  replace<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (const controller of this.controllers) controller.abort(new Error('Connection cancelled'));
    return this.enqueue(operation);
  }

  enqueue<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const result = this.pending.then(() => operation(controller.signal));
    this.pending = result.catch(() => undefined).finally(() => this.controllers.delete(controller));
    return result;
  }
}

/** Only race read-only work. Process/route changes must finish before cleanup starts. */
export function waitForConnectionTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
