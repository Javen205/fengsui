/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化日志附加字段；不得包含凭证明文。 */
export type LogMeta = Readonly<Record<string, unknown>>;

/**
 * 日志器契约。
 *
 * 核心只使用这四个级别，宿主可对接 pino / winston / console；
 * 未注入时使用 {@link silentLogger}，避免默认输出污染调用方日志。
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

/** 空实现：丢弃所有日志。作为默认日志器，保证核心零副作用。 */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
