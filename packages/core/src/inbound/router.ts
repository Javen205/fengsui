/**
 * 入站路由：事件 → 一组 handler。
 *
 * 设计要点：
 * - 同一事件可注册多个 handler，按注册顺序执行；
 * - handler 返回 `{ handled: true }` 时短路后续 handler；
 * - 单个 handler 抛错只影响自己：记录日志并继续，不会中断连接；
 * - 按「渠道 + 消息 ID」做 TTL 去重，避免断线重连后的重复投递。
 */
import type { InboundMessage } from './types';
import type {
  InboundDispatchInput,
  InboundDispatchResult,
  InboundHandler,
  InboundHandlerOutcome,
  InboundRouterOptions,
} from './types';

/** 默认去重窗口：10 分钟。 */
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
/** 默认去重缓存上限。 */
const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;
/** 通配事件名。 */
const WILDCARD = '*';

/**
 * 通用入站路由。
 *
 * @typeParam TMessage 归一化后的消息类型，如企业微信的 `WecomInboundMessage`。
 * @typeParam TReply 平台回复器类型。
 * @typeParam TResult handler 返回值类型，默认由核心判定的 `{ handled?: boolean }`。
 */
export class InboundRouter<
  TMessage extends InboundMessage = InboundMessage,
  TReply = unknown,
  TResult = InboundHandlerOutcome,
> {
  private readonly handlers = new Map<string, Array<InboundHandler<TMessage, TReply, TResult>>>();
  private readonly seen = new Map<string, number>();
  private readonly dedupeTtlMs: number;
  private readonly dedupeMaxEntries: number;
  private readonly onError: InboundRouterOptions<TMessage>['onError'];

  constructor(options: InboundRouterOptions<TMessage> = {}) {
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.dedupeMaxEntries = Math.max(1, options.dedupeMaxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES);
    this.onError = options.onError;
  }

  /**
   * 注册 handler。
   *
   * @param event 事件名，如 `message.text`；`*` 表示所有事件。
   * @returns 取消注册函数。
   */
  on(event: string, handler: InboundHandler<TMessage, TReply, TResult>): () => void {
    const list = this.handlers.get(event);
    if (list === undefined) {
      this.handlers.set(event, [handler]);
    } else {
      list.push(handler);
    }

    return () => {
      const current = this.handlers.get(event);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(handler);
      if (index !== -1) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        this.handlers.delete(event);
      }
    };
  }

  /**
   * 分发一次事件。
   *
   * 精确事件名 handler 先执行，随后执行 `*` handler；任一返回
   * `{ handled: true }` 立即停止。
   */
  async dispatch(input: InboundDispatchInput<TMessage, TReply>): Promise<InboundDispatchResult<TResult>> {
    const { event, message } = input;

    if (this.isDuplicate(message)) {
      return { event, matched: 0, handled: false, results: [], deduplicated: true };
    }

    const exact = this.handlers.get(event) ?? [];
    const wildcard = this.handlers.get(WILDCARD) ?? [];
    const candidates = [...exact, ...wildcard];

    const results: TResult[] = [];
    let handled = false;

    const context = {
      message,
      reply: input.reply,
      logger: input.logger,
      signal: input.signal,
      state: input.state ?? new Map<string, unknown>(),
    };

    for (const handler of candidates) {
      if (input.signal.aborted) {
        break;
      }

      try {
        const result = await handler(context);
        if (result !== undefined) {
          results.push(result as TResult);
        }
        if (isHandled(result)) {
          handled = true;
          break;
        }
      } catch (error) {
        input.logger.error('inbound.handler_failed', {
          event,
          channel: message.channel,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.onError?.(error, { event, message });
      }
    }

    return { event, matched: candidates.length, handled, results, deduplicated: false };
  }

  /** 清空所有 handler 与去重缓存。 */
  clear(): void {
    this.handlers.clear();
    this.seen.clear();
  }

  /** 判断并记录消息 ID，返回是否为重复消息。 */
  private isDuplicate(message: TMessage): boolean {
    if (this.dedupeTtlMs <= 0 || message.messageId === '') {
      return false;
    }

    const key = `${message.channel}:${message.messageId}`;
    const now = Date.now();
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < this.dedupeTtlMs) {
      return true;
    }

    this.seen.set(key, now);
    this.prune(now);
    return false;
  }

  /** 清理过期与超量记录，保证缓存有界。 */
  private prune(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt >= this.dedupeTtlMs) {
        this.seen.delete(key);
      }
    }
    while (this.seen.size > this.dedupeMaxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
  }
}

/** 判断 handler 返回值是否声明「已处理」。 */
function isHandled(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { handled?: unknown }).handled === true
  );
}
