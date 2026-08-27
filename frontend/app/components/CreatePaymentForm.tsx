'use client';

import { useState } from 'react';
import { createPayment, ApiError, type Payment } from '@/lib/api';

interface Props {
  /** Called after a payment is successfully created, so the parent can react (e.g. focus the lookup panel). */
  onCreated: (payment: Payment) => void;
}

/**
 * Form for creating a new payment.
 *
 * A fresh `Idempotency-Key` (a UUID) is generated on EVERY successful
 * submission, not once per component mount. If it were generated once
 * and reused, a second intentional payment creation from this same
 * form instance would incorrectly be treated as a retry of the first
 * and return the original payment instead of creating a new one.
 */
export function CreatePaymentForm({ onCreated }: Props) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payment = await createPayment(
        {
          amount: Number(amount),
          currency,
          description: description || undefined,
        },
        crypto.randomUUID(),
      );
      onCreated(payment);
      setAmount('');
      setDescription('');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          Array.isArray(err.body.message)
            ? err.body.message.join(', ')
            : err.body.message,
        );
      } else {
        setError('Could not reach the API. Is the backend running?');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2>Create a payment</h2>

      <label>
        Amount
        <input
          type="number"
          min="0.01"
          step="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="5000"
        />
      </label>

      <label>
        Currency
        <input
          type="text"
          required
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          placeholder="NGN"
        />
      </label>

      <label>
        Description (optional)
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Invoice #1024"
        />
      </label>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create payment'}
      </button>

      {error && <p className="error">{error}</p>}
    </form>
  );
}
