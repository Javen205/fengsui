import { FengsuiError } from '../../core/errors';

interface SmtpErrorLike {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  message?: unknown;
}

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNECTION',
  'ESOCKET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const AUTH_RESPONSE_CODES: ReadonlySet<number> = new Set([530, 534, 535]);
const RECIPIENT_RESPONSE_CODES: ReadonlySet<number> = new Set([550, 551, 553]);
const CONTENT_RESPONSE_CODES: ReadonlySet<number> = new Set([552, 554]);

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeSmtpError(error: unknown, channel: string): FengsuiError {
  const candidate = (typeof error === 'object' && error !== null ? error : {}) as SmtpErrorLike;
  const responseCode = asNumber(candidate.responseCode);
  const rawCode = asString(candidate.code);
  const response = asString(candidate.response);
  const message = asString(candidate.message) ?? 'SMTP send failed';

  const providerCode = responseCode !== undefined ? String(responseCode) : rawCode;
  const providerMessage = response ?? message;
  const details = { responseCode, code: rawCode, response, message };

  const fail = (
    code: 'network' | 'auth' | 'channel',
    summary: string,
    retryable: boolean,
  ): FengsuiError =>
    new FengsuiError({
      code,
      message: `${summary}${providerCode !== undefined ? ` (${providerCode})` : ''}: ${providerMessage}`,
      retryable,
      channel,
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(providerMessage !== providerCode ? { providerMessage } : {}),
      details,
      cause: error,
    });

  if (responseCode !== undefined) {
    if (responseCode >= 400 && responseCode < 500) {
      return fail('network', 'SMTP temporary failure', true);
    }
    if (AUTH_RESPONSE_CODES.has(responseCode)) {
      return fail('auth', 'SMTP authentication failed', false);
    }
    if (RECIPIENT_RESPONSE_CODES.has(responseCode) || CONTENT_RESPONSE_CODES.has(responseCode)) {
      return fail('channel', 'SMTP rejected the message', false);
    }
  }

  if (rawCode !== undefined && NETWORK_ERROR_CODES.has(rawCode)) {
    return fail('network', 'SMTP network error', true);
  }

  if (rawCode === 'EAUTH') {
    return fail('auth', 'SMTP authentication failed', false);
  }

  return fail('channel', 'SMTP channel error', false);
}
