import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonFilePaymentRepository } from './json-file-payment.repository';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Payment } from '../entities/payment.entity';

/**
 * Unit tests for `JsonFilePaymentRepository`.
 *
 * Each test uses a fresh temp file (under the OS temp directory) so
 * tests never touch the real `data/payments.json` used by the running
 * app. `onModuleInit()` is called manually since these tests
 * instantiate the class directly rather than through Nest's DI
 * container.
 */
describe('JsonFilePaymentRepository', () => {
    let tempFilePath: string;

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
    });

    afterEach(async () => {
        await fs.rm(tempFilePath, { force: true });
        await fs.rm(`${tempFilePath}.tmp`, { force: true });
    });

    it('initializes an empty data file if none exists yet', async () => {
        const repository = new JsonFilePaymentRepository(tempFilePath);
        await repository.onModuleInit();

        const all = await repository.findAll();
        expect(all).toEqual([]);

        const fileContents = await fs.readFile(tempFilePath, 'utf-8');
        expect(JSON.parse(fileContents)).toEqual([]);
    });

    it('creates a payment and persists it to disk', async () => {
        const repository = new JsonFilePaymentRepository(tempFilePath);
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
        const firstInstance = new JsonFilePaymentRepository(tempFilePath);
        await firstInstance.onModuleInit();
        await firstInstance.create(buildPayment({ id: 'payment-1' }));
        await firstInstance.create(buildPayment({ id: 'payment-2' }));

        const secondInstance = new JsonFilePaymentRepository(tempFilePath);
        await secondInstance.onModuleInit();

        const all = await secondInstance.findAll();
        expect(all).toHaveLength(2);
        expect(all.map((p) => p.id).sort()).toEqual(['payment-1', 'payment-2']);
    });

    it('restores Date objects (not strings) for createdAt/updatedAt after a reload', async () => {
        const firstInstance = new JsonFilePaymentRepository(tempFilePath);
        await firstInstance.onModuleInit();
        await firstInstance.create(buildPayment());

        const secondInstance = new JsonFilePaymentRepository(tempFilePath);
        await secondInstance.onModuleInit();

        const found = await secondInstance.findById('payment-1');
        expect(found?.createdAt).toBeInstanceOf(Date);
        expect(found?.updatedAt).toBeInstanceOf(Date);
    });

    it('returns null when a payment id does not exist', async () => {
        const repository = new JsonFilePaymentRepository(tempFilePath);
        await repository.onModuleInit();

        const found = await repository.findById('does-not-exist');
        expect(found).toBeNull();
    });

    it('overwrites the stored record when updating an existing payment', async () => {
        const repository = new JsonFilePaymentRepository(tempFilePath);
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
        const repository = new JsonFilePaymentRepository(tempFilePath);
        await repository.onModuleInit();

        const creates = Array.from({ length: 10 }, (_, i) =>
            repository.create(buildPayment({ id: `payment-${i}` })),
        );
        await Promise.all(creates);

        const all = await repository.findAll();
        expect(all).toHaveLength(10);

        const fileContents = JSON.parse(await fs.readFile(tempFilePath, 'utf-8'));
        expect(fileContents).toHaveLength(10);
    });
});