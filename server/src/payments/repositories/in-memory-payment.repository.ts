import { Injectable } from '@nestjs/common';
import { Payment } from '../entities/payment.entity';
import { PaymentRepository } from './payment-repository.interface';

/**
 * In-memory implementation of `PaymentRepository`.
 *
 * Backed by a `Map` for O(1) lookups by ID. Data lives only in process
 * memory — it is lost on restart and is NOT shared across multiple
 * instances of the app. This is intentional and acceptable for the
 * assessment's scope (simplicity, no external dependencies), but it is
 * the first thing that would need to change for a real deployment
 * (see the architecture doc's "path to production" section — this
 * would become a database-backed repository behind the same
 * interface).
 *
 * Every method is declared `async`/returns a `Promise` even though the
 * underlying `Map` operations are synchronous. This keeps the
 * interface identical to a real, I/O-bound implementation (like the
 * file-based or database-backed repositories), so callers never need
 * to know or care which implementation is currently wired in.
 */
@Injectable()
export class InMemoryPaymentRepository implements PaymentRepository {
    private readonly payments = new Map<string, Payment>();

    async create(payment: Payment): Promise<Payment> {
        this.payments.set(payment.id, payment);
        return payment;
    }

    async findById(id: string): Promise<Payment | null> {
        return this.payments.get(id) ?? null;
    }

    async update(payment: Payment): Promise<Payment> {
        this.payments.set(payment.id, payment);
        return payment;
    }

    async findAll(): Promise<Payment[]> {
        return Array.from(this.payments.values());
    }
}