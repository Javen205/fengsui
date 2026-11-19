/**
 * 企业微信智能机器人插件的公共类型。
 *
 * 插件把「一个机器人」映射成一个渠道 `wecom.bot.<alias>`：
 * - 出站：业务方用信封发消息，适配器负责 `sendMessage`；
 * - 入站：插件把 SDK 的 WebSocket 帧归一化成 {@link WecomInboundMessage}，
 *   再按事件名路由给 handler，handler 可通过 {@link WecomReply} 回复。
 *
 * 机器人定义写在代码里（`bots: [{ alias, botId, credentialsRef }]`）：
 * `botId` 不是密钥，可以随代码走；`secret` 只能由 `credentialsRef` 从
 * 环境变量或密钥服务解析，禁止写入配置或信封。
 */
import type {
  CredentialResolver,
  InboundContext,
  InboundHandler,
  InboundMessage,
  Logger,
} from '@javen205/fengsui-core';
import type {
  BaseMessage,
  EventContent,
  EventMessage,
  ReplyFeedback,
  ReplyMsgItem,
  SendMsgBody,
  TemplateCard,
  UploadMediaFinishResult,
  UploadMediaOptions,
  WeComMediaType,
  WelcomeReplyBody,
  WSClientOptions,
  WsFrame,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk';

/** 机器人别名允许的格式：小写字母开头，后续可含数字与连字符。 */
export const WECOM_BOT_ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 渠道 ID 前缀。 */
export const WECOM_CHANNEL_PREFIX = 'wecom.bot';

/** 默认凭证租户前缀；`alias` 为 `support` 时默认引用 `wecom/support`。 */
export const WECOM_DEFAULT_CREDENTIALS_TENANT = 'wecom';

/** 入站消息大类，与 SDK 的 `msgtype` 一一对应，事件统一为 `event`。 */
export type WecomMessageType =
  | 'text'
  | 'image'
  | 'mixed'
  | 'voice'
  | 'file'
  | 'video'
  | 'event'
  | 'unknown';

/** 原始帧：消息或事件。 */
export type WecomRawFrame = WsFrame<BaseMessage | EventMessage>;

/** 平台原始消息体。 */
export type WecomRawMessage = BaseMessage | EventMessage;

/**
 * 归一化后的企业微信入站消息。
 *
 * 除核心通用字段外，额外暴露机器人别名、原始消息类型与事件类型，
 * 便于业务代码按更细的粒度分流。
 */
export interface WecomInboundMessage extends InboundMessage<WecomRawFrame> {
  /** 机器人别名，对应渠道 `wecom.bot.<alias>`。 */
  alias: string;
  /** SDK 的原始消息类型；未知类型为 `unknown`。 */
  messageType: WecomMessageType;
  /** 事件类型（如 `enter_chat`），仅事件消息存在。 */
  eventType?: string | undefined;
  /** 事件载荷，仅事件消息存在。 */
  event?: EventContent | undefined;
}

/**
 * 单个机器人的定义。
 *
 * ```ts
 * {
 *   alias: 'support',
 *   botId: 'bot-id-from-wecom-console',
 *   credentialsRef: 'wecom/support', // 可省略，默认 wecom/<alias>
 * }
 * ```
 * 对应的环境变量示例：
 * `FENGSUI_CRED_WECOM_SUPPORT={"secret":"..."}`
 */
export interface WecomBotDefinition {
  /** 别名，决定渠道 ID；必须匹配 `^[a-z][a-z0-9-]*$` 且全局唯一。 */
  alias: string;
  /** 企业微信后台的机器人 ID，非密钥。 */
  botId: string;
  /**
   * 凭证引用，形如 `tenant/account`；省略时默认 `wecom/<alias>`。
   *
   * 凭证必须提供 `secret` 字段，可选提供 `botId` 覆盖这里的定义
   * （便于按项目切换同一机器人的凭证）。
   */
  credentialsRef?: string | undefined;
  /** 是否启用，默认 `true`；禁用后不注册渠道也不建连。 */
  enabled?: boolean | undefined;
  /** 场景值，透传给 SDK。 */
  scene?: number | undefined;
  /** 插件版本号，透传给 SDK。 */
  plugVersion?: string | undefined;
  /** 重连基础延迟（毫秒），SDK 默认 1000。 */
  reconnectInterval?: number | undefined;
  /** 最大重连次数，SDK 默认 10；`-1` 表示无限。 */
  maxReconnectAttempts?: number | undefined;
  /** 认证失败最大重试次数，SDK 默认 5；`-1` 表示无限。 */
  maxAuthFailureAttempts?: number | undefined;
  /** 心跳间隔（毫秒），SDK 默认 30000。 */
  heartbeatInterval?: number | undefined;
  /** 请求超时（毫秒），SDK 默认 10000。 */
  requestTimeout?: number | undefined;
  /** 自定义 WebSocket 地址，默认 `wss://openws.work.weixin.qq.com`。 */
  wsUrl?: string | undefined;
  /** 透传给底层 `ws` 的连接选项（TLS 证书等）。 */
  wsOptions?: WSClientOptions['wsOptions'] | undefined;
  /** 单个 req_id 的回复队列上限，SDK 默认 500。 */
  maxReplyQueueSize?: number | undefined;
  /** 该机器人专属 handler；与插件级 handler 合并执行。 */
  handlers?: WecomHandlerMap | undefined;
}

/** handler 映射：事件名 → 单个 handler 或 handler 数组。 */
export type WecomHandlerMap = Readonly<
  Record<string, WecomHandler | ReadonlyArray<WecomHandler>>
>;

/**
 * 回复器，绑定到当前事件的原始帧。
 *
 * 所有方法都会检查服务端回执的 `errcode`，失败时抛 `FengsuiError`。
 * 被动回复（`text` / `markdown` / `card` 等）必须在收到事件后 5 秒内调用，
 * 超时后企业微信会关闭回复窗口；主动推送（`sendTo`）不受此限制。
 */
export interface WecomReply {
  /** 当前事件的原始帧，高级用法可直接透传给 SDK。 */
  readonly frame: WsFrameHeaders;
  /** 当前机器人对应的渠道 ID。 */
  readonly channel: string;

  /** 回复纯文本（内部走一次性流式消息）。 */
  text(content: string): Promise<WsFrame>;

  /** 回复 Markdown（内部走一次性流式消息）。 */
  markdown(content: string): Promise<WsFrame>;

  /** 流式回复；同一 `id` 多次调用可逐步刷新内容。 */
  stream(options: WecomStreamReplyOptions): Promise<WsFrame>;

  /** 回复欢迎语；只能用于 `enter_chat` 事件。 */
  welcome(body: WelcomeReplyBody): Promise<WsFrame>;

  /** 回复模板卡片。 */
  card(card: TemplateCard, feedback?: ReplyFeedback): Promise<WsFrame>;

  /** 流式消息与模板卡片组合回复。 */
  streamWithCard(options: WecomStreamWithCardOptions): Promise<WsFrame>;

  /** 更新已发送的模板卡片；只能用于 `template_card_event` 事件。 */
  updateCard(card: TemplateCard, userIds?: ReadonlyArray<string>): Promise<WsFrame>;

  /** 回复临时素材（需先通过 `upload` 上传）。 */
  media(
    type: WeComMediaType,
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<WsFrame>;

  /** 上传临时素材，返回 `media_id`。 */
  upload(file: Buffer, options: UploadMediaOptions): Promise<UploadMediaFinishResult>;

  /** 主动推送到指定会话（单聊填 userid，群聊填 chatid）。 */
  sendTo(chatId: string, body: SendMsgBody): Promise<WsFrame>;

  /** 下载并解密图片 / 文件 / 视频。 */
  download(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;

  /** 当前帧是否还有未确认的回复（流式场景可用于跳过中间帧）。 */
  hasPendingAck(): boolean;
}

/** 流式回复选项。 */
export interface WecomStreamReplyOptions {
  /** 流式消息 ID；省略时自动生成，多次刷新需复用同一个值。 */
  id?: string | undefined;
  /** 回复内容，支持 Markdown。 */
  content: string;
  /** 是否结束流式消息，默认 `false`。 */
  finish?: boolean | undefined;
  /** 图文混排项，仅 `finish` 为 `true` 时生效。 */
  msgItems?: ReadonlyArray<ReplyMsgItem> | undefined;
  /** 反馈信息，仅首次回复时设置。 */
  feedback?: ReplyFeedback | undefined;
}

/** 流式消息 + 模板卡片组合回复选项。 */
export interface WecomStreamWithCardOptions {
  id?: string | undefined;
  content: string;
  finish?: boolean | undefined;
  msgItems?: ReadonlyArray<ReplyMsgItem> | undefined;
  streamFeedback?: ReplyFeedback | undefined;
  templateCard?: TemplateCard | undefined;
  cardFeedback?: ReplyFeedback | undefined;
}

/**
 * handler 返回值。
 *
 * - `void` / `{ handled: true }`：与核心语义一致；
 * - `{ text }` / `{ markdown }` / `{ card }`：插件自动回复，优先级
 *   `card` > `markdown` > `text`（同一次 handler 结果只发一条）。
 */
export type WecomHandlerResult =
  | void
  | { handled?: boolean }
  | {
      handled?: boolean;
      text?: string;
      markdown?: string;
      card?: TemplateCard;
    };

/** 企业微信 handler 的上下文。 */
export type WecomContext = InboundContext<WecomInboundMessage, WecomReply>;

/** 企业微信 handler。 */
export type WecomHandler = InboundHandler<
  WecomInboundMessage,
  WecomReply,
  WecomHandlerResult
>;

/** 机器人连接状态。 */
export type WecomBotConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'reconnecting'
  | 'disconnected'
  | 'stopped';

/** 机器人运行状态快照。 */
export interface WecomBotStatus {
  alias: string;
  channel: string;
  botId: string;
  enabled: boolean;
  state: WecomBotConnectionState;
  connected: boolean;
  startedAt?: string | undefined;
  lastConnectedAt?: string | undefined;
  lastAuthenticatedAt?: string | undefined;
  lastDisconnectedAt?: string | undefined;
  reconnectAttempt?: number | undefined;
  lastError?: string | undefined;
}

/** 创建 SDK 客户端所需的信息。 */
export interface WecomClientConfig {
  alias: string;
  botId: string;
  secret: string;
  options: WSClientOptions;
}

/**
 * SDK 客户端的结构子集。
 *
 * 抽出接口是为了测试时注入 Fake 客户端，避免真实建连；
 * 生产环境由默认工厂返回 `new WSClient(options)`。
 */
export interface WecomClient {
  connect(): unknown;
  disconnect(): void;
  readonly isConnected: boolean;
  on(event: 'message', handler: (frame: WsFrame<BaseMessage>) => void): unknown;
  on(event: 'event', handler: (frame: WsFrame<EventMessage>) => void): unknown;
  on(event: 'connected' | 'authenticated', handler: () => void): unknown;
  on(event: 'disconnected', handler: (reason: string) => void): unknown;
  on(event: 'reconnecting', handler: (attempt: number) => void): unknown;
  on(event: 'error', handler: (error: Error) => void): unknown;
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: ReplyMsgItem[],
    feedback?: ReplyFeedback,
  ): Promise<WsFrame>;
  replyWelcome(frame: WsFrameHeaders, body: WelcomeReplyBody): Promise<WsFrame>;
  replyTemplateCard(
    frame: WsFrameHeaders,
    templateCard: TemplateCard,
    feedback?: ReplyFeedback,
  ): Promise<WsFrame>;
  replyStreamWithCard(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    options?: {
      msgItem?: ReplyMsgItem[];
      streamFeedback?: ReplyFeedback;
      templateCard?: TemplateCard;
      cardFeedback?: ReplyFeedback;
    },
  ): Promise<WsFrame>;
  updateTemplateCard(
    frame: WsFrameHeaders,
    templateCard: TemplateCard,
    userids?: string[],
  ): Promise<WsFrame>;
  replyMedia(
    frame: WsFrameHeaders,
    mediaType: WeComMediaType,
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<WsFrame>;
  sendMessage(chatid: string, body: SendMsgBody): Promise<WsFrame>;
  sendMediaMessage(
    chatid: string,
    mediaType: WeComMediaType,
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<WsFrame>;
  uploadMedia(fileBuffer: Buffer, options: UploadMediaOptions): Promise<UploadMediaFinishResult>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
  hasPendingReplyAck?(frame: WsFrameHeaders): boolean;
}

/** 客户端工厂；测试可注入 Fake 实现。 */
export type WecomClientFactory = (config: WecomClientConfig) => WecomClient;

/** 插件级 handler 映射。 */
export interface WecomBotRuntimeInfo {
  /** 机器人别名。 */
  alias: string;
  /** 渠道 ID，`wecom.bot.<alias>`。 */
  channel: string;
  /** 机器人 ID（定义中的值；凭证中的 `botId` 可覆盖）。 */
  botId: string;
  /** 最终使用的凭证引用。 */
  credentialsRef: string;
  /** 是否启用。 */
  enabled: boolean;
  /** 原始定义，供适配器读取 WS 选项等。 */
  definition: WecomBotDefinition;
}

/** 插件配置。 */
export interface WecomBotPluginOptions {
  /** 机器人列表；别名必须唯一。 */
  bots: ReadonlyArray<WecomBotDefinition>;
  /** 对所有机器人生效的 handler。 */
  handlers?: WecomHandlerMap | undefined;
  /** 去重窗口（毫秒），默认 10 分钟；`<= 0` 关闭。 */
  dedupeTtlMs?: number | undefined;
  /** 去重缓存上限，默认 10000。 */
  dedupeMaxEntries?: number | undefined;
  /** 建连并等待认证的超时（毫秒），默认 10000。 */
  connectTimeoutMs?: number | undefined;
  /** 是否自动发送 handler 返回的 `{ text | markdown | card }`，默认 `true`。 */
  autoReply?: boolean | undefined;
  /** 自定义 SDK 客户端工厂，主要用于测试。 */
  clientFactory?: WecomClientFactory | undefined;
  /** 额外日志器；默认使用 `createFengsui()` 注入的日志器。 */
  logger?: Logger | undefined;
  /** handler 抛错回调；错误已写日志，这里可用于告警。 */
  onError?: ((error: unknown, info: { event: string; message: WecomInboundMessage }) => void) | undefined;
}

/** manager 构造参数：插件在 register 阶段补齐依赖。 */
export interface WecomBotManagerOptions extends WecomBotPluginOptions {
  /** 凭证解析器；未提供时由插件在 register 阶段注入。 */
  credentials?: CredentialResolver | undefined;
}
