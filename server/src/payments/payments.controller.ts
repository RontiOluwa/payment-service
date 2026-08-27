import {
    Body,
    Controller,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    UseInterceptors,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';

/**
 * HTTP layer for payments.
 *
 * Deliberately thin: every handler does exactly three things — parse
 * input (via DTOs/pipes, already validated by the time the body
 * reaches here), delegate to `PaymentsService`, and map the result to
 * `PaymentResponseDto`. All business rules (the state machine,
 * queuing) live in the service — if a bug shows up here, it's almost
 * certainly an HTTP wiring issue (status code, param parsing), not a
 * business-logic one.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    /**
     * `POST /payments` — creates a payment and returns immediately.
     *
     * Validation (positive amount, 3-letter currency) already happened
     * in the global `ValidationPipe` before this method runs — a
     * malformed body never reaches here. The 201 response reflects only
     * the payment's initial PENDING state; the queue-driven processing
     * that follows happens after this method has already returned.
     *
     * `IdempotencyInterceptor` wraps this handler: an optional
     * `Idempotency-Key` header lets a client safely retry this exact
     * request (e.g. after a network timeout) without risking a second
     * payment being created for what was really one intent.
     */
    @Post()
    @UseInterceptors(IdempotencyInterceptor)
    @ApiHeader({
        name: 'Idempotency-Key',
        description:
            'Optional. A client-generated unique value (e.g. a UUID). ' +
            'Retrying a POST with the same key returns the original payment ' +
            'instead of creating a duplicate.',
        required: false,
    })
    @ApiOperation({
        summary: 'Create a new payment',
        description:
            'Creates a payment in PENDING status and enqueues it for ' +
            'asynchronous processing. The response returns immediately — ' +
            'poll GET /payments/:id to observe the status change to ' +
            'PROCESSING and then COMPLETED or FAILED.',
    })
    @ApiResponse({
        status: 201,
        description: 'Payment created successfully.',
        type: PaymentResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    async create(@Body() dto: CreatePaymentDto): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.createPayment(dto);
        return PaymentResponseDto.fromEntity(payment);
    }

    /**
     * `GET /payments` — returns every stored payment, unfiltered and
     * unpaginated. Fine at this project's scale; a real deployment with
     * a large payment volume would need pagination here before this
     * became a problem.
     */
    @Get()
    @ApiOperation({ summary: 'List all payments' })
    @ApiResponse({
        status: 200,
        description: 'All stored payments.',
        type: [PaymentResponseDto],
    })
    async findAll(): Promise<PaymentResponseDto[]> {
        const payments = await this.paymentsService.getAllPayments();
        return payments.map((payment) => PaymentResponseDto.fromEntity(payment));
    }

    /**
     * `GET /payments/:id` — retrieves one payment.
     *
     * `ParseUUIDPipe` rejects a malformed `id` with 400 before this
     * method's body ever runs — a syntactically invalid ID never
     * reaches `PaymentsService`. A well-formed but nonexistent ID
     * reaches `getPayment`, which throws `NotFoundException` (mapped to
     * 404 by Nest automatically).
     */
    @Get(':id')
    @ApiOperation({ summary: 'Retrieve a payment by ID' })
    @ApiParam({ name: 'id', description: 'Payment ID (UUID)' })
    @ApiResponse({
        status: 200,
        description: 'The requested payment.',
        type: PaymentResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Malformed payment ID.' })
    @ApiResponse({ status: 404, description: 'Payment not found.' })
    async findOne(
        @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    ): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.getPayment(id);
        return PaymentResponseDto.fromEntity(payment);
    }

    /**
     * `PATCH /payments/:id/status` — manually overrides a payment's
     * status (e.g. to cancel a pending payment).
     *
     * The 404/409 responses aren't handled in this method at all — they
     * come from `PaymentsService.updateStatus` throwing
     * `NotFoundException`/`ConflictException`, which Nest's default
     * exception handling maps to the matching HTTP status automatically.
     * This endpoint uses the exact same state-machine rules as the
     * background `PaymentProcessingProcessor` (see
     * `PaymentsService.updateStatus`), so a manual override racing the
     * automatic processing is possible — see the handling of that race
     * in `PaymentProcessingProcessor.process`.
     */
    @Patch(':id/status')
    @ApiOperation({
        summary: 'Manually update a payment\'s status',
        description:
            'Enforces the same state-machine rules as automatic processing ' +
            '— an illegal transition (e.g. from a terminal state) is ' +
            'rejected with 409, not silently accepted.',
    })
    @ApiParam({ name: 'id', description: 'Payment ID (UUID)' })
    @ApiResponse({
        status: 200,
        description: 'Payment status updated.',
        type: PaymentResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body or ID.' })
    @ApiResponse({ status: 404, description: 'Payment not found.' })
    @ApiResponse({
        status: 409,
        description: 'The requested status transition is not allowed.',
    })
    async updateStatus(
        @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
        @Body() dto: UpdatePaymentStatusDto,
    ): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.updateStatus(id, dto.status);
        return PaymentResponseDto.fromEntity(payment);
    }
}