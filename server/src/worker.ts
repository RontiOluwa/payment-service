import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerAppModule } from './worker.module';

/**
 * Entry point for the WORKER PROCESS — a completely separate
 * deployable from the API process (`src/main.ts`).
 *
 * Uses `NestFactory.createApplicationContext`, NOT
 * `NestFactory.create` — this process never listens on any port and
 * has no HTTP server at all. Its entire purpose is to instantiate
 * `PaymentProcessingProcessor` (registered via `WorkerAppModule` ->
 * `PaymentsWorkerModule`), which immediately starts consuming jobs
 * from the shared Redis queue the moment the application context is
 * created — there is no further action needed here to "start"
 * processing.
 *
 * Run this in its own terminal/process, alongside (not instead of)
 * the API process:
 *   npm run start:worker:dev   (development, via ts-node)
 *   npm run start:worker       (production, after `npm run build`)
 *
 * If this process is never started, the API will still accept
 * `POST /payments` requests and enqueue jobs successfully — they will
 * simply never be processed, and payments will remain in PENDING
 * indefinitely. That is the correct, observable behavior of a real
 * service split, not a bug: the API and worker are now genuinely
 * independent deployables, each of which can be started, stopped, or
 * scaled without the other.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('WorkerBootstrap');

  const app = await NestFactory.createApplicationContext(WorkerAppModule);

  // Ensures onModuleDestroy hooks (e.g. RedisShutdownHook closing the
  // idempotency Redis connection — though that module isn't imported
  // by the worker today, this is the correct default for any process
  // that should clean up on SIGTERM/SIGINT rather than exit abruptly).
  app.enableShutdownHooks();

  // Mirrors the same process-level safety nets as main.ts — this
  // process has no HTTP layer to surface errors through, so an
  // unhandled rejection or uncaught exception here would otherwise be
  // silent.
  process.on('unhandledRejection', (reason) => {
    new Logger('UnhandledRejection').error(
      'Unhandled promise rejection',
      reason instanceof Error ? reason.stack : String(reason),
    );
  });
  process.on('uncaughtException', (error) => {
    new Logger('UncaughtException').error('Uncaught exception', error.stack);
  });

  logger.log('Worker process started — consuming payment-processing queue.');

  // No app.init() or app.listen() call needed here —
  // createApplicationContext() already fully initializes the module
  // graph (running onModuleInit hooks, starting the BullMQ worker
  // consuming the queue). The process stays alive on its own because
  // the underlying Redis connection used by the worker keeps the
  // event loop active — there is no separate "start listening" step
  // for a non-HTTP application context the way there is for
  // `app.listen()` in main.ts.
}

bootstrap();
