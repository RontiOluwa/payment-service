import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Basic liveness endpoint.
 *
 * Deliberately has no dependencies (no repository, no queue check) —
 * its only job is to confirm the HTTP server itself is up and
 * responding. A deeper "readiness" check (e.g. verifying the Redis
 * connection or the data file is writable) is a reasonable future
 * addition but is out of scope here; conflating the two would make a
 * transient Redis blip take down liveness checks too, which is
 * usually the wrong failure mode for orchestrators like Kubernetes.
 *
 * `@SkipThrottle()` exempts this endpoint from the global rate limit
 * configured in `AppModule` — uptime monitors and load balancers
 * typically poll a liveness check frequently and must never be
 * throttled, or the orchestrator could wrongly conclude the service
 * is down. This endpoint is also intentionally NOT behind
 * `ApiKeyGuard` (unlike everything in `PaymentsController`), for the
 * same reason: infrastructure health checks generally can't supply a
 * credential.
 */
@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
    @Get()
    @ApiOperation({ summary: 'Liveness check' })
    @ApiResponse({ status: 200, description: 'The service is up.' })
    check(): { status: string; timestamp: string } {
        return { status: 'ok', timestamp: new Date().toISOString() };
    }
}