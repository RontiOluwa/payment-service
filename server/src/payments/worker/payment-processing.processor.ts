import { ConflictException, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { PaymentsService } from '../payments.service';
import { PaymentStatus } from '../enums/payment-status.enum';
import {
  PAYMENT_PROCESSING_QUEUE,
  ProcessPaymentJobData,
} from '../processing/payment-processing.queue';

/** Minimum and maximum simulated processing delay, in milliseconds. */
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 3_000;

/**
 * Probability that a simulated payment succeeds. Deliberately not
 * 100% — a payment service that never fails wouldn't exercise the
 * FAILED path at all, and testing that path is one of the
 * assessment's explicit objectives (error handling).
 */
const SUCCESS_PROBABILITY = 0.8;

/**
 * Number of jobs this worker processes concurrently. Left at BullMQ's
 * default (1), payments would be processed strictly one at a time,
 * however many are created simultaneously — a real throughput
 * limitation for a payment service, not just a theoretical one. This
 * was actually discovered via the e2e integration test suite: with
 * only one payment queued, processing finished in ~2s; with several
 * payments created in quick succession by earlier tests in the same
 * run, a job could sit behind others long enough to exceed a
 * reasonable wait window. 5 is a modest, deliberately conservative
 * default for this project's scope — easily made configurable via an
 * environment variable if this were tuned for real production load.
 */
const WORKER_CONCURRENCY = 5;

/**
 * BullMQ worker that simulates an external payment gateway's
 * asynchronous processing.
 *
 * This replaces the earlier in-process `EventEmitter2`-based
 * `ProcessingEngine`. The behavior (PENDING -> PROCESSING -> outcome,
 * after a randomized delay) is identical — what's different is that
 * jobs now live in Redis, not just in this process's memory:
 *
 *  - If the app crashes after a payment is created but before this
 *    worker finishes processing it, the job is NOT lost — it remains
 *    in Redis and is picked up again (BullMQ redelivers unacknowledged
 *    jobs), unlike the old in-memory event which would simply vanish.
 *  - This worker process could be scaled independently of the HTTP
 *    API process in a real deployment — e.g. running N worker
 *    instances consuming the same queue under heavy processing load.
 *  - Failed jobs (e.g. an unexpected exception, not a simulated
 *    "FAILED" payment outcome — those are two different things) get
 *    BullMQ's built-in retry/backoff — EXCEPT when the failure is a
 *    `ConflictException` from the state machine (payment already
 *    terminal), which is deliberately marked unrecoverable rather
 *    than retried, since retrying can never succeed for that case.
 *
 * In a real system, this role would be played by a webhook received
 * from an actual payment provider (Stripe/Paystack/Flutterwave). For
 * this assessment, a randomized delay + randomized outcome is a
 * reasonable stand-in that still forces the rest of the system (state
 * machine, client polling) to handle genuine asynchronous behavior.
 */
@Processor(PAYMENT_PROCESSING_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class PaymentProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessingProcessor.name);

  constructor(private readonly paymentsService: PaymentsService) {
    super();
  }

  /**
   * Entry point BullMQ calls for every job pulled off the queue.
   *
   * Two error cases are handled differently here, which matters a lot
   * in practice:
   *
   *  - A `ConflictException` from `updateStatus` means the payment is
   *    already in a terminal state — most likely because a manual
   *    `PATCH /payments/:id/status` request raced this job and got
   *    there first. This is NOT a transient failure: retrying it will
   *    fail identically every time, forever. It's thrown as BullMQ's
   *    `UnrecoverableError`, which tells BullMQ to mark the job failed
   *    WITHOUT scheduling a retry — discovered by manually testing
   *    this exact race during development (a manual override landing
   *    between this worker's two `updateStatus` calls).
   *  - Any other error (e.g. a transient storage failure) is allowed
   *    to propagate as-is, so BullMQ's normal retry/backoff applies —
   *    that failure mode genuinely might succeed on a later attempt.
   */
  async process(job: Job<ProcessPaymentJobData>): Promise<void> {
    const { paymentId } = job.data;

    this.logger.log(`Processing job ${job.id} for payment ${paymentId}`);

    try {
      await this.paymentsService.updateStatus(
        paymentId,
        PaymentStatus.PROCESSING,
      );

      const outcome = await this.simulateProcessing(paymentId);

      await this.paymentsService.updateStatus(paymentId, outcome);
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.warn(
          `Payment ${paymentId} already reached a terminal state before ` +
            `job ${job.id} could finish (likely a manual status override) — ` +
            `skipping without retry.`,
        );
        throw new UnrecoverableError(
          `Payment ${paymentId} already in a terminal state`,
        );
      }
      throw error;
    }
  }

  /**
   * Simulates the actual gateway delay + outcome. Resolves after a
   * randomized delay with either COMPLETED or FAILED — this method
   * never resolves with PENDING or PROCESSING, since those are the
   * states *before* processing finishes, not outcomes of it.
   */
  private simulateProcessing(
    paymentId: string,
  ): Promise<PaymentStatus.COMPLETED | PaymentStatus.FAILED> {
    const delayMs = this.randomDelay();

    this.logger.log(
      `Simulating processing for payment ${paymentId} (delay=${delayMs}ms)`,
    );

    return new Promise((resolve) => {
      setTimeout(() => {
        const outcome = this.randomOutcome();
        this.logger.log(
          `Simulated processing for payment ${paymentId} finished with outcome=${outcome}`,
        );
        resolve(outcome);
      }, delayMs);
    });
  }

  /** Picks a random delay between MIN_DELAY_MS and MAX_DELAY_MS. */
  private randomDelay(): number {
    return (
      Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) +
      MIN_DELAY_MS
    );
  }

  /** Picks COMPLETED with probability SUCCESS_PROBABILITY, else FAILED. */
  private randomOutcome(): PaymentStatus.COMPLETED | PaymentStatus.FAILED {
    return Math.random() < SUCCESS_PROBABILITY
      ? PaymentStatus.COMPLETED
      : PaymentStatus.FAILED;
  }
}
