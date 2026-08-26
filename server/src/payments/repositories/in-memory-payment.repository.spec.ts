import { InMemoryPaymentRepository } from './in-memory-payment.repository';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Payment } from '../entities/payment.entity';

/**
 * Unit tests for `InMemoryPaymentRepository`.
 *
 * These verify the repository's own behavior in isolation, before
 * `PaymentsService` is built on top of it in the next step. Catching
 * a bug in the storage layer here is far cheaper than chasing it
 * later through a service-level test.
 */
describe('InMemoryPaymentRepository', () => {
    let repository: InMemoryPaymentRepository;

    const buildPayment = (overrides: Partial<Payment> = {}): Payment => ({
        id: 'payment-1',
        amount: 1000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    });

    beforeEach(() => {
        repository = new InMemoryPaymentRepository();
    });

    it('stores and retrieves a payment by id', async () => {
        const payment = buildPayment();

        await repository.create(payment);
        const found = await repository.findById(payment.id);

        expect(found).toEqual(payment);
    });

    it('returns null when a payment id does not exist', async () => {
        const found = await repository.findById('does-not-exist');

        expect(found).toBeNull();
    });

    it('overwrites the stored record when updating an existing payment', async () => {
        const payment = buildPayment();
        await repository.create(payment);

        const updated: Payment = {
            ...payment,
            status: PaymentStatus.COMPLETED,
            updatedAt: new Date(payment.updatedAt.getTime() + 1000),
        };
        await repository.update(updated);

        const found = await repository.findById(payment.id);
        expect(found?.status).toBe(PaymentStatus.COMPLETED);
    });

    it('lists all stored payments', async () => {
        await repository.create(buildPayment({ id: 'payment-1' }));
        await repository.create(buildPayment({ id: 'payment-2' }));

        const all = await repository.findAll();

        expect(all).toHaveLength(2);
        expect(all.map((p) => p.id).sort()).toEqual(['payment-1', 'payment-2']);
    });
});