import { describe, expect, it } from 'vitest';

import { createEnvCredentialResolver, FengsuiError, toCredentialEnvKey } from '../src/core';

describe('EnvCredentialResolver', () => {
  it('maps a credentialsRef to an environment variable name', () => {
    expect(toCredentialEnvKey('tenant-a/qq-main')).toBe('FENGSUI_CRED_TENANT_A_QQ_MAIN');
    expect(toCredentialEnvKey('tenant.a/qq_main', 'CUSTOM_')).toBe('CUSTOM_TENANT_A_QQ_MAIN');
  });

  it('resolves JSON object values from the environment', async () => {
    const resolver = createEnvCredentialResolver({
      env: { FENGSUI_CRED_TENANT_A_QQ_MAIN: '{"user":"ops@example.com","password":"secret"}' },
    });

    const credential = await resolver.resolve('tenant-a/qq-main');

    expect(credential.ref).toBe('tenant-a/qq-main');
    expect(credential.values).toEqual({ user: 'ops@example.com', password: 'secret' });
  });

  it('wraps a plain environment value as a single secret', async () => {
    const resolver = createEnvCredentialResolver({
      env: { FENGSUI_CRED_TENANT_A_QQ_MAIN: 'plain-secret' },
    });

    const credential = await resolver.resolve('tenant-a/qq-main');

    expect(credential.values).toEqual({ value: 'plain-secret' });
  });

  it('throws a credentials error without leaking other secrets', async () => {
    const resolver = createEnvCredentialResolver({
      env: { FENGSUI_CRED_TENANT_A_QQ_MAIN: 'do-not-leak' },
    });

    try {
      await resolver.resolve('tenant-b/other');
      throw new Error('Expected resolve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FengsuiError);
      const fengsuiError = error as FengsuiError;
      expect(fengsuiError.code).toBe('credentials');
      expect(fengsuiError.message).toContain('FENGSUI_CRED_TENANT_B_OTHER');
      expect(fengsuiError.message).not.toContain('do-not-leak');
    }
  });
});
