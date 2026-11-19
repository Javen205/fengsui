/**
 * 单个企业微信机器人的渠道适配器。
 *
 * 一个机器人 = 一个渠道 `wecom.bot.<alias>`，凭证固定绑定到该机器人：
 * 信封与配置都未提供 `credentialsRef` 时，投递器会回退到
 * `defaultCredentialsRef`（默认 `wecom/<alias>`）。
 *
 * 出站只支持主动推送：`markdown` 与 `template_card`。
 * 文本会按 Markdown 发送（企业微信 Markdown 渲染纯文本没有问题）。
 */
import type {
  AdapterContext,
  AdapterNormalizeInput,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelFallbacks,
  ChannelSendOutcome,
  HealthStatus,
  NormalizedMessage,
} from '@javen205/fengsui-core';
import { FengsuiError } from '@javen205/fengsui-core';
import type { SendMsgBody, TemplateCard } from '@wecom/aibot-node-sdk';

import type { WecomBotManager } from './manager';
import {
  wecomBotChannelOptionsSchema,
  type WecomBotChannelOptions,
} from './schema';
import type { WecomBotRuntimeInfo } from './types';

/** 默认能力：文本 / Markdown，模板卡片通过 `channelOptions.card` 启用。 */
const BASE_CAPABILITIES: ChannelCapabilities = {
  messageKinds: ['text', 'markdown'],
  attachments: false,
  mentions: false,
  batch: false,
  templates: true,
  receipts: 'sync',
  rateLimit: { scope: 'bot' },
  idempotency: 'local',
  dryRun: true,
};

/** 默认降级链：HTML 降级为纯文本。 */
const DEFAULT_FALLBACKS: ChannelFallbacks = { html: ['text'] };

/** 健康检查默认超时。 */
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export interface WecomBotAdapterOptions {
  /** 机器人运行信息（由 manager 提供）。 */
  bot: WecomBotRuntimeInfo;
  /** 提供连接与发送能力的管理器。 */
  manager: WecomBotManager;
  /** 覆盖默认能力声明。 */
  capabilities?: Partial<ChannelCapabilities>;
  /** 覆盖默认降级链。 */
  fallbacks?: ChannelFallbacks;
  /** 健康检查等待认证的超时（毫秒）。 */
  healthTimeoutMs?: number;
}

/**
 * 创建单个机器人渠道适配器。
 *
 * 一般由 `wecomBotPlugin()` 内部调用；需要自定义能力或只注册部分机器人时，
 * 可以结合 `new WecomBotManager(...)` 手动构造。
 */
export function createWecomBotAdapter(
  options: WecomBotAdapterOptions,
): ChannelAdapter<WecomBotChannelOptions> {
  const { bot, manager } = options;
  const capabilities: ChannelCapabilities = {
    ...BASE_CAPABILITIES,
    ...options.capabilities,
  };
  const fallbacks = options.fallbacks ?? DEFAULT_FALLBACKS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  return {
    id: bot.channel,
    schema: wecomBotChannelOptionsSchema,
    capabilities: () => capabilities,
    fallbacks,
    defaultCredentialsRef: bot.credentialsRef,

    normalize(
      input: AdapterNormalizeInput<WecomBotChannelOptions>,
    ): NormalizedMessage<WecomBotChannelOptions> {
      return {
        channel: bot.channel,
        action: input.envelope.action,
        target: input.target,
        content: input.content,
        options: input.options,
        credentialsRef: input.envelope.credentialsRef,
        idempotencyKey: input.envelope.meta?.idempotencyKey,
        degradedFrom: input.degradedFrom,
        degradedTo: input.degradedTo,
      };
    },

    async send(
      message: NormalizedMessage<WecomBotChannelOptions>,
      ctx: AdapterContext,
    ): Promise<ChannelSendOutcome> {
      if (ctx.signal.aborted) {
        throw new FengsuiError({
          code: 'network',
          message: `WeCom bot "${bot.alias}" send aborted before the message was queued`,
          retryable: false,
          channel: bot.channel,
        });
      }

      const chatId = resolveChatId(message, bot.channel);
      const body = buildSendBody(message, bot.channel);
      const frame = await manager.send(bot.alias, chatId, body);

      return {
        ...(frame.headers.req_id !== undefined ? { providerMessageId: frame.headers.req_id } : {}),
        ...(frame.errcode !== undefined ? { providerCode: String(frame.errcode) } : {}),
        ...(frame.errmsg !== undefined ? { providerMessage: frame.errmsg } : {}),
      };
    },

    async healthCheck(): Promise<HealthStatus> {
      const startedAt = Date.now();
      const checkedAt = new Date(startedAt).toISOString();

      if (!bot.enabled) {
        return { ok: false, checkedAt, detail: `WeCom bot "${bot.alias}" is disabled` };
      }

      try {
        await manager.waitReady(bot.alias, healthTimeoutMs);
        return { ok: true, checkedAt, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * 解析发送目标。
 *
 * 企业微信单聊用 userid，群聊用 chatid；这里按
 * `target.chatId` → `target.userIds[0]` → `target.to[0]` 的顺序取第一个。
 */
function resolveChatId(
  message: NormalizedMessage<WecomBotChannelOptions>,
  channel: string,
): string {
  const target = message.target;
  const candidates = [
    target?.chatId,
    target?.userIds?.[0],
    target?.to?.[0],
    target?.openIds?.[0],
  ];
  const chatId = candidates.find((value) => value !== undefined && value !== '');
  if (chatId === undefined) {
    throw new FengsuiError({
      code: 'validation',
      message: `WeCom channel "${channel}" requires target.chatId, target.userIds[0] or target.to[0]`,
      channel,
    });
  }
  return chatId;
}

/** 构造主动推送消息体：卡片优先，其次 Markdown / 文本。 */
function buildSendBody(
  message: NormalizedMessage<WecomBotChannelOptions>,
  channel: string,
): SendMsgBody {
  const card = message.options.card;
  if (card !== undefined) {
    return { msgtype: 'template_card', template_card: card as TemplateCard };
  }

  const content = message.content.markdown ?? message.content.text;
  if (content === undefined || content.length === 0) {
    throw new FengsuiError({
      code: 'validation',
      message: `WeCom channel "${channel}" requires content.markdown, content.text or channelOptions.card`,
      channel,
    });
  }

  return { msgtype: 'markdown', markdown: { content } };
}
