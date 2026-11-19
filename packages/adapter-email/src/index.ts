import type { ChannelAdapter, FengsuiPlugin } from '@javen205/fengsui-core';
import { listAdapters, registerAdapter } from '@javen205/fengsui-core';

import { createEmailAdapter, createEmailAdapters, type EmailAdapterOptions } from './adapter';
import { normalizeSmtpError } from './errors';
import {
  EMAIL_CHANNEL_IDS,
  EMAIL_PRESETS,
  EMAIL_SMTP_CHANNEL,
  getEmailPreset,
  resolveEmailTransport,
  type EmailAuthType,
  type EmailPreset,
  type EmailTransportOverrides,
  type ResolvedEmailTransport,
} from './presets';
import { emailChannelOptionsSchema, type EmailChannelOptions } from './schema';

export {
  createEmailAdapter,
  createEmailAdapters,
  normalizeSmtpError,
  EMAIL_CHANNEL_IDS,
  EMAIL_PRESETS,
  EMAIL_SMTP_CHANNEL,
  getEmailPreset,
  resolveEmailTransport,
  emailChannelOptionsSchema,
};
export type {
  EmailAdapterOptions,
  EmailAuthType,
  EmailChannelOptions,
  EmailPreset,
  EmailTransportOverrides,
  ResolvedEmailTransport,
};

export type EmailPluginOptions = Omit<EmailAdapterOptions, 'id'>;

/**
 * 邮件渠道插件：把 `email.smtp` 与全部内置 preset（`email.qq`、`email.163`、
 * `email.gmail` 等）注册到 fengsui 实例。
 *
 * 配置语义：
 * - `options` 是**实例级/全局**默认值，会应用到所有邮件渠道；
 * - 「项目级」差异不要靠创建多个实例解决，优先用信封的 `credentialsRef`
 *   （如 `project-a/qq-main`）与 `channelOptions`（from、transport、timeoutMs 等）；
 * - 若不同项目需要不同的默认端点或能力，用 `createEmailAdapter({ id, ... })`
 *   配合自定义插件手动注册，而不是重复调用 `emailPlugin()`（内置 ID 会冲突）。
 *
 * ```ts
 * const fengsui = createFengsui({
 *   credentials: createEnvCredentialResolver(),
 *   plugins: [emailPlugin()],
 * });
 * ```
 */
export function emailPlugin(options: EmailPluginOptions = {}): FengsuiPlugin {
  return {
    name: 'email',
    register({ adapters }) {
      for (const id of EMAIL_CHANNEL_IDS) {
        adapters.register(createEmailAdapter({ ...options, id }));
      }
    },
  };
}

/**
 * Registers every built-in email adapter into the module-level registry.
 * Adapters that are already registered are skipped, so calling this twice is safe.
 *
 * Prefer `emailPlugin()` with `createFengsui()` for isolated instances.
 */
export function registerEmailAdapters(
  options: Pick<EmailAdapterOptions, 'capabilities' | 'fallbacks' | 'maxAttachmentBytes'> = {},
): ReadonlyArray<ChannelAdapter> {
  const existing = new Set(listAdapters().map((adapter) => adapter.id));
  const registered: ChannelAdapter[] = [];

  for (const id of EMAIL_CHANNEL_IDS) {
    if (existing.has(id)) {
      continue;
    }
    const adapter = createEmailAdapter({ ...options, id });
    registerAdapter(adapter);
    registered.push(adapter);
  }

  return registered;
}
