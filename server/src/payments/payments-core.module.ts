import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { PAYMENT_REPOSITORY } from './repositories/payment-repository.interface';
import { JsonFilePaymentRepository } from './repositories/json-file-payment.repository';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROCESSING_QUEUE } from './processing/payment-processing.queue';
import { RedisModule, REDIS_CLIENT } from '../common/redis/redis.module';

/**
 * Shared core: the repository, `PaymentsService`, and the BullMQ queue
 * registration — everything BOTH the API process and the worker
 * process need, and nothing that belongs to only one of them.
 *
 * This module is what makes the API and worker genuinely independent
 * deployables rather than just internally-organized classes in one
 * process:
 *  - `PaymentsApiModule` imports this to get `PaymentsService` (which
 *    it needs to create/read/update payments) and the queue
 *    registration (so `PaymentsService` can inject `Queue` and
 *    PRODUCE jobs via `queue.add()`).
 *  - `PaymentsWorkerModule` imports this to get `PaymentsService`
 *    (which the processor calls back into to update status) and the
 *    SAME queue registration (so `PaymentProcessingProcessor` can
 *    attach as a CONSUMER of that queue).
 *
 * Both processes register the same queue name against the same Redis
 * connection — this is BullMQ's standard supported pattern for
 * separating a job's producer from its consumer into different
 * processes, and it's exactly what makes this a real split rather
 * than a cosmetic one.
 *
 * `BullModule` is re-exported (not just `PaymentsService`) so that
 * whichever module imports `PaymentsCoreModule` also gets access to
 * the queue's own providers — required for both `@InjectQueue` (API
 * side) and `@Processor` (worker side) to resolve correctly.
 *
 * `PAYMENT_REPOSITORY` is bound to `JsonFilePaymentRepository` here,
 * the ONE datastore both processes share — both read and write the
 * same `payments.json` file (path configurable via
 * `PAYMENTS_DATA_FILE`).
 *
 * `RedisModule` is imported here (not just by the API's own module)
 * because `JsonFilePaymentRepository` now needs a Redis client for a
 * cross-process file lock — see that class's doc comment for why this
 * became necessary: two genuinely separate processes reading, then
 * later writing, the WHOLE file back is a real data-loss risk without
 * one. Both processes get their own `REDIS_CLIENT` instance (via
 * their own import of `RedisModule`), which is exactly correct — the
 * lock lives in shared Redis, not in either process's memory.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: PAYMENT_PROCESSING_QUEUE,
    }),
    RedisModule,
  ],
  providers: [
    {
      provide: PAYMENT_REPOSITORY,
      inject: [REDIS_CLIENT],
      useFactory: (redisClient: Redis) =>
        new JsonFilePaymentRepository(
          process.env.PAYMENTS_DATA_FILE,
          redisClient,
        ),
    },
    PaymentsService,
  ],
  exports: [PaymentsService, BullModule],
})
export class PaymentsCoreModule {}
