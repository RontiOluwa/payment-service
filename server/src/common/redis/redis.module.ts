import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/** DI token for the shared, general-purpose Redis client. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Closes the shared Redis connection when the Nest application shuts
 * down (including in tests, when `app.close()` is called).
 *
 * Without this, the connection this module opens stays alive after
 * the app itself has stopped — harmless in the running app (the
 * process just keeps running), but it leaves an open handle behind in
 * tests, which is exactly what surfaced this gap: Jest warned about a
 * dangling connection after the e2e suite finished, even though every
 * test itself had passed.
 */
@Injectable()
class RedisShutdownHook implements OnModuleDestroy {
    constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) { }

    async onModuleDestroy(): Promise<void> {
        await this.client.quit();
    }
}

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
        RedisShutdownHook,
    ],
    exports: [REDIS_CLIENT],
})
export class RedisModule { }