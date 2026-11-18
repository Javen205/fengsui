/**
 * 入站消息的通用契约。
 *
 * 出站走 `ChannelAdapter`；入站走这里的 `InboundRouter`。
 * 平台插件（如企业微信机器人）负责把平台事件归一化成 `InboundMessage`，
 * 业务代码只需要注册 handler，无需感知 WebSocket / 回调细节。
 */
import type { Logger } from '../logger';

/** 入站载荷的大类，插件可在此范围内使用，也可用 `unknown` 扩展。 */
export type InboundKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'mixed'
  | 'voice'
  | 'file'
  | 'video'
  | 'card'
  | 'event'
  | 'unknown';

/** 会话信息：单聊或群聊。 */
export interface InboundChat {
  /** 单聊为对方 userid，群聊为 chatid；平台未提供时省略。 */
  id?: string | undefined;
  type: 'single' | 'group' | 'unknown';
}

/** 发送者信息。 */
export interface InboundSender {
  /** 平台用户 ID。 */
  id: string;
  /** 展示名，平台未提供时省略。 */
  name?: string | undefined;
  /** 租户 ID，便于多租户隔离。 */
  tenantId?: string | undefined;
}

/** 图片、文件等媒体引用。 */
export interface InboundMedia {
  /** 平台下载地址。 */
  url: string;
  /** 平台提供的解密 key；需要插件自行解密时使用。 */
  aesKey?: string | undefined;
  /** 文件名，文件消息常见。 */
  name?: string | undefined;
  /** 字节大小，平台提供时填充。 */
  size?: number | undefined;
  /** MIME 类型，平台提供时填充。 */
  contentType?: string | undefined;
}

/** 被引用的消息。 */
export interface InboundQuote {
  messageId?: string | undefined;
  text?: string | undefined;
}

/**
 * 归一化后的入站消息。
 *
 * `raw` 保留平台原始载荷，高级用法（比如平台特有字段）可以按插件类型取用。
 */
export interface InboundMessage<TRaw = unknown> {
  /** 渠道 ID，如 `wecom.bot.support`。 */
  channel: string;
  /** 机器人 / 应用 ID，平台概念。 */
  botId: string;
  /** 平台消息 ID，用于去重与追踪。 */
  messageId: string;
  /** 消息大类。 */
  kind: InboundKind;
  /** 会话信息。 */
  chat: InboundChat;
  /** 发送者信息。 */
  sender: InboundSender;
  /** 文本内容；语音消息可能填充平台转写结果。 */
  text?: string | undefined;
  /** 图片列表。 */
  images?: ReadonlyArray<InboundMedia> | undefined;
  /** 文件列表。 */
  files?: ReadonlyArray<InboundMedia> | undefined;
  /** 被引用的消息。 */
  quote?: InboundQuote | undefined;
  /** 接收时间（ISO 8601）。 */
  receivedAt: string;
  /** 平台原始载荷。 */
  raw: TRaw;
}

/**
 * handler 执行上下文。
 *
 * `reply` 由平台插件提供（如企业微信的回复器），核心只负责透传。
 * `state` 在同一次事件的所有 handler 之间共享，便于「鉴权 → 业务处理」分层。
 */
export interface InboundContext<TMessage extends InboundMessage = InboundMessage, TReply = unknown> {
  /** 归一化后的消息。 */
  message: TMessage;
  /** 平台回复器。 */
  reply: TReply;
  /** 实例级日志器。 */
  logger: Logger;
  /** 取消信号；`fengsui.close()` 或平台断开时触发。 */
  signal: AbortSignal;
  /** 同一次事件内共享的临时状态。 */
  state: Map<string, unknown>;
}

/**
 * handler 返回值。
 *
 * - `void`：继续执行后续 handler；
 * - `{ handled: true }`：短路后续 handler；
 * - 其他字段由平台插件解释（如企业微信支持 `{ text }` / `{ markdown }` / `{ card }` 自动回复）。
 */
export type InboundHandlerOutcome = void | { handled?: boolean } | Record<string, unknown>;

/** handler 函数签名。 */
export type InboundHandler<
  TMessage extends InboundMessage = InboundMessage,
  TReply = unknown,
  TResult = InboundHandlerOutcome,
> = (context: InboundContext<TMessage, TReply>) => TResult | void | Promise<TResult | void>;

/** 一次分发的输入。 */
export interface InboundDispatchInput<TMessage extends InboundMessage, TReply> {
  /** 事件名，如 `message.text`；支持 `*` 通配。 */
  event: string;
  /** 归一化后的消息。 */
  message: TMessage;
  /** 平台回复器。 */
  reply: TReply;
  /** 日志器。 */
  logger: Logger;
  /** 取消信号。 */
  signal: AbortSignal;
  /** 可选的共享状态，默认新建。 */
  state?: Map<string, unknown> | undefined;
}

/** 一次分发的统计结果。 */
export interface InboundDispatchResult<TResult = InboundHandlerOutcome> {
  event: string;
  /** 命中的 handler 数量（包含通配）。 */
  matched: number;
  /** 是否有 handler 返回 `{ handled: true }`。 */
  handled: boolean;
  /** 各 handler 的返回值，便于上层按平台语义处理自动回复。 */
  results: ReadonlyArray<TResult>;
  /** 是否因重复消息被跳过。 */
  deduplicated: boolean;
}

/** 入站路由选项。 */
export interface InboundRouterOptions<TMessage extends InboundMessage = InboundMessage> {
  /** 消息去重窗口（毫秒），默认 10 分钟；`<= 0` 关闭去重。 */
  dedupeTtlMs?: number;
  /** 去重缓存上限，默认 10000 条。 */
  dedupeMaxEntries?: number;
  /** handler 抛错时的回调；同时会写日志。 */
  onError?:
    | ((error: unknown, info: { event: string; message: TMessage }) => void)
    | undefined;
}
