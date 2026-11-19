import { afterEach, describe, expect, it } from 'vitest';

import { createFengsui, type CredentialResolver, type Fengsui } from '@javen205/fengsui-core';
import {
  wecomBotPlugin,
  type WecomInboundMessage,
} from '@javen205/fengsui-adapter-wecom-bot';

import { createFakeFactory, eventFrame, textFrame } from './helpers/fake-client';

const credentials: CredentialResolver = {
  async resolve(ref) {
    return { ref, values: { secret: `secret-for-${ref}` } };
  },
};

const instances: Fengsui[] = [];

function createInstance(options: Omit<Parameters<typeof createFengsui>[0], 'credentials'>): Fengsui {
  const instance = createFengsui({ credentials, ...options });
  instances.push(instance);
  return instance;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(async () => {
  while (instances.length > 0) {
    await instances.pop()?.close();
  }
});

describe('wecom bot plugin', () => {
  it('registers one channel per enabled bot with a fixed default credentials ref', () => {
    const { factory } = createFakeFactory();
    const plugin = wecomBotPlugin({
      bots: [
        { alias: 'support', botId: 'bot-1' },
        { alias: 'sales', botId: 'bot-2', credentialsRef: 'sales/wecom', enabled: false },
      ],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin] });

    expect(fengsui.listChannels().map((channel) => channel.id)).toEqual(['wecom.bot.support']);

    const adapter = fengsui.registry.get('wecom.bot.support');
    expect(adapter.defaultCredentialsRef).toBe('wecom/support');
    expect(plugin.bots.bots.map((bot) => bot.channel)).toEqual([
      'wecom.bot.support',
      'wecom.bot.sales',
    ]);
  });

  it('normalizes inbound messages and sends handler replies automatically', async () => {
    const { factory, clients } = createFakeFactory();
    let resolveMessage: ((message: WecomInboundMessage) => void) | undefined;
    const received = new Promise<WecomInboundMessage>((resolve) => {
      resolveMessage = resolve;
    });

    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
      handlers: {
        'message.text': async ({ message }) => {
          resolveMessage?.(message);
          return { markdown: '**pong**' };
        },
      },
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    clients[0]?.emit(
      'message',
      textFrame({ text: { content: 'ping' }, quote: { msgtype: 'text', text: { content: '引用' } } }),
    );

    const message = await received;
    expect(message).toMatchObject({
      channel: 'wecom.bot.support',
      alias: 'support',
      kind: 'text',
      messageType: 'text',
      text: 'ping',
      chat: { id: 'user-1', type: 'single' },
      sender: { id: 'user-1' },
      quote: { text: '引用' },
    });

    await settle();
    expect(clients[0]?.replies).toEqual([
      { kind: 'stream', streamId: expect.any(String), content: '**pong**', finish: true },
    ]);
  });

  it('routes enter_chat events and lets handlers reply with a welcome message', async () => {
    const { factory, clients } = createFakeFactory();
    let received: WecomInboundMessage | undefined;

    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
      handlers: {
        'event.enter_chat': async ({ message, reply }) => {
          received = message;
          await reply.welcome({ msgtype: 'text', text: { content: '欢迎' } });
          return { handled: true };
        },
      },
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    clients[0]?.emit('event', eventFrame());

    await settle();
    expect(received).toMatchObject({
      kind: 'event',
      messageType: 'event',
      eventType: 'enter_chat',
    });
    expect(clients[0]?.replies).toEqual([
      { kind: 'welcome', payload: { msgtype: 'text', text: { content: '欢迎' } } },
    ]);
  });

  it('keeps handlers and dedupe state isolated per bot', async () => {
    const { factory, clients } = createFakeFactory();
    const channels: string[] = [];

    const plugin = wecomBotPlugin({
      bots: [
        { alias: 'bot-a', botId: 'bot-a' },
        { alias: 'bot-b', botId: 'bot-b' },
      ],
      clientFactory: factory,
      handlers: {
        'message.text': async ({ message }) => {
          channels.push(message.channel);
        },
      },
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    const frame = textFrame();
    clients[0]?.emit('message', frame);
    clients[1]?.emit('message', frame);
    // 重复帧应被各自机器人的去重缓存拦截。
    clients[0]?.emit('message', frame);
    await settle();

    expect(channels).toEqual(['wecom.bot.bot-a', 'wecom.bot.bot-b']);
  });

  it('runs exact handlers before wildcard handlers and short-circuits on handled', async () => {
    const { factory, clients } = createFakeFactory();
    const calls: string[] = [];

    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
      handlers: {
        'message.text': () => {
          calls.push('exact');
          return { handled: true };
        },
        '*': () => {
          calls.push('wildcard');
        },
      },
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    clients[0]?.emit('message', textFrame());
    await settle();

    expect(calls).toEqual(['exact']);
  });

  it('deduplicates the same message id within the window', async () => {
    const { factory, clients } = createFakeFactory();
    let count = 0;

    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
      handlers: {
        'message.text': () => {
          count += 1;
        },
      },
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    const frame = textFrame();
    clients[0]?.emit('message', frame);
    await settle();
    clients[0]?.emit('message', frame);
    await settle();

    expect(count).toBe(1);
  });

  it('lazily connects on send, uses the default credentials ref and posts markdown', async () => {
    const { factory, clients } = createFakeFactory();
    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin], maxAttempts: 1 });

    const result = await fengsui.send({
      channel: 'wecom.bot.support',
      action: 'send',
      target: { chatId: 'user-1' },
      content: { markdown: 'hello' },
    });

    expect(result.status).toBe('sent');
    expect(clients[0]?.connectCalls).toBe(1);
    expect(clients[0]?.config.options.secret).toBe('secret-for-wecom/support');
    expect(clients[0]?.sent).toEqual([
      { chatId: 'user-1', body: { msgtype: 'markdown', markdown: { content: 'hello' } } },
    ]);
    expect(plugin.bots.status('support').state).toBe('authenticated');
  });

  it('waits for authentication before sending when connect is asynchronous', async () => {
    const { factory, clients } = createFakeFactory(false);
    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin], maxAttempts: 1 });

    const pending = fengsui.send({
      channel: 'wecom.bot.support',
      action: 'send',
      target: { chatId: 'user-1' },
      content: { markdown: 'hello' },
    });

    await settle();
    expect(clients[0]?.sent).toEqual([]);

    clients[0]?.emit('authenticated');
    const result = await pending;

    expect(result.status).toBe('sent');
    expect(clients[0]?.sent).toHaveLength(1);
  });

  it('sends a template card when channelOptions.card is provided', async () => {
    const { factory, clients } = createFakeFactory();
    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin] });

    const result = await fengsui.send({
      channel: 'wecom.bot.support',
      action: 'send',
      target: { userIds: ['user-1'] },
      content: { text: '卡片' },
      channelOptions: { card: { card_type: 'text_notice', main_title: { title: '通知' } } },
    });

    expect(result.status).toBe('sent');
    expect(clients[0]?.sent[0]?.body).toEqual({
      msgtype: 'template_card',
      template_card: { card_type: 'text_notice', main_title: { title: '通知' } },
    });
  });

  it('maps SDK errcodes to FengsuiError codes', async () => {
    const { factory, clients } = createFakeFactory();
    const plugin = wecomBotPlugin({
      bots: [{ alias: 'support', botId: 'bot-1' }],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin], maxAttempts: 1 });
    await fengsui.start();

    if (clients[0] !== undefined) {
      clients[0].nextFrame = { errcode: 45009, errmsg: 'api freq out of limit' };
    }

    const result = await fengsui.send({
      channel: 'wecom.bot.support',
      action: 'send',
      target: { chatId: 'user-1' },
      content: { markdown: 'hello' },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      errorCode: 'rate_limited',
      retryable: true,
      providerCode: '45009',
    });
  });

  it('disconnects every bot on close and reports stopped state', async () => {
    const { factory, clients } = createFakeFactory();
    const plugin = wecomBotPlugin({
      bots: [
        { alias: 'bot-a', botId: 'bot-a' },
        { alias: 'bot-b', botId: 'bot-b' },
      ],
      clientFactory: factory,
    });
    const fengsui = createInstance({ plugins: [plugin] });
    await fengsui.start();

    expect(plugin.bots.listStatus().map((status) => status.state)).toEqual([
      'authenticated',
      'authenticated',
    ]);

    await fengsui.close();

    expect(clients.map((client) => client.disconnectCalls)).toEqual([1, 1]);
    expect(plugin.bots.listStatus().map((status) => status.state)).toEqual(['stopped', 'stopped']);
  });
});
