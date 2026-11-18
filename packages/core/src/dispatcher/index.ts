/**
 * 投递器：信封 → 渠道适配器的完整流水线。
 *
 * 处理顺序：
 * 1. 校验信封（`validateEnvelopeOrThrow`）；
 * 2. 若注入了配置解析器，用配置补齐 `channel` / `credentialsRef` 并合并 `channelOptions`；
 * 3. 解析渠道（实例注册表或默认注册表）并校验 `channelOptions`；
 * 4. 根据渠道能力构建降级方案（不支持的类型按 `fallbacks` 降级或拒绝）；
 * 5. 幂等查询：命中则直接返回历史回执，不发送；
 * 6. 目标 fan-out：每个目标独立重试、超时、取消，互不影响；
 * 7. 汇总逐目标结果，写入幂等存储并返回回执。
 *
 * 适配器只看到单个目标的 `NormalizedMessage`，不感知 fan-out 与重试。
 */
import { randomUUID } from 'node:crypto';

import type {
  AdapterContext,
  ChannelAdapter,
  ChannelSendOutcome,
  NormalizedMessage,
} from '../adapter';
import {
  supportsMessageKind,
  summarizeDeliveryResults,
  type ChannelCapabilities,
  type DeliveryReceipt,
  type MessageKind,
  type TargetDeliveryResult,
} from '../capabilities';
import type { ConfigResolveInput, ConfigResolver } from '../config';
import {
  validateEnvelopeOrThrow,
  type Envelope,
  type EnvelopeContent,
  type EnvelopeTarget,
} from '../envelope';
import { FENGSUI_ERROR_CODES, FengsuiError, type FengsuiErrorCode } from '../errors';
import { silentLogger } from '../logger';
import { getAdapter } from '../registry';
import type { DispatchOptions, DispatchResult } from './types';

export * from './types';

type FallbackPolicy = 'degrade' | 'reject';

interface DegradePlan {
  kind: MessageKind;
  content: EnvelopeContent;
  chain: ReadonlyArray<MessageKind>;
  degradedFrom?: MessageKind;
  degradedTo?: MessageKind;
}

