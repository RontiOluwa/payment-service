'use client';

import { useEffect, useState } from 'react';
import { listPayments, ApiError, type Payment } from '@/lib/api';

export interface PaymentListHandle {
  refresh: () => void;
}

interface Props {
  /** Bumped by the parent whenever a new payment is created, to trigger a refresh. */
  refreshSignal: number;
}

/**
 * Shows every stored payment as a simple table. Re-fetches whenever
 * `refreshSignal` changes (the parent bumps this after a successful
 * creation) — this is a simple, explicit refresh trigger rather than
 * its own polling loop, since `PaymentLookup` already owns the
 * "watch one payment change over time" responsibility.
 */
export function PaymentList({ refreshSignal }: Props) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    listPayments()
      .then((data) => {
        if (!cancelled) setPayments(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Could not load payments.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
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
