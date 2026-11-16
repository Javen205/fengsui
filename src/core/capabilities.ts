export type MessageKind = 'text' | 'markdown' | 'html' | 'card' | 'template' | 'media';

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

export interface ChannelCapabilities {
  messageKinds: ReadonlyArray<MessageKind>;
  attachments: false | { maxBytes: number; kinds: ReadonlyArray<AttachmentKind> };
  mentions: false | { userIds: boolean; all: boolean; emails?: boolean };
  batch: false | { maxRecipients: number };
  templates: boolean;
  receipts: 'sync' | 'query' | 'callback' | 'none';
  rateLimit: {
    scope: 'tenant' | 'account' | 'bot' | 'recipient';
    perMinute?: number;
    perDay?: number;
  };
  idempotency: 'native' | 'local' | 'none';
  dryRun: boolean;
}

export function supportsMessageKind(capabilities: ChannelCapabilities, kind: MessageKind): boolean {
  return capabilities.messageKinds.includes(kind);
}

export type TargetDeliveryStatus = 'sent' | 'failed' | 'skipped';

export interface TargetDeliveryResult {
  target: string;
  status: TargetDeliveryStatus;
  providerMessageId?: string;
  providerCode?: string;
  providerMessage?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  errorCode?: string;
  reason?: string;
  attempts?: number;
  degradedFrom?: MessageKind;
  degradedTo?: MessageKind;
}

export type DeliveryStatus = 'sent' | 'partial' | 'failed' | 'skipped';

export interface DeliveryReceipt {
  channel: string;
  requestId: string;
  status: DeliveryStatus;
  results: ReadonlyArray<TargetDeliveryResult>;
  providerMessageId?: string;
  degraded?: boolean;
  dryRun?: boolean;
  deduplicated?: boolean;
  durationMs?: number;
  error?: { code: string; message: string; retryable: boolean };
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  status: DeliveryStatus;
}

export function summarizeDeliveryResults(
  results: ReadonlyArray<TargetDeliveryResult>,
): DeliverySummary {
  const total = results.length;
  const sent = results.filter((result) => result.status === 'sent').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;

  let status: DeliveryStatus;
  if (total === 0) {
    status = 'failed';
  } else if (skipped === total) {
    status = 'skipped';
  } else if (failed === 0 && skipped === 0) {
    status = 'sent';
  } else if (failed === total) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  return { total, sent, failed, skipped, status };
}

export function summarizeDeliveryStatus(
  results: ReadonlyArray<TargetDeliveryResult>,
): DeliveryStatus {
  return summarizeDeliveryResults(results).status;
}
