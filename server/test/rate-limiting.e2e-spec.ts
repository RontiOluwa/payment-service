import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Queue } from 'bullmq';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PAYMENT_PROCESSING_QUEUE } from '../src/payments/processing/payment-processing.queue';

/**
 * Isolated rate-limiting stress test.
 *
 * This lives in its OWN file with its OWN app instance (a fresh
 * Nest application, meaning fresh in-memory throttler counters —
 * `@nestjs/throttler`'s default storage is per-process, not shared
 * with `payments.e2e-spec.ts`'s app instance) specifically so it can
 * deliberately exceed the rate limits without disturbing the main
 * suite's request budget. Mixing this into the main file would create
 * a real problem: the main suite's own legitimate test traffic
 * already uses a meaningful fraction of the create endpoint's
 * throttle limit, and a stress test firing dozens more requests in
 * that same window would risk throttling the main suite's OWN
 * requests — a false failure caused by test interaction, not a real
 * bug.
 *
 * PREREQUISITE: Redis must be running (`docker compose up -d`).
 *
 * IMPORTANT — why `test/jest-e2e.json` sets `maxWorkers: 1`: Jest runs
 * separate test FILES in parallel worker processes by default. This
 * file and `payments.e2e-spec.ts` each boot their own isolated app
 * instance with their own isolated JSON data file — but both connect
 * to the SAME real Redis instance and use the SAME literal BullMQ
 * queue name (`payment-processing`). Running them concurrently means
 * jobs from both files' test traffic land in one shared queue,
 * competing for processing slots across two separate worker
 * instances. Forcing Jest to run e2e test files serially eliminates
 * that specific cross-file contention.
 *
 * IMPORTANT — why this file ALSO obliterates the queue in beforeAll
 * AND afterAll: serial execution alone isn't enough, because Redis is
 * a real, persistent external resource — leftover jobs can still
 * accumulate across SEPARATE invocations of `npm run test:e2e` over
 * time, or from manual `curl` testing against a running dev server.
 * This file creates roughly 35 jobs per run purely to trigger
 * throttling; without cleanup, a growing backlog here would eventually
 * delay a completely unrelated job in `payments.e2e-spec.ts`'s own
 * lifecycle test. Obliterating in `beforeAll` guarantees a clean slate
 * regardless of what happened before (including a prior run that
 * crashed before reaching its own `afterAll`), and obliterating again
 * in `afterAll` leaves nothing behind for whatever runs next.
 */
describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  let tempDataFile: string;
  const RUN_ID = Date.now();
  const TEST_API_KEY = process.env.API_KEY ?? 'dev-local-api-key';

  /** Fully wipes the BullMQ queue (all waiting/active/completed/failed jobs). */
  async function obliterateQueue(): Promise<void> {
    const queue = new Queue(PAYMENT_PROCESSING_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
    await queue.obliterate({ force: true });
    await queue.close();
  }

  beforeAll(async () => {
    await obliterateQueue();

    tempDataFile = path.join(
      os.tmpdir(),
      `payments-e2e-ratelimit-${RUN_ID}.json`,
    );
    process.env.PAYMENTS_DATA_FILE = tempDataFile;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await obliterateQueue();
    fs.rmSync(tempDataFile, { force: true });
    fs.rmSync(`${tempDataFile}.tmp`, { force: true });
  });

  it(
    'returns 429 once the create endpoint\'s per-minute limit (30) is exceeded',
    async () => {
      const responses: number[] = [];

      // Fire 35 requests — comfortably past the configured limit of
      // 30/min for POST /payments — each with its own unique
      // Idempotency-Key so none of them short-circuit as a cached
      // duplicate (which would skip the throttle-relevant handler
      // path entirely and defeat the point of this test).
      for (let i = 0; i < 35; i++) {
        const response = await request(app.getHttpServer())
          .post('/payments')
          .set('x-api-key', TEST_API_KEY)
          .set('Idempotency-Key', `rate-limit-test-${RUN_ID}-${i}`)
          .send({ amount: 10, currency: 'NGN' });
        responses.push(response.status);
      }

      const successCount = responses.filter((s) => s === 201).length;
      const throttledCount = responses.filter((s) => s === 429).length;

      // The first ~30 should succeed, the rest should be throttled.
      // Exact boundary isn't asserted precisely (timing can shift it
      // by one or two) — what matters is that BOTH outcomes actually
      // occurred, proving the limit is real and enforced.
      expect(successCount).toBeGreaterThan(0);
      expect(successCount).toBeLessThanOrEqual(30);
      expect(throttledCount).toBeGreaterThan(0);
    },
    15_000,
  );

  it('never throttles GET /health, however many times it is called', async () => {
    const responses: number[] = [];

    // 150 rapid calls — well past the global default limit of
    // 100/min that would apply if @SkipThrottle() on HealthController
    // were not working.
    for (let i = 0; i < 150; i++) {
      const response = await request(app.getHttpServer()).get('/health');
      responses.push(response.status);
    }

    expect(responses.every((status) => status === 200)).toBe(true);
  }, 20_000);
});
