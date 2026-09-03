import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { retries } from "./db/schema.js";
import { log } from "./logger.js";

export const RETRY_INTERVAL_MS = 30_000;
export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;

export type RetryHandler = (payload: Record<string, unknown>) => Promise<void>;

/** Thrown by handlers when the failure will never succeed; the job is dropped without retrying. */
export class PermanentError extends Error {
  override name = "PermanentError";
}

export function backoffMs(attempts: number, retryAfterMs?: number): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 5_000);
  return Math.max(exp, retryAfterMs ?? 0) + jitter;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export class RetryQueue {
  private handlers = new Map<string, RetryHandler>();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(private readonly db: Db) {}

  register(kind: string, handler: RetryHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Queue a failed job for later. First attempt already happened, so attempts starts at 1. */
  async enqueue(kind: string, payload: Record<string, unknown>, err: unknown, retryAfterMs?: number): Promise<void> {
    if (!this.handlers.has(kind)) log.warn("enqueueing retry with no registered handler", { kind });
    const next = new Date(Date.now() + backoffMs(1, retryAfterMs));
    await this.db.insert(retries).values({ kind, payload, attempts: 1, nextAttemptAt: next, lastError: errorMessage(err) });
    log.warn("queued for retry", { kind, nextAttemptAt: next.toISOString(), error: errorMessage(err) });
  }

  /**
   * Run `fn` now; on failure enqueue for retry (unless permanent). Never throws.
   * Use this as the entry point for every outbound side-effect.
   */
  async runOrEnqueue(kind: string, payload: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`no retry handler registered for ${kind}`);
    try {
      await handler(payload);
    } catch (err) {
      if (err instanceof PermanentError) {
        log.error("permanent failure, dropping", { kind, error: errorMessage(err) });
        return;
      }
      await this.enqueue(kind, payload, err, retryAfterFrom(err)).catch((e) => log.error("failed to enqueue retry", { kind, error: errorMessage(e) }));
    }
  }

  start(intervalMs = RETRY_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(now = new Date()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.db
        .select()
        .from(retries)
        .where(and(lte(retries.nextAttemptAt, now)))
        .orderBy(asc(retries.nextAttemptAt))
        .limit(50);
      for (const job of due) {
        const handler = this.handlers.get(job.kind);
        if (!handler) {
          log.error("dropping retry with unknown kind", { id: job.id, kind: job.kind });
          await this.db.delete(retries).where(eq(retries.id, job.id));
          continue;
        }
        try {
          await handler(job.payload);
          await this.db.delete(retries).where(eq(retries.id, job.id));
          log.info("retry succeeded", { id: job.id, kind: job.kind, attempts: job.attempts + 1 });
        } catch (err) {
          const attempts = job.attempts + 1;
          if (err instanceof PermanentError || attempts >= MAX_ATTEMPTS) {
            log.error("giving up on retry", { id: job.id, kind: job.kind, attempts, error: errorMessage(err), payload: job.payload });
            await this.db.delete(retries).where(eq(retries.id, job.id));
            continue;
          }
          const next = new Date(Date.now() + backoffMs(attempts, retryAfterFrom(err)));
          await this.db
            .update(retries)
            .set({ attempts, nextAttemptAt: next, lastError: errorMessage(err) })
            .where(eq(retries.id, job.id));
          log.warn("retry failed", { id: job.id, kind: job.kind, attempts, nextAttemptAt: next.toISOString(), error: errorMessage(err) });
        }
      }
    } catch (err) {
      log.error("retry drain crashed", { error: errorMessage(err) });
    } finally {
      this.draining = false;
    }
  }
}

/** Pull a Retry-After hint (ms) off Slack/Chatwoot rate-limit errors, if present. */
export function retryAfterFrom(err: unknown): number | undefined {
  const e = err as { retryAfter?: number; data?: { retryAfter?: number }; headers?: Record<string, string> } | undefined;
  const seconds = e?.retryAfter ?? e?.data?.retryAfter ?? (e?.headers?.["retry-after"] ? Number(e.headers["retry-after"]) : undefined);
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
