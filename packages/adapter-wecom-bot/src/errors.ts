/**
 * 企业微信错误归一化。
 *
 * SDK 有两类失败：
 * - 回执帧带 `errcode`（业务错误），需要按错误码归类；
 * - 连接 / 认证异常（如重连耗尽），需要识别 SDK 自定义错误码。
 *
 * 所有错误统一包装成 `FengsuiError`，让投递器按 `retryable` 决定是否重试。
 */
import { FengsuiError } from '@javen205/fengsui-core';
import type { WsFrame } from '@wecom/aibot-node-sdk';

/** 鉴权类错误码：凭证错误或失效，重试无意义。 */
const AUTH_CODES: ReadonlySet<number> = new Set([
  40001, // invalid credential / secret
  40013, // invalid corpid
  40014, // invalid access_token
  41001, // missing access_token
  42001, // expired access_token
  301002, // no privilege
]);

/** 限流类错误码：可重试。 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  45009, // api freq out of limit
  45033, // api concurrent limit
]);

/** 参数类错误码：入参不合法，重试无意义。 */
const VALIDATION_CODES: ReadonlySet<number> = new Set([
  40003, // invalid userid
  40008, // invalid message type
  40009, // invalid image size
  45002, // content too long
  45003, // title too long
]);

/** 被动回复窗口过期：超过 5 秒再回复会失败。 */
const REPLY_WINDOW_CODE = 45015;

/** 网络类 Node 错误码。 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** SDK 自定义错误码。 */
const AUTH_FAILURE_EXHAUSTED = 'WS_AUTH_FAILURE_EXHAUSTED';
const RECONNECT_EXHAUSTED = 'WS_RECONNECT_EXHAUSTED';

interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 校验回执帧；`errcode` 非 0 时抛出对应错误。
 *
 * @param frame SDK 返回的回执帧。
 * @param channel 渠道 ID，写入错误便于排障。
 * @param action 本次操作名，如 `sendMessage` / `replyStream`。
 */
export function assertFrameOk(frame: WsFrame, channel: string, action: string): void {
  if (frame.errcode === undefined || frame.errcode === 0) {
    return;
  }

  const code = frame.errcode;
  const detail = frame.errmsg ?? `errcode ${code}`;
  const base = {
    channel,
    providerCode: String(code),
    providerMessage: detail,
    details: { action, errcode: code, errmsg: frame.errmsg },
  };

  if (AUTH_CODES.has(code)) {
    throw new FengsuiError({
      ...base,
      code: 'auth',
      retryable: false,
      message: `WeCom ${action} failed with authentication error (${code}): ${detail}`,
    });
  }

  if (RATE_LIMIT_CODES.has(code)) {
    throw new FengsuiError({
      ...base,
      code: 'rate_limited',
      retryable: true,
      message: `WeCom ${action} was rate limited (${code}): ${detail}`,
    });
  }

  if (VALIDATION_CODES.has(code)) {
    throw new FengsuiError({
      ...base,
      code: 'validation',
      retryable: false,
      message: `WeCom ${action} rejected the request (${code}): ${detail}`,
    });
  }

  if (code === REPLY_WINDOW_CODE) {
    throw new FengsuiError({
      ...base,
      code: 'channel',
      retryable: false,
      message: `WeCom ${action} failed because the 5s passive reply window has expired (${code}): ${detail}`,
    });
  }

  throw new FengsuiError({
    ...base,
    code: 'channel',
    retryable: false,
    message: `WeCom ${action} failed (${code}): ${detail}`,
  });
}

/**
 * 归一化 SDK 抛出的异常。
 *
 * 已包装的 `FengsuiError` 原样返回；其余按错误码或网络特征分类。
 */
export function normalizeWecomError(error: unknown, channel: string, action: string): FengsuiError {
  if (error instanceof FengsuiError) {
    return error;
  }

  const candidate = (typeof error === 'object' && error !== null ? error : {}) as ErrorLike;
  const rawCode = asString(candidate.code);
  const message = asString(candidate.message) ?? 'unknown error';
  const details = { action, code: rawCode, message };

  if (rawCode === AUTH_FAILURE_EXHAUSTED) {
    return new FengsuiError({
      code: 'auth',
      message: `WeCom ${action} failed: authentication retries exhausted (${message})`,
      retryable: false,
      channel,
      details,
      cause: error,
    });
  }

  if (rawCode === RECONNECT_EXHAUSTED) {
    return new FengsuiError({
      code: 'network',
      message: `WeCom ${action} failed: reconnect attempts exhausted (${message})`,
      retryable: true,
      channel,
      details,
      cause: error,
    });
  }

  if (rawCode !== undefined && NETWORK_ERROR_CODES.has(rawCode)) {
    return new FengsuiError({
      code: 'network',
      message: `WeCom ${action} network error (${rawCode}): ${message}`,
      retryable: true,
      channel,
      details,
      cause: error,
    });
  }

  return new FengsuiError({
    code: 'network',
    message: `WeCom ${action} failed: ${message}`,
    retryable: true,
    channel,
    details,
    cause: error,
  });
}
