import { CallHandler, ExecutionContext, HttpStatus } from '@nestjs/common';
import { firstValueFrom, Observable, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStore } from './idempotency-store';

/**
 * Unit tests for `IdempotencyInterceptor`.
 *
 * `ExecutionContext` and `CallHandler` are mocked with just enough
 * shape to satisfy what the interceptor actually calls. A real
 * `IdempotencyStore` instance is used (not mocked) since the store's
 * own `Map` behavior is exactly what makes the concurrency test below
 * meaningful — mocking it away would test nothing real.
 */
describe('IdempotencyInterceptor', () => {
    let interceptor: IdempotencyInterceptor;
    let store: IdempotencyStore;
    let mockResponse: { status: jest.Mock };

    const buildContext = (headerValue: string | undefined): ExecutionContext => {
        const mockRequest = {
            method: 'POST',
            originalUrl: '/payments',
            header: (name: string) =>
                name.toLowerCase() === 'idempotency-key' ? headerValue : undefined,
        };

        return {
            switchToHttp: () => ({
                getRequest: () => mockRequest,
                getResponse: () => mockResponse,
            }),
        } as unknown as ExecutionContext;
    };

    /** A handler that emits `result` immediately. */
    const buildHandler = (result: unknown): CallHandler => ({
        handle: () => of(result),
    });

    /** A handler that emits `result` after `delayMs`, and reports how many times it actually ran. */
    const buildDelayedHandler = (
        result: unknown,
        delayMs: number,
        onInvoke: () => void,
    ): CallHandler => ({
        handle: () =>
            new Observable((subscriber) => {
                onInvoke();
                setTimeout(() => {
                    subscriber.next(result);
                    subscriber.complete();
                }, delayMs);
            }),
    });

    /** A handler that always fails. */
    const buildFailingHandler = (error: Error): CallHandler => ({
        handle: () =>
            new Observable((subscriber) => {
                subscriber.error(error);
            }),
    });

    beforeEach(() => {
        store = new IdempotencyStore();
        interceptor = new IdempotencyInterceptor(store);
        mockResponse = { status: jest.fn() };
    });

    it('passes the request through untouched when no Idempotency-Key header is present', async () => {
        const context = buildContext(undefined);
        const handler = buildHandler({ id: 'payment-1' });
        const handleSpy = jest.spyOn(handler, 'handle');

        const result = await firstValueFrom(interceptor.intercept(context, handler));

        expect(handleSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ id: 'payment-1' });
        expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('runs the handler normally on the first request with a given key', async () => {
        const context = buildContext('key-abc');
        const handler = buildHandler({ id: 'payment-1' });

        const result = await firstValueFrom(interceptor.intercept(context, handler));

        expect(result).toEqual({ id: 'payment-1' });
    });

    it('returns the original response (without re-running the handler) for a repeated key', async () => {
        const context = buildContext('key-abc');
        const firstHandler = buildHandler({ id: 'payment-1' });

        await firstValueFrom(interceptor.intercept(context, firstHandler));

        const secondHandler = buildHandler({ id: 'DIFFERENT-should-not-see-this' });
        const secondHandleSpy = jest.spyOn(secondHandler, 'handle');

        const secondResult = await firstValueFrom(
            interceptor.intercept(context, secondHandler),
        );

        // The second handler must never actually run.
        expect(secondHandleSpy).not.toHaveBeenCalled();
        // The client gets back the ORIGINAL result, not a new one.
        expect(secondResult).toEqual({ id: 'payment-1' });
        // The cache-hit path explicitly sets the known success status.
        expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    });

    it('does not create a duplicate when two identical requests race concurrently', async () => {
        const context = buildContext('key-concurrent');
        let handlerInvocations = 0;
        const slowHandler = buildDelayedHandler(
            { id: 'payment-once-only' },
            20,
            () => {
                handlerInvocations += 1;
            },
        );

        // Fire two "requests" with the same key at effectively the same
        // time — before either has had a chance to finish.
        const [resultA, resultB] = await Promise.all([
            firstValueFrom(interceptor.intercept(context, slowHandler)),
            firstValueFrom(interceptor.intercept(context, slowHandler)),
        ]);

        // The handler's underlying logic only actually ran once — the
        // second call found the in-flight promise already in the store
        // and awaited it, rather than invoking the handler a second time.
        expect(handlerInvocations).toBe(1);
        expect(resultA).toEqual({ id: 'payment-once-only' });
        expect(resultB).toEqual({ id: 'payment-once-only' });
    });

    it('removes the cache entry if the handler fails, allowing a genuine retry', async () => {
        const context = buildContext('key-failure');
        const failingHandler = buildFailingHandler(new Error('downstream failure'));

        await expect(
            firstValueFrom(interceptor.intercept(context, failingHandler)),
        ).rejects.toThrow('downstream failure');

        // Give the store's cleanup .catch() a microtask to run before the
        // next request checks the store.
        await new Promise((resolve) => setImmediate(resolve));

        const succeedingHandler = buildHandler({ id: 'payment-retry-succeeded' });
        const result = await firstValueFrom(
            interceptor.intercept(context, succeedingHandler),
        );

        expect(result).toEqual({ id: 'payment-retry-succeeded' });
    });
});