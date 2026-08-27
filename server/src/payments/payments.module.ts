import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { JsonFilePaymentRepository } from './repositories/json-file-payment.repository';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaymentProcessingProcessor } from './processing/payment-processing.processor';
import { PAYMENT_PROCESSING_QUEUE } from './processing/payment-processing.queue';
import { IdempotencyStore } from './idempotency/idempotency-store';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';

/**
 * Feature module for everything payment-related.
 *
 * `PAYMENT_REPOSITORY` is bound to `JsonFilePaymentRepository`, the
 * project's single storage backend — data persists to a JSON file on
 * disk and survives an app restart. The data file's location is
 * configurable via the `PAYMENTS_DATA_FILE` environment variable (see
 * `.env.example`), defaulting to `./data/payments.json`.
 *
 * `PaymentsService` and `PaymentsController` still depend only on the
 * `PaymentRepository` interface, not on this concrete class — so a
 * different backend (e.g. a real database) could still be swapped in
 * later by changing only the `useFactory` below.
 *
 * `BullModule.registerQueue` declares this module's queue, using the
 * shared Redis connection configured once in `AppModule`.
 * `PaymentProcessingProcessor` is registered as a provider so Nest
 * instantiates it and starts it consuming jobs from that queue
 * automatically — nothing else in this module needs to reference it
 * directly.
 *
 * `PaymentsController` is registered under `controllers` and is the
 * only way this module's functionality is reachable over HTTP; it's
 * exported alongside `PaymentsService` in case another future module
 * ever needs to trigger payment logic directly (e.g. a webhook module
 * receiving a real gateway callback).
 *
 * `IdempotencyStore` and `IdempotencyInterceptor` are registered as
 * providers so Nest's DI container can construct
 * `IdempotencyInterceptor` when `PaymentsController` references it
 * via `@UseInterceptors(IdempotencyInterceptor)` on the create route.
 */
@Module({
    imports: [
        BullModule.registerQueue({
            name: PAYMENT_PROCESSING_QUEUE,
        }),
    ],
    providers: [
        {
            provide: PAYMENT_REPOSITORY,
            useFactory: () =>
                new JsonFilePaymentRepository(process.env.PAYMENTS_DATA_FILE),
        },
        PaymentsService,
        PaymentProcessingProcessor,
        IdempotencyStore,
        IdempotencyInterceptor,
    ],
    controllers: [PaymentsController],
    exports: [PaymentsService],
})
export class PaymentsModule { }