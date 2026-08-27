import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PaymentStatus } from '../enums/payment-status.enum';

/**
 * Shape of the request body accepted by `PATCH /payments/:id/status`.
 *
 * Note: accepting any `PaymentStatus` value here does NOT mean any
 * transition is allowed — this DTO only validates that the value is a
 * *known* status. Whether the transition is actually legal (e.g. you
 * cannot move a COMPLETED payment back to PENDING) is enforced by the
 * state machine in `PaymentsService`, not here. Keeping that rule out
 * of the DTO keeps validation (shape) and business rules (behavior)
 * cleanly separated.
 */
export class UpdatePaymentStatusDto {
  @ApiProperty({
    description: 'The new status to transition the payment to.',
    enum: PaymentStatus,
    example: PaymentStatus.FAILED,
  })
  @IsEnum(PaymentStatus, {
    message: `status must be one of: ${Object.values(PaymentStatus).join(', ')}`,
  })
  status: PaymentStatus;
}
