import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/** Sentinel value stored while a request with a given key is still being processed. */
const PENDING_SENTINEL = '__PENDING__';

/**
 * How long a "claim" on a key lasts before it's considered abandoned
 * (e.g. the process crashed mid-request) and eligible to be reclaimed.
 * Kept short — payment creation itself is fast; this is not the delay
 * for the asynchronous payment processing that happens afterward.
 */
const PENDING_TTL_SECONDS = 30;

/**
 * How long a COMPLETED result is cached for, once known. 24 hours
 * matches the convention real payment gateways (e.g. Stripe) use for
 * idempotency keys — long enough to protect against a delayed retry,
 * short enough that the store doesn't grow forever.
 */
const RESULT_TTL_SECONDS = 60 * 60 * 24;

/** Possible outcomes of reading a key's current value. */
export type IdempotencyLookup =
  | { state: 'not-found' }
  | { state: 'pending' }
  | { state: 'completed'; value: unknown };

/**
 * Redis-backed store of idempotent request results, keyed by a string
 * combining the HTTP method, path, and the client's `Idempotency-Key`
 * header value.
 *
 * This replaces an earlier in-memory `Map`-based version. That
 * implementation had two real production gaps: it was wiped on every
 * process restart (so a key could "disappear" even though the payment
 * it protected had already durably persisted to disk, defeating the
 * whole point of idempotency), and it wouldn't work at all if this API
 * ever ran as more than one instance, since each instance would have
 * its own separate `Map`. Redis — already required by this project for
 * BullMQ — fixes both: the store is durable and shared across any
 * number of instances.
 *
 * Redis can't hold a live JS `Promise` (only strings), so unlike the
 * old `Map` version, concurrency here is handled via a distributed
 * lock pattern instead of storing an in-flight promise directly — see
 * `tryClaim` and `IdempotencyInterceptor` for how the two work
 * together.
 */
@Injectable()
export class IdempotencyStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Attempts to atomically claim `key` as "in progress". Uses Redis's
   * `SET ... NX` (set only if the key does not already exist), which
   * is atomic — two instances racing to claim the same key can never
   * both succeed.
   *
   * @returns `true` if this call claimed the key (the caller should
   *   proceed to run the handler); `false` if someone else already
   *   claimed or completed it first.
   */
  async tryClaim(key: string): Promise<boolean> {
    const result = await this.redis.set(
      key,
      PENDING_SENTINEL,
      'EX',
      PENDING_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  /** Reads the current state of `key`. */
  async lookup(key: string): Promise<IdempotencyLookup> {
    const raw = await this.redis.get(key);

    if (raw === null) {
      return { state: 'not-found' };
    }
    if (raw === PENDING_SENTINEL) {
      return { state: 'pending' };
    }
    return { state: 'completed', value: JSON.parse(raw) };
  }

  /**
   * Records the final result for `key`, replacing the pending lock
   * with the actual response body, kept for `RESULT_TTL_SECONDS`.
   */
  async complete(key: string, value: unknown): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', RESULT_TTL_SECONDS);
  }

  /**
   * Removes `key` entirely. Used when the handler fails, so a client
   * retrying with the same key after a genuine failure gets a real
   * second attempt rather than being stuck behind a dead claim.
   */
  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