interface DeliverTargetArgs {
  adapter: ChannelAdapter;
  envelope: Envelope;
  target: EnvelopeTarget | undefined;
  targetLabel: string;
  plan: DegradePlan;
  channelOptions: unknown;
  context: Omit<AdapterContext, 'signal'>;
  options: DispatchOptions;
  maxAttempts: number;
  attemptTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/**
 * 投递一个信封。
 *
 * @param input 未校验的信封，内部会做 schema 校验。
 * @param options 实例级依赖与重试/超时策略。
 * @returns 逐目标回执与汇总；不会因单个目标失败而抛异常。
 * @throws {FengsuiError} 信封或渠道选项非法、渠道未注册、能力不支持时抛出。
 */
export async function dispatchEnvelope(
  input: unknown,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const parsed = validateEnvelopeOrThrow(input);
  const logger = options.logger ?? silentLogger;
  // 先解析渠道，才能读取适配器声明的固定凭证默认值。
  const channel = await resolveChannel(parsed, options.config);
  const adapter =
    options.registry !== undefined ? options.registry.get(channel) : getAdapter(channel);
  const envelope = await resolveEnvelope(parsed, channel, adapter.defaultCredentialsRef, options.config);
  const capabilities = adapter.capabilities();
  const channelOptions = validateChannelOptions(adapter, envelope.channelOptions);
  const fallbackPolicy: FallbackPolicy = envelope.meta?.options?.fallback ?? 'degrade';
  const plan = buildDegradePlan(adapter, capabilities, envelope.content, fallbackPolicy);

  const targets = resolveTargets(envelope);
  const dryRun = options.dryRun === true || envelope.meta?.options?.dryRun === true;
  const requestId = envelope.meta?.requestId ?? randomUUID();
  const traceId = envelope.meta?.traceId ?? requestId;
  const [tenantFromRef] = envelope.credentialsRef.split('/');
  const tenantId = envelope.meta?.tenantId ?? tenantFromRef ?? '';

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const attemptTimeoutMs = envelope.meta?.options?.timeoutMs ?? options.attemptTimeoutMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const startedAt = Date.now();

  logger.debug('dispatcher.start', {
    channel: adapter.id,
    traceId,
    targets: targets.length,
    dryRun,
    kind: plan.kind,
  });

  const store = options.idempotencyStore;
  const idempotencyKey =
    envelope.meta?.idempotencyKey !== undefined
      ? `${tenantId}:${adapter.id}:${envelope.meta.idempotencyKey}`
      : undefined;

  if (!dryRun && idempotencyKey !== undefined && store !== undefined) {
    const existing = await store.get(idempotencyKey);
    if (existing !== undefined) {
      const existingSummary = summarizeDeliveryResults(existing.results);
      logger.debug('dispatcher.deduplicated', { channel: adapter.id, idempotencyKey });
      return {
        ...structuredClone(existing),
        status: existingSummary.status,
        summary: existingSummary,
        deduplicated: true,
        dryRun: existing.dryRun ?? false,
      };
    }
  }

  const context: Omit<AdapterContext, 'signal'> = {
    ...(options.http !== undefined ? { http: options.http } : {}),
    credentials: options.credentials,
    logger,
    traceId,
    tenantId,
  };

  const results: ReadonlyArray<TargetDeliveryResult> = dryRun
    ? targets.map((target) =>
        skippedResult(
          describeTarget(target, adapter.id),
          plan,
          'dry-run: validated without sending',
        ),
      )
    : await Promise.all(
        targets.map((target) =>
          deliverToTarget({
            adapter,
            envelope,
            target,
            targetLabel: describeTarget(target, adapter.id),
            plan,
            channelOptions,
            context,
            options,
            maxAttempts,
            attemptTimeoutMs,
            sleep,
            random,
          }),
        ),
      );

  const summary = summarizeDeliveryResults(results);
  const firstSent = results.find((result) => result.status === 'sent');
  const firstFailed = results.find((result) => result.status === 'failed');

  const receipt: DispatchResult = {
    channel: adapter.id,
    requestId,
    status: summary.status,
    results,
    summary,
    deduplicated: false,
    dryRun,
    durationMs: Date.now() - startedAt,
    ...(firstSent?.providerMessageId !== undefined
      ? { providerMessageId: firstSent.providerMessageId }
      : {}),
    ...(results.some((result) => result.degradedFrom !== undefined) ? { degraded: true } : {}),
    ...(summary.status === 'failed' && firstFailed !== undefined
      ? {
          error: {
            code: firstFailed.errorCode ?? 'channel',
            message: firstFailed.providerMessage ?? 'All targets failed',
            retryable: firstFailed.retryable ?? false,
          },
        }
      : {}),
  };

  logger.info('dispatcher.finished', {
    channel: adapter.id,
    status: summary.status,
    total: summary.total,
    sent: summary.sent,
    failed: summary.failed,
    skipped: summary.skipped,
  });

  if (!dryRun && idempotencyKey !== undefined && store !== undefined) {
    await store.set(idempotencyKey, structuredClone(receipt));
  }

  return receipt;
}

/** 配置解析后的信封：`channel` 与 `credentialsRef` 保证存在。 */
interface ResolvedEnvelope extends Envelope {
  channel: string;
  credentialsRef: string;
}

/**
 * 解析最终渠道 ID。
 *
 * 信封显式 `channel` 优先；否则用配置里的默认渠道。
 *
 * @throws {FengsuiError} 没有配置且信封未指定渠道时抛 `code: 'validation'`。
 */
async function resolveChannel(
  envelope: Envelope,
  config: ConfigResolver | undefined,
): Promise<string> {
  if (envelope.channel !== undefined) {
    return envelope.channel;
  }
  if (config === undefined) {
    throw new FengsuiError({
      code: 'validation',
      message:
        'Invalid envelope: channel is required. Set it on the envelope or inject a ConfigProvider with defaults.channel',
    });
  }

  const channel = await config.resolveChannel(
    envelope.meta?.projectId !== undefined ? { projectId: envelope.meta.projectId } : {},
  );
  if (channel === undefined) {
    throw new FengsuiError({
      code: 'validation',
      message:
        'Envelope "channel" is required: set it on the envelope or provide defaults.channel in configuration',
    });
  }
  return channel;
}

/**
 * 解析最终凭证引用与渠道选项。
 *
 * 优先级：信封显式值 > 配置默认值 > 适配器 `defaultCredentialsRef`。
 *
 * @throws {FengsuiError} 解析后仍缺少凭证引用时抛 `code: 'validation'`。
 */
async function resolveEnvelope(
  envelope: Envelope,
  channel: string,
  defaultCredentialsRef: string | undefined,
  config: ConfigResolver | undefined,
): Promise<ResolvedEnvelope> {
  if (config === undefined) {
    const credentialsRef = envelope.credentialsRef ?? defaultCredentialsRef;
    if (credentialsRef === undefined) {
      throw new FengsuiError({
        code: 'validation',
        message: `Invalid envelope: credentialsRef is required for channel "${channel}". Set it on the envelope, provide a default in the config provider, or register the adapter with a default credentialsRef`,
        channel,
      });
    }
    return { ...envelope, channel, credentialsRef };
  }

  const resolveInput: ConfigResolveInput = {
    channel,
    credentialsRef: envelope.credentialsRef,
    channelOptions: envelope.channelOptions,
    defaultCredentialsRef,
    ...(envelope.meta?.projectId !== undefined ? { projectId: envelope.meta.projectId } : {}),
  };
  const resolved = await config.resolve(resolveInput);

  return {
    ...envelope,
    channel: resolved.channel,
    credentialsRef: resolved.credentialsRef,
    channelOptions: resolved.channelOptions,
  };
}

/**
 * 向单个目标投递，内部完成 normalize、重试与超时控制。
 *
 * `normalize()` 失败不重试；`send()` 仅在 `error.retryable` 为 true 且未达上限时重试。
 */
async function deliverToTarget(args: DeliverTargetArgs): Promise<TargetDeliveryResult> {
  const { adapter, plan, targetLabel } = args;

  let message: NormalizedMessage;
  try {
    message = adapter.normalize({
      envelope: args.envelope,
      target: args.target,
      content: plan.content,
      options: args.channelOptions,
      degradedFrom: plan.degradedFrom,
      degradedTo: plan.degradedTo,
    });
  } catch (error) {
    const failure = toFengsuiError(error, adapter.id);
    return failedResult(targetLabel, failure, 0, plan);
  }

  let lastFailure: FengsuiError | undefined;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    try {
      const outcome = await withAttemptTimeout(
        (signal) => adapter.send(message, { ...args.context, signal }),
        args.attemptTimeoutMs,
        args.options.signal,
      );
      return successResult(targetLabel, outcome, attempt, plan);
    } catch (error) {
      const failure = toFengsuiError(error, adapter.id);
      lastFailure = failure;

      if (failure.retryable && attempt < args.maxAttempts) {
        const delay = computeRetryDelay(
          attempt,
          failure.retryAfterMs,
          args.options.baseRetryDelayMs ?? 250,
          args.options.maxRetryDelayMs ?? 5000,
          args.random,
        );
        args.context.logger.debug('dispatcher.retry', {
          channel: adapter.id,
          target: targetLabel,
          attempt,
          delayMs: delay,
          errorCode: failure.code,
        });
        await args.sleep(delay);
        continue;
      }

      return failedResult(targetLabel, failure, attempt, plan);
    }
  }

