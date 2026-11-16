import { z } from 'zod';

const transportSchema = z
  .object({
    host: z.string().min(1, 'transport.host must not be empty').optional(),
    port: z.number().int('transport.port must be an integer').min(1).max(65535).optional(),
    secure: z.boolean().optional(),
  })
  .strict();

const poolSchema = z.union([
  z.boolean(),
  z
    .object({
      maxConnections: z.number().int().positive().optional(),
      maxMessages: z.number().int().positive().optional(),
    })
    .strict(),
]);

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
