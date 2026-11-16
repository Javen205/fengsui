export const FENGSUI_ERROR_CODES = [
  'validation',
  'credentials',
  'unsupported',
  'rate_limited',
  'auth',
  'network',
  'channel',
  'budget',
  'internal',
] as const;

export type FengsuiErrorCode = (typeof FENGSUI_ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<FengsuiErrorCode> = new Set(['network', 'rate_limited']);

export function isRetryableCode(code: FengsuiErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export interface FengsuiErrorInit {
  code: FengsuiErrorCode;
  message: string;
  retryable?: boolean;
  cause?: unknown;
  channel?: string;
  providerCode?: string;
  providerMessage?: string;
  retryAfterMs?: number;
  details?: unknown;
}

export class FengsuiError extends Error {
  readonly code: FengsuiErrorCode;
  readonly retryable: boolean;
  readonly channel: string | undefined;
  readonly providerCode: string | undefined;
  readonly providerMessage: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;

  constructor(init: FengsuiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'FengsuiError';
    this.code = init.code;
    this.retryable = init.retryable ?? isRetryableCode(init.code);
    this.channel = init.channel;
    this.providerCode = init.providerCode;
    this.providerMessage = init.providerMessage;
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      channel: this.channel,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}
