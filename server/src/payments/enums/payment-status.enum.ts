/**
The lifecycle states a payment can be in.

 State transitions are enforced by `PaymentsService` (built in a later
 step), not by this enum itself — this file only defines the set of
 valid values.

 Lifecycle:
   PENDING  --(processing engine starts)-->  PROCESSING
   PROCESSING --(simulation resolves)-->  COMPLETED | FAILED

 COMPLETED and FAILED are terminal: once reached, a payment's status
 can no longer change.
 */
export enum PaymentStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
}