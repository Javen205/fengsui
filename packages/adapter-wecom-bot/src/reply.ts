/**
 * 回复器：把 SDK 的被动回复 / 主动推送能力包装成统一 API。
 *
 * 每个收到的帧都会创建一个实例，绑定该帧的 `req_id`；
 * 所有调用都会校验回执 `errcode` 并归一化异常。
 */
import { randomUUID } from 'node:crypto';

import type {
  ReplyFeedback,
  ReplyMsgItem,
  SendMsgBody,
  StreamReplyBody,
  TemplateCard,
  UploadMediaFinishResult,
  UploadMediaOptions,
  WeComMediaType,
  WelcomeReplyBody,
  WsFrame,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk';

import { assertFrameOk, normalizeWecomError } from './errors';
import type {
  WecomClient,
  WecomReply,
  WecomStreamReplyOptions,
  WecomStreamWithCardOptions,
} from './types';

interface CreateReplyArgs {
  client: WecomClient;
  frame: WsFrameHeaders;
  channel: string;
}

/** 创建绑定到指定帧的回复器。 */
export function createWecomReply(args: CreateReplyArgs): WecomReply {
  const { client, frame, channel } = args;
  const headers: WsFrameHeaders = { headers: frame.headers };

  const run = async (action: string, task: () => Promise<WsFrame>): Promise<WsFrame> => {
    try {
      const result = await task();
      assertFrameOk(result, channel, action);
      return result;
    } catch (error) {
      throw normalizeWecomError(error, channel, action);
    }
  };

  return {
    frame: headers,
    channel,

    text(content: string): Promise<WsFrame> {
      return run('replyStream', () =>
        client.replyStream(headers, randomUUID(), content, true),
      );
    },

    markdown(content: string): Promise<WsFrame> {
      return run('replyStream', () =>
        client.replyStream(headers, randomUUID(), content, true),
      );
    },

    stream(options: WecomStreamReplyOptions): Promise<WsFrame> {
      const items = options.msgItems === undefined ? undefined : [...options.msgItems];
      return run('replyStream', () =>
        client.replyStream(
          headers,
          options.id ?? randomUUID(),
          options.content,
          options.finish ?? false,
          items,
          options.feedback,
        ),
      );
    },

    welcome(body: WelcomeReplyBody): Promise<WsFrame> {
      return run('replyWelcome', () => client.replyWelcome(headers, body));
    },

    card(card: TemplateCard, feedback?: ReplyFeedback): Promise<WsFrame> {
      return run('replyTemplateCard', () =>
        client.replyTemplateCard(headers, card, feedback),
      );
    },

    streamWithCard(options: WecomStreamWithCardOptions): Promise<WsFrame> {
      const items = options.msgItems === undefined ? undefined : [...options.msgItems];
      return run('replyStreamWithCard', () =>
        client.replyStreamWithCard(
          headers,
          options.id ?? randomUUID(),
          options.content,
          options.finish ?? false,
          {
            ...(items !== undefined ? { msgItem: items } : {}),
            ...(options.streamFeedback !== undefined
              ? { streamFeedback: options.streamFeedback }
              : {}),
            ...(options.templateCard !== undefined
              ? { templateCard: options.templateCard }
              : {}),
            ...(options.cardFeedback !== undefined
              ? { cardFeedback: options.cardFeedback }
              : {}),
          },
        ),
      );
    },

    updateCard(card: TemplateCard, userIds?: ReadonlyArray<string>): Promise<WsFrame> {
      return run('updateTemplateCard', () =>
        client.updateTemplateCard(headers, card, userIds === undefined ? undefined : [...userIds]),
      );
    },

    media(
      type: WeComMediaType,
      mediaId: string,
      videoOptions?: { title?: string; description?: string },
    ): Promise<WsFrame> {
      return run('replyMedia', () =>
        client.replyMedia(headers, type, mediaId, videoOptions),
      );
    },

    async upload(
      file: Buffer,
      options: UploadMediaOptions,
    ): Promise<UploadMediaFinishResult> {
      try {
        return await client.uploadMedia(file, options);
      } catch (error) {
        throw normalizeWecomError(error, channel, 'uploadMedia');
      }
    },

    sendTo(chatId: string, body: SendMsgBody): Promise<WsFrame> {
      return run('sendMessage', () => client.sendMessage(chatId, body));
    },

    async download(
      url: string,
      aesKey?: string,
    ): Promise<{ buffer: Buffer; filename?: string }> {
      try {
        return await client.downloadFile(url, aesKey);
      } catch (error) {
        throw normalizeWecomError(error, channel, 'downloadFile');
      }
    },

    hasPendingAck(): boolean {
      return client.hasPendingReplyAck?.(headers) ?? false;
    },
  };
}

/** 一次性流式回复体，供高级场景直接构造。 */
export function buildStreamBody(
  id: string,
  content: string,
  finish: boolean,
): StreamReplyBody {
  return { msgtype: 'stream', stream: { id, content, finish } };
}

/** 图文混排项构造辅助。 */
export function imageMsgItem(base64: string, md5: string): ReplyMsgItem {
  return { msgtype: 'image', image: { base64, md5 } };
}
