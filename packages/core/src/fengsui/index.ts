import { randomUUID } from 'node:crypto';

import type { HttpClient } from '@javen205/fengsui-http';

import type { AdapterContext, CredentialResolver, HealthStatus } from '../adapter';
import type { ChannelCapabilities } from '../capabilities';
import {
  createConfigResolver,
  type ConfigProvider,
  type ConfigResolver,
  type ConfigResolverOptions,
} from '../config';
import { dispatchEnvelope, type DispatchOptions, type DispatchResult } from '../dispatcher';
import { FengsuiError } from '../errors';
import type { IdempotencyStore } from '../idempotency';
import { silentLogger, type Logger } from '../logger';
import type { FengsuiPlugin, PluginContext } from '../plugin';
import { createAdapterRegistry, type AdapterRegistry } from '../registry';

export interface FengsuiConfig {
  credentials: CredentialResolver;
  /** Required only by adapters that perform HTTP requests. */
  http?: HttpClient;
  /**
   * 可选配置来源插件（如 `@javen205/fengsui-config-file` 的 `fileConfig()`）。
   *
   * 注入后，信封可以省略 `channel` / `credentialsRef`，由配置提供默认值；
   * `channelOptions` 会按「配置默认值 → 信封显式值」深合并。
   */
  config?: ConfigProvider;
  /** 配置解析策略：缓存时间、项目严格模式、默认项目。 */
  configOptions?: ConfigResolverOptions;
  logger?: Logger;
  idempotencyStore?: IdempotencyStore;
  plugins?: ReadonlyArray<FengsuiPlugin>;
  /** Total attempts per target, including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Per-attempt timeout. Defaults to 15000ms. */
  attemptTimeoutMs?: number;
}

export interface FengsuiSendOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface FengsuiHealthCheckOptions {
  signal?: AbortSignal;
  /** Credential ref used when the adapter was registered without a default one. */
  credentialsRef?: string;
}

export interface ChannelView {
  id: string;
  capabilities: ChannelCapabilities;
}

export interface Fengsui {
  readonly registry: AdapterRegistry;
  send(input: unknown, options?: FengsuiSendOptions): Promise<DispatchResult>;
  healthCheck(channelId: string, options?: FengsuiHealthCheckOptions): Promise<HealthStatus>;
  listChannels(): ReadonlyArray<ChannelView>;
  /**
   * 启动需要长连接的插件（如企业微信机器人）。
   *
   * 纯发送场景可以省略；发送类适配器会在首次 `send()` 时自行懒连接。
   * 可重复调用，插件应保证幂等。
   */
  start(): Promise<void>;
  /** 停止插件（逆序）并释放配置 Provider 等资源。 */
  close(): Promise<void>;
}

/**
 * Creates an isolated fengsui instance.
 * Channels come exclusively from plugins, so the core stays free of any
 * provider-specific dependency.
 */
export function createFengsui(config: FengsuiConfig): Fengsui {
  const registry = createAdapterRegistry();
  const logger = config.logger ?? silentLogger;
  const configResolver: ConfigResolver | undefined =
    config.config === undefined
      ? undefined
      : createConfigResolver(config.config, config.configOptions);

  const pluginContext: PluginContext = {
    adapters: registry,
    credentials: config.credentials,
    logger,
    ...(config.http !== undefined ? { http: config.http } : {}),
    ...(configResolver !== undefined ? { config: configResolver } : {}),
  };

  const plugins = config.plugins ?? [];
  for (const plugin of plugins) {
    plugin.register(pluginContext);
  }

  return {
    registry,
    send(input, options = {}) {
      const dispatchOptions: DispatchOptions = {
        credentials: config.credentials,
        registry,
        logger,
        ...(config.http !== undefined ? { http: config.http } : {}),
        ...(configResolver !== undefined ? { config: configResolver } : {}),
        ...(config.idempotencyStore !== undefined
          ? { idempotencyStore: config.idempotencyStore }
          : {}),
        ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
        ...(config.attemptTimeoutMs !== undefined
          ? { attemptTimeoutMs: config.attemptTimeoutMs }
          : {}),
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };

      return dispatchEnvelope(input, dispatchOptions);
    },

    async healthCheck(channelId, options = {}) {
      const adapter = registry.get(channelId);
      if (adapter.healthCheck === undefined) {
        throw new FengsuiError({
          code: 'unsupported',
          message: `Adapter "${channelId}" does not implement healthCheck`,
          channel: channelId,
        });
      }

      const context: AdapterContext = {
        credentials: config.credentials,
        logger,
        signal: options.signal ?? new AbortController().signal,
        traceId: randomUUID(),
        tenantId: options.credentialsRef?.split('/')[0] ?? '',
        ...(config.http !== undefined ? { http: config.http } : {}),
        ...(options.credentialsRef !== undefined
          ? { credentialsRef: options.credentialsRef }
          : adapter.defaultCredentialsRef !== undefined
            ? { credentialsRef: adapter.defaultCredentialsRef }
            : {}),
      };

      return adapter.healthCheck(context);
    },

    listChannels() {
      return registry
        .list()
        .map((adapter) => ({ id: adapter.id, capabilities: adapter.capabilities() }));
    },

    async start() {
      for (const plugin of plugins) {
        await plugin.start?.(pluginContext);
      }
    },

    async close() {
      for (let index = plugins.length - 1; index >= 0; index -= 1) {
        await plugins[index]?.stop?.(pluginContext);
      }
      await configResolver?.close();
    },
  };
}
