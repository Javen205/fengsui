/**
 * 统一信封 schema。
 *
 * 信封是调用方与核心之间唯一的输入契约，包含：渠道、动作、目标、内容、
 * 渠道选项、凭证引用与元信息。几点约定：
 * - 所有对象都是 `.strict()`：未知字段直接报错，避免拼写错误被静默忽略；
 * - 凭证只能通过 `credentialsRef` 引用，禁止把密码/token 内联到信封或 `channelOptions`；
 * - `channelOptions` 由具体渠道适配器的 schema 再次校验，本文件只做 `unknown` 记录；
 * - `channel` 与 `credentialsRef` 可以省略：省略时由配置提供默认值，
 *   最终由投递器在配置解析后检查是否齐全。
 */
import { z } from 'zod';

import { FengsuiError } from '../errors';
import { CHANNEL_PATTERN, CREDENTIALS_REF_PATTERN } from '../patterns';
import { isInlineSecretKey } from '../secrets';

/** 附件描述：`path` 与 `url` 二者至少一个（由适配器进一步校验可达性）。 */
const attachmentSchema = z
  .object({
    name: z.string().min(1, 'attachment name is required'),
    path: z.string().min(1, 'attachment path must not be empty').optional(),
    url: z.string().url('attachment url must be a valid URL').optional(),
    contentType: z.string().min(1, 'attachment contentType must not be empty').optional(),
    size: z.number().int().nonnegative('attachment size must be a non-negative integer').optional(),
  })
  .strict();

/**
 * 消息内容。至少应提供一种正文（`text` / `html` / `markdown` / 模板 `data`），
 * 具体是否合法由渠道能力决定；`subject` 主要供邮件使用。
 */
const contentSchema = z
  .object({
    subject: z.string().min(1, 'content.subject must not be empty').optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    markdown: z.string().optional(),
    attachments: z.array(attachmentSchema).optional(),
    data: z.record(z.string(), z.string()).optional(),
    url: z.string().url('content.url must be a valid URL').optional(),
  })
  .strict();

/**
 * 投递目标。字段含义按渠道解释：
 * - 邮件：`to` / `cc` / `bcc`；
 * - IM：`userIds` / `chatId`；
 * - 短信：`phoneNumbers`；
 * - 微信：`openIds`；
 * - 组织类渠道：`departmentIds` / `tagIds`。
 * 单个目标对象或目标数组都接受，数组表示 fan-out 到多组目标。
 */
const targetSchema = z
  .object({
    to: z.array(z.string().min(1)).min(1, 'target.to must not be empty').optional(),
    cc: z.array(z.string().min(1)).optional(),
    bcc: z.array(z.string().min(1)).optional(),
    userIds: z.array(z.string().min(1)).optional(),
    chatId: z.string().min(1, 'target.chatId must not be empty').optional(),
    phoneNumbers: z.array(z.string().min(1)).optional(),
    openIds: z.array(z.string().min(1)).optional(),
    departmentIds: z.array(z.string().min(1)).optional(),
    tagIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * `meta.options`：控制本次投递行为。
 * - `dryRun`：只校验不发送；
 * - `fallback`：内容类型不支持时降级（`degrade`）还是直接拒绝（`reject`）；
 * - `timeoutMs`：单次尝试超时，覆盖适配器/全局默认值。
 */
const metaOptionsSchema = z
  .object({
    dryRun: z.boolean().optional(),
    fallback: z.enum(['degrade', 'reject']).optional(),
    timeoutMs: z
      .number()
      .int('meta.options.timeoutMs must be an integer')
      .positive('meta.options.timeoutMs must be positive')
      .optional(),
  })
  .strict();

/**
 * `meta`：追踪与幂等相关信息。
 * `requestId` / `traceId` 用于日志关联，`idempotencyKey` 用于去重，`tags` 用于分类统计；
 * `projectId` 用于从配置快照中选择项目级默认值（渠道、凭证引用、渠道选项）。
 */
const metaSchema = z
  .object({
    requestId: z.string().min(1, 'meta.requestId must not be empty').optional(),
    traceId: z.string().min(1, 'meta.traceId must not be empty').optional(),
    idempotencyKey: z.string().min(1, 'meta.idempotencyKey must not be empty').optional(),
    tenantId: z.string().min(1, 'meta.tenantId must not be empty').optional(),
    projectId: z.string().min(1, 'meta.projectId must not be empty').optional(),
    tags: z.record(z.string(), z.string()).optional(),
    options: metaOptionsSchema.optional(),
  })
  .strict();

/**
 * 信封主 schema。
 *
 * `version` 目前固定为 1；`target` 可省略（例如按会话或全量广播的渠道）；
 * `channelOptions` 默认空对象，交给适配器二次校验。
 *
 * `channel` 与 `credentialsRef` 可选：省略时由配置（`defaults` /
 * `projects.<meta.projectId>`）补齐；两者最终仍缺失时，投递器会抛
 * `validation` 错误，并提示应该补在哪一层。
 */
export const envelopeSchema = z
  .object({
    version: z.literal(1).default(1),
    channel: z
      .string({ error: 'channel must be a string like "email.qq"' })
      .regex(CHANNEL_PATTERN, 'channel must look like "domain.action", e.g. "email.qq"')
      .optional(),
    action: z.string({ error: 'action is required' }).min(1, 'action must not be empty'),
    target: z
      .union([targetSchema, z.array(targetSchema).min(1, 'target must not be empty')])
      .optional(),
    content: contentSchema,
    channelOptions: z.record(z.string(), z.unknown()).default({}),
    credentialsRef: z
      .string({ error: 'credentialsRef must be a string in the form "tenant/account"' })
      .regex(CREDENTIALS_REF_PATTERN, 'credentialsRef must look like "tenant/account"')
      .optional(),
    meta: metaSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value.channelOptions)) {
      if (isInlineSecretKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['channelOptions', key],
          message: `Inline secret "${key}" is not allowed in channelOptions; use credentialsRef instead`,
        });
      }
    }

    for (const key of Object.keys(value)) {
      if (isInlineSecretKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Inline secret "${key}" is not allowed in the envelope; use credentialsRef instead`,
        });
      }
    }
  });

export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeInput = z.input<typeof envelopeSchema>;
export type EnvelopeAttachment = z.infer<typeof attachmentSchema>;
export type EnvelopeContent = z.infer<typeof contentSchema>;
export type EnvelopeTarget = z.infer<typeof targetSchema>;
export type EnvelopeMeta = z.infer<typeof metaSchema>;

export interface EnvelopeIssue {
  path: string;
  message: string;
  code: string;
}

export type EnvelopeParseResult =
  { ok: true; value: Envelope } | { ok: false; issues: ReadonlyArray<EnvelopeIssue> };

/**
 * 校验信封，不抛异常。
 *
 * @returns 成功时返回收窄后的 `value`；失败时返回扁平化的 `issues`（`path` 为点分路径）。
 */
export function parseEnvelope(input: unknown): EnvelopeParseResult {
  const result = envelopeSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    })),
  };
}

/**
 * 校验信封，失败时抛 `FengsuiError(code: 'validation')`。
 *
 * 错误信息聚合所有 issue，便于一次修正多个字段。
 */
export function validateEnvelopeOrThrow(input: unknown): Envelope {
  const result = parseEnvelope(input);
  if (result.ok) {
    return result.value;
  }

  const summary = result.issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');

  throw new FengsuiError({
    code: 'validation',
    message: `Invalid envelope: ${summary}`,
    details: result.issues,
  });
}
