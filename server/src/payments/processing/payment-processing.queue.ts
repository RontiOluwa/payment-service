/**
 * Name of the BullMQ queue used for asynchronous payment processing.
 * Shared between the producer (`PaymentsService`, which adds jobs)
 * and the consumer (`PaymentProcessingProcessor`, which processes
 * them) so both sides always refer to the same queue by a single
 * source of truth rather than a repeated string literal.
 */
export const PAYMENT_PROCESSING_QUEUE = 'payment-processing';

/**
 * Name of the job type added to the queue. BullMQ supports multiple
 * named job types per queue; this project only uses one, but naming
 * it explicitly (rather than leaving it unnamed) makes the queue
 * self-documenting if more job types are added later.
 */
export const PROCESS_PAYMENT_JOB = 'process-payment';

/** Shape of the data carried by a `process-payment` job. */
export interface ProcessPaymentJobData {
    paymentId: string;
}