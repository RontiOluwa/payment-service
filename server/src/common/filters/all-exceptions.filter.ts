import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Consistent shape returned for every error response, regardless of
 * where the error originated — a thrown `NotFoundException`, a
 * `ValidationPipe` failure, or a completely unexpected bug all end up
 * looking the same to a client.
 */
interface ErrorResponseBody {
    statusCode: number;
    message: string | string[];
    error: string;
    timestamp: string;
    path: string;
}

/**
 * Catches every exception thrown anywhere in the app (`@Catch()` with
 * no argument matches everything, not just HTTP exceptions) and
 * formats it into one consistent JSON shape.
 *
 * This replaces relying on each exception class's own default
 * response shape. Nest's built-ins (`NotFoundException`,
 * `ConflictException`, `ValidationPipe` failures) already produce a
 * reasonable body on their own, but this filter adds `timestamp` and
 * `path` uniformly, and — more importantly — gives genuinely
 * unexpected errors (bugs, not deliberate domain exceptions) a safe,
 * generic response instead of leaking a stack trace or internal
 * error message to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const { statusCode, message, error } = this.resolveException(exception);

        // A 5xx represents a genuine bug or unexpected failure — log the
        // full detail (including stack trace) server-side even though the
        // client only ever receives the generic message below. Client
        // errors (4xx) are expected, routine traffic and don't need
        // error-level log noise for every validation failure or 404.
        if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(
                `Unhandled exception on ${request.method} ${request.url}`,
                exception instanceof Error ? exception.stack : String(exception),
            );
        }

        const body: ErrorResponseBody = {
            statusCode,
            message,
            error,
            timestamp: new Date().toISOString(),
            path: request.url,
        };

        response.status(statusCode).json(body);
    }

    /**
     * Normalizes any thrown value into a consistent
     * `{ statusCode, message, error }` triple.
     *
     * Nest's built-in `HttpException` subclasses (and `ValidationPipe`
     * failures) already carry a structured response body — that's
     * reused directly rather than re-derived. Anything that ISN'T an
     * `HttpException` at all (a genuine bug — a thrown plain object, a
     * null-pointer-style error, anything unanticipated) is deliberately
     * NOT passed through to the client: its real message could contain
     * internal details (file paths, library internals) that shouldn't
     * be exposed over a public API.
     */
    private resolveException(exception: unknown): {
        statusCode: number;
        message: string | string[];
        error: string;
    } {
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const payload = exception.getResponse();

            if (typeof payload === 'object' && payload !== null) {
                const body = payload as Record<string, unknown>;
                return {
                    statusCode: status,
                    message: (body.message as string | string[]) ?? exception.message,
                    error: (body.error as string) ?? 'Error',
                };
            }

            return {
                statusCode: status,
                message: typeof payload === 'string' ? payload : exception.message,
                error: 'Error',
            };
        }

        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'An unexpected error occurred.',
            error: 'Internal Server Error',
        };
    }
}