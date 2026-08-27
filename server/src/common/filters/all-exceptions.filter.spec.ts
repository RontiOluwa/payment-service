import {
  ArgumentsHost,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Unit tests for `AllExceptionsFilter`.
 *
 * `ArgumentsHost` is mocked with just enough shape to satisfy what
 * the filter actually calls — `switchToHttp().getResponse()` /
 * `getRequest()` — rather than a real Express request/response pair.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: { method: string; url: string };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = { method: 'GET', url: '/payments/some-id' };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('formats a NestJS HttpException (e.g. NotFoundException) consistently', () => {
    const exception = new NotFoundException(
      'Payment with id "x" was not found',
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = mockResponse.json.mock.calls[0][0];
    expect(body.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(body.message).toBe('Payment with id "x" was not found');
    expect(body.error).toBe('Not Found');
    expect(body.path).toBe('/payments/some-id');
    expect(typeof body.timestamp).toBe('string');
  });

  it('preserves an array message from a ValidationPipe-style failure', () => {
    const exception = new BadRequestException([
      'amount must be greater than 0',
    ]);

    filter.catch(exception, mockHost);

    const body = mockResponse.json.mock.calls[0][0];
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.message).toEqual(['amount must be greater than 0']);
  });

  it('never leaks details of an unexpected, non-HttpException error', () => {
    const exception = new Error('some internal secret detail');

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    const body = mockResponse.json.mock.calls[0][0];
    expect(body.message).toBe('An unexpected error occurred.');
    expect(body.message).not.toContain('some internal secret detail');
    expect(body.error).toBe('Internal Server Error');
  });

  it('includes the request path and a timestamp on every response', () => {
    filter.catch(new NotFoundException('x'), mockHost);

    const body = mockResponse.json.mock.calls[0][0];
    expect(body.path).toBe('/payments/some-id');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });
});