  return failedResult(
    targetLabel,
    lastFailure ??
      new FengsuiError({ code: 'internal', message: 'Dispatch attempt loop ended unexpectedly' }),
    args.maxAttempts,
    plan,
  );
}

/** 用适配器自己的 schema 校验 `channelOptions`，失败时抛出带字段路径的校验错误。 */
function validateChannelOptions(adapter: ChannelAdapter, channelOptions: unknown): unknown {
  const parsed = adapter.schema.safeParse(channelOptions);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
  const summary = issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');

  throw new FengsuiError({
    code: 'validation',
    message: `Invalid channelOptions for "${adapter.id}": ${summary}`,
    channel: adapter.id,
    details: issues,
  });
}

/**
 * 根据渠道能力与降级策略决定最终发送的内容类型。
 *
 * - 附件不被支持时直接抛 `unsupported`；
 * - 当前类型受支持则原样发送；
 * - 否则按适配器声明的 `fallbacks[type]` 顺序找第一个可用类型并转换内容；
 * - `reject` 策略下不做降级，直接抛错。
 */
function buildDegradePlan(
  adapter: ChannelAdapter,
  capabilities: ChannelCapabilities,
  content: EnvelopeContent,
  policy: FallbackPolicy,
): DegradePlan {
  if (
    Array.isArray(content.attachments) &&
    content.attachments.length > 0 &&
    capabilities.attachments === false
  ) {
    throw new FengsuiError({
      code: 'unsupported',
      message: `Adapter "${adapter.id}" does not support attachments`,
      channel: adapter.id,
      details: { feature: 'attachments' },
    });
  }

  const kind = inferMessageKind(content);
  if (supportsMessageKind(capabilities, kind)) {
    return { kind, content, chain: [] };
  }

  const chain = adapter.fallbacks?.[kind] ?? [];
  if (policy === 'degrade') {
    for (const candidate of chain) {
      if (candidate === kind || !supportsMessageKind(capabilities, candidate)) {
        continue;
      }
      return {
        kind: candidate,
        content: degradeContent(content, candidate),
        chain,
        degradedFrom: kind,
        degradedTo: candidate,
      };
    }
  }

  throw new FengsuiError({
    code: 'unsupported',
    message:
      chain.length > 0
        ? `Adapter "${adapter.id}" does not support ${kind} content and no declared fallback is usable`
        : `Adapter "${adapter.id}" does not support ${kind} content`,
    channel: adapter.id,
    details: { kind, supportedKinds: capabilities.messageKinds, fallbacks: chain },
  });
}

