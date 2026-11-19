import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAdapters,
  createConfigResolver,
  dispatchEnvelope,
  FengsuiError,
  registerAdapter,
  type ConfigProvider,
  type ConfigSnapshot,
} from '@javen205/fengsui-core';

import { createFakeAdapter, staticCredentials } from './helpers/fake-adapter';

/** 内存 Provider：统计加载次数，便于断言缓存行为。 */
function memoryProvider(snapshot: unknown): {
  provider: ConfigProvider;
  loads: () => number;
} {
  let loadCount = 0;
  return {
    provider: {
      name: 'memory',
      async load() {
        loadCount += 1;
        return structuredClone(snapshot);
      },
    },
    loads: () => loadCount,
  };
}

const snapshot: ConfigSnapshot = {
  version: 1,
  defaults: {
    channel: 'email.qq',
    credentialsRef: 'default/main',
    channelOptions: {
      timeoutMs: 10_000,
      headers: { 'X-Env': 'default' },
    },
  },
  projects: {
    billing: {
      credentialsRef: 'billing/main',
      channelOptions: {
        from: 'billing@example.com',
        headers: { 'X-App': 'billing' },
      },
      channels: {
        'email.qq': {
          credentialsRef: 'billing/qq',
          channelOptions: { timeoutMs: 5_000 },
        },
      },
    },
  },
};

async function captureError(promise: Promise<unknown>): Promise<FengsuiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FengsuiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the promise to reject with FengsuiError');
}

describe('config resolver', () => {
  it('merges defaults, project and channel layers with envelope overrides', async () => {
    const { provider } = memoryProvider(snapshot);
    const resolver = createConfigResolver(provider);

    const resolved = await resolver.resolve({
      projectId: 'billing',
      channelOptions: { replyTo: 'ops@example.com', headers: { 'X-Trace': 'trace-1' } },
    });

    expect(resolved).toEqual({
      channel: 'email.qq',
      credentialsRef: 'billing/qq',
      projectId: 'billing',
      channelOptions: {
        timeoutMs: 5_000,
        from: 'billing@example.com',
        replyTo: 'ops@example.com',
        headers: {
          'X-Env': 'default',
          'X-App': 'billing',
          'X-Trace': 'trace-1',
        },
      },
    });
  });

  it('uses envelope channel and credentialsRef as the highest priority', async () => {
    const { provider } = memoryProvider(snapshot);
    const resolver = createConfigResolver(provider);

    const resolved = await resolver.resolve({
      channel: 'email.163',
      credentialsRef: 'override/main',
    });

    expect(resolved.channel).toBe('email.163');
    expect(resolved.credentialsRef).toBe('override/main');
  });

  it('follows the extends chain from root to child', async () => {
    const { provider } = memoryProvider({
      version: 1,
      projects: {
        base: {
          channel: 'email.qq',
          credentialsRef: 'base/main',
          channelOptions: { timeoutMs: 8_000, from: 'base@example.com' },
        },
        child: {
          extends: 'base',
          channelOptions: { timeoutMs: 3_000 },
        },
      },
    });
    const resolver = createConfigResolver(provider);

    const resolved = await resolver.resolve({ projectId: 'child' });

    expect(resolved.channel).toBe('email.qq');
    expect(resolved.credentialsRef).toBe('base/main');
    expect(resolved.channelOptions).toEqual({ timeoutMs: 3_000, from: 'base@example.com' });
  });

  it('rejects cyclic project inheritance', async () => {
    const { provider } = memoryProvider({
      version: 1,
      projects: {
        a: { extends: 'b' },
        b: { extends: 'a' },
      },
    });
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({ projectId: 'a' }));

    expect(error.code).toBe('config');
    expect(error.message).toContain('Cyclic');
  });

  it('rejects unknown projects by default and can be relaxed', async () => {
    const { provider } = memoryProvider(snapshot);
    const strict = createConfigResolver(provider);

    const error = await captureError(strict.resolve({ projectId: 'missing' }));
    expect(error.code).toBe('config');
    expect(error.message).toContain('missing');

    const relaxed = createConfigResolver(provider, { strictProject: false });
    const resolved = await relaxed.resolve({
      projectId: 'missing',
      channel: 'email.qq',
      credentialsRef: 'fallback/main',
    });
    expect(resolved.credentialsRef).toBe('fallback/main');
    expect(resolved.channelOptions).toEqual({
      timeoutMs: 10_000,
      headers: { 'X-Env': 'default' },
    });
  });

  it('fails with validation when channel cannot be resolved', async () => {
    const { provider } = memoryProvider({ version: 1 });
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({}));

    expect(error.code).toBe('validation');
    expect(error.message).toContain('channel');
  });

  it('fails with validation when credentialsRef cannot be resolved', async () => {
    const { provider } = memoryProvider({ version: 1, defaults: { channel: 'email.qq' } });
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({}));

    expect(error.code).toBe('validation');
    expect(error.message).toContain('credentialsRef');
  });

  it('fails fast when the provider cannot load', async () => {
    const provider: ConfigProvider = {
      name: 'broken',
      async load() {
        throw new Error('disk unavailable');
      },
    };
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({}));

    expect(error.code).toBe('config');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('disk unavailable');
  });

  it('rejects an invalid snapshot', async () => {
    const { provider } = memoryProvider({ version: 1, defaults: { channel: 'EMAIL' } });
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({}));

    expect(error.code).toBe('config');
    expect(error.message).toContain('channel');
  });

  it('rejects inline secrets anywhere in the configuration', async () => {
    const { provider } = memoryProvider({
      version: 1,
      defaults: { channelOptions: { transport: { password: 'smtp-secret' } } },
    });
    const resolver = createConfigResolver(provider);

    const error = await captureError(resolver.resolve({}));

    expect(error.code).toBe('config');
    expect(error.message).toContain('credentialsRef');
    expect(JSON.stringify(error.details)).toContain('channelOptions.transport.password');
  });

  it('caches snapshots until the TTL expires or the cache is invalidated', async () => {
    const { provider, loads } = memoryProvider(snapshot);
    const resolver = createConfigResolver(provider);

    await resolver.resolve({});
    await resolver.resolve({});
    expect(loads()).toBe(1);

    resolver.invalidate();
    await resolver.resolve({});
    expect(loads()).toBe(2);

    const uncached = createConfigResolver(provider, { cacheTtlMs: 0 });
    await uncached.resolve({});
    await uncached.resolve({});
    expect(loads()).toBe(4);
  });

  it('invalidates the cache when the provider reports a change', async () => {
    let notify: (() => void) | undefined;
    let version = 'v1';
    const provider: ConfigProvider = {
      name: 'memory',
      async load() {
        return { version: 1, defaults: { channel: 'email.qq', credentialsRef: `tenant/${version}` } };
      },
      subscribe(onChange) {
        notify = onChange;
        return () => {
          notify = undefined;
        };
      },
    };
    const resolver = createConfigResolver(provider);

    expect((await resolver.resolve({})).credentialsRef).toBe('tenant/v1');
    version = 'v2';
    notify?.();
    expect((await resolver.resolve({})).credentialsRef).toBe('tenant/v2');
  });
});

