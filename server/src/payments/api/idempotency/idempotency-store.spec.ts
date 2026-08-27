import { IdempotencyStore } from './idempotency-store';

/**
 * Unit tests for `IdempotencyStore`.
 *
 * The Redis client is mocked with just the three commands this class
 * actually uses (`set`, `get`, `del`) rather than a real Redis
 * connection — this keeps the test suite fast and dependency-free.
 * Live behavior against a real Redis instance was verified manually
 * during development (see the commit description).
 */
describe('IdempotencyStore', () => {
  let store: IdempotencyStore;
  let mockRedis: { set: jest.Mock; get: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    mockRedis = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    };
    store = new IdempotencyStore(mockRedis as any);
  });

  describe('tryClaim', () => {
    it('returns true when the SET NX succeeds (key was unclaimed)', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const claimed = await store.tryClaim('key-1');

      expect(claimed).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key-1',
        '__PENDING__',
        'EX',
        30,
        'NX',
      );
    });

    it('returns false when the SET NX fails (key already claimed)', async () => {
      mockRedis.set.mockResolvedValue(null);

      const claimed = await store.tryClaim('key-1');

      expect(claimed).toBe(false);
    });
  });

  describe('lookup', () => {
    it('returns not-found when the key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await store.lookup('key-1');

      expect(result).toEqual({ state: 'not-found' });
    });

    it('returns pending when the key holds the sentinel value', async () => {
      mockRedis.get.mockResolvedValue('__PENDING__');

      const result = await store.lookup('key-1');

      expect(result).toEqual({ state: 'pending' });
    });

    it('returns the parsed completed value when the key holds a result', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ id: 'payment-1' }));

      const result = await store.lookup('key-1');

      expect(result).toEqual({
        state: 'completed',
        value: { id: 'payment-1' },
      });
    });
  });

  describe('complete', () => {
    it('stores the JSON-serialized result with the completed TTL', async () => {
      await store.complete('key-1', { id: 'payment-1' });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'key-1',
        JSON.stringify({ id: 'payment-1' }),
        'EX',
        60 * 60 * 24,
      );
    });
  });

  describe('release', () => {
    it('deletes the key', async () => {
      await store.release('key-1');

      expect(mockRedis.del).toHaveBeenCalledWith('key-1');
    });
  });
});
