/**
 * 多机器人管理器。
 *
 * 每个启用的机器人对应：
 * - 一条 SDK WebSocket 长连接；
 * - 一个渠道 `wecom.bot.<alias>`；
 * - 一个独立的 `InboundRouter`，handler 与去重缓存互不干扰。
 *
 * 连接策略：
 * - `fengsui.start()` 触发全部机器人建连（不阻塞等待认证）；
 * - `send()` / `waitReady()` 按需懒连接，并等待认证完成；
 * - `fengsui.close()` 逆序停止插件，管理器负责断开全部连接。
 *
 * 注意：企业微信智能机器人一个 botId 只能维持一条长连接，
 * 多副本部署时需要选主或通过开关只让一个副本启动插件。
 */
import {
  FengsuiError,
  InboundRouter,
  silentLogger,
  type CredentialResolver,
  type Logger,
} from '@javen205/fengsui-core';
import { WSClient } from '@wecom/aibot-node-sdk';
import type {
  BaseMessage,
  EventMessage,
  SendMsgBody,
  TemplateCard,
  WSClientOptions,
  WsFrame,
} from '@wecom/aibot-node-sdk';

import { assertFrameOk, normalizeWecomError } from './errors';
import { eventNameOf, normalizeInboundFrame } from './message';
import { createWecomReply } from './reply';
import {
  WECOM_BOT_ALIAS_PATTERN,
  WECOM_CHANNEL_PREFIX,
  WECOM_DEFAULT_CREDENTIALS_TENANT,
  type WecomBotConnectionState,
  type WecomBotDefinition,
  type WecomBotManagerOptions,
  type WecomBotRuntimeInfo,
  type WecomBotStatus,
  type WecomClient,
  type WecomClientConfig,
  type WecomClientFactory,
  type WecomHandler,
  type WecomHandlerMap,
  type WecomHandlerResult,
  type WecomInboundMessage,
  type WecomRawFrame,
  type WecomReply,
} from './types';

/** 默认建连超时：10 秒。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

interface ReadyWaiter {
  resolve(): void;
  reject(error: FengsuiError): void;
  timer: NodeJS.Timeout;
}

interface Runtime {
  readonly bot: WecomBotRuntimeInfo;
  readonly router: InboundRouter<WecomInboundMessage, WecomReply, WecomHandlerResult>;
  readonly waiters: Set<ReadyWaiter>;
  client: WecomClient | undefined;
  abort: AbortController;
  state: WecomBotConnectionState;
  connecting: boolean;
  stopped: boolean;
  startedAt: string | undefined;
  lastConnectedAt: string | undefined;
  lastAuthenticatedAt: string | undefined;
  lastDisconnectedAt: string | undefined;
  reconnectAttempt: number | undefined;
  lastError: string | undefined;
}

/**
 * 机器人管理器，由 `wecomBotPlugin()` 创建并通过 `plugin.bots` 暴露。
 *
 * 业务代码一般不需要直接实例化它；测试或高级场景可以自行构造。
 */
export class WecomBotManager {
  private readonly options: WecomBotManagerOptions;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly connectTimeoutMs: number;
  private readonly autoReply: boolean;
  private readonly clientFactory: WecomClientFactory;
  private credentials: CredentialResolver | undefined;
  private logger: Logger = silentLogger;

