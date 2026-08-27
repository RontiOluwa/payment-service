# Payment Processing System

A payment processing microservice built with NestJS, plus a demo Next.js frontend to exercise it visually.

## Structure

.
├── payment-service/ # Backend — API + worker (Node.js/NestJS)
└── payment-service-ui/ # Frontend — demo UI (Next.js)

These are two separate projects, each with their own `package.json`, dependencies, and README. There's no shared build step between them — set each one up independently.

## Quick Start

### 1. Backend

```bash
cd payment-service
npm install
docker compose up -d          # starts Redis

# Two processes, each in its own terminal:
npm run start:dev             # the API
npm run start:worker:dev      # the background worker
```

API runs at `http://localhost:3000`, with interactive docs at `http://localhost:3000/docs`.

Full setup, API reference, testing instructions, and architecture notes: [`payment-service/README.md`](./payment-service/README.md)

### 2. Frontend (optional demo UI)

```bash
cd payment-service-ui
npm install
cp .env.local.example .env.local
npm run dev -- -p 3001        # different port than the backend
```

Full details: [`payment-service-ui/README.md`](./payment-service-ui/README.md)

## Notes

- The backend must be running (both the API **and** the worker) for payments to actually process — the frontend and API alone won't do anything without the worker consuming the queue.
- Redis is required by the backend regardless of whether you run the frontend.
- See each subfolder's README for environment variables, known limitations, and design decisions.
