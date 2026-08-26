import { Module } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { InMemoryPaymentRepository } from './repositories/in-memory-payment.repository';

/**
 * Feature module for everything payment-related.
 *
 * The `PAYMENT_REPOSITORY` provider is bound to `InMemoryPaymentRepository`
 * here. To switch persistence strategies later (e.g. to a
 * `JsonFilePaymentRepository`, or eventually a real database
 * repository), only the `useClass` line below needs to change —
 * nothing in `PaymentsService` or the controller is aware of which
 * implementation is actually in use.
 */

@Module({
    providers: [
        {
            provide: PAYMENT_REPOSITORY,
            useClass: InMemoryPaymentRepository,
        },
    ],
    exports: [PAYMENT_REPOSITORY],
})
export class PaymentsModule { }
