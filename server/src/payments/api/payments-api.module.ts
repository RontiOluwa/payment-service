import { Module } from '@nestjs/common';
import { PaymentsCoreModule } from '../payments-core.module';
import { PaymentsController } from './payments.controller';
import { IdempotencyStore } from './idempotency/idempotency-store';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { RedisModule } from '../../common/redis/redis.module';

/**
 * HTTP-facing module — everything the API PROCESS needs that the
 * worker process does NOT: the controller itself, and idempotency
 * (a request-deduplication concern that only makes sense at the HTTP
 * boundary, since only HTTP requests can be retried by a client).
 *
 * This module deliberately does NOT include `PaymentProcessingProcessor`
 * — that lives only in `PaymentsWorkerModule`, imported by the
 * separate worker process (`src/worker.ts`). This is what makes the
 * two genuinely independent deployables: the API process that imports
 * this module never instantiates a queue consumer at all, so running
 * only the API without ever starting the worker process means jobs
 * would enqueue but never be processed — exactly the kind of
 * observable behavior a real service split has.
 */
@Module({
  imports: [PaymentsCoreModule, RedisModule],
  providers: [IdempotencyStore, IdempotencyInterceptor],
  controllers: [PaymentsController],
})
export class PaymentsApiModule {}
