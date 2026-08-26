import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './enums/payment-status.enum';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import type { PaymentRepository } from './repositories/payment-repository.interface';

/**
 * Declares which status transitions are legal, keyed by the current
 * status. This is the single source of truth for the payment state
 * machine — both the (future) automatic processing engine and manual
 * `PATCH` requests are validated against this same map, so there is
 * only one set of rules to reason about, not two.
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
 * This service depends only on the `PaymentRepository` interface
 * (injected via the `PAYMENT_REPOSITORY` token), never on a concrete
 * storage implementation — so it can be unit tested with a mock
 * repository and works unchanged regardless of which repository
 * implementation is wired up in `PaymentsModule`.
 *
 * Controllers should stay thin and delegate all actual logic here.
 */
@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        @Inject(PAYMENT_REPOSITORY)
        private readonly paymentRepository: PaymentRepository,
    ) { }

    /**
     * Creates a new payment in PENDING status.
     *
     * Note: this method does NOT yet trigger the asynchronous processing
     * simulation — that integration is added in a later step once the
     * `ProcessingEngine` exists. For now, a created payment simply sits
     * in PENDING until something explicitly moves it forward.
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
     * or (in a later step) the processing engine completing its
     * simulation. Centralizing it here means the transition rules are
     * enforced exactly once, regardless of the trigger.
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