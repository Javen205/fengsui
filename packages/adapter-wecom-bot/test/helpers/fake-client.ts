/**
 * 测试用 Fake SDK 客户端：记录调用并手动触发事件，避免真实 WebSocket。
 */
import type {
  BaseMessage,
  EventMessage,
  ReplyFeedback,
  ReplyMsgItem,
  SendMsgBody,
  TemplateCard,
  UploadMediaFinishResult,
  UploadMediaOptions,
  WeComMediaType,
  WelcomeReplyBody,
  WsFrame,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk';
import { EventType } from '@wecom/aibot-node-sdk';

import type { WecomClient, WecomClientConfig, WecomClientFactory } from '@javen205/fengsui-adapter-wecom-bot';

type Listener = (...args: never[]) => void;

export interface FakeReply {
  kind:
    | 'stream'
    | 'welcome'
    | 'card'
    | 'streamWithCard'
    | 'updateCard'
    | 'media';
  streamId?: string;
  content?: string;
  finish?: boolean;
  payload?: unknown;
  feedback?: ReplyFeedback;
  msgItems?: ReplyMsgItem[];
}

export class FakeWecomClient implements WecomClient {
  readonly config: WecomClientConfig;
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: Array<{ chatId: string; body: SendMsgBody }> = [];
  readonly sentMedia: Array<{ chatId: string; mediaType: WeComMediaType; mediaId: string }> = [];
  readonly replies: FakeReply[] = [];
  readonly downloads: Array<{ url: string; aesKey?: string }> = [];

  connectCalls = 0;
  disconnectCalls = 0;
  autoAuthenticate = true;
  pendingAck = false;
  nextFrame: Partial<WsFrame> = {};
  nextSendError: unknown;

  private connectedFlag = false;

  constructor(config: WecomClientConfig) {
    this.config = config;
  }

  connect(): this {
    this.connectCalls += 1;
    this.connectedFlag = true;
    this.emit('connected');
    if (this.autoAuthenticate) {
      this.emit('authenticated');
    }
    return this;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connectedFlag = false;
    this.emit('disconnected', 'manual');
  }

  get isConnected(): boolean {
    return this.connectedFlag;
  }

  on(event: string, handler: Listener): this {
    const list = this.listeners.get(event);
    if (list === undefined) {
      this.listeners.set(event, [handler]);
    } else {
      list.push(handler);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }

  async replyStream(
    _frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: ReplyMsgItem[],
    feedback?: ReplyFeedback,
  ): Promise<WsFrame> {
    this.replies.push({
      kind: 'stream',
      streamId,
      content,
      ...(finish !== undefined ? { finish } : {}),
      ...(msgItem !== undefined ? { msgItems: msgItem } : {}),
      ...(feedback !== undefined ? { feedback } : {}),
    });
    return this.frame();
  }

  async replyWelcome(_frame: WsFrameHeaders, body: WelcomeReplyBody): Promise<WsFrame> {
    this.replies.push({ kind: 'welcome', payload: body });
    return this.frame();
  }

  async replyTemplateCard(
    _frame: WsFrameHeaders,
    card: TemplateCard,
    feedback?: ReplyFeedback,
  ): Promise<WsFrame> {
    this.replies.push({
      kind: 'card',
      payload: card,
      ...(feedback !== undefined ? { feedback } : {}),
    });
    return this.frame();
  }

  async replyStreamWithCard(
    _frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    options?: {
      msgItem?: ReplyMsgItem[];
      streamFeedback?: ReplyFeedback;
      templateCard?: TemplateCard;
      cardFeedback?: ReplyFeedback;
    },
  ): Promise<WsFrame> {
    this.replies.push({
      kind: 'streamWithCard',
      streamId,
      content,
      ...(finish !== undefined ? { finish } : {}),
      ...(options !== undefined ? { payload: options } : {}),
    });
    return this.frame();
  }

  async updateTemplateCard(
    _frame: WsFrameHeaders,
    card: TemplateCard,
    userids?: string[],
  ): Promise<WsFrame> {
    this.replies.push({ kind: 'updateCard', payload: { card, userids } });
    return this.frame();
  }

  async replyMedia(
    _frame: WsFrameHeaders,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<WsFrame> {
    this.replies.push({ kind: 'media', payload: { mediaType, mediaId } });
    return this.frame();
  }

  async sendMessage(chatId: string, body: SendMsgBody): Promise<WsFrame> {
    if (this.nextSendError !== undefined) {
      throw this.nextSendError;
    }
    this.sent.push({ chatId, body });
    return this.frame();
  }

  async sendMediaMessage(
    chatid: string,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<WsFrame> {
    this.sentMedia.push({ chatId: chatid, mediaType, mediaId });
    return this.frame();
  }

  async uploadMedia(
    _fileBuffer: Buffer,
    _options: UploadMediaOptions,
  ): Promise<UploadMediaFinishResult> {
    return {
      type: 'file',
      media_id: 'media-1',
      created_at: new Date().toISOString(),
    };
  }

  async downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.downloads.push({ url, ...(aesKey !== undefined ? { aesKey } : {}) });
    return { buffer: Buffer.from('file'), filename: 'demo.txt' };
  }

  hasPendingReplyAck(): boolean {
    return this.pendingAck;
  }

  private frame(): WsFrame {
    return {
      headers: { req_id: 'ack-1' },
      errcode: 0,
      errmsg: 'ok',
      ...this.nextFrame,
    };
  }
}

export interface FakeFactoryHandle {
  factory: WecomClientFactory;
  clients: FakeWecomClient[];
}

export function createFakeFactory(autoAuthenticate = true): FakeFactoryHandle {
  const clients: FakeWecomClient[] = [];
  const factory: WecomClientFactory = (config) => {
    const client = new FakeWecomClient(config);
    client.autoAuthenticate = autoAuthenticate;
    clients.push(client);
    return client;
  };
  return { factory, clients };
}

let sequence = 0;

/** 构造一条文本消息帧。 */
export function textFrame(overrides: Partial<BaseMessage> = {}): WsFrame<BaseMessage> {
  sequence += 1;
  const body: BaseMessage = {
    msgid: `msg-${sequence}`,
    aibotid: 'bot-1',
    chattype: 'single',
    from: { userid: 'user-1' },
    create_time: 1_700_000_000,
    msgtype: 'text',
    text: { content: 'ping' },
    ...overrides,
  };
  return { headers: { req_id: `req-${sequence}` }, body };
}

/** 构造一条事件帧。 */
export function eventFrame(overrides: Partial<EventMessage> = {}): WsFrame<EventMessage> {
  sequence += 1;
  const body: EventMessage = {
    msgid: `event-${sequence}`,
    aibotid: 'bot-1',
    chattype: 'single',
    from: { userid: 'user-1' },
    create_time: 1_700_000_000,
    msgtype: 'event',
    event: { eventtype: EventType.EnterChat },
    ...overrides,
  };
  return { headers: { req_id: `req-${sequence}` }, body };
}
