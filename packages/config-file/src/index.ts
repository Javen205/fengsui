/**
 * JSON 文件配置插件。
 *
 * 把一份 JSON 文件包装成核心的 `ConfigProvider`：
 * - `load()` 每次读取并解析整份文件，核心负责 schema 校验与缓存；
 * - `watch: true` 时监听文件变化，变更后通知核心让缓存失效，下一次发送自动使用新配置；
 * - 读取或解析失败抛出 `FengsuiError(code: 'config')`，由核心 fail-fast 暴露问题。
 *
 * ```ts
 * const fengsui = createFengsui({
 *   credentials: createEnvCredentialResolver(),
 *   config: fileConfig({ path: './fengsui.config.json', watch: true }),
 *   plugins: [emailPlugin()],
 * });
 * ```
 *
 * 其他来源（SQLite / MySQL / Redis）按同样的 `ConfigProvider` 契约实现即可，
 * 核心与适配器都不需要改动。
 */
import { watch as watchFile, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { FengsuiError, type ConfigProvider } from '@javen205/fengsui-core';

/** 文件配置来源选项。 */
export interface FileConfigOptions {
  /** 配置文件路径；相对路径按 `process.cwd()` 解析。 */
  path: string;
  /** 是否监听文件变化并让核心缓存失效，默认 `false`。 */
  watch?: boolean;
  /** 文件变化防抖时间（毫秒），默认 100，避免编辑器多次写入触发重复加载。 */
  debounceMs?: number;
}

/** 默认防抖时间。 */
const DEFAULT_DEBOUNCE_MS = 100;

/**
 * 创建一个 JSON 文件配置来源。
 *
 * @param options 文件路径与监听策略。
 * @returns 可直接传给 `createFengsui({ config })` 的 Provider。
 */
export function fileConfig(options: FileConfigOptions): ConfigProvider {
  const filePath = isAbsolute(options.path) ? options.path : resolve(process.cwd(), options.path);
  const listeners = new Set<() => void>();

  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stopWatching(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    watcher?.close();
    watcher = undefined;
  }

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function startWatching(): void {
    if (watcher !== undefined) {
      return;
    }
    try {
      watcher = watchFile(filePath, { persistent: false }, () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = undefined;
          notify();
        }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      });
      // 监听错误不应让进程崩溃：下一次 load() 仍会按缓存 TTL 重新读取。
      watcher.on('error', () => {
        stopWatching();
      });
      watcher.unref();
    } catch {
      // 文件暂不存在等场景：退化为仅按 TTL 重新读取，不阻断发送。
      watcher = undefined;
    }
  }

  return {
    name: `file:${filePath}`,

    async load(): Promise<unknown> {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        throw new FengsuiError({
          code: 'config',
          message: `Failed to read config file "${filePath}"`,
          retryable: false,
          cause: error,
          details: { path: filePath },
        });
      }

      try {
        return JSON.parse(raw) as unknown;
      } catch (error) {
        throw new FengsuiError({
          code: 'config',
          message: `Config file "${filePath}" is not valid JSON`,
          retryable: false,
          cause: error,
          details: { path: filePath },
        });
      }
    },

    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      if (options.watch === true) {
        startWatching();
      }

      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          stopWatching();
        }
      };
    },

    async close(): Promise<void> {
      listeners.clear();
      stopWatching();
    },
  };
}
