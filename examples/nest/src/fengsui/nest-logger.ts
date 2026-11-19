import { Logger } from '@nestjs/common';

import type { LogMeta, Logger as FengsuiLogger } from '@javen205/fengsui-core';

/**
 * 把烽燧的结构化日志接到 Nest 的 Logger 上。
 *
 * 元信息统一 JSON 化后追加在消息末尾：示例里便于观察 traceId、channel
 * 与重试过程；生产环境可以换成 pino / winston 实现同一个 Logger 契约。
 */
export function createFengsuiLogger(context = 'Fengsui'): FengsuiLogger {
  const logger = new Logger(context);

  const withMeta = (message: string, meta?: LogMeta): string => {
    if (meta === undefined || Object.keys(meta).length === 0) {
      return message;
    }
    return `${message} ${JSON.stringify(meta)}`;
  };

  return {
    debug(message, meta) {
      logger.debug(withMeta(message, meta));
    },
    info(message, meta) {
      logger.log(withMeta(message, meta));
    },
    warn(message, meta) {
      logger.warn(withMeta(message, meta));
    },
    error(message, meta) {
      logger.error(withMeta(message, meta));
    },
  };
}
