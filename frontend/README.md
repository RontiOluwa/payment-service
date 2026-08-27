# Payment Service — Demo Frontend

A small Next.js frontend for the [Payment Processing Microservice](../payment-service) backend. Lets you create a payment, watch it move through its async processing lifecycle in real time, and see a list of everything created.

This is a **bonus/demo UI**, not a required deliverable — it exists to exercise the backend API visually rather than only via `curl`/Postman/Swagger.

## Features

- **Create a payment** — simple form (amount, currency, optional description)
- **Live status tracking** — after creating a payment, watch it move from `PENDING` → `PROCESSING` → `COMPLETED`/`FAILED` automatically, via polling every 1.5s
- **Payment list** — a table of every payment created, refreshing after each new submission

## Prerequisites

- Node.js 20+ and npm
- The backend running and reachable (see the [backend README](../payment-service/README.md) — it needs Redis running too)

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Edit `.env.local` if your backend isn't running on the defaults:

```bash
NEXT_PUBLIC_API_URL=http://localhost:1000
NEXT_PUBLIC_API_KEY=dev-local-api-key
```

`NEXT_PUBLIC_API_KEY` must match the backend's own `API_KEY` — if the backend uses the default (`dev-local-api-key`), leave this as-is.

## Running

```bash
npm run dev
```

**Port conflict note:** both this app and the backend default to port 3000. If you're running both locally, start one on a different port:

```bash
npm run dev -- -p 3001
```

Then open `http://localhost:3001` (or whichever port you chose) in your browser.

## Project Structure

payment-service-ui/
├── app/
│ ├── page.tsx # Main page — wires the three panels together
│ ├── layout.tsx
│ ├── globals.css
│ └── components/
│ ├── CreatePaymentForm.tsx # Payment creation form
│ ├── PaymentLookup.tsx # Single-payment status view, with polling
│ └── PaymentList.tsx # Table of all payments
├── lib/
│ └── api.ts # API client — all backend calls go through here
└── .env.local.example

`lib/api.ts` is the only file that knows about the backend's URL, headers, and error shape — every component calls its typed functions (`createPayment`, `getPayment`, `listPayments`) rather than calling `fetch()` directly.

## How It Talks to the Backend

- Every request includes the `x-api-key` header, since the backend requires it on all `/payments` routes.
- `POST /payments` includes a fresh `Idempotency-Key` (a UUID, generated per submission) — this is what lets the backend safely dedupe a retried request without you having to think about it in the UI.
- `PaymentLookup` polls `GET /payments/:id` every 1.5 seconds until the payment reaches a terminal status (`COMPLETED` or `FAILED`), then stops automatically.

## Known Limitation — API Key Exposure

`NEXT_PUBLIC_API_KEY` is bundled directly into the browser JavaScript at build time — this is how Next.js's `NEXT_PUBLIC_*` variables work, and it means the key is visible to anyone who opens browser dev tools. This is acceptable for a local demo, but **not** how a production frontend should handle a secret.

A real production setup would add a Next.js API route (a server-side file) that holds the real key server-side and proxies requests to the backend — the browser would then only ever talk to your own Next.js server, never directly to the backend with a visible credential. This wasn't built here, since it adds meaningful complexity for what is explicitly a bonus/demo UI, not the graded deliverable.

## Build for Production

```bash
npm run build
npm run start
```
