import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { PaymentProcessingProcessor } from './payment-processing.processor';
import { PaymentsService } from '../payments.service';
import { PaymentStatus } from '../enums/payment-status.enum';
import { ProcessPaymentJobData } from './payment-processing.queue';

/**
 * Unit tests for `PaymentProcessingProcessor`.
 *
 * `PaymentsService` is fully mocked, and jobs are plain mock objects
 * shaped like a BullMQ `Job` — no real Redis connection or queue is
 * involved.
 */
describe('PaymentProcessingProcessor', () => {
    let processor: PaymentProcessingProcessor;
    let mockPaymentsService: { updateStatus: jest.Mock };

    const buildJob = (paymentId: string): Job<ProcessPaymentJobData> =>
        ({
            id: 'job-1',
            data: { paymentId },
        }) as Job<ProcessPaymentJobData>;

    beforeEach(async () => {
        mockPaymentsService = { updateStatus: jest.fn().mockResolvedValue({}) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentProcessingProcessor,
                { provide: PaymentsService, useValue: mockPaymentsService },
            ],
        }).compile();

        processor = module.get<PaymentProcessingProcessor>(
            PaymentProcessingProcessor,
        );

        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('transitions PENDING -> PROCESSING immediately, then to an outcome after the delay', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);

        const processPromise = processor.process(buildJob('payment-1'));

        await Promise.resolve();
        expect(mockPaymentsService.updateStatus).toHaveBeenNthCalledWith(
            1,
            'payment-1',
            PaymentStatus.PROCESSING,
        );

        jest.runAllTimers();
        await processPromise;

        expect(mockPaymentsService.updateStatus).toHaveBeenNthCalledWith(
            2,
            'payment-1',
            PaymentStatus.COMPLETED,
        );
        expect(mockPaymentsService.updateStatus).toHaveBeenCalledTimes(2);
    });

    it('resolves to FAILED when the random outcome roll fails', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.99);

        const processPromise = processor.process(buildJob('payment-2'));

        await Promise.resolve();
        jest.runAllTimers();
        await processPromise;

        expect(mockPaymentsService.updateStatus).toHaveBeenNthCalledWith(
            2,
            'payment-2',
            PaymentStatus.FAILED,
        );
    });

    it('propagates errors so BullMQ can apply its retry/backoff behavior', async () => {
        mockPaymentsService.updateStatus.mockRejectedValueOnce(
            new Error('storage unavailable'),
        );

        await expect(processor.process(buildJob('payment-3'))).rejects.toThrow(
            'storage unavailable',
        );
    });
});