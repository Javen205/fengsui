import type { HttpClient } from '@fengsui/http';

import type { CredentialResolver } from '../adapter';
import type { ConfigResolver } from '../config';
import type { Logger } from '../logger';
import type { AdapterRegistry } from '../registry';

/**
 * 插件初始化上下文。
 *
 * `register()` 阶段使用 `adapters` 注册渠道；`start()` / `stop()` 阶段
 * 还可以使用凭证、日志与配置解析器建立或释放长连接。
 */
export interface PluginContext {
  /** 当前 `createFengsui()` 实例独占的渠道注册表。 */
  readonly adapters: AdapterRegistry;
  /** 凭证解析器，供需要建连的插件在 `start()` 中解析 secret。 */
  readonly credentials: CredentialResolver;
  /** 实例级日志器。 */
  readonly logger: Logger;
  /** HTTP 传输，仅需要发起 HTTP 请求的插件使用。 */
  readonly http?: HttpClient | undefined;
  /** 配置解析器，插件可据此读取默认值。 */
  readonly config?: ConfigResolver | undefined;
}

/**
 * 插件契约。
 *
 * 生命周期：
 * 1. `createFengsui()` 同步调用 `register()`，插件只注册渠道，不产生 IO；
 * 2. `fengsui.start()` 依次调用 `start()`，需要长连接的插件在这里建连；
 * 3. `fengsui.close()` 逆序调用 `stop()`，释放连接与订阅。
 *
 * 发送类插件可以不实现 `start/stop`，由适配器在首次 `send()` 时懒连接。
 */
export interface FengsuiPlugin {
  readonly name: string;
  register(context: PluginContext): void;
  start?(context: PluginContext): void | Promise<void>;
  stop?(context: PluginContext): void | Promise<void>;
}

export function definePlugin(plugin: FengsuiPlugin): FengsuiPlugin {
  return plugin;
}
