import { Module } from '@nestjs/common';
import Redis from 'ioredis';

/** DI token for the shared, general-purpose Redis client. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Provides a general-purpose Redis client, separate from the
 * connection BullMQ manages internally for queues.
 *
 * BullMQ's `BullModule.forRoot()` (registered in `AppModule`) opens
 * its own Redis connection(s) for queue operations — that connection
 * isn't exposed for arbitrary commands (`SET`/`GET`/`DEL`), which is
 * exactly what `IdempotencyStore` needs. This module opens one
 * additional, plain `ioredis` connection to the same Redis instance,
 * reusing the same `REDIS_HOST`/`REDIS_PORT` configuration.
 */
@Module({
    providers: [
        {
            provide: REDIS_CLIENT,
            useFactory: () =>
                new Redis({
                    host: process.env.REDIS_HOST ?? 'localhost',
                    port: Number(process.env.REDIS_PORT ?? 6379),
                }),
        },
    ],
    exports: [REDIS_CLIENT],
})
export class RedisModule { }