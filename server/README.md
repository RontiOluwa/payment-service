# Payment Processing Microservice

A Node.js/NestJS payment-processing system built as **two independently deployable processes** — an HTTP API and a background worker — sharing one Redis instance and one JSON data file.

## Features

- REST API to create, retrieve, and update payments
- **Two separate processes**: the API only ever produces jobs; a separate worker process consumes them and does the actual async processing. Running the API alone will accept and enqueue payments but never process them — the worker must also be running.
- Persistent storage (JSON file, survives restarts, safely shared across both processes via a Redis-backed cross-process lock)
- Idempotency protection on payment creation (mandatory `Idempotency-Key` header, backed by Redis)
- Shared-secret API key authentication on every payment route
- Rate limiting (generous global default + a stricter limit on payment creation)
- Centralized, consistent error handling
- Full unit + integration (e2e) test coverage
- Interactive API documentation via Swagger

## Tech Stack

- **Framework:** NestJS (Express under the hood)
- **Language:** TypeScript
- **Queue:** BullMQ + Redis (also used for the file lock and idempotency store)
- **Persistence:** JSON file, shared by both processes
- **Testing:** Jest (unit) + Supertest (integration)
- **API docs:** Swagger / OpenAPI

## Prerequisites

- Node.js 20+ and npm
- Docker (for Redis) — or a Redis instance running locally on port 6379

## Setup

```bash
git clone <repo-url>
cd payment-service
npm install
docker compose up -d          # Redis — required by BOTH processes below
cp .env.example .env          # optional — sensible defaults are used if skipped
```

## Running the App — TWO Processes

This service is genuinely split into an API process and a worker process. **Both must be running** for payments to actually get processed:

```bash
# Terminal 1 — the API
npm run start:dev

# Terminal 2 — the worker (separately, in its own terminal)
npm run start:worker:dev
```

If you only start the API, `POST /payments` will still succeed and payments will be created — they will simply sit at `PENDING` forever, since nothing is consuming the queue. This is expected, correct behavior for a real service split, not a bug.

Production equivalents (after `npm run build`):
```bash
npm run start:prod         # API
npm run start:worker:prod  # worker
```

Once the API is running:
- API base URL: `http://localhost:3000`
- Interactive API docs (Swagger UI): `http://localhost:3000/docs`
- Liveness check: `GET http://localhost:3000/health` (no auth required)

**Port conflict note:** if you're also running the [demo frontend](../payment-service-ui), it defaults to port 3000 too — run one of them on a different port.

## Authentication

Every `/payments` route requires a matching `x-api-key` header. Requests without one, or with an incorrect value, are rejected with `401`.

If `API_KEY` isn't set in your environment, the app falls back to a documented dev-only default: **`dev-local-api-key`**. Set a strong secret via `API_KEY` for any real deployment.

`GET /health` does not require this header, since infrastructure health checks typically can't supply a credential.