  constructor(options: WecomBotManagerOptions) {
    this.options = options;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.autoReply = options.autoReply ?? true;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.credentials = options.credentials;
    if (options.logger !== undefined) {
      this.logger = options.logger;
    }

    const globalHandlers = flattenHandlers(options.handlers);
    const seen = new Set<string>();

    for (const definition of options.bots) {
      const info = normalizeBot(definition);
      if (seen.has(info.alias)) {
        throw new FengsuiError({
          code: 'validation',
          message: `Duplicate wecom bot alias "${info.alias}"`,
          details: { alias: info.alias },
        });
      }
      seen.add(info.alias);

      const routerOptions = {
        ...(options.dedupeTtlMs !== undefined ? { dedupeTtlMs: options.dedupeTtlMs } : {}),
        ...(options.dedupeMaxEntries !== undefined
          ? { dedupeMaxEntries: options.dedupeMaxEntries }
          : {}),
        onError: (error: unknown, info2: { event: string; message: WecomInboundMessage }) => {
          this.options.onError?.(error, info2);
        },
      };
      const router = new InboundRouter<WecomInboundMessage, WecomReply, WecomHandlerResult>(
        routerOptions,
      );
      for (const [event, handler] of [...globalHandlers, ...flattenHandlers(definition.handlers)]) {
        router.on(event, handler);
      }

      this.runtimes.set(info.alias, {
        bot: info,
        router,
        waiters: new Set(),
        client: undefined,
        abort: new AbortController(),
        state: 'idle',
        connecting: false,
        stopped: false,
        startedAt: undefined,
        lastConnectedAt: undefined,
        lastAuthenticatedAt: undefined,
        lastDisconnectedAt: undefined,
        reconnectAttempt: undefined,
        lastError: undefined,
      });
    }
  }

  /** 全部机器人（含禁用项）的静态信息，供插件注册渠道。 */
  get bots(): ReadonlyArray<WecomBotRuntimeInfo> {
    return [...this.runtimes.values()].map((runtime) => runtime.bot);
  }

  /**
   * 由插件在 `register()` 阶段注入依赖。
   *
   * 重复调用会覆盖凭证与日志器；`options.logger` 优先于上下文日志器。
   */
  attach(context: { credentials: CredentialResolver; logger: Logger }): void {
    this.credentials = context.credentials;
    this.logger = this.options.logger ?? context.logger;
  }

