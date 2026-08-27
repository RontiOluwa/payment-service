import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonFilePaymentRepository } from './json-file-payment.repository';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Payment } from '../entities/payment.entity';

/**
 * Minimal in-memory stand-in for the Redis client, implementing only
 * the two commands `JsonFilePaymentRepository`'s file lock actually
 * uses (`set` with NX semantics, `del`). This is enough to correctly
 * exercise the real locking logic (including genuinely serializing
 * concurrent calls) without a real Redis connection — unlike the
 * repository's own class, which legitimately needs real Redis in
 * production since the lock must be visible across processes; here, a
 * single shared fake instance stands in for "the one Redis both
 * simulated instances would talk to."
 */
class FakeRedisLockClient {
  private readonly held = new Set<string>();

  async set(
    key: string,
    _value: string,
    ..._rest: unknown[]
  ): Promise<'OK' | null> {
    if (this.held.has(key)) {
      return null;
    }
    this.held.add(key);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.held.delete(key) ? 1 : 0;
  }
}

/**
 * Unit tests for `JsonFilePaymentRepository`.
 *
 * Each test uses a fresh temp file (under the OS temp directory) so
 * tests never touch the real `data/payments.json` used by the running
 * app, and can't interfere with each other. `onModuleInit()` is
 * called manually here since these tests instantiate the class
 * directly rather than through Nest's DI container (which is what
 * normally triggers that lifecycle hook).
 *
 * A single `FakeRedisLockClient` is shared across BOTH "instances" in
 * the restart-simulation tests below (`firstInstance`/`secondInstance`),
 * mirroring how two real processes would both talk to the SAME real
 * Redis for the file lock — using two separate fakes there would test
 * something that doesn't reflect how this class is actually used.
 */
describe('JsonFilePaymentRepository', () => {
  let tempFilePath: string;
  let fakeRedis: FakeRedisLockClient;

  const buildPayment = (overrides: Partial<Payment> = {}): Payment => ({
    id: 'payment-1',
    amount: 1000,
    currency: 'NGN',
    status: PaymentStatus.PENDING,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    tempFilePath = path.join(
      os.tmpdir(),
      `payments-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    fakeRedis = new FakeRedisLockClient();
  });

  afterEach(async () => {
    // Clean up the data file and any leftover uniquely-named temp
    // files from this test's writes.
    const dir = path.dirname(tempFilePath);
    const base = path.basename(tempFilePath);
    const entries = await fs.readdir(dir).catch(() => []);
    await Promise.all(
      entries
        .filter((name) => name === base || name.startsWith(`${base}.`))
        .map((name) => fs.rm(path.join(dir, name), { force: true })),
    );
  });

  function buildRepository(): JsonFilePaymentRepository {
    return new JsonFilePaymentRepository(tempFilePath, fakeRedis as never);
  }

  it('initializes an empty data file if none exists yet', async () => {
    const repository = buildRepository();
    await repository.onModuleInit();

    const all = await repository.findAll();
    expect(all).toEqual([]);

    const fileContents = await fs.readFile(tempFilePath, 'utf-8');
    expect(JSON.parse(fileContents)).toEqual([]);
  });

  it('creates a payment and persists it to disk', async () => {
    const repository = buildRepository();
    await repository.onModuleInit();

    const payment = buildPayment();
    await repository.create(payment);

    const found = await repository.findById(payment.id);
    expect(found).toEqual(payment);

    const fileContents = JSON.parse(await fs.readFile(tempFilePath, 'utf-8'));
    expect(fileContents).toHaveLength(1);
    expect(fileContents[0].id).toBe(payment.id);
  });

  it('survives a "restart" — a new instance reads back previously written data', async () => {
    const firstInstance = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    await firstInstance.onModuleInit();
    await firstInstance.create(buildPayment({ id: 'payment-1' }));
    await firstInstance.create(buildPayment({ id: 'payment-2' }));

    // Simulate a process restart: a brand-new instance pointed at the
    // same file, with no shared in-memory state from the first one —
    // but the SAME (fake) Redis, matching how two real processes
    // would both point at the same real Redis for the file lock.
    const secondInstance = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    await secondInstance.onModuleInit();

    const all = await secondInstance.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id).sort()).toEqual(['payment-1', 'payment-2']);
  });

  it('restores Date objects (not strings) for createdAt/updatedAt after a reload', async () => {
    const firstInstance = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    await firstInstance.onModuleInit();
    await firstInstance.create(buildPayment());

    const secondInstance = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    await secondInstance.onModuleInit();

    const found = await secondInstance.findById('payment-1');
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
  });

  it('returns null when a payment id does not exist', async () => {
    const repository = buildRepository();
    await repository.onModuleInit();

    const found = await repository.findById('does-not-exist');
    expect(found).toBeNull();
  });

  it('overwrites the stored record when updating an existing payment', async () => {
    const repository = buildRepository();
    await repository.onModuleInit();

    const payment = buildPayment();
    await repository.create(payment);

    const updated: Payment = {
      ...payment,
      status: PaymentStatus.COMPLETED,
      updatedAt: new Date('2026-01-01T00:05:00.000Z'),
    };
    await repository.update(updated);

    const found = await repository.findById(payment.id);
    expect(found?.status).toBe(PaymentStatus.COMPLETED);
  });

  it('serializes concurrent writes without corrupting the file', async () => {
    const repository = buildRepository();
    await repository.onModuleInit();

    // Fire off 10 concurrent creates — if the lock weren't correctly
    // serializing these, this is exactly the scenario that could
    // corrupt the JSON file or silently drop records via a lost write.
    const creates = Array.from({ length: 10 }, (_, i) =>
      repository.create(buildPayment({ id: `payment-${i}` })),
    );
    await Promise.all(creates);

    const all = await repository.findAll();
    expect(all).toHaveLength(10);

    // The file itself must be valid, complete JSON — this would throw
    // if a write had been interleaved/corrupted.
    const fileContents = JSON.parse(await fs.readFile(tempFilePath, 'utf-8'));
    expect(fileContents).toHaveLength(10);
  });

  it('does not lose a write from a second "process" racing a first (the cross-process lock actually works)', async () => {
    // Two separate repository instances sharing the same fake Redis
    // (simulating two real processes sharing the same real Redis) —
    // this is the exact scenario that previously caused data loss:
    // one "process" reads, then writes, while the other does the
    // same thing at nearly the same moment.
    const processA = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    const processB = new JsonFilePaymentRepository(
      tempFilePath,
      fakeRedis as never,
    );
    await processA.onModuleInit();

    await Promise.all([
      processA.create(buildPayment({ id: 'from-a' })),
      processB.create(buildPayment({ id: 'from-b' })),
    ]);

    const all = await processA.findAll();
    expect(all.map((p) => p.id).sort()).toEqual(['from-a', 'from-b']);
  });
});
