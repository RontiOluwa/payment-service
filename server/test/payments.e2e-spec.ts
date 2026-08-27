import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Queue } from 'bullmq';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AppModule } from '../src/app.module';
import { WorkerAppModule } from '../src/worker.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PAYMENT_PROCESSING_QUEUE } from '../src/payments/processing/payment-processing.queue';

/**
 * End-to-end integration tests.
 *
 * Unlike every other test file in this project, NOTHING here is
 * mocked: a real Nest application is bootstrapped with the exact same
 * global configuration as production (`main.ts`'s `ValidationPipe`
 * and `AllExceptionsFilter`), real HTTP requests are sent via
 * Supertest, and the app talks to a real `JsonFilePaymentRepository`
 * (pointed at a temp file, not the app's real data file) and a real
 * Redis/BullMQ queue. This is what actually proves the pieces work
 * together — every other test in this project verifies one component
 * in isolation with its dependencies mocked away.
 *
 * PREREQUISITE: Redis must be running (`docker compose up -d`) before
 * this suite can pass — these tests use the real queue, not a mock.
 *
 * IMPORTANT — why this file bootstraps BOTH `AppModule` (the API) AND
 * `WorkerAppModule` (the worker): since the API/worker split
 * (`PaymentsApiModule` / `PaymentsWorkerModule`), `AppModule` alone no
 * longer includes any queue consumer at all — that's the entire point
 * of the split (see `AppModule`'s doc comment). If this test only
 * bootstrapped `AppModule`, a created payment would have nobody to
 * process it, exactly as if you ran the API in production without
 * ever starting the worker process. Booting both here mirrors a real
 * deployment (API + worker, both pointed at the same Redis and the
 * same data file) rather than testing a shape of the system that
 * doesn't actually exist anymore.
 *
 * Every request below sends the `x-api-key` header (via `API_KEY_HEADER`
 * pointing at `TEST_API_KEY`), since `PaymentsController` now requires
 * it on every route. The rate-limit STRESS test (firing enough
 * requests to actually trigger a 429) deliberately lives in a SEPARATE
 * file (`rate-limiting.e2e-spec.ts`) with its own isolated app
 * instance — this file's total `POST /payments` calls stay
 * comfortably under the create endpoint's throttle limit (30/min) so
 * this suite's own volume never risks tripping it. `maxWorkers: 1`
 * in `jest-e2e.json` forces these two files to run one at a time, not
 * concurrently, since they'd otherwise share one real BullMQ queue.
 *
 * IMPORTANT — why this file obliterates the queue in beforeAll AND
 * afterAll: even with the two e2e files running serially, leftover
 * jobs can still accumulate in Redis across SEPARATE invocations of
 * `npm run test:e2e` over time (or from manual `curl` testing against
 * a running dev server) — the queue is real and persistent, with no
 * automatic cleanup. A stale backlog from a past run can sit ahead of
 * a fresh run's own job and delay it enough to fail the lifecycle
 * test below, even though nothing is actually broken. Obliterating in
 * `beforeAll` guarantees a clean slate no matter what happened before
 * (including a prior run that crashed without reaching its own
 * `afterAll`), and obliterating again in `afterAll` leaves nothing
 * behind for whatever runs next.
 *
 * IMPORTANT — why every Idempotency-Key below has a RUN_ID suffix:
 * IdempotencyStore is backed by real Redis with a 24h TTL on
 * completed results (see idempotency-store.ts). Redis persists
 * between separate runs of this suite, even though each run gets a
 * brand-new temp JSON data file that's deleted in afterAll. If two
 * runs reused the same fixed key string, the second run's POST would
 * correctly return the FIRST run's cached result — a payment ID that
 * only ever existed in the first run's (now-deleted) temp file —
 * causing every subsequent GET in that test to 404. That isn't an app
 * bug; it's idempotency working exactly as designed. The fix is for
 * every key used here to be unique per test run.
 */
