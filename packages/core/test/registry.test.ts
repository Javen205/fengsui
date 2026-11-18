import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAdapters,
  getAdapter,
  listAdapters,
  registerAdapter,
  suggestAdapterIds,
} from '@fengsui/core';
import { createFakeAdapter } from './helpers/fake-adapter';

describe('adapter registry', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('registers adapters and lists them by domain', () => {
    registerAdapter(createFakeAdapter({ id: 'email.qq' }).adapter);
    registerAdapter(createFakeAdapter({ id: 'im.feishu.robot' }).adapter);

    expect(getAdapter('email.qq').id).toBe('email.qq');
    expect(listAdapters().map((adapter) => adapter.id)).toEqual(['email.qq', 'im.feishu.robot']);
    expect(listAdapters({ domain: 'email' }).map((adapter) => adapter.id)).toEqual(['email.qq']);
    expect(listAdapters({ domain: 'sms' })).toEqual([]);
  });

  it('rejects duplicate adapter ids', () => {
    registerAdapter(createFakeAdapter({ id: 'email.qq' }).adapter);

    expect(() => registerAdapter(createFakeAdapter({ id: 'email.qq' }).adapter)).toThrow(
      /already registered/,
    );
  });

  it('suggests close adapter ids', () => {
    registerAdapter(createFakeAdapter({ id: 'email.qq' }).adapter);
    registerAdapter(createFakeAdapter({ id: 'im.feishu.robot' }).adapter);

    expect(suggestAdapterIds('email.qqq')).toEqual(['email.qq']);
    expect(suggestAdapterIds('unknown-channel')).toEqual([]);
  });
});
