import type { ChannelAdapter } from '../../core';
import { listAdapters, registerAdapter } from '../../core';
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

/**
 * Registers every built-in email adapter (`email.smtp` + presets).
 * Adapters that are already registered are skipped, so calling this twice is safe.
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