This is a single shared secret, not a full authentication system — see [Architecture & Design Decisions](#architecture--design-decisions).

## Rate Limiting

- **Global default:** 100 requests/minute per client, applied to every route.
- **`POST /payments`:** a stricter 30 requests/minute — payment creation is the operation with the most real abuse potential.
- **`GET /health`:** exempt entirely.

Exceeding a limit returns `429 Too Many Requests`.

## API Reference

Full interactive documentation (with example requests/responses, and an "Authorize" button for the API key) is at `/docs` once the API is running.

| Method | Endpoint | Auth required | Description |
|---|---|---|---|
| `POST` | `/payments` | Yes | Create a payment. **Requires** an `Idempotency-Key` header too. Rate-limited to 30/min. |
| `GET` | `/payments` | Yes | List all payments. |
| `GET` | `/payments/:id` | Yes | Retrieve a single payment by ID. |
| `PATCH` | `/payments/:id/status` | Yes | Manually update a payment's status. |
| `GET` | `/health` | No | Liveness check. |

### Creating a payment

```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-local-api-key" \
  -H "Idempotency-Key: <any-unique-client-generated-value>" \
  -d '{"amount": 5000, "currency": "NGN", "description": "Invoice #1024"}'
```

The `Idempotency-Key` header is **mandatory** — a request without it is rejected with `400`. Retrying with the same key returns the original payment rather than creating a duplicate; use a new key for a genuinely new payment.

A newly created payment starts in `PENDING`. **The worker process** (not the API) transitions it through `PROCESSING` and finally to `COMPLETED` (80%) or `FAILED` (20%, deliberately, so both outcome paths are exercised). Poll `GET /payments/:id` to observe this — remember the worker must be running for this to happen at all.

### Payment status lifecycle

```
PENDING  →  PROCESSING  →  COMPLETED
                       ↘   FAILED
```

`COMPLETED`/`FAILED` are terminal. An illegal transition (automatic or via `PATCH`) returns `409 Conflict`.

### Error responses

Every error returns a consistent shape:

```json
{
  "statusCode": 404,
  "message": "Payment with id \"...\" was not found",
  "error": "Not Found",
  "timestamp": "2026-08-27T12:00:00.000Z",
  "path": "/payments/..."
}
```

## Testing

```bash
# Unit tests (mocked dependencies — no Redis required)
npm test

# Integration/e2e tests (real HTTP, real Redis, AND a real in-process
# worker context bootstrapped alongside the API — see the note in
# test/payments.e2e-spec.ts for why both are needed now)
docker compose up -d
npm run test:e2e

# Test coverage
npm run test:cov
```

Two e2e spec files, both required for `npm run test:e2e`:
- `test/payments.e2e-spec.ts` — the main functional suite. Bootstraps BOTH the API module and the worker module internally (since the split means the API alone has no consumer), so this test is self-contained and doesn't depend on a separately-running worker process.
- `test/rate-limiting.e2e-spec.ts` — an isolated stress test proving the rate limits are enforced.

`test/jest-e2e.json` sets `maxWorkers: 1` so these two files run one at a time (they share one real Redis queue). Each file wipes its BullMQ queue in `beforeAll`/`afterAll`, so leftover jobs from a previous run never interfere.

**If running `npm run start:dev` in a separate terminal while also running e2e tests**, stop it first — a second live worker connected to the same Redis can claim a job meant for the test's own isolated worker context, and since that job references a payment ID that only exists in the test's temp data file, it will fail. Confirm nothing else is running (`lsof -i :3000` should return nothing) before `npm run test:e2e`.

## Environment Variables

See `.env.example` for the full list. The most relevant:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the API listens on |
| `PAYMENTS_DATA_FILE` | `./data/payments.json` | Path to the JSON persistence file — **must be the same value for both the API and worker processes** |
| `REDIS_HOST` | `localhost` | Redis host — used for the queue, idempotency store, AND the cross-process file lock |
| `REDIS_PORT` | `6379` | Redis port |
| `API_KEY` | `dev-local-api-key` | Shared-secret key required on every `/payments` request |

## Project Structure

```
src/
├── main.ts, app.module.ts              # API process entry point
├── worker.ts, worker.module.ts         # Worker process entry point (separate deployable)
├── common/                             # Shared infra: exception filter, API key guard, Redis client
├── health/                             # Liveness endpoint (API only)
└── payments/
    ├── dto/, entities/, enums/         # Domain model — shared by both processes
    ├── repositories/                   # JsonFilePaymentRepository — shared, Redis-lock-protected
    ├── processing/                     # Queue name/job-type constants — shared
    ├── payments.service.ts             # Core business logic — shared
    ├── payments-core.module.ts         # Wires up everything shared by both processes
    ├── api/                            # API-ONLY: controller, idempotency
    │   ├── payments.controller.ts
    │   ├── payments-api.module.ts
    │   └── idempotency/
    └── worker/                         # WORKER-ONLY: the BullMQ job consumer
        ├── payment-processing.processor.ts
        └── payments-worker.module.ts
```

## Architecture & Design Decisions

The full architecture document (component breakdown, the state machine, the production evolution path) is included separately. A few decisions worth calling out here explicitly, since they were deliberate trade-offs rather than oversights:

- **The API and worker are genuinely separate processes**, not just organized classes in one process. `AppModule` never instantiates a queue consumer; `WorkerAppModule` never opens an HTTP port. They communicate only through Redis (the queue) and the shared JSON file — exactly the topology a real microservice split would have, just without a second real database per service.
- **`JsonFilePaymentRepository` uses a Redis-backed cross-process lock**, not just in-process serialization. This was a real bug found via this project's own e2e tests: two separate processes each doing "read the whole file, modify it, write it back" can silently clobber each other's unrelated writes without a lock spanning both processes. The lock (`SET ... NX EX`) is the same primitive the idempotency store uses.
- **Reads always hit disk fresh — no in-memory cache.** An earlier version cached the file's contents at startup; that broke immediately once the worker was a separate process, since its cache could never learn about payments the API created afterward.
- **Idempotency is mandatory, not optional**, and backed by Redis so the guarantee survives a restart and works across multiple instances.
- **Authentication is a single shared API key, not a full auth system** — no per-client credentials, roles, or token expiry.
- **Rate limiting is stricter on payment creation** than on read endpoints, so legitimate status polling is never accidentally throttled.
- **No real database.** The JSON file (even with the cross-process lock) is the single biggest thing that would change for a genuine production deployment — a database gives atomic, conditional updates that a whole-file read-modify-write can only approximate.

## Known Limitations

- The cross-process file lock uses a TTL-based safety net (not a compare-and-delete Lua script) — sufficient at this project's scale, but a higher-throughput deployment would want that hardening.
- Idempotency keys are cached for 24 hours with no manual eviction API.
- No pagination on `GET /payments`.
- Authentication is a single shared secret, not per-client credentials.
- Rate limits are process-local (in-memory via `@nestjs/throttler`'s default storage) — a multi-instance deployment of the API itself (not just the API/worker split) would need a shared store for limits to apply consistently.
