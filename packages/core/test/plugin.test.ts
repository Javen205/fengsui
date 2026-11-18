import { describe, expect, it } from 'vitest';

import {
  createFengsui,
  FengsuiError,
  type AdapterContext,
  type ChannelAdapter,
  type FengsuiPlugin,
} from '@fengsui/core';

import { createFakeAdapter, staticCredentials } from './helpers/fake-adapter';

const envelope = {
  channel: 'email.qq',
  action: 'send',
  credentialsRef: 'test/main',
  target: { to: ['ops@example.com'] },
  content: { text: 'hello' },
};

describe('plugin model', () => {
  it('registers adapters from plugins and sends through them', async () => {
    const { adapter, state } = createFakeAdapter();
    const plugin: FengsuiPlugin = {
      name: 'fake',
      register({ adapters }) {
        adapters.register(adapter);
      },
    };

    const fengsui = createFengsui({ credentials: staticCredentials, plugins: [plugin] });

    expect(fengsui.registry.has('email.qq')).toBe(true);
    expect(fengsui.listChannels().map((channel) => channel.id)).toEqual(['email.qq']);

    const result = await fengsui.send(envelope);

    expect(result.status).toBe('sent');
    expect(state.sendCalls).toBe(1);
  });

  it('keeps registries isolated between instances', () => {
    const first = createFakeAdapter({ id: 'email.qq' });
    const second = createFakeAdapter({ id: 'sms.aliyun' });

    const fengsuiA = createFengsui({
      credentials: staticCredentials,
      plugins: [{ name: 'a', register: ({ adapters }) => adapters.register(first.adapter) }],
    });
    const fengsuiB = createFengsui({
      credentials: staticCredentials,
      plugins: [{ name: 'b', register: ({ adapters }) => adapters.register(second.adapter) }],
    });

    expect(fengsuiA.registry.has('email.qq')).toBe(true);
    expect(fengsuiA.registry.has('sms.aliyun')).toBe(false);
    expect(fengsuiB.registry.has('sms.aliyun')).toBe(true);
  });

  it('sends without an HttpClient because http is optional', async () => {
    const { adapter, state } = createFakeAdapter();
    const fengsui = createFengsui({
      credentials: staticCredentials,
      plugins: [{ name: 'fake', register: ({ adapters }) => adapters.register(adapter) }],
    });

    await fengsui.send(envelope);

    expect(state.contexts[0]?.http).toBeUndefined();
  });

  it('forwards credentialsRef to the adapter context on healthCheck', async () => {
    const { adapter } = createFakeAdapter();
    let captured: AdapterContext | undefined;
    const withHealthCheck: ChannelAdapter = {
      ...adapter,
      healthCheck: async (ctx) => {
        captured = ctx;
        return { ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 };
      },
    };

    const fengsui = createFengsui({
      credentials: staticCredentials,
      plugins: [{ name: 'fake', register: ({ adapters }) => adapters.register(withHealthCheck) }],
    });

    const status = await fengsui.healthCheck('email.qq', { credentialsRef: 'qq/main' });

    expect(status.ok).toBe(true);
    expect(captured?.credentialsRef).toBe('qq/main');
    expect(captured?.tenantId).toBe('qq');
  });

  it('throws a FengsuiError when the adapter has no healthCheck', async () => {
    const { adapter } = createFakeAdapter();
    const fengsui = createFengsui({
      credentials: staticCredentials,
      plugins: [{ name: 'fake', register: ({ adapters }) => adapters.register(adapter) }],
    });

    await expect(fengsui.healthCheck('email.qq')).rejects.toBeInstanceOf(FengsuiError);
  });
});
