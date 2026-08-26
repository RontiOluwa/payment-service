import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PaymentsService } from '../payments.service';
import { PaymentStatus } from '../enums/payment-status.enum';
import {
    PAYMENT_PROCESSING_QUEUE,
    ProcessPaymentJobData,
} from './payment-processing.queue';

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
 * BullMQ worker that simulates an external payment gateway's
 * asynchronous processing.
 *
 * In a real system, this role would be played by a webhook received
 * from an actual payment provider (Stripe/Paystack/Flutterwave). For
 * this assessment, a randomized delay + randomized outcome is a
 * reasonable stand-in that still forces the rest of the system (state
 * machine, client polling) to handle genuine asynchronous behavior.
 *
 * Because jobs live in Redis (not just process memory):
 *  - A crash between payment creation and job completion does not
 *    lose the job — BullMQ redelivers unacknowledged jobs.
 *  - This worker could scale independently of the HTTP API process.
 *  - Failures get BullMQ's built-in retry/backoff rather than
 *    disappearing silently.
 */
@Processor(PAYMENT_PROCESSING_QUEUE)
export class PaymentProcessingProcessor extends WorkerHost {
    private readonly logger = new Logger(PaymentProcessingProcessor.name);

    constructor(private readonly paymentsService: PaymentsService) {
        super();
    }

    /**
     * Entry point BullMQ calls for every job pulled off the queue.
     *
     * Any error thrown here is treated by BullMQ as a job failure and
     * triggers its retry/backoff behavior — errors are deliberately
     * allowed to propagate rather than being caught here.
     */
    async process(job: Job<ProcessPaymentJobData>): Promise<void> {
        const { paymentId } = job.data;

        this.logger.log(`Processing job ${job.id} for payment ${paymentId}`);

        await this.paymentsService.updateStatus(paymentId, PaymentStatus.PROCESSING);

        const outcome = await this.simulateProcessing(paymentId);

        await this.paymentsService.updateStatus(paymentId, outcome);
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