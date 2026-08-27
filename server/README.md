# Payment Processing Microservice

A Node.js/NestJS microservice simulating payment processing: create payments,
track their status, and observe realistic asynchronous processing via a real
job queue.

## Features

- REST API to create, retrieve, and update payments
- Asynchronous payment processing via Redis/BullMQ (not a fake `setTimeout`
  bolted onto the request — a real, durable job queue)
- Persistent storage (JSON file, survives restarts)
- Idempotency protection on payment creation (mandatory `Idempotency-Key`
  header, backed by Redis — survives restarts and works across multiple
  instances)
- Shared-secret API key authentication on every payment route
- Rate limiting (global default + a stricter limit on payment creation)
- Centralized, consistent error handling
- Full unit + integration (e2e) test coverage
- Interactive API documentation via Swagger

## Tech Stack

- **Framework:** NestJS (Express under the hood)
- **Language:** TypeScript
- **Queue:** BullMQ + Redis
- **Persistence:** JSON file (see [Architecture](#architecture--design-decisions))
- **Testing:** Jest (unit) + Supertest (integration)
- **API docs:** Swagger / OpenAPI

## Prerequisites

- Node.js 20+ and npm
- Docker (for Redis) — or a Redis instance running locally on port 6379

## Setup

```bash
# 1. Clone and install dependencies
git clone <repo-url>
cd payment-service
npm install

# 2. Start Redis (required — the app will not function correctly without it)
docker compose up -d

# 3. (Optional) copy the example env file — sensible defaults are used if skipped
cp .env.example .env
```

## Running the App

```bash
# Development (hot reload)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

Once running:

- API base URL: `http://localhost:1000`
- Interactive API docs (Swagger UI): `http://localhost:1000/docs`
- Liveness check: `GET http://localhost:1000/health` (no auth required)

## Authentication

Every `/payments` route requires a matching `x-api-key` header. Requests
without one, or with an incorrect value, are rejected with `401`.

If you haven't set `API_KEY` in your environment, the app falls back to a
documented dev-only default: **`dev-local-api-key`**. For any real
deployment, set a strong secret via the `API_KEY` environment variable — the
default exists purely so a fresh checkout works out of the box for local
development and review.

`GET /health` deliberately does **not** require this header, since
infrastructure health checks (load balancers, uptime monitors) typically
can't supply a credential.

This is a single shared secret, not a full authentication system — there's
no per-client key, no roles, no token expiry. See
[Architecture & Design Decisions](#architecture--design-decisions) for why
that scope was chosen.

## Rate Limiting

- **Global default:** 100 requests/minute per client, applied to every route.
- **`POST /payments`:** a stricter 30 requests/minute, since payment creation
  is the operation with the most real abuse/resource-exhaustion potential.
- **`GET /health`:** exempt entirely — never throttled, regardless of volume.

Exceeding a limit returns `429 Too Many Requests`.

## API Reference

All endpoints are under the base URL. Full interactive documentation
(including example requests/responses, and an "Authorize" button for the API
key) is available at `/docs` once the app is running — this section is a
quick reference.

| Method  | Endpoint               | Auth required | Description                                                                             |
| ------- | ---------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `POST`  | `/payments`            | Yes           | Create a payment. **Requires** an `Idempotency-Key` header too. Rate-limited to 30/min. |
| `GET`   | `/payments`            | Yes           | List all payments.                                                                      |
| `GET`   | `/payments/:id`        | Yes           | Retrieve a single payment by ID.                                                        |
| `PATCH` | `/payments/:id/status` | Yes           | Manually update a payment's status.                                                     |
| `GET`   | `/health`              | No            | Liveness check.                                                                         |

### Creating a payment

```bash
curl -X POST http://localhost:1000/payments \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-local-api-key" \
  -H "Idempotency-Key: <any-unique-client-generated-value>" \
  -d '{"amount": 5000, "currency": "NGN", "description": "Invoice #1024"}'
```

The `Idempotency-Key` header is **mandatory** — a request without it is
rejected with `400`. This guarantees that retrying the same request (e.g.
after a network timeout) never creates a duplicate payment. Reusing the same
key returns the original payment; use a new key for a genuinely new payment.

A newly created payment starts in `PENDING` status. It transitions
automatically — via a real background worker, not an inline delay — through
`PROCESSING` and finally to `COMPLETED` (80% of the time) or `FAILED` (20%,
deliberately, so both outcome paths are exercised). Poll `GET /payments/:id`
to observe this.

### Payment status lifecycle

`COMPLETED` and `FAILED` are terminal — no further transition is permitted
from either, whether attempted automatically or via the manual `PATCH`
endpoint. An illegal transition returns `409 Conflict`.

### Error responses

Every error (validation failure, missing/invalid API key, not-found,
conflict, rate limit exceeded, or an unexpected server error) returns a
consistent shape:

```json
{
  "statusCode": 404,
  "message": "Payment with id \"...\" was not found",
  "error": "Not Found",
  "timestamp": "2026-08-27T12:00:00.000Z",
  "path": "/payments/..."
}
```

## Testing via Swagger

1. Go to `http://localhost:1000/docs`
2. Click **Authorize**, paste your API key (`dev-local-api-key` if unset),
   click **Authorize**, then **Close** — every request from here on
   automatically includes the header.
3. Expand `POST /payments` → **Try it out** → fill in an `Idempotency-Key`
   and a request body → **Execute**.
4. Copy the returned `id`, then use it in `GET /payments/{id}` to watch the
   status change over the next few seconds.

## Testing

```bash
# Unit tests (mocked dependencies — no Redis required)
npm test

# Integration/e2e tests (real HTTP, real Redis — Redis MUST be running)
docker compose up -d
npm run test:e2e

# Test coverage
npm run test:cov
```

There are two e2e spec files:

- `test/payments.e2e-spec.ts` — the main functional suite (CRUD, validation,
  auth, idempotency, the full async lifecycle).
- `test/rate-limiting.e2e-spec.ts` — an isolated stress test proving the
  rate limits are genuinely enforced.

Both use a real Redis/BullMQ queue, so a few things matter for a reliable
run:

- **Stop any other running instance of the app before running e2e tests.**
  If `npm run start:dev` (or another copy of this app) is running in a
  separate terminal, its background worker is connected to the _same_ real
  Redis queue and can claim a job that belongs to the test's own isolated
  app instance — since that job references a payment ID that only exists in
  the test's temp data file, the job fails immediately, and the test hangs
  waiting for a job that was never actually processed by its own worker.
  Confirm nothing else is running (`lsof -i :1000` should return nothing)
  before running `npm run test:e2e`.
- Each e2e file fully wipes its BullMQ queue in `beforeAll`/`afterAll`, so
  leftover jobs from a previous run (or manual `curl` testing) never
  interfere — you do not need to manually flush Redis before running tests.
- `test/jest-e2e.json` sets `maxWorkers: 1` so the two e2e files run one at a
  time, not concurrently — they share one real Redis queue and would
  otherwise contend with each other's jobs.

## Environment Variables

See `.env.example` for the full list with defaults. The most relevant:

| Variable             | Default                | Description                                             |
| -------------------- | ---------------------- | ------------------------------------------------------- |
| `PORT`               | `1000`                 | HTTP port the API listens on                            |
| `PAYMENTS_DATA_FILE` | `./data/payments.json` | Path to the JSON persistence file                       |
| `REDIS_HOST`         | `localhost`            | Redis host (queue + idempotency store)                  |
| `REDIS_PORT`         | `6379`                 | Redis port                                              |
| `API_KEY`            | `dev-local-api-key`    | Shared-secret key required on every `/payments` request |

## Architecture & Design Decisions

The full architecture document (component breakdown, the payment state
machine, the queue design, and the production evolution path) is included
separately. A few decisions worth calling out explicitly here, since they
were deliberate trade-offs made for this project's scope rather than
oversights:

- **Persistence is a JSON file, not a database.** Chosen for the
  assessment's explicit "in-memory or file-based" scope. The
  `PaymentRepository` interface it's built behind means swapping in a real
  database later touches one file (`payments.module.ts`), not business logic.
- **A real queue (Redis/BullMQ), not a `setTimeout`.** This was upgraded
  from an initial simpler design once persistence became durable — a
  `setTimeout`-based simulation loses in-flight work on a crash; BullMQ does
  not.
- **Idempotency is mandatory, not optional**, and backed by Redis (not an
  in-memory `Map`) specifically so the guarantee survives a process restart
  and works correctly across multiple instances of this API.
- **Authentication is a single shared API key, not a full auth system.**
  There's no per-client key, no roles/scopes, no token expiry — this is an
  honest "shared secret required" pattern, not user-level authentication or
  authorization. A real deployment serving multiple distinct clients would
  need per-client API keys or a full scheme (JWT/OAuth).
- **Rate limiting is IP/client-based via `@nestjs/throttler`**, with a
  stricter limit specifically on payment creation rather than a single
  blanket limit — the operation with the most real abuse potential gets the
  tightest control, while read endpoints stay generously limited so
  legitimate polling (e.g. watching a payment's status) is never choked.
- **No database migrations / real DB.** The single biggest thing that would
  change for a production deployment beyond this assessment's scope.
- **BullMQ worker concurrency is set to 5** (not left at the default of 1),
  so multiple payments created in quick succession are processed in
  parallel rather than strictly one at a time — found and fixed via the
  integration test suite.

## Known Limitations

Documented explicitly rather than silently omitted:

- The JSON file has no row-level locking beyond the app's own internal write
  queue — fine for a single instance, would need a real database for
  multiple instances.
- Idempotency keys are cached for 24 hours with no manual eviction API.
- No pagination on `GET /payments` — fine at this project's scale.
- Authentication is a single shared secret, not per-client credentials or
  full user-level authentication.
- Rate limits are process-local (in-memory) via `@nestjs/throttler`'s
  default storage — a multi-instance deployment would need a shared store
  (e.g. Redis-backed) for limits to apply consistently across instances.
