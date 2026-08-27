import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Unit tests for `ApiKeyGuard`.
 *
 * `ExecutionContext` is mocked with just enough shape to satisfy what
 * the guard actually calls — `switchToHttp().getRequest()`.
 */
describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  const originalApiKey = process.env.API_KEY;

  const buildContext = (headerValue: string | undefined): ExecutionContext => {
    const mockRequest = {
      header: (name: string) =>
        name.toLowerCase() === 'x-api-key' ? headerValue : undefined,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    guard = new ApiKeyGuard();
  });

  afterEach(() => {
    process.env.API_KEY = originalApiKey;
  });

  it('allows the request when the header matches API_KEY', () => {
    process.env.API_KEY = 'secret-123';

    expect(guard.canActivate(buildContext('secret-123'))).toBe(true);
  });

  it('rejects the request when the header is missing', () => {
    process.env.API_KEY = 'secret-123';

    expect(() => guard.canActivate(buildContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects the request when the header does not match', () => {
    process.env.API_KEY = 'secret-123';

    expect(() => guard.canActivate(buildContext('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('falls back to the default dev key when API_KEY is unset', () => {
    delete process.env.API_KEY;

    expect(guard.canActivate(buildContext('dev-local-api-key'))).toBe(true);
  });

  it('rejects an empty string header value', () => {
    process.env.API_KEY = 'secret-123';

    expect(() => guard.canActivate(buildContext(''))).toThrow(
      UnauthorizedException,
    );
  });
});
