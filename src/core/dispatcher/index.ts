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

export async function dispatchEnvelope(
  input: unknown,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const envelope = validateEnvelopeOrThrow(input);
  const logger = options.logger ?? silentLogger;
  const adapter = getAdapter(envelope.channel);
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
    http: options.http,
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

function toPlainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTargets(envelope: Envelope): ReadonlyArray<EnvelopeTarget | undefined> {
  if (Array.isArray(envelope.target)) {
    return envelope.target;
  }
  if (envelope.target !== undefined) {
    return [envelope.target];
  }
  return [undefined];
}

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
