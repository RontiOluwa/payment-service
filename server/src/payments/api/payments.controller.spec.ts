import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from '../payments.service';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Payment } from '../entities/payment.entity';
import { IdempotencyStore } from './idempotency/idempotency-store';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';

/**
 * Unit tests for `PaymentsController`.
 *
 * `PaymentsService` is fully mocked — these tests only verify that
 * the controller calls the right service method with the right
 * arguments and maps the result to `PaymentResponseDto` correctly.
 * Business logic (the state machine, queuing) is already covered by
 * `PaymentsService`'s own tests and is not re-tested here.
 *
 * `IdempotencyStore` is also mocked — the `create` route is decorated
 * with `@UseInterceptors(IdempotencyInterceptor)`, so Nest's DI
 * container needs `IdempotencyInterceptor`'s dependency satisfied even
 * though these tests call `controller.create()` directly and never go
 * through the interceptor chain. A mock avoids needing a real Redis
 * connection just to compile this test module.
 * `IdempotencyInterceptor` and `IdempotencyStore` each have their own
 * dedicated test files covering their actual behavior.
 */
describe('PaymentsController', () => {
  let controller: PaymentsController;
  let mockService: {
    createPayment: jest.Mock;
    getPayment: jest.Mock;
    getAllPayments: jest.Mock;
    updateStatus: jest.Mock;
  };

  const buildPayment = (overrides: Partial<Payment> = {}): Payment => ({
    id: '3f1b6c2e-9a3d-4b8e-8f3a-1c2d3e4f5a6b',
    amount: 5000,
    currency: 'NGN',
    status: PaymentStatus.PENDING,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    mockService = {
      createPayment: jest.fn(),
      getPayment: jest.fn(),
      getAllPayments: jest.fn(),
      updateStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: mockService },
        {
          provide: IdempotencyStore,
          useValue: { tryClaim: jest.fn(), lookup: jest.fn(), complete: jest.fn(), release: jest.fn() },
        },
        IdempotencyInterceptor,
      ],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
  });

  describe('create', () => {
    it('delegates to service.createPayment and maps the result', async () => {
      const payment = buildPayment();
      mockService.createPayment.mockResolvedValue(payment);

      const result = await controller.create({
        amount: 5000,
        currency: 'NGN',
      });

      expect(mockService.createPayment).toHaveBeenCalledWith({
        amount: 5000,
        currency: 'NGN',
      });
      expect(result.id).toBe(payment.id);
      expect(result.status).toBe(PaymentStatus.PENDING);
    });
  });

  describe('findAll', () => {
    it('delegates to service.getAllPayments and maps every result', async () => {
      const payments = [
        buildPayment({ id: 'payment-1' }),
        buildPayment({ id: 'payment-2' }),
      ];
      mockService.getAllPayments.mockResolvedValue(payments);

      const result = await controller.findAll();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id)).toEqual(['payment-1', 'payment-2']);
    });
  });

  describe('findOne', () => {
    it('delegates to service.getPayment with the given id', async () => {
      const payment = buildPayment();
      mockService.getPayment.mockResolvedValue(payment);

      const result = await controller.findOne(payment.id);

      expect(mockService.getPayment).toHaveBeenCalledWith(payment.id);
      expect(result.id).toBe(payment.id);
    });

    it('propagates errors thrown by the service (e.g. NotFoundException)', async () => {
      mockService.getPayment.mockRejectedValue(new Error('not found'));

      await expect(controller.findOne('missing-id')).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('updateStatus', () => {
    it('delegates to service.updateStatus with id and new status', async () => {
      const payment = buildPayment({ status: PaymentStatus.FAILED });
      mockService.updateStatus.mockResolvedValue(payment);

      const result = await controller.updateStatus(payment.id, {
        status: PaymentStatus.FAILED,
      });

      expect(mockService.updateStatus).toHaveBeenCalledWith(
        payment.id,
        PaymentStatus.FAILED,
      );
      expect(result.status).toBe(PaymentStatus.FAILED);
    });

    it('propagates errors thrown by the service (e.g. ConflictException)', async () => {
      mockService.updateStatus.mockRejectedValue(new Error('conflict'));

      await expect(
        controller.updateStatus('payment-1', {
          status: PaymentStatus.PENDING,
        }),
      ).rejects.toThrow('conflict');
    });
  });
});
