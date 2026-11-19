import type { HttpClient } from '@javen205/fengsui-http';

import type { CredentialResolver } from '../adapter';
import type { DeliveryReceipt, DeliverySummary } from '../capabilities';
import type { ConfigResolver } from '../config';
import type { IdempotencyStore } from '../idempotency';
import type { Logger } from '../logger';
import type { AdapterRegistry } from '../registry';

/**
 * `dispatchEnvelope()` 的运行时选项。
 *
 * 这里放的是「进程级/实例级」依赖与策略，区别于信封里的单次投递参数：
 * - 依赖：`http`、`credentials`、`config`、`registry`、`logger`、`idempotencyStore`；
 * - 策略：`maxAttempts`、`attemptTimeoutMs`、退避参数；
 * - 测试钩子：`sleep`、`random`。
 */
export interface DispatchOptions {
  /** 仅 HTTP 渠道需要；纯 SMTP 等适配器可以不传。 */
  http?: HttpClient;
  /** 凭证解析器，必填。 */
  credentials: CredentialResolver;
  /**
   * 配置解析器；省略时信封必须自带 `channel` 与 `credentialsRef`。
   * 传入后可用配置为两者提供默认值，并按项目覆盖 `channelOptions`。
   */
  config?: ConfigResolver;
  /** 渠道注册表；省略时使用模块级默认注册表。 */
  registry?: AdapterRegistry;
  /** 日志器；省略时丢弃日志。 */
  logger?: Logger;
  /** 幂等存储；省略时不做去重。 */
  idempotencyStore?: IdempotencyStore;
  /** 每个目标的最大尝试次数（含首次）。默认 3。 */
  maxAttempts?: number;
  /** 单次尝试超时（毫秒）。默认 15000；信封的 `meta.options.timeoutMs` 优先。 */
  attemptTimeoutMs?: number;
  /** 指数退避的基准延迟（毫秒）。默认 250。 */
  baseRetryDelayMs?: number;
  /** 退避延迟上限（毫秒）。默认 5000。 */
  maxRetryDelayMs?: number;
  /** 可注入的 sleep，便于测试跳过节流等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 抖动来源，返回 [0, 1) 的随机数；默认 `Math.random`。 */
  random?: () => number;
  /** 强制 dry-run（只校验不发送）；信封的 `meta.options.dryRun` 同样生效。 */
  dryRun?: boolean;
  /** 外部取消信号；触发后本次投递不再重试。 */
  signal?: AbortSignal;
}

/**
 * `dispatchEnvelope()` 的返回值。
 *
 * 在 `DeliveryReceipt` 基础上补充了汇总信息与状态标记，
 * 调用方通常只需读取 `status` / `summary` / `results`。
 */
export interface DispatchResult extends DeliveryReceipt {
  /** 逐状态计数与汇总状态。 */
  summary: DeliverySummary;
  /** 是否命中幂等记录（命中时不会真正发送）。 */
  deduplicated: boolean;
  /** 是否为 dry-run。 */
  dryRun: boolean;
}
