/**
 * 统一错误码。
 *
 * 用于跨渠道归类失败原因，也是重试与告警的决策依据：
 * - `validation`：入参或渠道选项非法，重试无意义；
 * - `credentials`：凭证缺失或不可用；
 * - `unsupported`：渠道不支持该能力或内容类型；
 * - `rate_limited`：被服务商限流，默认可重试；
 * - `auth`：鉴权失败（签名错误、token 过期等）；
 * - `network`：网络或传输失败，默认可重试；
 * - `channel`：服务商返回的业务错误；
 * - `budget`：超出预算或配额；
 * - `config`：配置来源不可用或配置快照非法，重试无意义；
 * - `internal`：框架内部错误。
 */
export const FENGSUI_ERROR_CODES = [
  'validation',
  'credentials',
  'unsupported',
  'rate_limited',
  'auth',
  'network',
  'channel',
  'budget',
  'config',
  'internal',
] as const;

export type FengsuiErrorCode = (typeof FENGSUI_ERROR_CODES)[number];

/** 默认视为可重试的错误码；适配器可通过 `retryable` 显式覆盖。 */
const RETRYABLE_CODES: ReadonlySet<FengsuiErrorCode> = new Set(['network', 'rate_limited']);

/** 判断错误码在默认策略下是否可重试。 */
export function isRetryableCode(code: FengsuiErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** 构造 {@link FengsuiError} 的初始化参数。 */
export interface FengsuiErrorInit {
  /** 统一错误码。 */
  code: FengsuiErrorCode;
  /** 面向开发者的错误描述，可包含渠道信息，但不得包含凭证明文。 */
  message: string;
  /** 覆盖默认重试策略；省略时按 `code` 推断。 */
  retryable?: boolean;
  /** 底层错误，会挂到 `Error.cause`。 */
  cause?: unknown;
  /** 出错渠道 ID，如 `email.qq`。 */
  channel?: string;
  /** 服务商错误码，便于排障与告警分类。 */
  providerCode?: string;
  /** 服务商原始错误描述。 */
  providerMessage?: string;
  /** 服务商建议的重试等待时间（毫秒）。 */
  retryAfterMs?: number;
  /** 结构化附加信息，写入日志与回执，避免放入敏感数据。 */
  details?: unknown;
}

/**
 * 框架统一错误。
 *
 * 所有适配器与核心逻辑都应抛出该类型，投递器据此生成逐目标失败结果与重试决策；
 * 非 `FengsuiError` 的异常会被包装为 `internal`。
 */
export class FengsuiError extends Error {
  /** 统一错误码。 */
  readonly code: FengsuiErrorCode;
  /** 是否可重试。 */
  readonly retryable: boolean;
  /** 出错渠道。 */
  readonly channel: string | undefined;
  /** 服务商错误码。 */
  readonly providerCode: string | undefined;
  /** 服务商错误描述。 */
  readonly providerMessage: string | undefined;
  /** 建议的重试等待时间（毫秒）。 */
  readonly retryAfterMs: number | undefined;
  /** 结构化附加信息。 */
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

  /** 序列化为普通对象，便于日志与 IPC 传输；不包含 `cause`，避免泄露底层堆栈。 */
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
