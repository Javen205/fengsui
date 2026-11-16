import { z } from 'zod';

import { FengsuiError } from '../errors';

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const CREDENTIALS_REF_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const attachmentSchema = z
  .object({
    name: z.string().min(1, 'attachment name is required'),
    path: z.string().min(1, 'attachment path must not be empty').optional(),
    url: z.string().url('attachment url must be a valid URL').optional(),
    contentType: z.string().min(1, 'attachment contentType must not be empty').optional(),
    size: z.number().int().nonnegative('attachment size must be a non-negative integer').optional(),
  })
  .strict();

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

const metaSchema = z
  .object({
    requestId: z.string().min(1, 'meta.requestId must not be empty').optional(),
    traceId: z.string().min(1, 'meta.traceId must not be empty').optional(),
    idempotencyKey: z.string().min(1, 'meta.idempotencyKey must not be empty').optional(),
    tenantId: z.string().min(1, 'meta.tenantId must not be empty').optional(),
    tags: z.record(z.string(), z.string()).optional(),
    options: metaOptionsSchema.optional(),
  })
  .strict();

const INLINE_SECRET_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'key',
  'sign',
  'apikey',
  'accesskeysecret',
  'webhookkey',
  'authcode',
  'appsecret',
  'clientsecret',
  'accesstoken',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function isInlineSecretKey(key: string): boolean {
  return INLINE_SECRET_KEYS.has(normalizeKey(key));
}

export const envelopeSchema = z
  .object({
    version: z.literal(1).default(1),
    channel: z
      .string({ error: 'channel is required and must be a string like "email.qq"' })
      .regex(CHANNEL_PATTERN, 'channel must look like "domain.action", e.g. "email.qq"'),
    action: z.string({ error: 'action is required' }).min(1, 'action must not be empty'),
    target: z
      .union([targetSchema, z.array(targetSchema).min(1, 'target must not be empty')])
      .optional(),
    content: contentSchema,
    channelOptions: z.record(z.string(), z.unknown()).default({}),
    credentialsRef: z
      .string({ error: 'credentialsRef is required in the form "tenant/account"' })
      .regex(CREDENTIALS_REF_PATTERN, 'credentialsRef must look like "tenant/account"'),
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
