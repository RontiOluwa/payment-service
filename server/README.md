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

- API base URL: `http://localhost:3000`
- Interactive API docs (Swagger UI): `http://localhost:3000/docs`
- Liveness check: `GET http://localhost:3000/health`

## API Reference

All endpoints are under the base URL. Full interactive documentation
(including example requests/responses) is available at `/docs` once the app
is running — this section is a quick reference.

| Method  | Endpoint               | Description                                                 |
| ------- | ---------------------- | ----------------------------------------------------------- |
| `POST`  | `/payments`            | Create a payment. **Requires** an `Idempotency-Key` header. |
| `GET`   | `/payments`            | List all payments.                                          |
| `GET`   | `/payments/:id`        | Retrieve a single payment by ID.                            |
| `PATCH` | `/payments/:id/status` | Manually update a payment's status.                         |
| `GET`   | `/health`              | Liveness check.                                             |

### Creating a payment

```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
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

Every error (validation failure, not-found, conflict, or an unexpected
server error) returns a consistent shape:

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

# Integration/e2e tests (real HTTP, real Redis — Redis MUST be running)
docker compose up -d
npm run test:e2e

# Test coverage
npm run test:cov
```

**Note on running the e2e suite repeatedly:** the e2e tests use real Redis
for idempotency and queue behavior. If you run the suite many times in a row
without restarting Redis, old BullMQ job data can accumulate. If you ever see
the async lifecycle test hang or time out, reset Redis first:

```bash
docker compose down -v && docker compose up -d
```

## Environment Variables

See `.env.example` for the full list with defaults. The most relevant:

| Variable             | Default                | Description                            |
| -------------------- | ---------------------- | -------------------------------------- |
| `PORT`               | `3000`                 | HTTP port the API listens on           |
| `PAYMENTS_DATA_FILE` | `./data/payments.json` | Path to the JSON persistence file      |
| `REDIS_HOST`         | `localhost`            | Redis host (queue + idempotency store) |
| `REDIS_PORT`         | `6379`                 | Redis port                             |

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
  and would work correctly if this API ever ran as more than one instance.
- **No authentication.** Out of scope for this assessment; a real deployment
  would add API-key or JWT auth in front of every route.
- **No database migrations / real DB.** Noted above — this is the single
  biggest thing that would change for a production deployment beyond this
  assessment's scope.
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
- No rate limiting or authentication on any endpoint.