  /** 启动全部启用机器人的长连接；不等待认证完成。 */
  async start(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.bot.enabled) {
        continue;
      }
      this.resetForStart(runtime);
      await this.connectRuntime(runtime);
    }
  }

  /** 断开全部连接并拒绝等待中的 `send()`。 */
  async stop(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.stopped = true;
      const client = runtime.client;
      const error = new FengsuiError({
        code: 'network',
        message: `WeCom bot "${runtime.bot.alias}" has been stopped`,
        retryable: true,
        channel: runtime.bot.channel,
      });
      this.rejectWaiters(runtime, error);
      runtime.abort.abort();

      if (client !== undefined) {
        try {
          client.disconnect();
        } catch (cause) {
          this.logger.warn('wecom.disconnect_failed', {
            alias: runtime.bot.alias,
            error: describeError(cause),
          });
        }
      }

      runtime.state = 'stopped';
      runtime.lastError = undefined;
    }
  }

  /** 按需建立连接并等待认证通过；超时或断开时抛 `FengsuiError`。 */
  async waitReady(alias: string, timeoutMs = this.connectTimeoutMs): Promise<void> {
    const runtime = this.requireRuntime(alias);
    if (isAuthenticated(runtime)) {
      return;
    }

    if (runtime.client === undefined || runtime.state === 'idle' || runtime.state === 'stopped') {
      this.resetForStart(runtime);
      await this.connectRuntime(runtime);
    }

    if (isAuthenticated(runtime)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.waiters.delete(waiter);
        reject(
          new FengsuiError({
            code: 'network',
            message: `WeCom bot "${alias}" was not authenticated within ${timeoutMs}ms (state: ${runtime.state})`,
            retryable: true,
            channel: runtime.bot.channel,
          }),
        );
      }, timeoutMs);

      const waiter: ReadyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: FengsuiError) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };
      runtime.waiters.add(waiter);
    });
  }

  /**
   * 主动发送消息。
   *
   * @param alias 机器人别名。
   * @param chatId 单聊 userid 或群聊 chatid。
   * @param body SDK 消息体（markdown / template_card / media）。
   */
  async send(alias: string, chatId: string, body: SendMsgBody): Promise<WsFrame> {
    const runtime = this.requireRuntime(alias);
    const client = await this.ensureClient(runtime);
    await this.waitReady(alias);

    try {
      const frame = await client.sendMessage(chatId, body);
      assertFrameOk(frame, runtime.bot.channel, 'sendMessage');
      return frame;
    } catch (error) {
      throw normalizeWecomError(error, runtime.bot.channel, 'sendMessage');
    }
  }

  /** 注册 handler；`alias` 传 `*` 表示所有机器人。 */
  on(alias: string, event: string, handler: WecomHandler): () => void {
    const targets = alias === '*' ? [...this.runtimes.values()] : [this.requireRuntime(alias)];
    const unsubscribers = targets.map((runtime) => runtime.router.on(event, handler));
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  /** 取某个机器人的路由器，便于高级场景直接 dispatch。 */
  router(alias: string): InboundRouter<WecomInboundMessage, WecomReply, WecomHandlerResult> {
    return this.requireRuntime(alias).router;
  }

  /** 查询单个机器人状态。 */
  status(alias: string): WecomBotStatus {
    return toStatus(this.requireRuntime(alias));
  }

  /** 查询全部机器人状态。 */
  listStatus(): ReadonlyArray<WecomBotStatus> {
    return [...this.runtimes.values()].map(toStatus);
  }

  private requireRuntime(alias: string): Runtime {
    const runtime = this.runtimes.get(alias);
    if (runtime === undefined) {
      const available = [...this.runtimes.keys()].sort();
      throw new FengsuiError({
        code: 'validation',
        message: `Unknown wecom bot alias "${alias}"${available.length > 0 ? `; available: ${available.join(', ')}` : ''}`,
        details: { alias, available },
      });
    }
    return runtime;
  }

  private resetForStart(runtime: Runtime): void {
    if (runtime.stopped || runtime.abort.signal.aborted) {
      runtime.abort = new AbortController();
    }
    runtime.stopped = false;
    runtime.reconnectAttempt = undefined;
    if (runtime.state === 'stopped' || runtime.state === 'idle') {
      runtime.state = 'idle';
    }
  }

  private async ensureClient(runtime: Runtime): Promise<WecomClient> {
    if (
      runtime.client === undefined ||
      runtime.state === 'idle' ||
      runtime.state === 'disconnected' ||
      runtime.state === 'stopped'
    ) {
      this.resetForStart(runtime);
      await this.connectRuntime(runtime);
    }

    if (runtime.client === undefined) {
      throw new FengsuiError({
        code: 'internal',
        message: `WeCom bot "${runtime.bot.alias}" has no client after connect`,
        channel: runtime.bot.channel,
      });
    }
    return runtime.client;
  }

  private async connectRuntime(runtime: Runtime): Promise<void> {
    if (!runtime.bot.enabled) {
      throw new FengsuiError({
        code: 'unsupported',
        message: `WeCom bot "${runtime.bot.alias}" is disabled`,
        channel: runtime.bot.channel,
      });
    }
    if (
      runtime.connecting ||
      runtime.state === 'connecting' ||
      runtime.state === 'reconnecting' ||
      runtime.state === 'authenticated'
    ) {
      return;
    }

    runtime.connecting = true;
    runtime.state = 'connecting';
    runtime.startedAt ??= new Date().toISOString();
    runtime.lastError = undefined;

    try {
      if (runtime.client === undefined) {
        const client = await this.createClient(runtime);
        this.wireClient(runtime, client);
        runtime.client = client;
      }
      runtime.client.connect();
      this.logger.info('wecom.bot_connecting', {
        alias: runtime.bot.alias,
        channel: runtime.bot.channel,
      });
    } catch (error) {
      const normalized = normalizeWecomError(error, runtime.bot.channel, 'connect');
      runtime.state = 'disconnected';
      runtime.lastError = normalized.message;
      this.rejectWaiters(runtime, normalized);
      this.logger.error('wecom.bot_connect_failed', {
        alias: runtime.bot.alias,
        channel: runtime.bot.channel,
        error: normalized.message,
      });
      throw normalized;
    } finally {
      runtime.connecting = false;
    }
  }

  private async createClient(runtime: Runtime): Promise<WecomClient> {
    const credentials = this.credentials;
    if (credentials === undefined) {
      throw new FengsuiError({
        code: 'internal',
        message:
          'WecomBotManager is not attached to a fengsui context; register wecomBotPlugin() via createFengsui() before starting',
        channel: runtime.bot.channel,
      });
    }

    let values: Readonly<Record<string, string>>;
    try {
      const credential = await credentials.resolve(runtime.bot.credentialsRef);
      values = credential.values;
    } catch (error) {
      if (error instanceof FengsuiError) {
        throw error;
      }
      throw new FengsuiError({
        code: 'credentials',
        message: `Failed to resolve credentials "${runtime.bot.credentialsRef}" for wecom bot "${runtime.bot.alias}": ${describeError(error)}`,
        channel: runtime.bot.channel,
        cause: error,
      });
    }

    const secret = values.secret;
    if (secret === undefined || secret === '') {
      throw new FengsuiError({
        code: 'credentials',
        message: `Credential "${runtime.bot.credentialsRef}" must provide a non-empty "secret" for wecom bot "${runtime.bot.alias}"`,
        channel: runtime.bot.channel,
        details: { ref: runtime.bot.credentialsRef },
      });
    }

    const botId = values.botId ?? runtime.bot.botId;
    if (botId === '') {
      throw new FengsuiError({
        code: 'credentials',
        message: `WeCom bot "${runtime.bot.alias}" requires a botId in the definition or credential`,
        channel: runtime.bot.channel,
      });
    }

    const config: WecomClientConfig = {
      alias: runtime.bot.alias,
      botId,
      secret,
      options: buildClientOptions(runtime.bot.definition, botId, secret, this.logger),
    };
    return this.clientFactory(config);
  }

  private wireClient(runtime: Runtime, client: WecomClient): void {
    const { alias, channel } = runtime.bot;

    client.on('message', (frame: WsFrame<BaseMessage>) => {
      void this.handleFrame(runtime, frame).catch((error: unknown) => {
        this.logger.error('wecom.message_failed', {
          alias,
          channel,
          error: describeError(error),
        });
      });
    });

    client.on('event', (frame: WsFrame<EventMessage>) => {
      void this.handleFrame(runtime, frame).catch((error: unknown) => {
        this.logger.error('wecom.event_failed', {
          alias,
          channel,
          error: describeError(error),
        });
      });
    });

    client.on('connected', () => {
      runtime.state = 'connected';
      runtime.lastConnectedAt = new Date().toISOString();
      this.logger.info('wecom.bot_connected', { alias, channel });
    });

    client.on('authenticated', () => {
      runtime.state = 'authenticated';
      runtime.lastAuthenticatedAt = new Date().toISOString();
      runtime.reconnectAttempt = undefined;
      runtime.lastError = undefined;
      this.resolveWaiters(runtime);
      this.logger.info('wecom.bot_authenticated', { alias, channel });
    });

    client.on('disconnected', (reason: string) => {
      runtime.state = runtime.stopped ? 'stopped' : 'disconnected';
      runtime.lastDisconnectedAt = new Date().toISOString();
      runtime.lastError = reason;
      this.rejectWaiters(
        runtime,
        new FengsuiError({
          code: 'network',
          message: `WeCom bot "${alias}" disconnected: ${reason}`,
          retryable: true,
          channel,
        }),
      );
      this.logger.warn('wecom.bot_disconnected', { alias, channel, reason });
    });

    client.on('reconnecting', (attempt: number) => {
      runtime.state = 'reconnecting';
      runtime.reconnectAttempt = attempt;
      this.logger.warn('wecom.bot_reconnecting', { alias, channel, attempt });
    });

    client.on('error', (error: Error) => {
      const normalized = normalizeWecomError(error, channel, 'connection');
      runtime.lastError = normalized.message;
      this.rejectWaiters(runtime, normalized);
      this.logger.error('wecom.bot_error', {
        alias,
        channel,
        error: normalized.message,
        retryable: normalized.retryable,
      });
    });
  }

  private async handleFrame(
    runtime: Runtime,
    frame: WecomRawFrame,
  ): Promise<void> {
    const client = runtime.client;
    if (client === undefined) {
      return;
    }

    const message = normalizeInboundFrame(runtime.bot.alias, runtime.bot.channel, frame);
    if (message === undefined) {
      this.logger.warn('wecom.frame_without_body', {
        alias: runtime.bot.alias,
        channel: runtime.bot.channel,
        reqId: frame.headers.req_id,
      });
      return;
    }

    const event = eventNameOf(message);
    const reply = createWecomReply({ client, frame: { headers: frame.headers }, channel: runtime.bot.channel });
    const result = await runtime.router.dispatch({
      event,
      message,
      reply,
      logger: this.logger,
      signal: runtime.abort.signal,
    });

    if (result.deduplicated) {
      this.logger.debug('wecom.duplicate_message', {
        alias: runtime.bot.alias,
        channel: runtime.bot.channel,
        messageId: message.messageId,
        event,
      });
      return;
    }

    if (this.autoReply) {
      await this.sendAutoReply(reply, result.results, message);
    }
  }

  private async sendAutoReply(
    reply: WecomReply,
    results: ReadonlyArray<WecomHandlerResult>,
    message: WecomInboundMessage,
  ): Promise<void> {
    const picked = pickAutoReply(results);
    if (picked === undefined) {
      return;
    }

    try {
      if (picked.card !== undefined) {
        await reply.card(picked.card);
        return;
      }
      if (picked.markdown !== undefined) {
        await reply.markdown(picked.markdown);
        return;
      }
      if (picked.text !== undefined) {
        await reply.text(picked.text);
      }
    } catch (error) {
      const normalized = normalizeWecomError(error, message.channel, 'autoReply');
      this.logger.error('wecom.auto_reply_failed', {
        alias: message.alias,
        channel: message.channel,
        messageId: message.messageId,
        error: normalized.message,
      });
      this.options.onError?.(error, {
        event: eventNameOf(message),
        message,
      });
    }
  }

  private resolveWaiters(runtime: Runtime): void {
    for (const waiter of runtime.waiters) {
      runtime.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectWaiters(runtime: Runtime, error: FengsuiError): void {
    for (const waiter of runtime.waiters) {
      runtime.waiters.delete(waiter);
      waiter.reject(error);
    }
  }
}

/** 规范化机器人定义；非法别名或空 botId 直接失败。 */
function normalizeBot(definition: WecomBotDefinition): WecomBotRuntimeInfo {
  if (!WECOM_BOT_ALIAS_PATTERN.test(definition.alias)) {
    throw new FengsuiError({
      code: 'validation',
      message: `Invalid wecom bot alias "${definition.alias}": must match ${WECOM_BOT_ALIAS_PATTERN.source}`,
      details: { alias: definition.alias },
    });
  }
  if (definition.botId.trim() === '') {
    throw new FengsuiError({
      code: 'validation',
      message: `WeCom bot "${definition.alias}" requires a non-empty botId`,
      details: { alias: definition.alias },
    });
  }

  return {
    alias: definition.alias,
    channel: `${WECOM_CHANNEL_PREFIX}.${definition.alias}`,
    botId: definition.botId,
    credentialsRef:
      definition.credentialsRef ?? `${WECOM_DEFAULT_CREDENTIALS_TENANT}/${definition.alias}`,
    enabled: definition.enabled ?? true,
    definition,
  };
}

/** 展平 handler 映射，保持声明顺序。 */
function flattenHandlers(map: WecomHandlerMap | undefined): ReadonlyArray<[string, WecomHandler]> {
  if (map === undefined) {
    return [];
  }

  const entries: Array<[string, WecomHandler]> = [];
  for (const [event, value] of Object.entries(map)) {
    if (Array.isArray(value)) {
      for (const handler of value) {
        entries.push([event, handler]);
      }
      continue;
    }
    entries.push([event, value as WecomHandler]);
  }
  return entries;
}

/** 从 handler 返回值中挑出第一条自动回复。 */
function pickAutoReply(
  results: ReadonlyArray<WecomHandlerResult>,
): { text?: string; markdown?: string; card?: TemplateCard } | undefined {
  for (const result of results) {
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const candidate = result as { text?: unknown; markdown?: unknown; card?: unknown };
    const text =
      typeof candidate.text === 'string' && candidate.text.length > 0 ? candidate.text : undefined;
    const markdown =
      typeof candidate.markdown === 'string' && candidate.markdown.length > 0
        ? candidate.markdown
        : undefined;
    const card =
      typeof candidate.card === 'object' && candidate.card !== null
        ? (candidate.card as TemplateCard)
        : undefined;
    if (text !== undefined || markdown !== undefined || card !== undefined) {
      return {
        ...(text !== undefined ? { text } : {}),
        ...(markdown !== undefined ? { markdown } : {}),
        ...(card !== undefined ? { card } : {}),
      };
    }
  }
  return undefined;
}

function toStatus(runtime: Runtime): WecomBotStatus {
  return {
    alias: runtime.bot.alias,
    channel: runtime.bot.channel,
    botId: runtime.bot.botId,
    enabled: runtime.bot.enabled,
    state: runtime.state,
    connected: runtime.state === 'connected' || runtime.state === 'authenticated',
    ...(runtime.startedAt !== undefined ? { startedAt: runtime.startedAt } : {}),
    ...(runtime.lastConnectedAt !== undefined ? { lastConnectedAt: runtime.lastConnectedAt } : {}),
    ...(runtime.lastAuthenticatedAt !== undefined
      ? { lastAuthenticatedAt: runtime.lastAuthenticatedAt }
      : {}),
    ...(runtime.lastDisconnectedAt !== undefined
      ? { lastDisconnectedAt: runtime.lastDisconnectedAt }
      : {}),
    ...(runtime.reconnectAttempt !== undefined ? { reconnectAttempt: runtime.reconnectAttempt } : {}),
    ...(runtime.lastError !== undefined ? { lastError: runtime.lastError } : {}),
  };
}

function buildClientOptions(
  definition: WecomBotDefinition,
  botId: string,
  secret: string,
  logger: Logger,
): WSClientOptions {
  return {
    botId,
    secret,
    logger: toSdkLogger(logger),
    ...(definition.scene !== undefined ? { scene: definition.scene } : {}),
    ...(definition.plugVersion !== undefined ? { plug_version: definition.plugVersion } : {}),
    ...(definition.reconnectInterval !== undefined
      ? { reconnectInterval: definition.reconnectInterval }
      : {}),
    ...(definition.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: definition.maxReconnectAttempts }
      : {}),
    ...(definition.maxAuthFailureAttempts !== undefined
      ? { maxAuthFailureAttempts: definition.maxAuthFailureAttempts }
      : {}),
    ...(definition.heartbeatInterval !== undefined
      ? { heartbeatInterval: definition.heartbeatInterval }
      : {}),
    ...(definition.requestTimeout !== undefined
      ? { requestTimeout: definition.requestTimeout }
      : {}),
    ...(definition.wsUrl !== undefined ? { wsUrl: definition.wsUrl } : {}),
    ...(definition.wsOptions !== undefined ? { wsOptions: definition.wsOptions } : {}),
    ...(definition.maxReplyQueueSize !== undefined
      ? { maxReplyQueueSize: definition.maxReplyQueueSize }
      : {}),
  };
}

/** 把核心日志器适配成 SDK 的日志接口。 */
function toSdkLogger(logger: Logger): NonNullable<WSClientOptions['logger']> {
  const wrap =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void => {
      logger[level](`[aibot] ${message}`, args.length > 0 ? { args } : undefined);
    };

  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}

/** 默认工厂：真实建连；测试可注入 Fake 客户端。 */
function defaultClientFactory(config: WecomClientConfig): WecomClient {
  return new WSClient(config.options) as unknown as WecomClient;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticated(runtime: Runtime): boolean {
  return runtime.state === 'authenticated';
}
