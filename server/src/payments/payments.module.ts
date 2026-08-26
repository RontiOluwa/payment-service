import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { JsonFilePaymentRepository } from './repositories/json-file-payment.repository';
import { PaymentsService } from './payments.service';
import { PaymentProcessingProcessor } from './processing/payment-processing.processor';
import { PAYMENT_PROCESSING_QUEUE } from './processing/payment-processing.queue';

/**
 * Feature module for everything payment-related.
 *
 * `PAYMENT_REPOSITORY` is bound to `JsonFilePaymentRepository`, the
 * project's single storage backend — data persists to a JSON file on
 * disk and survives an app restart. The data file's location is
 * configurable via the `PAYMENTS_DATA_FILE` environment variable (see
 * `.env.example`), defaulting to `./data/payments.json`.
 *
 * `PaymentsService` and the controller still depend only on the
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
    ],
    exports: [PaymentsService],
})
export class PaymentsModule { }