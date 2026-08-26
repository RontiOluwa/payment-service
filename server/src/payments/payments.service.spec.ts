import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { PaymentStatus } from './enums/payment-status.enum';
import { Payment } from './entities/payment.entity';

/**
 * Unit tests for `PaymentsService`.
 *
 * The repository is fully mocked here — these tests exercise only the
 * business logic (creation, retrieval, and state-machine transitions),
 * completely independent of any real storage mechanism. This is what
 * makes the interface-based repository design pay off: no real Map,
 * file, or database is involved in these tests at all.
 */
describe('PaymentsService', () => {
    let service: PaymentsService;
    let mockRepository: {
        create: jest.Mock;
        findById: jest.Mock;
        update: jest.Mock;
        findAll: jest.Mock;
    };

    const buildPayment = (overrides: Partial<Payment> = {}): Payment => ({
        id: 'payment-1',
        amount: 1000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    });

    beforeEach(async () => {
        mockRepository = {
            create: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            findAll: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentsService,
                { provide: PAYMENT_REPOSITORY, useValue: mockRepository },
            ],
        }).compile();

        service = module.get<PaymentsService>(PaymentsService);
    });

    describe('createPayment', () => {
        it('creates a payment in PENDING status with a generated id', async () => {
            mockRepository.create.mockImplementation((payment: Payment) =>
                Promise.resolve(payment),
            );

            const result = await service.createPayment({
                amount: 2500,
                currency: 'ngn', // lowercase input — service should normalize it
            });

            expect(result.status).toBe(PaymentStatus.PENDING);
            expect(result.currency).toBe('NGN'); // normalized to uppercase
            expect(result.id).toEqual(expect.any(String));
            expect(mockRepository.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('getPayment', () => {
        it('returns the payment when it exists', async () => {
            const payment = buildPayment();
            mockRepository.findById.mockResolvedValue(payment);

            const result = await service.getPayment('payment-1');

            expect(result).toEqual(payment);
        });

        it('throws NotFoundException when the payment does not exist', async () => {
            mockRepository.findById.mockResolvedValue(null);

            await expect(service.getPayment('missing-id')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('updateStatus', () => {
        it('allows a legal transition (PENDING -> PROCESSING)', async () => {
            const payment = buildPayment({ status: PaymentStatus.PENDING });
            mockRepository.findById.mockResolvedValue(payment);
            mockRepository.update.mockImplementation((p: Payment) =>
                Promise.resolve(p),
            );

            const result = await service.updateStatus(
                'payment-1',
                PaymentStatus.PROCESSING,
            );

            expect(result.status).toBe(PaymentStatus.PROCESSING);
        });

        it('allows a legal transition (PROCESSING -> COMPLETED)', async () => {
            const payment = buildPayment({ status: PaymentStatus.PROCESSING });
            mockRepository.findById.mockResolvedValue(payment);
            mockRepository.update.mockImplementation((p: Payment) =>
                Promise.resolve(p),
            );

            const result = await service.updateStatus(
                'payment-1',
                PaymentStatus.COMPLETED,
            );

            expect(result.status).toBe(PaymentStatus.COMPLETED);
        });

        it('rejects an illegal transition (COMPLETED -> PENDING)', async () => {
            const payment = buildPayment({ status: PaymentStatus.COMPLETED });
            mockRepository.findById.mockResolvedValue(payment);

            await expect(
                service.updateStatus('payment-1', PaymentStatus.PENDING),
            ).rejects.toThrow(ConflictException);

            // The repository must never be asked to persist an illegal
            // transition — the rejection has to happen before any write.
            expect(mockRepository.update).not.toHaveBeenCalled();
        });

        it('rejects any transition from a terminal FAILED state', async () => {
            const payment = buildPayment({ status: PaymentStatus.FAILED });
            mockRepository.findById.mockResolvedValue(payment);

            await expect(
                service.updateStatus('payment-1', PaymentStatus.PROCESSING),
            ).rejects.toThrow(ConflictException);
        });

        it('throws NotFoundException when updating a non-existent payment', async () => {
            mockRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateStatus('missing-id', PaymentStatus.FAILED),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('getAllPayments', () => {
        it('returns all payments from the repository', async () => {
            const payments = [buildPayment({ id: 'p1' }), buildPayment({ id: 'p2' })];
            mockRepository.findAll.mockResolvedValue(payments);

            const result = await service.getAllPayments();

            expect(result).toEqual(payments);
        });
    });
});