import { createHmac, timingSafeEqual } from "node:crypto";

/** GitHub signs every delivery with the app's webhook secret; anything unsigned or tampered is rejected. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Runs jobs for the same key (one issue) one after another, jobs for different keys in parallel.
 * The webhook answers GitHub straight away; the work happens here in the background.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (key: string, err: unknown) => void = () => {}) {}

  push(key: string, job: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => this.onError(key, err));
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  /** Resolves once everything queued so far has finished (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all(this.tails.values());
  }
}
