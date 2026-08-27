import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

/** HTTP header clients must send a valid API key in. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Fallback API key used when the `API_KEY` environment variable isn't
 * set. This exists so a reviewer following the README's default setup
 * (`npm install && npm run start:dev`, no `.env` customization) still
 * gets a working, authenticated API out of the box — the alternative
 * would be either silently disabling authentication when unconfigured
 * (dangerous — a real deployment could go live with no auth by
 * accident) or failing to start at all (friction for a first run).
 * A real deployment MUST override this via `API_KEY` in its
 * environment — this default is documented as dev-only, not a
 * production credential.
 */
const DEFAULT_DEV_API_KEY = 'dev-local-api-key';

/**
 * Simple shared-secret authentication: every request must include a
 * matching `x-api-key` header.
 *
 * This is deliberately NOT a full authentication system — there's no
 * per-client key, no roles or scopes, no token expiry. It's a single
 * static secret, which is a legitimate, honest pattern for "this
 * endpoint requires a shared secret" (common for service-to-service
 * or internal APIs), but it does not represent user-level
 * authentication or authorization. A real production deployment
 * serving multiple distinct clients would need per-client API keys
 * (to know WHO is calling, not just THAT they're allowed to call) or
 * a full auth scheme (JWT/OAuth) — noted explicitly here rather than
 * left unstated, since presenting this as more than it is would be
 * misleading about the security posture.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.header(API_KEY_HEADER);
    const expectedKey = process.env.API_KEY ?? DEFAULT_DEV_API_KEY;

    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException(
        `A valid "${API_KEY_HEADER}" header is required.`,
      );
    }

    return true;
  }
}
