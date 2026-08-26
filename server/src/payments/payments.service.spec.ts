import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { PaymentStatus } from './enums/payment-status.enum';
import { Payment } from './entities/payment.entity';
import {
    PAYMENT_PROCESSING_QUEUE,
    PROCESS_PAYMENT_JOB,
} from './processing/payment-processing.queue';

/**
 * Unit tests for `PaymentsService`.
 *
 * The repository AND the BullMQ queue are fully mocked here — these
 * tests exercise only the business logic, with no real Redis
 * connection, no real storage, and no real worker involved.
 */
describe('PaymentsService', () => {
    let service: PaymentsService;
    let mockRepository: {
        create: jest.Mock;
        findById: jest.Mock;
        update: jest.Mock;
        findAll: jest.Mock;
    };
    let mockQueue: { add: jest.Mock };

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
        mockQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentsService,
                { provide: PAYMENT_REPOSITORY, useValue: mockRepository },
                {
                    provide: getQueueToken(PAYMENT_PROCESSING_QUEUE),
                    useValue: mockQueue,
                },
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
                currency: 'ngn',
            });

            expect(result.status).toBe(PaymentStatus.PENDING);
            expect(result.currency).toBe('NGN');
            expect(result.id).toEqual(expect.any(String));
            expect(mockRepository.create).toHaveBeenCalledTimes(1);
        });

        it('enqueues a process-payment job after saving the payment', async () => {
            mockRepository.create.mockImplementation((payment: Payment) =>
                Promise.resolve(payment),
            );

            const result = await service.createPayment({
                amount: 2500,
                currency: 'NGN',
            });

            expect(mockQueue.add).toHaveBeenCalledTimes(1);
            expect(mockQueue.add).toHaveBeenCalledWith(PROCESS_PAYMENT_JOB, {
                paymentId: result.id,
            });
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