describe('dispatcher with configuration', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('sends with only business fields when configuration provides the rest', async () => {
    const { adapter, state } = createFakeAdapter();
    registerAdapter(adapter);
    const { provider } = memoryProvider(snapshot);
    const config = createConfigResolver(provider);

    const receipt = await dispatchEnvelope(
      {
        action: 'send',
        target: { to: ['ops@example.com'] },
        content: { text: 'hello' },
        meta: { projectId: 'billing' },
      },
      { credentials: staticCredentials, config },
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.channel).toBe('email.qq');
    expect(state.messages[0]?.credentialsRef).toBe('billing/qq');
    expect(state.messages[0]?.options).toMatchObject({
      timeoutMs: 5_000,
      from: 'billing@example.com',
    });
  });

  it('requires channel and credentialsRef when no configuration is injected', async () => {
    const { adapter } = createFakeAdapter();
    registerAdapter(adapter);

    const error = await captureError(
      dispatchEnvelope(
        { action: 'send', content: { text: 'hello' } },
        { credentials: staticCredentials },
      ),
    );

    expect(error.code).toBe('validation');
    expect(error.message).toContain('channel');
  });

  it('requires credentialsRef when configuration only provides the channel', async () => {
    const { adapter } = createFakeAdapter();
    registerAdapter(adapter);
    const { provider } = memoryProvider({ version: 1, defaults: { channel: 'email.qq' } });

    const error = await captureError(
      dispatchEnvelope(
        { action: 'send', content: { text: 'hello' } },
        { credentials: staticCredentials, config: createConfigResolver(provider) },
      ),
    );

    expect(error.code).toBe('validation');
    expect(error.message).toContain('credentialsRef');
  });
});
