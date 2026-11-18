/**
 * 邮件渠道选项 schema。
 *
 * 这是「单次投递级」配置，写在信封的 `channelOptions` 中，按请求生效；
 * 与它对应的是 `createEmailAdapter()` / `emailPlugin()` 的「适配器级」配置，
 * 后者作为默认值，可被这里的字段逐项覆盖。
 *
 * 所有对象均为 `.strict()`：未知字段直接报错，避免把凭证或拼写错误混进来。
 * 凭证不在此处配置，必须走 `credentialsRef`。
 */
import { z } from 'zod';

/**
 * SMTP 连接覆盖项。
 *
 * 典型用法：同一 preset 需要走自建代理或测试服务器时，只覆盖 host/port/secure。
 */
const transportSchema = z
  .object({
    host: z.string().min(1, 'transport.host must not be empty').optional(),
    port: z.number().int('transport.port must be an integer').min(1).max(65535).optional(),
    secure: z.boolean().optional(),
  })
  .strict();

/**
 * 连接池配置。
 *
 * - `true`：启用默认池参数；
 * - 对象：自定义最大连接数与单连接最大消息数；
 * - 省略：每次发送新建连接。
 */
const poolSchema = z.union([
  z.boolean(),
  z
    .object({
      maxConnections: z.number().int().positive().optional(),
      maxMessages: z.number().int().positive().optional(),
    })
    .strict(),
]);

/**
 * 邮件渠道选项。
 *
 * 字段全部可选，省略时使用适配器默认值：
 * - `transport`：覆盖 preset 的 host/port/secure；
 * - `pool`：连接池；
 * - `timeoutMs`：SMTP 操作超时，默认 15000ms；
 * - `charset`：正文编码，目前仅支持 `utf-8`；
 * - `from`：发件人，省略时使用凭证里的 `user`；
 * - `replyTo`：回复地址；
 * - `headers`：附加邮件头，保留头（From/To/Subject 等）会被适配器拒绝。
 */
export const emailChannelOptionsSchema = z
  .object({
    transport: transportSchema.optional(),
    pool: poolSchema.optional(),
    timeoutMs: z.number().int('timeoutMs must be an integer').positive().optional(),
    charset: z.literal('utf-8', { error: 'charset currently only supports "utf-8"' }).optional(),
    from: z.string().min(1, 'from must not be empty').optional(),
    replyTo: z.string().min(1, 'replyTo must not be empty').optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type EmailChannelOptions = z.infer<typeof emailChannelOptionsSchema>;
