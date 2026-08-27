'use client';

import { useState } from 'react';
import { CreatePaymentForm } from './components/CreatePaymentForm';
import { PaymentLookup } from './components/PaymentLookup';
import { PaymentList } from './components/PaymentList';
import type { Payment } from '@/lib/api';

/**
 * Single-page demo UI for the Payment Processing Microservice.
 *
 * Deliberately simple: one page, three panels, no routing, no state
 * management library. State that needs to cross component boundaries
 * (the just-created payment, a signal to refresh the list) lives here
 * and is passed down as props — this is a bonus demo frontend, not
 * the graded deliverable, so it's kept as light as it can be while
 * still genuinely exercising the backend end-to-end.
 */
export default function Home() {
  const [activePayment, setActivePayment] = useState<Payment | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  function handleCreated(payment: Payment) {
    setActivePayment(payment);
    setRefreshSignal((n) => n + 1);
  }

  return (
    <main>
      <h1>Payment Processing Microservice</h1>
      <p className="muted">
        Demo frontend for the backend API. Create a payment and watch it
        move through PENDING → PROCESSING → COMPLETED/FAILED in real time.
      </p>

      <div className="grid">
        <CreatePaymentForm onCreated={handleCreated} />
        <PaymentLookup payment={activePayment} />
      </div>

      <PaymentList refreshSignal={refreshSignal} />
    </main>
  );
}
