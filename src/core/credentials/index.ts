import type { CredentialResolver, ResolvedCredential } from '../adapter';
import { FengsuiError } from '../errors';

const DEFAULT_ENV_PREFIX = 'FENGSUI_CRED_';

export interface EnvCredentialResolverOptions {
  env?: Readonly<Record<string, string | undefined>>;
  prefix?: string;
}

/**
 * Maps a credentialsRef (`tenant/account`) to an environment variable name,
 * e.g. `tenant-a/qq-main` -> `FENGSUI_CRED_TENANT_A_QQ_MAIN`.
 */
export function toCredentialEnvKey(ref: string, prefix: string = DEFAULT_ENV_PREFIX): string {
  return (
    prefix +
    ref
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

function parseCredentialValue(raw: string): Readonly<Record<string, string>> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      }
    } catch {
      // Not JSON; fall back to treating the raw value as a single secret.
    }
  }
  return { value: raw };
}

export class EnvCredentialResolver implements CredentialResolver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #prefix: string;

  constructor(options: EnvCredentialResolverOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? DEFAULT_ENV_PREFIX;
  }

  async resolve(ref: string): Promise<ResolvedCredential> {
    const envKey = toCredentialEnvKey(ref, this.#prefix);
    const raw = this.#env[envKey];
    if (raw === undefined || raw === '') {
      throw new FengsuiError({
        code: 'credentials',
        message: `Credential "${ref}" is not configured (missing environment variable ${envKey})`,
        details: { ref, envKey },
      });
    }

    return { ref, values: parseCredentialValue(raw) };
  }
}

export function createEnvCredentialResolver(
  options: EnvCredentialResolverOptions = {},
): EnvCredentialResolver {
  return new EnvCredentialResolver(options);
}
