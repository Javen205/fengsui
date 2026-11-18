/** 消息内容类型。核心据此校验渠道能力，并在不支持时选择降级或拒绝。 */
export type MessageKind = 'text' | 'markdown' | 'html' | 'card' | 'template' | 'media';

/** 附件类型。用于渠道能力声明与附件校验。 */
export type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

/**
 * 渠道能力声明。
 *
 * 适配器通过 `capabilities()` 返回静态能力，核心在投递前据此决定：
 * 是否需要降级、是否拒绝附件、是否走批量接口等。
 */
export interface ChannelCapabilities {
  /** 支持的文本/富文本消息类型。 */
  messageKinds: ReadonlyArray<MessageKind>;
  /** 附件能力；`false` 表示完全不支持附件。 */
  attachments: false | { maxBytes: number; kinds: ReadonlyArray<AttachmentKind> };
  /** @ 能力；`false` 表示不支持。 */
  mentions: false | { userIds: boolean; all: boolean; emails?: boolean };
  /** 批量发送能力；`false` 表示只能逐条发送。 */
  batch: false | { maxRecipients: number };
  /** 是否支持模板消息。 */
  templates: boolean;
  /** 回执模式：同步返回、主动查询、回调推送或不支持。 */
  receipts: 'sync' | 'query' | 'callback' | 'none';
  /** 限流维度与建议阈值，供上层做配额控制。 */
  rateLimit: {
    scope: 'tenant' | 'account' | 'bot' | 'recipient';
    perMinute?: number;
    perDay?: number;
  };
  /** 幂等能力：服务商原生支持、仅本地去重或不支持。 */
  idempotency: 'native' | 'local' | 'none';
  /** 是否支持 dry-run（只校验不发送）。 */
  dryRun: boolean;
}

/** 判断渠道是否声明支持某消息类型。 */
export function supportsMessageKind(capabilities: ChannelCapabilities, kind: MessageKind): boolean {
  return capabilities.messageKinds.includes(kind);
}

/** 单个目标的投递状态。 */
export type TargetDeliveryStatus = 'sent' | 'failed' | 'skipped';

/**
 * 单个目标的投递结果。
 *
 * fan-out 后每个目标一条，便于定位某个收件人为何失败；
 * 未设置的可选字段表示该渠道没有提供对应信息。
 */
export interface TargetDeliveryResult {
  /** 目标标识（邮箱、用户 ID、手机号等），由 `describeTarget` 生成。 */
  target: string;
  /** 目标级状态。 */
  status: TargetDeliveryStatus;
  /** 服务商消息 ID。 */
  providerMessageId?: string;
  /** 服务商状态码。 */
  providerCode?: string;
  /** 服务商原始描述或错误信息。 */
  providerMessage?: string;
  /** 该目标是否可重试。 */
  retryable?: boolean;
  /** 建议的重试等待时间（毫秒）。 */
  retryAfterMs?: number;
  /** 统一错误码。 */
  errorCode?: string;
  /** 跳过原因（dry-run、适配器主动 skip 等）。 */
  reason?: string;
  /** 实际尝试次数。 */
  attempts?: number;
  /** 降级来源类型。 */
  degradedFrom?: MessageKind;
  /** 降级目标类型。 */
  degradedTo?: MessageKind;
}

/** 整次投递的汇总状态。 */
export type DeliveryStatus = 'sent' | 'partial' | 'failed' | 'skipped';

/** 投递回执，`dispatchEnvelope()` 的直接产物。 */
export interface DeliveryReceipt {
  /** 实际使用的渠道 ID。 */
  channel: string;
  /** 本次请求 ID，用于日志关联。 */
  requestId: string;
  /** 汇总状态。 */
  status: DeliveryStatus;
  /** 逐目标结果。 */
  results: ReadonlyArray<TargetDeliveryResult>;
  /** 首个成功目标的服务商消息 ID。 */
  providerMessageId?: string;
  /** 是否发生了内容降级。 */
  degraded?: boolean;
  /** 是否为 dry-run。 */
  dryRun?: boolean;
  /** 命中的幂等记录。 */
  deduplicated?: boolean;
  /** 总耗时（毫秒）。 */
  durationMs?: number;
  /** 全部失败时的首个错误摘要。 */
  error?: { code: string; message: string; retryable: boolean };
}

/** 回执的计数汇总。 */
export interface DeliverySummary {
  /** 目标总数。 */
  total: number;
  /** 成功数。 */
  sent: number;
  /** 失败数。 */
  failed: number;
  /** 跳过数。 */
  skipped: number;
  /** 汇总状态。 */
  status: DeliveryStatus;
}

/**
 * 根据逐目标结果计算汇总状态。
 *
 * 规则：无目标视为失败；全部跳过为 `skipped`；全部成功为 `sent`；
 * 全部失败为 `failed`；其余为 `partial`。
 */
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

/** 只取汇总状态的便捷函数。 */
export function summarizeDeliveryStatus(
  results: ReadonlyArray<TargetDeliveryResult>,
): DeliveryStatus {
  return summarizeDeliveryResults(results).status;
}
