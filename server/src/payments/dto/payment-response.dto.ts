import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Payment } from '../entities/payment.entity';

/**
 * Shape of a payment as returned to API clients.
 *
 * Kept as a distinct class from the internal `Payment` entity so that
 * the public API contract (documented via Swagger) can evolve
 * independently of internal storage concerns — e.g. if the entity
 * later grows internal-only fields (audit metadata, gateway
 * references), this response shape doesn't automatically leak them.
 */
export class PaymentResponseDto {
    @ApiProperty({ example: '3f1b6c2e-9a3d-4b8e-8f3a-1c2d3e4f5a6b' })
    id: string;

    @ApiProperty({ example: 5000 })
    amount: number;

    @ApiProperty({ example: 'NGN' })
    currency: string;

    @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PENDING })
    status: PaymentStatus;

    @ApiPropertyOptional({ example: 'Invoice #1024 for cashew export shipment' })
    description?: string;

    @ApiProperty({ example: '2026-08-26T17:56:41.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-08-26T17:56:41.000Z' })
    updatedAt: Date;

    /**
     * Maps an internal `Payment` domain object to its public response
     * shape. Centralizing the mapping here means controllers never
     * construct this shape by hand, so the mapping only needs to be
     * correct in one place.
     */
    static fromEntity(payment: Payment): PaymentResponseDto {
        const dto = new PaymentResponseDto();
        dto.id = payment.id;
        dto.amount = payment.amount;
        dto.currency = payment.currency;
        dto.status = payment.status;
        dto.description = payment.description;
        dto.createdAt = payment.createdAt;
        dto.updatedAt = payment.updatedAt;
        return dto;
    }
}