/** 推断内容的主类型，优先级：html > markdown > 附件(media) > text。 */
function inferMessageKind(content: EnvelopeContent): MessageKind {
  if (content.html !== undefined) {
    return 'html';
  }
  if (content.markdown !== undefined) {
    return 'markdown';
  }
  if (Array.isArray(content.attachments) && content.attachments.length > 0) {
    return 'media';
  }
  return 'text';
}

/** 把内容降级为目标类型：目前支持降到 `text` 或 `markdown`，其余原样返回。 */
function degradeContent(content: EnvelopeContent, to: MessageKind): EnvelopeContent {
  if (to === 'text') {
    const text =
      content.text ??
      (content.html !== undefined
        ? toPlainText(content.html)
        : content.markdown !== undefined
          ? toPlainText(content.markdown)
          : undefined);
    const next: EnvelopeContent = { ...content };
    delete next.html;
    delete next.markdown;
    if (text !== undefined) {
      next.text = text;
    }
    return next;
  }

  if (to === 'markdown') {
    const markdown =
      content.markdown ??
      content.text ??
      (content.html !== undefined ? toPlainText(content.html) : undefined);
    const next: EnvelopeContent = { ...content };
    delete next.html;
    if (markdown !== undefined) {
      next.markdown = markdown;
    }
    return next;
  }

  return content;
}

/** 粗略地把 HTML/Markdown 转为纯文本：去标签、去链接语法、压缩空白。 */
function toPlainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 目标归一为数组：单目标、目标数组、无目标三种形态统一处理。 */
function resolveTargets(envelope: Envelope): ReadonlyArray<EnvelopeTarget | undefined> {
  if (Array.isArray(envelope.target)) {
    return envelope.target;
  }
  if (envelope.target !== undefined) {
    return [envelope.target];
  }
  return [undefined];
}

/** 生成可读的目标标签（用于回执与日志），优先取第一组非空地址。 */
function describeTarget(target: EnvelopeTarget | undefined, fallback: string): string {
  if (target === undefined) {
    return fallback;
  }

  const groups = [
    target.to,
    target.userIds,
    target.phoneNumbers,
    target.openIds,
    target.departmentIds,
    target.tagIds,
  ];
  for (const group of groups) {
    if (group !== undefined && group.length > 0) {
      return group.join(',');
    }
  }
  return target.chatId ?? fallback;
}

function successResult(
  target: string,
  outcome: ChannelSendOutcome,
  attempts: number,
  plan: DegradePlan,
): TargetDeliveryResult {
  if (isDeliveryReceipt(outcome)) {
    if (outcome.status === 'skipped') {
      return skippedResult(
        target,
        plan,
        outcome.error?.message ?? 'Adapter skipped the message',
        attempts,
      );
    }
    if (outcome.status !== 'sent') {
      throw new FengsuiError({
        code: normalizeErrorCode(outcome.error?.code),
        message: outcome.error?.message ?? `Adapter "${outcome.channel}" failed to send`,
        channel: outcome.channel,
        ...(outcome.error?.retryable !== undefined ? { retryable: outcome.error.retryable } : {}),
        ...(outcome.error?.message !== undefined ? { providerMessage: outcome.error.message } : {}),
      });
    }

    const first = outcome.results[0];
    return {
      target,
      status: 'sent',
      attempts,
      ...(outcome.providerMessageId !== undefined
        ? { providerMessageId: outcome.providerMessageId }
        : first?.providerMessageId !== undefined
          ? { providerMessageId: first.providerMessageId }
          : {}),
      ...(first?.providerCode !== undefined ? { providerCode: first.providerCode } : {}),
      ...(first?.providerMessage !== undefined ? { providerMessage: first.providerMessage } : {}),
      ...(plan.degradedFrom !== undefined ? { degradedFrom: plan.degradedFrom } : {}),
      ...(plan.degradedTo !== undefined ? { degradedTo: plan.degradedTo } : {}),
    };
  }

  return {
    target,
    status: 'sent',
    attempts,
    ...(outcome.providerMessageId !== undefined
      ? { providerMessageId: outcome.providerMessageId }
      : {}),
    ...(outcome.providerCode !== undefined ? { providerCode: outcome.providerCode } : {}),
    ...(outcome.providerMessage !== undefined ? { providerMessage: outcome.providerMessage } : {}),
    ...(plan.degradedFrom !== undefined ? { degradedFrom: plan.degradedFrom } : {}),
    ...(plan.degradedTo !== undefined ? { degradedTo: plan.degradedTo } : {}),
  };
}

