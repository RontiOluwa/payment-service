import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsModule } from './payments/payments.module';

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
 * Beyond that, this module has no controllers/providers of its own —
 * it exists purely to compose feature modules.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    PaymentsModule,
  ],
})
export class AppModule { }