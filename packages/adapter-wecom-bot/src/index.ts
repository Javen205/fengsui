/**
 * 企业微信智能机器人插件入口。
 *
 * ```ts
 * const fengsui = createFengsui({
 *   credentials: createEnvCredentialResolver(),
 *   plugins: [
 *     wecomBotPlugin({
 *       bots: [{ alias: 'support', botId: 'your-bot-id' }],
 *       handlers: {
 *         'message.text': async ({ message, reply }) => {
 *           await reply.markdown(`收到：${message.text ?? ''}`);
 *           return { handled: true };
 *         },
 *       },
 *     }),
 *   ],
 * });
 *
 * await fengsui.start();
 * ```
 *
 * 凭证通过 `credentialsRef`（默认 `wecom/<alias>`）解析，必须提供 `secret`：
 * `FENGSUI_CRED_WECOM_SUPPORT={"secret":"..."}`。
 */
import type { FengsuiPlugin, PluginContext } from '@fengsui/core';

import { createWecomBotAdapter } from './adapter';
import { WecomBotManager } from './manager';
import type { WecomBotPluginOptions } from './types';

export interface WecomBotPlugin extends FengsuiPlugin {
  /** 机器人管理器，可用于动态注册 handler、查询状态或主动发送。 */
  readonly bots: WecomBotManager;
}

/**
 * 创建企业微信机器人插件。
 *
 * - 每个启用的机器人注册一个渠道 `wecom.bot.<alias>`；
 * - `register()` 只做静态注册，不建连；
 * - `fengsui.start()` 建立长连接，`send()` 会懒连接并等待认证；
 * - `fengsui.close()` 逆序停止插件并断开全部连接。
 */
export function wecomBotPlugin(options: WecomBotPluginOptions): WecomBotPlugin {
  const manager = new WecomBotManager(options);

  return {
    name: 'wecom-bot',
    bots: manager,

    register(context: PluginContext): void {
      manager.attach({ credentials: context.credentials, logger: context.logger });
      for (const bot of manager.bots) {
        if (!bot.enabled) {
          continue;
        }
        context.adapters.register(createWecomBotAdapter({ bot, manager }));
      }
    },

    async start(): Promise<void> {
      await manager.start();
    },

    async stop(): Promise<void> {
      await manager.stop();
    },
  };
}

export { createWecomBotAdapter } from './adapter';
export { WecomBotManager } from './manager';
export { assertFrameOk, normalizeWecomError } from './errors';
export { eventNameOf, normalizeInboundFrame } from './message';
export { buildStreamBody, createWecomReply, imageMsgItem } from './reply';
export {
  wecomBotChannelOptionsSchema,
  type WecomBotChannelOptions,
} from './schema';
export {
  WECOM_BOT_ALIAS_PATTERN,
  WECOM_CHANNEL_PREFIX,
  WECOM_DEFAULT_CREDENTIALS_TENANT,
} from './types';
export type {
  WecomBotAdapterOptions,
} from './adapter';
export type {
  WecomBotConnectionState,
  WecomBotDefinition,
  WecomBotManagerOptions,
  WecomBotRuntimeInfo,
  WecomBotStatus,
  WecomClient,
  WecomClientConfig,
  WecomClientFactory,
  WecomContext,
  WecomHandler,
  WecomHandlerMap,
  WecomHandlerResult,
  WecomInboundMessage,
  WecomMessageType,
  WecomRawFrame,
  WecomRawMessage,
  WecomReply,
  WecomStreamReplyOptions,
  WecomStreamWithCardOptions,
} from './types';
