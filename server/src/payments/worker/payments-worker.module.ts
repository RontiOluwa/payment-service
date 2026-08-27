import { Module } from '@nestjs/common';
import { PaymentsCoreModule } from '../payments-core.module';
import { PaymentProcessingProcessor } from './payment-processing.processor';

/**
 * Worker-facing module — everything the WORKER PROCESS needs that the
 * API process does NOT: the actual BullMQ job consumer.
 *
 * This module deliberately does NOT include `PaymentsController`,
 * `IdempotencyStore`/`IdempotencyInterceptor`, or anything HTTP-related
 * — the worker process never opens an HTTP port at all (see
 * `src/worker.ts`, which uses `NestFactory.createApplicationContext`,
 * not `NestFactory.create`). Its only job is to consume
 * `process-payment` jobs from the queue and update payment status via
 * `PaymentsService` (available here through `PaymentsCoreModule`).
 */
@Module({
  imports: [PaymentsCoreModule],
  providers: [PaymentProcessingProcessor],
})
export class PaymentsWorkerModule {}
