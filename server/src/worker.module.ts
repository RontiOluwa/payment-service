import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsWorkerModule } from './payments/worker/payments-worker.module';

/**
 * Root module for the WORKER PROCESS (bootstrapped by `src/worker.ts`).
 *
 * This is the counterpart to `AppModule` (the API process). It shares
 * NOTHING with `AppModule` at the module level — no `ThrottlerModule`,
 * no `HealthController`, no HTTP concerns of any kind, since this
 * process never opens an HTTP port. What it DOES share with the API
 * process is external, not structural: the same Redis instance (via
 * its own `BullModule.forRoot()` call, using the same connection
 * config) and the same `payments.json` data file (via
 * `PaymentsCoreModule`, imported transitively through
 * `PaymentsWorkerModule`).
 *
 * This process's only job is to consume `process-payment` jobs and
 * update payment status — see `PaymentProcessingProcessor`.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    PaymentsWorkerModule,
  ],
})
export class WorkerAppModule {}
