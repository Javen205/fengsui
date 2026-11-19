import type { WecomHandlerMap, WecomHandlerResult } from '@javen205/fengsui-adapter-wecom-bot';

import { markdownIntro } from '../common/project-content.js';

/** 触发项目介绍的输入。 */
const INTRO_KEYWORDS = /^(fengsui|烽燧|ijpay|tnwx|帮助|help|\?|？)$/i;

/**
 * 企业微信机器人的事件处理。
 *
 * - `message.text`：命中关键词返回项目介绍，其他文本回提示；
 * - `event.enter_chat`：新成员进入会话时发送欢迎语；
 * - `*`：兜底日志，便于观察所有入站帧。
 *
 * 返回值里的 `markdown` 由插件自动回复；`enter_chat` 用 `reply.welcome`
 * 发送企业微信规定的欢迎语格式。
 */
export function createWecomHandlers(): WecomHandlerMap {
  return {
    'message.text': ({ message }): WecomHandlerResult => {
      const text = (message.text ?? '').trim();

      if (INTRO_KEYWORDS.test(text) || text.includes('项目')) {
        return { handled: true, markdown: markdownIntro() };
      }

      const quoted = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      return {
        handled: true,
        markdown: [
          quoted.length > 0 ? `收到：**${quoted}**` : '收到你的消息。',
          '',
          '回复 `fengsui`、`ijpay`、`tnwx` 或 `帮助`，查看 Javen 的开源项目速览。',
        ].join('\n'),
      };
    },

    'event.enter_chat': async ({ reply }): Promise<WecomHandlerResult> => {
      await reply.welcome({
        msgtype: 'text',
        text: {
          content:
            '你好，我是烽燧示例机器人。发送 fengsui、ijpay、tnwx 或 帮助，看看 Javen 的开源项目。',
        },
      });
      return { handled: true };
    },

    '*': ({ message, logger }): void => {
      logger.debug('wecom.inbound', {
        channel: message.channel,
        messageId: message.messageId,
        messageType: message.messageType,
        chatType: message.chat.type,
      });
    },
  };
}
