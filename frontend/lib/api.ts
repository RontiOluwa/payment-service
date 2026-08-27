/**
 * Thin client for the Payment Processing Microservice API.
 *
 * SECURITY NOTE: This is a plain client-side app — `NEXT_PUBLIC_*`
 * environment variables are bundled into the browser JavaScript and
 * are visible to anyone who opens dev tools. That means the API key
 * below is NOT actually secret in this setup. This is acceptable for
 * a local demo/bonus frontend, but a real production frontend would
 * proxy these requests through a Next.js API route (a server
 * component or route handler), keeping the real API key server-side
 * and never shipping it to the browser. Noted explicitly rather than
 * silently glossed over.
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'dev-local-api-key';

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

/** Thrown when the API returns a non-2xx response. Carries the parsed error body. */
export class ApiError extends Error {
  constructor(public readonly body: ApiErrorBody) {
    super(
      Array.isArray(body.message) ? body.message.join(', ') : body.message,
    );
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      body ?? {
        statusCode: response.status,
        message: response.statusText,
        error: 'Error',
        timestamp: new Date().toISOString(),
        path,
      },
    );
  }

  return body as T;
}

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  description?: string;
}

/**
 * Creates a payment. `idempotencyKey` is required by the backend —
 * generating a fresh one (via `crypto.randomUUID()`) per user-initiated
 * submission is what prevents a double form-submit from creating two
 * payments.
 */
export function createPayment(
  input: CreatePaymentInput,
  idempotencyKey: string,
): Promise<Payment> {
  return request<Payment>('/payments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function getPayment(id: string): Promise<Payment> {
  return request<Payment>(`/payments/${id}`);
}

export function listPayments(): Promise<Payment[]> {
  return request<Payment[]>('/payments');
}
