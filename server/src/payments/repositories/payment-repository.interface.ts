import { Payment } from '../entities/payment.entity';

/**
 * Injection token used to bind a concrete repository implementation
 * to this interface in the Nest DI container. Using a string/symbol
 * token (rather than the interface itself, which doesn't exist at
 * runtime in TypeScript) is the standard Nest pattern for injecting
 * by abstraction.
 */
export const PAYMENT_REPOSITORY = 'PAYMENT_REPOSITORY';

/**
 * Persistence-agnostic contract for storing and retrieving payments.
 *
 * `PaymentsService` depends on this interface only — never on a
 * concrete storage technology. This is what makes the storage layer
 * swappable: `InMemoryPaymentRepository` (this step) and
 * `JsonFilePaymentRepository` (a later step) both implement this same
 * contract, and swapping between them (or later, a real database) is
 * a one-line change in `payments.module.ts`, with zero changes to
 * business logic.
 */
export interface PaymentRepository {
    /** Persist a new payment record. */
    create(payment: Payment): Promise<Payment>;

    /** Retrieve a payment by its ID, or `null` if it doesn't exist. */
    findById(id: string): Promise<Payment | null>;

    /**
     * Persist an updated payment record. The caller is responsible for
     * constructing the full updated `Payment` object (including a fresh
     * `updatedAt`) — the repository's job is only to store it.
     */
    update(payment: Payment): Promise<Payment>;

    /** Retrieve all payments. Used by the optional list endpoint/UI. */
    findAll(): Promise<Payment[]>;
}