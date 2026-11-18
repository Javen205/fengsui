/**
 * SDK 帧 → 核心入站消息的归一化。
 *
 * 只做纯数据映射，不产生 IO；归一化后的 `raw` 保留完整原始帧，
 * 业务代码需要平台特有字段时可直接读取。
 */
import type { InboundChat, InboundMedia, InboundQuote, InboundSender } from '@fengsui/core';
import type {
  EventMessage,
  MixedContent,
  QuoteContent,
} from '@wecom/aibot-node-sdk';

import type {
  WecomInboundMessage,
  WecomMessageType,
  WecomRawFrame,
  WecomRawMessage,
} from './types';

/**
 * 把 SDK 帧归一化成 {@link WecomInboundMessage}。
 *
 * @returns 帧体缺失时返回 `undefined`，由调用方记录日志并跳过。
 */
export function normalizeInboundFrame(
  alias: string,
  channel: string,
  frame: WecomRawFrame,
): WecomInboundMessage | undefined {
  const body = frame.body;
  if (body === undefined) {
    return undefined;
  }

  const messageType = messageTypeOf(body);
  const chat = buildChat(body);
  const sender = buildSender(body);
  const media = buildMedia(body);
  const quote = buildQuote(isEvent(body) ? undefined : body.quote);

  const normalized: WecomInboundMessage = {
    channel,
    alias,
    botId: body.aibotid,
    messageId: body.msgid ?? frame.headers.req_id,
    kind: kindOf(messageType),
    messageType,
    chat,
    sender,
    receivedAt: toIsoTime(body.create_time),
    raw: frame,
    ...(media.text !== undefined ? { text: media.text } : {}),
    ...(media.images !== undefined ? { images: media.images } : {}),
    ...(media.files !== undefined ? { files: media.files } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(isEvent(body) ? { eventType: body.event.eventtype, event: body.event } : {}),
  };

  return normalized;
}

/** 计算路由事件名：消息为 `message.<type>`，事件为 `event.<eventtype>`。 */
export function eventNameOf(message: WecomInboundMessage): string {
  if (message.messageType === 'event') {
    return `event.${message.eventType ?? 'unknown'}`;
  }
  return `message.${message.messageType}`;
}

function isEvent(body: WecomRawMessage): body is EventMessage {
  return body.msgtype === 'event';
}

function messageTypeOf(body: WecomRawMessage): WecomMessageType {
  if (isEvent(body)) {
    return 'event';
  }

  switch (body.msgtype) {
    case 'text':
    case 'image':
    case 'mixed':
    case 'voice':
    case 'file':
    case 'video':
      return body.msgtype;
    default:
      return 'unknown';
  }
}

function kindOf(messageType: WecomMessageType): WecomInboundMessage['kind'] {
  return messageType;
}

function buildChat(body: WecomRawMessage): InboundChat {
  const type =
    body.chattype === 'group' ? 'group' : body.chattype === 'single' ? 'single' : 'unknown';
  const id = body.chatid ?? body.from.userid;
  return { type, ...(id !== undefined && id !== '' ? { id } : {}) };
}

function buildSender(body: WecomRawMessage): InboundSender {
  const corpid = isEvent(body) ? body.from.corpid : undefined;
  return {
    id: body.from.userid,
    ...(corpid !== undefined && corpid !== '' ? { tenantId: corpid } : {}),
  };
}

interface NormalizedMedia {
  text?: string | undefined;
  images?: ReadonlyArray<InboundMedia> | undefined;
  files?: ReadonlyArray<InboundMedia> | undefined;
}

function buildMedia(body: WecomRawMessage): NormalizedMedia {
  if (isEvent(body)) {
    return {};
  }

  switch (body.msgtype) {
    case 'text':
      return { text: body.text.content };
    case 'voice':
      return { text: body.voice.content };
    case 'image':
      return { images: [toMedia(body.image.url, body.image.aeskey)] };
    case 'file':
      return { files: [toMedia(body.file.url, body.file.aeskey)] };
    case 'video':
      return { files: [toMedia(body.video.url, body.video.aeskey, 'video/mp4')] };
    case 'mixed':
      return buildMixedMedia(body.mixed);
    default:
      return {};
  }
}

function buildMixedMedia(mixed: MixedContent): NormalizedMedia {
  const texts: string[] = [];
  const images: InboundMedia[] = [];

  for (const item of mixed.msg_item) {
    if (item.msgtype === 'text' && item.text !== undefined) {
      texts.push(item.text.content);
      continue;
    }
    if (item.msgtype === 'image' && item.image !== undefined) {
      images.push(toMedia(item.image.url, item.image.aeskey));
    }
  }

  return {
    ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

function toMedia(url: string, aesKey: string | undefined, contentType?: string): InboundMedia {
  return {
    url,
    ...(aesKey !== undefined && aesKey !== '' ? { aesKey } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

function buildQuote(quote: QuoteContent | undefined): InboundQuote | undefined {
  if (quote === undefined) {
    return undefined;
  }

  const text = quoteText(quote);
  return text !== undefined ? { text } : undefined;
}

function quoteText(quote: QuoteContent): string | undefined {
  switch (quote.msgtype) {
    case 'text':
      return quote.text?.content;
    case 'voice':
      return quote.voice?.content;
    case 'mixed': {
      const parts = (quote.mixed?.msg_item ?? [])
        .map((item) => (item.msgtype === 'text' ? item.text?.content : undefined))
        .filter((part): part is string => part !== undefined && part.length > 0);
      return parts.length > 0 ? parts.join('\n') : undefined;
    }
    default:
      return undefined;
  }
}

function toIsoTime(createTime: number | undefined): string {
  if (createTime === undefined) {
    return new Date().toISOString();
  }
  // 企业微信返回秒级时间戳；兼容毫秒级输入。
  const millis = createTime < 1_000_000_000_000 ? createTime * 1000 : createTime;
  return new Date(millis).toISOString();
}
