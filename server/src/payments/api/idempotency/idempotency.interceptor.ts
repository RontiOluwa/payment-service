import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { firstValueFrom, from, Observable } from 'rxjs';
import { IdempotencyStore } from './idempotency-store';

/** HTTP header clients use to mark a request as idempotent. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** How often to re-check a key that's still "pending" (another request owns it). */
const POLL_INTERVAL_MS = 100;

/**
 * Maximum number of poll attempts before giving up and telling the
 * client to retry later, rather than waiting forever. Payment
 * creation itself is fast (it only saves a record and enqueues a
 * job — it does NOT wait for the 1-3s asynchronous processing
 * simulation), so 2 seconds total is generous headroom, not a tight
 * timeout.
 */
const MAX_POLL_ATTEMPTS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prevents duplicate payment creation when a client retries a
 * `POST /payments` request (e.g. after a timeout where it's unclear
 * whether the first attempt actually succeeded).
 *
 * The `Idempotency-Key` header is REQUIRED on every request this
 * interceptor guards — a request without it is rejected with `400`
 * before the handler ever runs. An idempotency mechanism clients can
 * simply opt out of by omitting a header isn't a guarantee, it's a
 * courtesy — making it mandatory means every payment created through
 * this API is provably deduplicated, with no gap.
 *
 * Backed by `IdempotencyStore` (Redis), this works correctly even
 * across multiple instances of this API and survives a process
 * restart — see that class's doc comment for why that matters and
 * what it replaced.
 *
 * Flow for a given key:
 *  1. Try to atomically CLAIM the key (`IdempotencyStore.tryClaim`).
 *  2. Claimed -> this request owns it: run the handler, then record
 *     the result (or release the claim entirely on failure, so a
 *     retry after a genuine failure is a real retry).
 *  3. Not claimed -> someone else (possibly a concurrent duplicate
 *     request, possibly a completed request) already holds this key.
 *     Poll briefly: a `pending` state means a concurrent duplicate is
 *     still being processed, so we wait for it to finish rather than
 *     running the handler a second time; a `completed` state means
 *     this is a retry after success, so the original result is
 *     returned immediately.
 *
 * Scope limit: this interceptor assumes the wrapped route always
 * responds with a fixed, known success status code — it explicitly
 * sets `201 Created`, matching `POST /payments`' `@Post()` default.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly store: IdempotencyStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const idempotencyKey = request.header(IDEMPOTENCY_KEY_HEADER);

    if (!idempotencyKey) {
      throw new BadRequestException(
        `The "${IDEMPOTENCY_KEY_HEADER}" header is required on this request.`,
      );
    }

    const cacheKey = `idempotency:${request.method}:${request.originalUrl}:${idempotencyKey}`;

    return from(this.handleWithIdempotency(cacheKey, idempotencyKey, next, response));
  }

  private async handleWithIdempotency(
    cacheKey: string,
    idempotencyKey: string,
    next: CallHandler,
    response: Response,
  ): Promise<unknown> {
    const claimed = await this.store.tryClaim(cacheKey);

    if (claimed) {
      try {
        const result = await firstValueFrom(next.handle());
        await this.store.complete(cacheKey, result);
        return result;
      } catch (error) {
        // A genuine failure — release the claim so a retry with the
        // same key gets a real second attempt, not a dead lock.
        await this.store.release(cacheKey);
        throw error;
      }
    }

    this.logger.log(
      `Idempotency key "${idempotencyKey}" already claimed — waiting for ` +
        `its result instead of running the handler again.`,
    );
    const value = await this.waitForCompletion(cacheKey);
    response.status(HttpStatus.CREATED);
    return value;
  }

  /**
   * Polls `cacheKey` until it resolves to a completed result. Used
   * when this request did NOT win the claim — either a concurrent
   * duplicate is still being processed (state stays `pending` for a
   * short while), or a previous request already completed (state is
   * immediately `completed`).
   */
  private async waitForCompletion(cacheKey: string): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const lookup = await this.store.lookup(cacheKey);

      if (lookup.state === 'completed') {
        return lookup.value;
      }

      if (lookup.state === 'not-found') {
        // The claim expired (e.g. the owning request's process
        // crashed) before it ever completed. There's no result to
        // return — the safest thing is to tell the client to retry,
        // not to silently proceed as if this were a fresh request.
        throw new RequestTimeoutException(
          'The original request for this idempotency key did not ' +
            'complete. Please retry.',
        );
      }

      // Still pending — wait briefly and check again.
      await sleep(POLL_INTERVAL_MS);
    }

    throw new RequestTimeoutException(
      'Timed out waiting for the original request with this idempotency ' +
        'key to complete. Please retry.',
    );
  }
}
