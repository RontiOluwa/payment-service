import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PaymentsModule } from './payments/payments.module';
import { HealthController } from './health/health.controller';

/**
 * Root application module.
 *
 * `BullModule.forRoot()` establishes the shared Redis connection used
 * by every BullMQ queue in the app. It's registered here (not inside
 * `PaymentsModule`) because the Redis connection is process-wide
 * infrastructure — any future module adding its own queue would reuse
 * this same connection rather than opening a new one.
 *
 * Connection details come from environment variables (see
 * `.env.example`), defaulting to a local Redis instance on the
 * standard port — matching what `docker-compose.yml` provides.
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
 * monitors/load balancers can always reach it. Feature modules with
 * real logic (like `PaymentsModule`) still get their own module and
 * are imported below.
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
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule { }