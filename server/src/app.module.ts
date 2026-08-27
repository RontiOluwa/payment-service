import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PaymentsApiModule } from './payments/api/payments-api.module';
import { HealthController } from './health/health.controller';

/**
 * Root module for the API PROCESS (bootstrapped by `src/main.ts`).
 *
 * This is one of TWO independently deployable processes in this
 * project — the other is the worker process, bootstrapped by
 * `src/worker.ts` with its own root module (`WorkerAppModule`). They
 * are genuinely separate: this process never instantiates
 * `PaymentProcessingProcessor` at all. If you run only this process
 * without ever starting the worker, payments will be created and
 * enqueued but never processed — status will sit at PENDING forever.
 * That's not a bug; it's the observable behavior of a real service
 * split, not just internally-organized classes in one process.
 *
 * `BullModule.forRoot()` establishes the shared Redis connection used
 * by the queue. Both this process and the worker process register the
 * SAME queue name against the SAME Redis connection — this process
 * only ever PRODUCES jobs (via `PaymentsService`'s injected `Queue`,
 * available through `PaymentsApiModule` -> `PaymentsCoreModule`); it
 * never consumes any.
 *
 * `ThrottlerModule.forRoot()` configures a GLOBAL default rate limit
 * (100 requests/minute per client), applied to every route via the
 * `APP_GUARD` provider below. This is a generous baseline, not the
 * primary protection — `PaymentsController.create` (payment creation,
 * the operation with the most real abuse potential) overrides it with
 * a much stricter limit via `@Throttle` at the route level. The
 * generous global default exists so read endpoints (list/retrieve)
 * aren't accidentally choked — e.g. a client legitimately polling
 * `GET /payments/:id` to watch a payment's async status shouldn't hit
 * a wall doing so, which is exactly what this project's own e2e test
 * does.
 *
 * `HealthController` is registered directly here (not inside its own
 * module) since it's a single trivial controller with no providers of
 * its own — creating a whole module for it would be unnecessary
 * ceremony. Its `check()` method is marked `@SkipThrottle()` so uptime
 * monitors/load balancers can always reach it.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 100,
      },
    ]),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    PaymentsApiModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
