import {
    Body,
    Controller,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Post()
    @ApiOperation({
        summary: 'Create a new payment',
        description:
            'Creates a payment in PENDING status and enqueues it for ' +
            'asynchronous processing. The response returns immediately — ' +
            'poll GET /payments/:id to observe the status change to ' +
            'PROCESSING and then COMPLETED or FAILED.',
    })
    @ApiResponse({ status: 201, description: 'Payment created successfully.', type: PaymentResponseDto })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    async create(@Body() dto: CreatePaymentDto): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.createPayment(dto);
        return PaymentResponseDto.fromEntity(payment);
    }

    @Get()
    @ApiOperation({ summary: 'List all payments' })
    @ApiResponse({ status: 200, description: 'All stored payments.', type: [PaymentResponseDto] })
    async findAll(): Promise<PaymentResponseDto[]> {
        const payments = await this.paymentsService.getAllPayments();
        return payments.map((payment) => PaymentResponseDto.fromEntity(payment));
    }

    @Get(':id')
    @ApiOperation({ summary: 'Retrieve a payment by ID' })
    @ApiParam({ name: 'id', description: 'Payment ID (UUID)' })
    @ApiResponse({ status: 200, description: 'The requested payment.', type: PaymentResponseDto })
    @ApiResponse({ status: 400, description: 'Malformed payment ID.' })
    @ApiResponse({ status: 404, description: 'Payment not found.' })
    async findOne(
        @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    ): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.getPayment(id);
        return PaymentResponseDto.fromEntity(payment);
    }

    @Patch(':id/status')
    @ApiOperation({
        summary: "Manually update a payment's status",
        description:
            'Enforces the same state-machine rules as automatic processing ' +
            '— an illegal transition (e.g. from a terminal state) is ' +
            'rejected with 409, not silently accepted.',
    })
    @ApiParam({ name: 'id', description: 'Payment ID (UUID)' })
    @ApiResponse({ status: 200, description: 'Payment status updated.', type: PaymentResponseDto })
    @ApiResponse({ status: 400, description: 'Invalid request body or ID.' })
    @ApiResponse({ status: 404, description: 'Payment not found.' })
    @ApiResponse({ status: 409, description: 'The requested status transition is not allowed.' })
    async updateStatus(
        @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
        @Body() dto: UpdatePaymentStatusDto,
    ): Promise<PaymentResponseDto> {
        const payment = await this.paymentsService.updateStatus(id, dto.status);
        return PaymentResponseDto.fromEntity(payment);
    }
}