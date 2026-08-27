'use client';

import { useEffect, useRef, useState } from 'react';
import { getPayment, ApiError, type Payment } from '@/lib/api';

interface Props {
  /** The payment to display and poll. Passed down from the parent (e.g. right after creation). */
  payment: Payment | null;
}

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED'];
const POLL_INTERVAL_MS = 1500;

/**
 * Shows a single payment's current status, polling automatically
 * while it's still PENDING/PROCESSING so the status change to
 * COMPLETED/FAILED is visible without a manual refresh — this is the
 * panel that actually demonstrates the backend's async processing
 * pipeline, not just its CRUD surface.
 *
 * Polling stops on its own once a terminal status is reached, or if
 * the component unmounts (the `cancelled` flag below prevents a
 * state update after that point, avoiding a React warning).
 */
export function PaymentLookup({ payment: initialPayment }: Props) {
  const [payment, setPayment] = useState<Payment | null>(initialPayment);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setPayment(initialPayment);
    setError(null);
  }, [initialPayment]);

  useEffect(() => {
    cancelledRef.current = false;

    if (!payment || TERMINAL_STATUSES.includes(payment.status)) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const updated = await getPayment(payment.id);
        if (!cancelledRef.current) {
          setPayment(updated);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          setError(
            err instanceof ApiError ? err.message : 'Lost connection to the API.',
          );
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [payment]);

  if (!payment) {
    return (
      <div className="card">
        <h2>Payment status</h2>
        <p className="muted">Create a payment to see its status here.</p>
      </div>
    );
  }

  const isPolling = !TERMINAL_STATUSES.includes(payment.status);

  return (
    <div className="card">
      <h2>Payment status</h2>
      <dl>
        <dt>ID</dt>
        <dd className="mono">{payment.id}</dd>
        <dt>Amount</dt>
        <dd>
          {payment.amount} {payment.currency}
        </dd>
        <dt>Status</dt>
        <dd>
          <span className={`badge badge-${payment.status.toLowerCase()}`}>
            {payment.status}
          </span>
          {isPolling && <span className="muted"> — watching for updates…</span>}
        </dd>
        {payment.description && (
          <>
            <dt>Description</dt>
            <dd>{payment.description}</dd>
          </>
        )}
      </dl>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
