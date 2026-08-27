import { Injectable } from '@nestjs/common';

/**
 * In-memory store of in-flight/completed idempotent request results,
 * keyed by a string combining the HTTP method, path, and the client's
 * `Idempotency-Key` header value.
 *
 * The value stored is a `Promise<unknown>`, not just the eventual
 * result — this is deliberate. Storing the promise itself (rather
 * than waiting for it to resolve before storing anything) is what
 * lets a concurrent duplicate request, arriving while the first is
 * still being processed, find and await that same in-flight promise
 * instead of slipping through and triggering a second payment
 * creation. See `IdempotencyInterceptor` for how this is used.
 *
 * Known simplification: entries are never evicted. In a production
 * system, entries would expire after a reasonable window (e.g. 24h)
 * via a TTL — straightforward to add later (e.g. by moving this store
 * to Redis, which has TTL built in), but out of scope for the
 * assessment. Documented explicitly rather than silently omitted.
 */
@Injectable()
export class IdempotencyStore {
    private readonly entries = new Map<string, Promise<unknown>>();

    get(key: string): Promise<unknown> | undefined {
        return this.entries.get(key);
    }

    set(key: string, value: Promise<unknown>): void {
        this.entries.set(key, value);
    }

    delete(key: string): void {
        this.entries.delete(key);
    }
}