describe('Payments API (e2e)', () => {
  let app: INestApplication;
  let workerApp: TestingModule;
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

    // Point the repository at an isolated temp file so this test run
    // never touches (or is affected by) the app's real data file.
    tempDataFile = path.join(
      os.tmpdir(),
      `payments-e2e-${RUN_ID}.json`,
    );
    process.env.PAYMENTS_DATA_FILE = tempDataFile;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror main.ts's global configuration exactly — an integration
    // test that didn't apply the same pipes/filters as production
    // would be testing a different app than the one actually shipped.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    // Boot the WORKER too — see the class-level doc comment above for
    // why this is required now that the API/worker split means
    // AppModule alone has no queue consumer. Both point at the same
    // Redis (via their own, separate BullModule.forRoot() calls, just
    // like two genuinely separate processes would) and, since
    // PAYMENTS_DATA_FILE was set above before either module compiled,
    // the same isolated temp data file.
    const workerModuleFixture: TestingModule = await Test.createTestingModule(
      {
        imports: [WorkerAppModule],
      },
    ).compile();
    workerApp = workerModuleFixture;
    await workerApp.init();
  });

  afterAll(async () => {
    await app.close();
    await workerApp.close();
    await obliterateQueue();
    fs.rmSync(tempDataFile, { force: true });
    fs.rmSync(`${tempDataFile}.tmp`, { force: true });
  });

  describe('GET /health', () => {
    it('returns 200 with a status field, with NO api key required', async () => {
      const response = await request(app.getHttpServer()).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(typeof response.body.timestamp).toBe('string');
    });
  });

  describe('Authentication (ApiKeyGuard)', () => {
    it('rejects POST /payments with no x-api-key header', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', `e2e-no-api-key-${RUN_ID}`)
        .send({ amount: 100, currency: 'NGN' });

      expect(response.status).toBe(401);
    });

    it('rejects GET /payments with no x-api-key header', async () => {
      const response = await request(app.getHttpServer()).get('/payments');

      expect(response.status).toBe(401);
    });

    it('rejects a request with an incorrect x-api-key value', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments')
        .set('x-api-key', 'definitely-the-wrong-key');

      expect(response.status).toBe(401);
    });

    it('accepts a request with the correct x-api-key value', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments')
        .set('x-api-key', TEST_API_KEY);

      expect(response.status).toBe(200);
    });
  });

  describe('POST /payments', () => {
    it('rejects a request with no Idempotency-Key header (but valid api key)', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .send({ amount: 1000, currency: 'NGN' });

      expect(response.status).toBe(400);
      expect(response.body.message.toLowerCase()).toContain('idempotency-key');
      // Consistent error shape from AllExceptionsFilter, not Nest's
      // raw default — proves the global filter is actually wired in.
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path', '/payments');
    });

    it('rejects an invalid body with an array of validation messages', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-invalid-body-${RUN_ID}`)
        .send({ amount: -50, currency: 'N' });

      expect(response.status).toBe(400);
      expect(Array.isArray(response.body.message)).toBe(true);
      expect(response.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('amount'),
          expect.stringContaining('currency'),
        ]),
      );
    });

    it('rejects a body with an unknown extra field', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-unknown-field-${RUN_ID}`)
        .send({ amount: 100, currency: 'NGN', notAllowed: true });

      expect(response.status).toBe(400);
    });

    it('creates a payment and returns it in PENDING status', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-create-basic-${RUN_ID}`)
        .send({ amount: 12000, currency: 'ngn', description: 'e2e test' });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        amount: 12000,
        currency: 'NGN', // normalized to uppercase by the service
        status: 'PENDING',
        description: 'e2e test',
      });
      expect(response.body.id).toEqual(expect.any(String));
      expect(response.body.createdAt).toEqual(response.body.updatedAt);
    });

    it('returns the SAME payment for a repeated Idempotency-Key, without creating a duplicate', async () => {
      const key = `e2e-duplicate-key-${RUN_ID}`;
      const first = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', key)
        .send({ amount: 500, currency: 'NGN' });

      const second = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', key)
        .send({ amount: 500, currency: 'NGN' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);

      // Confirm only one payment actually exists with that ID's data —
      // not just that the two responses happened to match.
      const list = await request(app.getHttpServer())
        .get('/payments')
        .set('x-api-key', TEST_API_KEY);
      const matching = list.body.filter((p: { id: string }) => p.id === first.body.id);
      expect(matching).toHaveLength(1);
    });
  });

  describe('GET /payments/:id', () => {
    it('retrieves a previously created payment', async () => {
      const created = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-get-by-id-${RUN_ID}`)
        .send({ amount: 750, currency: 'NGN' });

      const response = await request(app.getHttpServer())
        .get(`/payments/${created.body.id}`)
        .set('x-api-key', TEST_API_KEY);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
    });

    it('returns 404 for a well-formed but nonexistent UUID', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/3f1b6c2e-9a3d-4b8e-8f3a-1c2d3e4f5a6b')
        .set('x-api-key', TEST_API_KEY);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
    });

    it('returns 400 for a malformed (non-UUID) ID', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/not-a-uuid')
        .set('x-api-key', TEST_API_KEY);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /payments', () => {
    it('lists payments as an array', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments')
        .set('x-api-key', TEST_API_KEY);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('PATCH /payments/:id/status', () => {
    it('returns 404 when updating a nonexistent payment', async () => {
      const response = await request(app.getHttpServer())
        .patch('/payments/3f1b6c2e-9a3d-4b8e-8f3a-1c2d3e4f5a6b/status')
        .set('x-api-key', TEST_API_KEY)
        .send({ status: 'FAILED' });

      expect(response.status).toBe(404);
    });

    it('returns 409 for an illegal transition back to PENDING', async () => {
      // PENDING and PROCESSING can both never legally move back to
      // PENDING — this holds regardless of which of those two states
      // the background worker has already moved the payment to by the
      // time this request runs, so the test isn't sensitive to timing.
      const created = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-illegal-transition-${RUN_ID}`)
        .send({ amount: 200, currency: 'NGN' });

      const response = await request(app.getHttpServer())
        .patch(`/payments/${created.body.id}/status`)
        .set('x-api-key', TEST_API_KEY)
        .send({ status: 'PENDING' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Conflict');
    });

    it('returns 400 for an unknown status value', async () => {
      const created = await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', TEST_API_KEY)
        .set('Idempotency-Key', `e2e-bad-status-value-${RUN_ID}`)
        .send({ amount: 200, currency: 'NGN' });

      const response = await request(app.getHttpServer())
        .patch(`/payments/${created.body.id}/status`)
        .set('x-api-key', TEST_API_KEY)
        .send({ status: 'NOT_A_REAL_STATUS' });

      expect(response.status).toBe(400);
    });
  });

  describe('full asynchronous lifecycle (real queue, real worker)', () => {
    it(
      'moves a payment from PENDING through to a terminal state via the real BullMQ worker',
      async () => {
        const created = await request(app.getHttpServer())
          .post('/payments')
          .set('x-api-key', TEST_API_KEY)
          .set('Idempotency-Key', `e2e-full-lifecycle-${RUN_ID}`)
          .send({ amount: 999, currency: 'NGN' });

        expect(created.body.status).toBe('PENDING');

        // Poll the real endpoint until the real background worker
        // (connected to real Redis) moves the payment to a terminal
        // state. This is the one test in the suite that genuinely
        // waits on real time passing, since it's proving the actual
        // async pipeline works end-to-end, not just that an HTTP
        // response looks right. These GET requests deliberately do
        // NOT hit the strict create-specific throttle — GET /payments/:id
        // stays under the generous global default (100/min), which is
        // exactly why that default exists (see AppModule).
        const terminalStatuses = ['COMPLETED', 'FAILED'];
        let finalStatus = created.body.status;

        for (let attempt = 0; attempt < 40; attempt++) {
          const check = await request(app.getHttpServer())
            .get(`/payments/${created.body.id}`)
            .set('x-api-key', TEST_API_KEY);
          finalStatus = check.body.status;
          if (terminalStatuses.includes(finalStatus)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        expect(terminalStatuses).toContain(finalStatus);
      },
      10_000, // generous timeout — the simulated delay is up to 3s
    );
  });
});
