import {
    BadRequestException,
    CallHandler,
    ExecutionContext,
    HttpStatus,
    RequestTimeoutException,
} from '@nestjs/common';
import { firstValueFrom, Observable, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStore, IdempotencyLookup } from './idempotency-store';

/**
 * Unit tests for `IdempotencyInterceptor`.
 *
 * `IdempotencyStore` is mocked here (its own Redis-backed behavior is
 * covered by `idempotency-store.spec.ts`) so these tests focus purely
 * on the interceptor's claim/poll orchestration logic.
 */
describe('IdempotencyInterceptor', () => {
    let interceptor: IdempotencyInterceptor;
    let mockStore: {
        tryClaim: jest.Mock;
        lookup: jest.Mock;
        complete: jest.Mock;
        release: jest.Mock;
    };
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

    const buildHandler = (result: unknown): CallHandler => ({
        handle: () => of(result),
    });

    const buildFailingHandler = (error: Error): CallHandler => ({
        handle: () =>
            new Observable((subscriber) => {
                subscriber.error(error);
            }),
    });

    beforeEach(() => {
        mockStore = {
            tryClaim: jest.fn(),
            lookup: jest.fn(),
            complete: jest.fn(),
            release: jest.fn(),
        };
        interceptor = new IdempotencyInterceptor(mockStore as unknown as IdempotencyStore);
        mockResponse = { status: jest.fn() };
    });

    it('rejects the request with 400 when no Idempotency-Key header is present', () => {
        const context = buildContext(undefined);
        const handler = buildHandler({ id: 'payment-1' });
        const handleSpy = jest.spyOn(handler, 'handle');

        expect(() => interceptor.intercept(context, handler)).toThrow(
            BadRequestException,
        );
        expect(handleSpy).not.toHaveBeenCalled();
    });

    it('runs the handler and records the result when the claim succeeds', async () => {
        mockStore.tryClaim.mockResolvedValue(true);
        const context = buildContext('key-abc');
        const handler = buildHandler({ id: 'payment-1' });

        const result = await firstValueFrom(interceptor.intercept(context, handler));

        expect(result).toEqual({ id: 'payment-1' });
        expect(mockStore.complete).toHaveBeenCalledWith(
            expect.stringContaining('key-abc'),
            { id: 'payment-1' },
        );
        // A freshly-claimed, successful request never needs to poll.
        expect(mockStore.lookup).not.toHaveBeenCalled();
    });

    it('releases the claim and rethrows when the handler fails', async () => {
        mockStore.tryClaim.mockResolvedValue(true);
        const context = buildContext('key-abc');
        const handler = buildFailingHandler(new Error('boom'));

        await expect(
            firstValueFrom(interceptor.intercept(context, handler)),
        ).rejects.toThrow('boom');

        expect(mockStore.release).toHaveBeenCalledWith(
            expect.stringContaining('key-abc'),
        );
        expect(mockStore.complete).not.toHaveBeenCalled();
    });

    it('returns the cached result immediately when the key is already completed (retry after success)', async () => {
        mockStore.tryClaim.mockResolvedValue(false);
        mockStore.lookup.mockResolvedValue({
            state: 'completed',
            value: { id: 'payment-1' },
        } satisfies IdempotencyLookup);

        const context = buildContext('key-abc');
        const handler = buildHandler({ id: 'DIFFERENT-should-not-see-this' });
        const handleSpy = jest.spyOn(handler, 'handle');

        const result = await firstValueFrom(interceptor.intercept(context, handler));

        expect(handleSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ id: 'payment-1' });
        expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    });

    it('polls until a concurrent duplicate finishes, then returns its result', async () => {
        mockStore.tryClaim.mockResolvedValue(false);
        // Pending on the first two lookups, completed on the third —
        // simulates a concurrent duplicate still being processed.
        mockStore.lookup
            .mockResolvedValueOnce({ state: 'pending' })
            .mockResolvedValueOnce({ state: 'pending' })
            .mockResolvedValueOnce({
                state: 'completed',
                value: { id: 'payment-once-only' },
            });

        const context = buildContext('key-concurrent');
        const handler = buildHandler({ id: 'should-not-run' });
        const handleSpy = jest.spyOn(handler, 'handle');

        const result = await firstValueFrom(interceptor.intercept(context, handler));

        expect(handleSpy).not.toHaveBeenCalled();
        expect(mockStore.lookup).toHaveBeenCalledTimes(3);
        expect(result).toEqual({ id: 'payment-once-only' });
    });

    it('throws RequestTimeoutException if the claim disappears while polling (owner crashed)', async () => {
        mockStore.tryClaim.mockResolvedValue(false);
        mockStore.lookup.mockResolvedValue({ state: 'not-found' });

        const context = buildContext('key-crashed');
        const handler = buildHandler({ id: 'irrelevant' });

        await expect(
            firstValueFrom(interceptor.intercept(context, handler)),
        ).rejects.toThrow(RequestTimeoutException);
    });
});