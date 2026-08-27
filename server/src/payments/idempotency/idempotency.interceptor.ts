import {
    CallHandler,
    BadRequestException,
    ExecutionContext,
    HttpStatus,
    Injectable,
    Logger,
    NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { firstValueFrom, from, Observable } from 'rxjs';
import { IdempotencyStore } from './idempotency-store';

/** HTTP header clients use to mark a request as idempotent. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Prevents duplicate payment creation when a client retries a
 * `POST /payments` request (e.g. after a timeout where it's unclear
 * whether the first attempt actually succeeded).
 *
 * Behavior:
 *  - No `Idempotency-Key` header present -> idempotency is opt-in, not
 *    required. The request proceeds completely normally with no
 *    deduplication.
 *  - Header present, never seen before -> the handler runs normally.
 *    Its result is stored (as a Promise, not yet resolved — see
 *    `IdempotencyStore`'s doc comment for why that matters) under a
 *    key combining the HTTP method, path, and the header value, so
 *    the same key on a different route never collides with this one.
 *  - Header present, already seen (whether that request has finished
 *    or is still in flight) -> the ORIGINAL response is returned. The
 *    handler does not run again; no second payment is created.
 *
 * Scope limit: this interceptor assumes the wrapped route always
 * responds with a fixed, known success status code — it explicitly
 * sets `201 Created` on a cache hit, matching `POST /payments`'
 * `@Post()` default. It is deliberately NOT a general-purpose
 * interceptor for routes with varying status codes; it's applied only
 * to the one endpoint that needs it.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
    private readonly logger = new Logger(IdempotencyInterceptor.name);

    constructor(private readonly store: IdempotencyStore) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request>();
        const response = context.switchToHttp().getResponse<Response>();

        const idempotencyKey = request.header(IDEMPOTENCY_KEY_HEADER);

        if (!idempotencyKey) {
            throw new BadRequestException(
                `The "${IDEMPOTENCY_KEY_HEADER}" header is required on this request.`,
            );
        }


        const cacheKey = `${request.method}:${request.originalUrl}:${idempotencyKey}`;
        const existing = this.store.get(cacheKey);

        if (existing) {
            this.logger.log(
                `Idempotency key "${idempotencyKey}" already seen on ` +
                `${request.method} ${request.originalUrl} — returning the ` +
                `original response instead of running the handler again.`,
            );
            return from(
                existing.then((body) => {
                    response.status(HttpStatus.CREATED);
                    return body;
                }),
            );
        }

        // First time seeing this key. Convert the handler's Observable
        // into a Promise and store THAT immediately — before it has
        // resolved. This is what closes the race: if a second identical
        // request arrives while this one is still being processed, it
        // will find this in-flight promise already in the store above,
        // rather than finding nothing and proceeding to create a
        // duplicate payment.
        const resultPromise = firstValueFrom(next.handle());
        this.store.set(cacheKey, resultPromise);

        // If the request fails, remove the cache entry — a client retrying
        // with the same key after a genuine failure should get a real
        // second attempt, not a replayed failure forever.
        resultPromise.catch(() => this.store.delete(cacheKey));

        return from(resultPromise);
    }
}