function failedResult(
  target: string,
  error: FengsuiError,
  attempts: number,
  plan: DegradePlan,
): TargetDeliveryResult {
  return {
    target,
    status: 'failed',
    attempts,
    errorCode: error.code,
    retryable: error.retryable,
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    ...(error.providerMessage !== undefined
      ? { providerMessage: error.providerMessage }
      : { providerMessage: error.message }),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(plan.degradedFrom !== undefined ? { degradedFrom: plan.degradedFrom } : {}),
    ...(plan.degradedTo !== undefined ? { degradedTo: plan.degradedTo } : {}),
  };
}

function skippedResult(
  target: string,
  plan: DegradePlan,
  reason: string,
  attempts = 0,
): TargetDeliveryResult {
  return {
    target,
    status: 'skipped',
    reason,
    attempts,
    ...(plan.degradedFrom !== undefined ? { degradedFrom: plan.degradedFrom } : {}),
    ...(plan.degradedTo !== undefined ? { degradedTo: plan.degradedTo } : {}),
  };
}

function isDeliveryReceipt(outcome: ChannelSendOutcome): outcome is DeliveryReceipt {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    'status' in outcome &&
    'results' in outcome &&
    Array.isArray((outcome as { results?: unknown }).results)
  );
}

function normalizeErrorCode(code: string | undefined): FengsuiErrorCode {
  if (code !== undefined && FENGSUI_ERROR_CODES.includes(code as FengsuiErrorCode)) {
    return code as FengsuiErrorCode;
  }
  return 'channel';
}

function toFengsuiError(error: unknown, channel: string): FengsuiError {
  if (error instanceof FengsuiError) {
    return error;
  }
  if (error instanceof Error) {
    return new FengsuiError({ code: 'internal', message: error.message, cause: error, channel });
  }
  return new FengsuiError({ code: 'internal', message: String(error), channel });
}

/**
 * 计算第 N 次失败后的等待时间。
 *
 * 优先使用服务商给出的 `retryAfterMs`；否则用指数退避
 * `base * 2^(attempt-1)` 作为上限，再乘随机数做抖动，避免同时重试。
 */
function computeRetryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  baseRetryDelayMs: number,
  maxRetryDelayMs: number,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.max(0, retryAfterMs);
  }
  const ceiling = Math.min(maxRetryDelayMs, baseRetryDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给单次适配器调用加超时与外部取消。
 *
 * 超时抛 `network`（可重试）；外部取消抛 `network` 且 `retryable: false`。
 * 传入适配器的 signal 由外部 signal 与内部超时 signal 合并而成。
 */
async function withAttemptTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  if (externalSignal?.aborted === true) {
    throw new FengsuiError({ code: 'network', message: 'Dispatch aborted', retryable: false });
  }

  const controller = new AbortController();
  const signal =
    externalSignal !== undefined
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new FengsuiError({
          code: 'network',
          message: `Adapter attempt timed out after ${timeoutMs}ms`,
          retryable: true,
          details: { timeoutMs },
        }),
      );
    }, timeoutMs);
    if (typeof timer === 'object') {
      (timer as { unref?: () => void }).unref?.();
    }

    if (externalSignal !== undefined) {
      abortListener = () => {
        reject(
          new FengsuiError({ code: 'network', message: 'Dispatch aborted', retryable: false }),
        );
      };
      externalSignal.addEventListener('abort', abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([run(signal), guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (abortListener !== undefined && externalSignal !== undefined) {
      externalSignal.removeEventListener('abort', abortListener);
    }
  }
}
