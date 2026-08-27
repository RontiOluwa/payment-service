import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Application bootstrap.
 *
 * Responsible for:
 *  - Creating the Nest application instance
 *  - Enabling global input validation (DTOs are enforced automatically)
 *  - Enabling CORS so a separately-served frontend can call this API
 *  - Registering the global exception filter for consistent error responses
 *  - Wiring up Swagger (OpenAPI) documentation at `/docs`
 *  - Starting the HTTP listener
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Global validation pipe: every incoming request body is validated
  // against its DTO's class-validator decorators before it reaches a
  // controller. Unknown/extra fields are stripped (whitelist) and a
  // request containing them is rejected outright (forbidNonWhitelisted),
  // which doubles as a lightweight security boundary against unexpected
  // payload shapes.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true, // auto-transform payloads into typed DTO instances
    }),
  );

  // Allow a separately-hosted frontend (e.g. Vite dev server on a
  // different port/origin) to call this API during local development.
  app.enableCors();

  // Every error response (thrown domain exceptions, validation
  // failures, or a genuinely unexpected bug) is normalized into one
  // consistent JSON shape by this filter, applied globally so no
  // controller needs to think about error formatting itself.
  app.useGlobalFilters(new AllExceptionsFilter());

  // OpenAPI/Swagger documentation, generated from controller and DTO
  // decorators. Served at GET /docs once the app is running.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payment Processing Microservice')
    .setDescription(
      'A simulated payment processing API: create payments, retrieve ' +
      'their status, and observe asynchronous processing transitions.',
    )
    .setVersion('1.0')
    .addApiKey(
      { type: 'apiKey', name: 'x-api-key', in: 'header' },
      'api-key',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = process.env.PORT ?? 1000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`API documentation available at: http://localhost:${port}/docs`);
}

// Process-level safety nets: an unhandled promise rejection or a
// truly uncaught exception anywhere in the process is logged loudly
// rather than crashing silently or corrupting state invisibly. This
// doesn't replace proper error handling elsewhere in the app — it's
// a last-resort net for anything that slips through everything else.
process.on('unhandledRejection', (reason) => {
  new Logger('UnhandledRejection').error(
    'Unhandled promise rejection',
    reason instanceof Error ? reason.stack : String(reason),
  );
});

process.on('uncaughtException', (error) => {
  new Logger('UncaughtException').error('Uncaught exception', error.stack);
});

bootstrap();
