import type { HttpClient } from '@fengsui/http';

import { FengsuiError } from '../errors';
import type { AdapterContext } from './types';

export * from './types';

/**
 * Returns the injected HTTP client or throws a clear, actionable error.
 * Adapters that perform HTTP requests should call this instead of assuming
 * `ctx.http` exists.
 */
export function requireHttp(ctx: Pick<AdapterContext, 'http'>): HttpClient {
  if (ctx.http === undefined) {
    throw new FengsuiError({
      code: 'internal',
      message:
        'This adapter requires an HttpClient. Inject one via createFengsui({ http }) or the adapter options.',
      retryable: false,
    });
  }
  return ctx.http;
}
