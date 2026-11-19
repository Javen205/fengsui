import { describe, expect, it } from 'vitest';

import { FengsuiError, parseEnvelope, validateEnvelopeOrThrow } from '@javen205/fengsui-core';

const validEnvelope = {
  channel: 'email.qq',
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: 'Build finished', text: 'Build #1234 passed' },
  channelOptions: { replyTo: 'ops@example.com' },
  credentialsRef: 'tenant-a/qq-main',
  meta: {
    traceId: 'trace-1',
    idempotencyKey: 'build-1234',
    tags: { env: 'test' },
    tenantId: 'tenant-a',
  },
};

describe('envelope schema', () => {
  it('parses a valid envelope and applies defaults', () => {
    const result = parseEnvelope(validEnvelope);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.channel).toBe('email.qq');
    expect(result.value.version).toBe(1);
    expect(result.value.credentialsRef).toBe('tenant-a/qq-main');
  });

  it('defaults channelOptions to an empty object', () => {
    const { channelOptions: _ignored, ...input } = validEnvelope;
    const result = parseEnvelope(input);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.channelOptions).toEqual({});
  });

  it('allows omitting channel and credentialsRef so configuration can fill them', () => {
    const input = {
      action: 'send',
      content: { text: 'hello' },
    };

    const result = parseEnvelope(input);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.channel).toBeUndefined();
    expect(result.value.credentialsRef).toBeUndefined();
  });

  it('carries meta.projectId for configuration lookup', () => {
    const result = parseEnvelope({ ...validEnvelope, meta: { projectId: 'billing' } });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.meta?.projectId).toBe('billing');
  });

  it('rejects unknown top-level fields', () => {
    const result = parseEnvelope({ ...validEnvelope, extra: true });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects unknown fields inside content', () => {
    const result = parseEnvelope({
      ...validEnvelope,
      content: { text: 'hello', body: 'not allowed' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === 'content')).toBe(true);
  });

  it('supports multi-target arrays', () => {
    const result = parseEnvelope({
      ...validEnvelope,
      target: [{ to: ['a@example.com'] }, { userIds: ['u-1'] }],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects inline secrets in channelOptions', () => {
    const result = parseEnvelope({
      ...validEnvelope,
      channelOptions: { webhookKey: 'super-secret' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const issue = result.issues.find((item) => item.path === 'channelOptions.webhookKey');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('credentialsRef');
  });

  it('rejects credentialsRef without tenant/account form', () => {
    const result = parseEnvelope({ ...validEnvelope, credentialsRef: 'qq-main' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === 'credentialsRef')).toBe(true);
  });

  it('accepts explicit empty cc/bcc arrays alongside non-empty to', () => {
    const result = parseEnvelope({
      ...validEnvelope,
      target: { to: ['ops@example.com'], cc: [], bcc: [] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.target).toMatchObject({
      to: ['ops@example.com'],
      cc: [],
      bcc: [],
    });
  });

  it('validateEnvelopeOrThrow throws FengsuiError with validation details', () => {
    expect(() => validateEnvelopeOrThrow({ action: 'send', channel: 'not-a-channel' })).toThrow(
      FengsuiError,
    );

    try {
      validateEnvelopeOrThrow({ action: 'send', channel: 'not-a-channel' });
    } catch (error) {
      expect(error).toBeInstanceOf(FengsuiError);
      const fengsuiError = error as FengsuiError;
      expect(fengsuiError.code).toBe('validation');
      expect(fengsuiError.retryable).toBe(false);
      expect(Array.isArray(fengsuiError.details)).toBe(true);
    }
  });
});
