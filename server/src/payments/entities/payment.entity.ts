import { PaymentStatus } from '../enums/payment-status.enum';

/**
 * The core `Payment` domain object.
 *
 * This is a plain TypeScript interface rather than a database ORM
 * entity, since the assessment scope uses in-memory/file persistence,
 * not a real database. If this project were migrated to a database
 * later (see the architecture doc's "path to production" section),
 * this shape would become a TypeORM/Prisma entity — but the interface
 * itself would stay the same, which is exactly why business logic is
 * written against this interface rather than against a specific
 * storage technology.
 */
export interface Payment {
  /** Unique identifier for the payment (UUID v4). */
  id: string;

  /** Payment amount, in the smallest currency unit is NOT assumed here —
   *  this is treated as a plain decimal amount (e.g. 100.50). */
  amount: number;

  /** ISO 4217 currency code, e.g. "NGN", "USD". */
  currency: string;

  /** Current lifecycle state of the payment. */
  status: PaymentStatus;

  /** Optional free-text description of what the payment is for. */
  description?: string;

  /** Timestamp the payment record was created. */
  createdAt: Date;

  /** Timestamp the payment record was last updated. */
  updatedAt: Date;
}
