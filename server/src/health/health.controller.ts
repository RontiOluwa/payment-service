import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
    @Get()
    @ApiOperation({ summary: 'Liveness check' })
    @ApiResponse({ status: 200, description: 'The service is up.' })
    check(): { status: string; timestamp: string } {
        return { status: 'ok', timestamp: new Date().toISOString() };
    }
}