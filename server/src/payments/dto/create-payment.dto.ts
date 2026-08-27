import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsPositive,
  IsString,
  Length,
  IsOptional,
  MaxLength,
} from 'class-validator';

/**
 * Shape of the request body accepted by `POST /payments`.
 *
 * Every field here is validated automatically by the global
 * `ValidationPipe` configured in `main.ts` before this DTO ever
 * reaches the controller — if validation fails, the request is
 * rejected with a 400 and a field-level error message, and no
 * business logic runs.
 */
export class CreatePaymentDto {
  @ApiProperty({
    description: 'The payment amount (must be a positive number).',
    example: 5000,
  })
  @IsNumber({}, { message: 'amount must be a number' })
  @IsPositive({ message: 'amount must be greater than 0' })
  amount: number;

  @ApiProperty({
    description: 'ISO 4217 currency code (3 letters), e.g. NGN, USD.',
    example: 'NGN',
  })
  @IsString()
  @Length(3, 3, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency: string;

  @ApiPropertyOptional({
    description: 'Optional free-text description of the payment.',
    example: 'Invoice #1024 for cashew export shipment',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
