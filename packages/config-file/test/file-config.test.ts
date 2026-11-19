import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfigResolver, FengsuiError } from '@javen205/fengsui-core';
import { fileConfig } from '@javen205/fengsui-config-file';

let tempDir: string | undefined;

async function writeConfig(content: unknown): Promise<string> {
  tempDir ??= await mkdtemp(join(tmpdir(), 'fengsui-config-'));
  const path = join(tempDir, 'fengsui.config.json');
  await writeFile(path, JSON.stringify(content, null, 2), 'utf8');
  return path;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('file config provider', () => {
  it('loads a JSON snapshot from disk and resolves defaults', async () => {
    const path = await writeConfig({
      version: 1,
      defaults: {
        channel: 'email.qq',
        credentialsRef: 'tenant/qq-main',
        channelOptions: { from: 'noreply@example.com' },
      },
    });
    const resolver = createConfigResolver(fileConfig({ path }));

    const resolved = await resolver.resolve({});

    expect(resolved).toEqual({
      channel: 'email.qq',
      credentialsRef: 'tenant/qq-main',
      projectId: undefined,
      channelOptions: { from: 'noreply@example.com' },
    });

    await resolver.close();
  });

  it('reports a missing file as a config error', async () => {
    const provider = fileConfig({ path: join(tmpdir(), `fengsui-missing-${Date.now()}.json`) });

    await expect(provider.load()).rejects.toMatchObject({
      name: 'FengsuiError',
      code: 'config',
    });
  });

  it('reports invalid JSON as a config error', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fengsui-config-'));
    const path = join(tempDir, 'broken.json');
    await writeFile(path, '{ not json', 'utf8');

    try {
      await fileConfig({ path }).load();
      throw new Error('Expected load() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(FengsuiError);
      expect((error as FengsuiError).code).toBe('config');
      expect((error as FengsuiError).message).toContain('not valid JSON');
    }
  });

  it('reloads after the file changes when watch is enabled', async () => {
    const path = await writeConfig({
      version: 1,
      defaults: { channel: 'email.qq', credentialsRef: 'tenant/v1' },
    });
    const provider = fileConfig({ path, watch: true, debounceMs: 20 });
    const resolver = createConfigResolver(provider);

    expect((await resolver.resolve({})).credentialsRef).toBe('tenant/v1');

    await writeFile(
      path,
      JSON.stringify({ version: 1, defaults: { channel: 'email.qq', credentialsRef: 'tenant/v2' } }),
      'utf8',
    );

    await vi.waitFor(
      async () => {
        expect((await resolver.resolve({})).credentialsRef).toBe('tenant/v2');
      },
      { timeout: 5_000, interval: 100 },
    );

    await resolver.close();
  });
});
