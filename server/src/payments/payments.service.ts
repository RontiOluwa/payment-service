import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './enums/payment-status.enum';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import type { PaymentRepository } from './repositories/payment-repository.interface';
import {
    PAYMENT_PROCESSING_QUEUE,
    PROCESS_PAYMENT_JOB,
    ProcessPaymentJobData,
} from './processing/payment-processing.queue';

/**
 * Declares which status transitions are legal, keyed by the current
 * status. This is the single source of truth for the payment state
 * machine — both the `PaymentProcessingProcessor` (BullMQ worker) and
 * manual `PATCH` requests are validated against this same map, so
 * there is only one set of rules to reason about, not two.
 *
 * COMPLETED and FAILED map to empty arrays: they are terminal states,
 * so no further transition is ever valid from them.
 */
const ALLOWED_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
    [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING, PaymentStatus.FAILED],
    [PaymentStatus.PROCESSING]: [PaymentStatus.COMPLETED, PaymentStatus.FAILED],
    [PaymentStatus.COMPLETED]: [],
    [PaymentStatus.FAILED]: [],
};

/**
 * Core business logic for payments.
 *
 * This service depends on the `PaymentRepository` interface (injected
 * via the `PAYMENT_REPOSITORY` token) and on a BullMQ `Queue`, never
 * on `PaymentProcessingProcessor` directly. That decoupling matters:
 * the processor needs to call back into this service (via
 * `updateStatus`) once it finishes a job, so if this service also
 * depended directly on the processor, we'd have a circular
 * dependency. Instead, this service only enqueues a job and moves
 * on — it has no idea what consumes the queue or how.
 */
@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        @Inject(PAYMENT_REPOSITORY)
        private readonly paymentRepository: PaymentRepository,
        @InjectQueue(PAYMENT_PROCESSING_QUEUE)
        private readonly processingQueue: Queue<ProcessPaymentJobData>,
    ) { }

    /**
     * Creates a new payment in PENDING status, then enqueues a
     * `process-payment` job so that `PaymentProcessingProcessor`
     * (running as a separate BullMQ worker) can pick up the
     * asynchronous processing simulation.
     *
     * The job is durably stored in Redis the moment `queue.add`
     * resolves — if the app crashes immediately after this method
     * returns, the job is not lost; it will still be processed once the
     * worker (or a restarted instance of it) comes back up.
     */
    async createPayment(dto: CreatePaymentDto): Promise<Payment> {
        const now = new Date();
        const payment: Payment = {
            id: randomUUID(),
            amount: dto.amount,
            currency: dto.currency.toUpperCase(),
            description: dto.description,
            status: PaymentStatus.PENDING,
            createdAt: now,
            updatedAt: now,
        };

        const created = await this.paymentRepository.create(payment);
        this.logger.log(`Payment ${created.id} created (status=PENDING)`);

        await this.processingQueue.add(PROCESS_PAYMENT_JOB, {
            paymentId: created.id,
        });

        return created;
    }

    /**
     * Retrieves a single payment by ID.
     *
     * @throws NotFoundException if no payment exists with that ID.
     */
    async getPayment(id: string): Promise<Payment> {
        const payment = await this.paymentRepository.findById(id);
        if (!payment) {
            throw new NotFoundException(`Payment with id "${id}" was not found`);
        }
        return payment;
    }

    /** Retrieves every stored payment. Used by the optional list endpoint. */
    async getAllPayments(): Promise<Payment[]> {
        return this.paymentRepository.findAll();
    }

    /**
     * Transitions a payment to a new status, enforcing the state machine.
     *
     * This is the single method that changes a payment's status —
     * whether the caller is a human hitting `PATCH /payments/:id/status`
     * or `PaymentProcessingProcessor` reporting a job result.
     * Centralizing it here means the transition rules are enforced
     * exactly once, regardless of the trigger.
     *
     * @throws NotFoundException if the payment doesn't exist.
     * @throws ConflictException if the requested transition is not legal
     *   from the payment's current status (e.g. COMPLETED -> PENDING).
     */
    async updateStatus(id: string, newStatus: PaymentStatus): Promise<Payment> {
        const payment = await this.getPayment(id);

        if (!this.canTransition(payment.status, newStatus)) {
            throw new ConflictException(
                `Cannot transition payment from "${payment.status}" to "${newStatus}"`,
            );
        }

        const updated: Payment = {
            ...payment,
            status: newStatus,
            updatedAt: new Date(),
        };

        const saved = await this.paymentRepository.update(updated);
        this.logger.log(
            `Payment ${id} transitioned ${payment.status} -> ${newStatus}`,
        );
        return saved;
    }

    /**
     * Checks whether moving from `from` to `to` is a legal transition
     * under the state machine defined in `ALLOWED_TRANSITIONS`.
     */
    private canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
        return ALLOWED_TRANSITIONS[from].includes(to);
    }
}