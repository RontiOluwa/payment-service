import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PaymentProcessingProcessor } from './payment-processing.processor';
import { PaymentsService } from '../payments.service';
import { PaymentStatus } from '../enums/payment-status.enum';
import { ProcessPaymentJobData } from '../processing/payment-processing.queue';

/**
 * Unit tests for `PaymentProcessingProcessor`.
 *
 * `PaymentsService` is fully mocked, and jobs are plain mock objects
 * shaped like a BullMQ `Job` — no real Redis connection or queue is
 * involved. Jest's fake timers let us advance the simulated delay
 * instantly instead of the test suite actually waiting per test.
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
    // Force a deterministic outcome (COMPLETED) instead of relying on
    // real randomness, since the point of this test is the sequencing
    // of calls, not which outcome is picked.
    jest.spyOn(Math, 'random').mockReturnValue(0); // -> delay=MIN, outcome=COMPLETED

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

  it('propagates non-conflict errors so BullMQ can apply its retry/backoff behavior', async () => {
    mockPaymentsService.updateStatus.mockRejectedValueOnce(
      new Error('storage unavailable'),
    );

    // Unlike the old event-based engine (which had to swallow errors
    // since nothing was "listening" for a failure), this processor
    // deliberately lets a genuinely transient error propagate as-is —
    // BullMQ's normal job-failure and retry mechanics are the
    // intended handler for it.
    await expect(processor.process(buildJob('payment-3'))).rejects.toThrow(
      'storage unavailable',
    );
  });

  it('marks the job unrecoverable (no retry) when the payment already reached a terminal state', async () => {
    // Simulates the real race discovered during manual testing: a
    // manual PATCH request moves the payment to a terminal state
    // (e.g. COMPLETED) before this worker's second updateStatus call
    // runs, which then throws ConflictException.
    mockPaymentsService.updateStatus
      .mockResolvedValueOnce({}) // PENDING -> PROCESSING succeeds
      .mockRejectedValueOnce(
        new ConflictException('Cannot transition payment from "COMPLETED"'),
      );

    jest.spyOn(Math, 'random').mockReturnValue(0);

    const processPromise = processor.process(buildJob('payment-4'));
    await Promise.resolve();
    jest.runAllTimers();

    // UnrecoverableError tells BullMQ not to retry — retrying a
    // permanently-terminal conflict can never succeed.
    await expect(processPromise).rejects.toThrow(UnrecoverableError);
  });
});
