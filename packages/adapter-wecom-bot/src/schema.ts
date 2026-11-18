/**
 * 企业微信机器人渠道选项。
 *
 * 这是「单次发送级」配置，写在信封的 `channelOptions` 中；
 * 机器人定义与凭证不在信封里配置。
 *
 * 主动推送只支持 Markdown 与模板卡片，因此这里只有两个旋钮：
 * - `card`：提供模板卡片对象时按卡片发送；
 * - `msgtype`：显式指定发送类型，便于在卡片对象缺字段时提前报错。
 */
import { z } from 'zod';

/** 模板卡片：只强制校验 `card_type`，其余字段由企业微信定义，保持宽松。 */
const templateCardSchema = z.looseObject({
  card_type: z.string().min(1, 'card.card_type is required'),
});

export const wecomBotChannelOptionsSchema = z
  .object({
    /** 发送类型；省略时根据 `card` 是否存在推断。 */
    msgtype: z
      .enum(['markdown', 'template_card'], {
        error: 'msgtype must be "markdown" or "template_card"',
      })
      .optional(),
    /** 模板卡片内容；存在时优先按卡片发送。 */
    card: templateCardSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.msgtype === 'template_card' && value.card === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['card'],
        message: 'channelOptions.card is required when msgtype is "template_card"',
      });
    }
  });

export type WecomBotChannelOptions = z.infer<typeof wecomBotChannelOptionsSchema>;
