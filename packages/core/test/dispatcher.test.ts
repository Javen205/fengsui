import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  clearAdapters,
  dispatchEnvelope,
  FengsuiError,
  InMemoryIdempotencyStore,
  registerAdapter,
  type DispatchOptions,
} from '@javen205/fengsui-core';
import { createFakeAdapter, staticCredentials, unusedHttpClient } from './helpers/fake-adapter';

const baseEnvelope = {
  channel: 'email.qq',
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: 'Build finished', text: 'Build #1234 passed' },
  channelOptions: {},
  credentialsRef: 'tenant-a/qq-main',
};

function dispatch(input: unknown, overrides: Partial<DispatchOptions> = {}) {
  return dispatchEnvelope(input, {
    http: unusedHttpClient,
    credentials: staticCredentials,
    ...overrides,
  });
}

async function captureError(promise: Promise<unknown>): Promise<FengsuiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FengsuiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected dispatchEnvelope to throw');
}

describe('dispatcher', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('sends directly to a single target', async () => {
    const { adapter } = createFakeAdapter();
    registerAdapter(adapter);

    const receipt = await dispatch(baseEnvelope);

    expect(receipt.status).toBe('sent');
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.dryRun).toBe(false);
    expect(receipt.summary).toEqual({ total: 1, sent: 1, failed: 0, skipped: 0, status: 'sent' });
    expect(receipt.results[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('reports an unknown channel with a close suggestion', async () => {
    const { adapter } = createFakeAdapter({ id: 'email.qq' });
    registerAdapter(adapter);

    const error = await captureError(dispatch({ ...baseEnvelope, channel: 'email.qqq' }));

    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('email.qq');
    expect(error.details).toMatchObject({ suggestions: ['email.qq'] });
  });

  it('rejects invalid channelOptions with validation details', async () => {
    const { adapter } = createFakeAdapter({
      schema: z.object({ replyTo: z.string().min(10) }).strict(),
    });
    registerAdapter(adapter);

    const error = await captureError(
      dispatch({ ...baseEnvelope, channelOptions: { replyTo: 'short' } }),
    );

    expect(error.code).toBe('validation');
    expect(error.channel).toBe('email.qq');
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'replyTo', message: expect.stringContaining('Too small') }),
    ]);
  });

  it('rejects an unsupported content kind when no fallback is declared', async () => {
    const { adapter } = createFakeAdapter({ capabilities: { messageKinds: ['text'] } });
    registerAdapter(adapter);

    const error = await captureError(
      dispatch({ ...baseEnvelope, content: { html: '<b>hello</b>' } }),
    );

    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('html');
    expect(error.details).toMatchObject({ kind: 'html', supportedKinds: ['text'] });
  });

  it('degrades content when the adapter declares a fallback', async () => {
    const { adapter, state } = createFakeAdapter({
      capabilities: { messageKinds: ['text', 'markdown'] },
      fallbacks: { html: ['markdown', 'text'] },
    });
    registerAdapter(adapter);

    const receipt = await dispatch({
      ...baseEnvelope,
      content: { html: '<b>hello</b> world' },
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.degraded).toBe(true);
    expect(receipt.results[0]).toMatchObject({
      status: 'sent',
      degradedFrom: 'html',
      degradedTo: 'markdown',
    });

    const message = state.messages[0];
    expect(message?.degradedFrom).toBe('html');
    expect(message?.degradedTo).toBe('markdown');
    expect(message?.content.html).toBeUndefined();
    expect(message?.content.markdown).toContain('hello');
  });

  it('retries a retryable failure twice and then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];

    const { adapter } = createFakeAdapter({
      onSend: async () => {
        calls += 1;
        if (calls < 3) {
          throw new FengsuiError({ code: 'network', message: 'temporary network error' });
        }
        return { providerMessageId: 'ok-1' };
      },
    });
    registerAdapter(adapter);

    const receipt = await dispatch(baseEnvelope, {
      maxAttempts: 3,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.results[0]).toMatchObject({ status: 'sent', attempts: 3 });
    expect(sleeps).toEqual([100, 200]);
    expect(sleeps.reduce((total, delay) => total + delay, 0)).toBe(300);
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    const sleeps: number[] = [];
    const { adapter, state } = createFakeAdapter({
      onSend: async () => {
        throw new FengsuiError({ code: 'auth', message: 'invalid credentials' });
      },
    });
    registerAdapter(adapter);

    const receipt = await dispatch(baseEnvelope, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(state.sendCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      errorCode: 'auth',
      retryable: false,
    });
    expect(receipt.error).toMatchObject({ code: 'auth', retryable: false });
  });

  it('retries on timeout and finally fails', async () => {
    const sleeps: number[] = [];
    const { adapter, state } = createFakeAdapter({
      onSend: () => new Promise(() => undefined),
    });
    registerAdapter(adapter);

    const receipt = await dispatch(baseEnvelope, {
      maxAttempts: 2,
      attemptTimeoutMs: 10,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(state.sendCalls).toBe(2);
    expect(sleeps).toEqual([0]);
    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      errorCode: 'network',
      retryable: true,
    });
    expect(receipt.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('fans out to multiple targets and reports partial success', async () => {
    const { adapter } = createFakeAdapter({
      onSend: async (message) => {
        const to = message.target?.to?.[0];
        if (to === 'bad@example.com') {
          throw new FengsuiError({ code: 'auth', message: 'recipient rejected' });
        }
        return { providerMessageId: `ok-${to ?? 'unknown'}` };
      },
    });
    registerAdapter(adapter);

    const receipt = await dispatch({
      ...baseEnvelope,
      target: [{ to: ['good@example.com'] }, { to: ['bad@example.com'] }],
    });

    expect(receipt.status).toBe('partial');
    expect(receipt.summary).toEqual({
      total: 2,
      sent: 1,
      failed: 1,
      skipped: 0,
      status: 'partial',
    });
    expect(receipt.results.map((result) => result.status)).toEqual(['sent', 'failed']);
    expect(receipt.results[0]?.providerMessageId).toBe('ok-good@example.com');
    expect(receipt.results[1]?.errorCode).toBe('auth');
  });

  it('returns the first receipt for a duplicated idempotency key', async () => {
    const store = new InMemoryIdempotencyStore();
    const { adapter, state } = createFakeAdapter({
      onSend: async () => ({ providerMessageId: 'first-receipt' }),
    });
    registerAdapter(adapter);

    const envelope = { ...baseEnvelope, meta: { idempotencyKey: 'build-1' } };
    const options = { idempotencyStore: store };

    const first = await dispatch(envelope, options);
    const second = await dispatch(envelope, options);

    expect(state.sendCalls).toBe(1);
    expect(second.deduplicated).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.results[0]?.providerMessageId).toBe('first-receipt');
  });

  it('does not call the adapter in dry-run mode', async () => {
    const { adapter, state } = createFakeAdapter();
    registerAdapter(adapter);

    const receipt = await dispatch(baseEnvelope, { dryRun: true });

    expect(state.sendCalls).toBe(0);
    expect(state.normalizeCalls).toBe(0);
    expect(receipt.status).toBe('skipped');
    expect(receipt.dryRun).toBe(true);
    expect(receipt.summary).toEqual({
      total: 1,
      sent: 0,
      failed: 0,
      skipped: 1,
      status: 'skipped',
    });
    expect(receipt.results[0]).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('dry-run'),
    });
  });

  it('honors dry-run declared in envelope meta options', async () => {
    const { adapter, state } = createFakeAdapter();
    registerAdapter(adapter);

    const receipt = await dispatch({ ...baseEnvelope, meta: { options: { dryRun: true } } });

    expect(state.sendCalls).toBe(0);
    expect(receipt.status).toBe('skipped');
  });
});
