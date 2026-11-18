/**
 * 配置快照的 schema。
 *
 * 所有对象均为 `.strict()`：拼写错误、遗留字段会直接报错，而不是被静默忽略。
 * 另外递归拒绝疑似密钥字段，保证配置可以安全地写入日志或仓库。
 */
import { z } from 'zod';

import { CHANNEL_PATTERN, CREDENTIALS_REF_PATTERN } from '../patterns';
import { collectInlineSecrets } from '../secrets';

/** 配置里的渠道 ID 必须与信封使用同一套规则。 */
const channelIdSchema = z
  .string()
  .regex(CHANNEL_PATTERN, 'channel must look like "domain.action", e.g. "email.qq"');

/** 配置里的凭证引用必须与信封使用同一套规则。 */
const credentialsRefSchema = z
  .string()
  .regex(CREDENTIALS_REF_PATTERN, 'credentialsRef must look like "tenant/account"');

/** 单渠道默认值。 */
const channelDefaultsSchema = z
  .object({
    credentialsRef: credentialsRefSchema.optional(),
    channelOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** 一层配置。 */
const layerSchema = z
  .object({
    channel: channelIdSchema.optional(),
    credentialsRef: credentialsRefSchema.optional(),
    channelOptions: z.record(z.string(), z.unknown()).optional(),
    channels: z.record(channelIdSchema, channelDefaultsSchema).optional(),
  })
  .strict();

/** 项目配置 = 一层配置 + `extends`。 */
const projectSchema = layerSchema.extend({
  extends: z.string().min(1, 'extends must not be empty').optional(),
});

/**
 * 配置快照 schema。
 *
 * `version` 省略时默认 1，便于手写最小配置。
 */
export const configSnapshotSchema = z
  .object({
    version: z.literal(1).default(1),
    defaults: layerSchema.optional(),
    projects: z.record(z.string().min(1, 'project id must not be empty'), projectSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const hit of collectInlineSecrets(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [...hit.path],
        message: `Inline secret "${hit.key}" is not allowed in configuration; use credentialsRef instead`,
      });
    }
  });

/** 通过 schema 校验后的配置快照。 */
export type ParsedConfigSnapshot = z.infer<typeof configSnapshotSchema>;
