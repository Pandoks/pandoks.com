// Runs a handler on deliveries with the same settle rules as the Go and Python workers.
import { MAX_DELAY, backoff, sleep, type Delivery, type Queue } from './envelope.ts';

const HANDLER_MARGIN = 10;
const POLL_ERROR_DELAY = 1;

/** A handler error the worker acks instead of retrying, like a malformed payload. */
export class Permanent extends Error {}

/** A handler error the worker retries after delay seconds, clamped to 0 through MAX_DELAY. */
export class RetryAfter extends Error {
  delay: number;

  constructor(delay: number, message?: string) {
    super(message);
    this.delay = delay;
  }
}

/**
 * Runs handle on up to concurrency deliveries at once. A handler that resolves is acked;
 * Permanent is acked and logged; RetryAfter is retried after its delay; any other error is
 * retried after backoff. The handler's signal aborts 10 s before the delivery's deadline (halfway
 * there for a shorter lease) or on shutdown. run resolves once signal aborts, what its last
 * receive returned is released, and the running handlers have settled.
 */
export class Worker {
  queue: Queue;
  handle: (delivery: Delivery, signal: AbortSignal) => Promise<void>;
  concurrency: number;

  constructor(options: Pick<Worker, 'queue' | 'handle' | 'concurrency'>) {
    this.queue = options.queue;
    this.handle = options.handle;
    this.concurrency = options.concurrency;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.concurrency < 1) {
      throw new Error('queue worker: concurrency must be at least 1');
    }
    const running = new Set<Promise<void>>();
    while (!signal.aborted) {
      if (running.size === this.concurrency) {
        await Promise.race(running);
        continue;
      }
      let deliveries: Delivery[];
      try {
        deliveries = await this.queue.receive(this.concurrency - running.size, signal);
      } catch (error) {
        if (signal.aborted) break;
        console.error('queue receive failed', error);
        await sleep(POLL_ERROR_DELAY, signal);
        continue;
      }
      if (signal.aborted) {
        await this.queue.retry(0, ...deliveries).catch((error: unknown) => {
          console.error('queue release failed', error);
        });
        break;
      }
      for (const delivery of deliveries) {
        const settled = this.process(delivery, signal).finally(() => running.delete(settled));
        running.add(settled);
      }
    }
    await Promise.all(running);
  }

  private async process(delivery: Delivery, signal: AbortSignal): Promise<void> {
    const untilDeadline = delivery.deadline.getTime() - Date.now();
    const remaining = Math.floor(
      untilDeadline - Math.min(HANDLER_MARGIN * 1000, untilDeadline / 2)
    );
    const handlerSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(remaining, 0))]);
    const name = `${delivery.id} (${delivery.type}) attempt ${delivery.attempt}`;
    try {
      try {
        await this.handle(delivery, handlerSignal);
      } catch (error) {
        if (error instanceof Permanent) {
          console.error(`queue message ${name} failed permanently`, error);
          return await this.queue.ack(delivery);
        }
        if (error instanceof RetryAfter) {
          console.warn(`queue message ${name} retried in ${error.delay}s`, error);
          return await this.queue.retry(Math.min(Math.max(error.delay, 0), MAX_DELAY), delivery);
        }
        console.error(`queue message ${name} failed`, error);
        return await this.queue.retry(backoff(delivery.attempt), delivery);
      }
      await this.queue.ack(delivery);
    } catch (error) {
      console.error(`queue settle of ${delivery.id} failed`, error);
    }
  }
}
