'use client';

import { useEffect, useState } from 'react';
import { listPayments, ApiError, type Payment } from '@/lib/api';

interface Props {
  /** Bumped by the parent whenever a new payment is created, to trigger an immediate refresh. */
  refreshSignal: number;
}

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED'];
const POLL_INTERVAL_MS = 2000;

/**
 * Shows every stored payment as a simple table.
 *
 * Refetches immediately whenever `refreshSignal` changes (the parent
 * bumps this right after a successful creation), and then keeps
 * polling on its own as long as ANY visible payment is still
 * PENDING/PROCESSING — otherwise a payment's status in this table
 * would only ever update the next time a *different* payment was
 * created, leaving stale statuses visible until an unrelated action
 * happened to trigger a refetch. Polling stops automatically once
 * every payment has reached a terminal state, and resumes on its own
 * if a new payment is created (which restarts this effect via
 * `refreshSignal`).
 *
 * The self-rescheduling `setTimeout` pattern here (rather than a
 * naive `setInterval`) avoids overlapping requests if a fetch ever
 * takes longer than the poll interval — the same pattern
 * `PaymentLookup` uses for a single payment.
 */
export function PaymentList({ refreshSignal }: Props) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function fetchAndScheduleNext() {
      try {
        const data = await listPayments();
        if (cancelled) return;

        setPayments(data);
        setError(null);

        const hasActivePayment = data.some(
          (p) => !TERMINAL_STATUSES.includes(p.status),
        );
        if (hasActivePayment) {
          timer = setTimeout(fetchAndScheduleNext, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Could not load payments.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    fetchAndScheduleNext();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshSignal]);

  return (
    <div className="card">
      <h2>All payments</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && payments.length === 0 && (
        <p className="muted">No payments yet.</p>
      )}
      {payments.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id.slice(0, 8)}…</td>
                <td>
                  {p.amount} {p.currency}
                </td>
                <td>
                  <span className={`badge badge-${p.status.toLowerCase()}`}>
                    {p.status}
                  </span>
                </td>
                <td>{new Date(p.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}