/**
 * 配置插件的公共契约。
 *
 * 设计目标：发送一条消息时，业务方只需要描述「发给谁、发什么」，
 * 渠道、凭证引用、渠道选项（如发件人、超时）等都可以由配置提供默认值。
 *
 * 关键取舍：
 * - **整份快照**：Provider 每次 `load()` 返回完整配置，而不是按 key 查询。
 *   这样核心可以做严格的 schema 校验、层级合并与缓存，Provider 只负责「取数据」。
 * - **来源无关**：文件、SQLite、MySQL、Redis、配置中心都实现同一个 `ConfigProvider`，
 *   核心不感知来源；本轮只提供 `@fengsui/config-file`。
 * - **凭证不进配置**：配置只能写 `credentialsRef`，密钥仍由 `CredentialResolver`
 *   从环境变量、Vault 等安全来源解析。
 */

/**
 * 单个渠道的默认值，写在 `channels.<channelId>` 下。
 *
 * 渠道级配置只对指定渠道生效，优先级高于同层的通用 `credentialsRef` /
 * `channelOptions`。
 */
export interface ConfigChannelDefaults {
  /** 该渠道默认使用的凭证引用，形如 `tenant/account`。 */
  credentialsRef?: string | undefined;
  /** 该渠道的默认 `channelOptions`，最终会与信封里的同名对象深合并。 */
  channelOptions?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * 一层配置（全局默认、项目或项目继承链中的某一层）。
 *
 * 字段含义：
 * - `channel`：默认渠道 ID，如 `email.qq`；
 * - `credentialsRef`：默认凭证引用；
 * - `channelOptions`：默认渠道选项；
 * - `channels`：按渠道覆盖上面的默认值。
 *
 * 同一层内，`channels.<id>` 的优先级高于本层的 `credentialsRef` /
 * `channelOptions`；层与层之间，越靠近项目的层优先级越高。
 */
export interface ConfigLayer {
  /** 默认渠道 ID，形如 `email.qq`。 */
  channel?: string | undefined;
  /** 默认凭证引用，形如 `tenant/account`。 */
  credentialsRef?: string | undefined;
  /** 默认渠道选项。 */
  channelOptions?: Readonly<Record<string, unknown>> | undefined;
  /** 按渠道覆盖默认值。 */
  channels?: Readonly<Record<string, ConfigChannelDefaults>> | undefined;
}

/**
 * 一个项目（租户/业务线）的配置，支持通过 `extends` 复用父项目。
 *
 * 继承链按「从根到当前项目」的顺序合并，当前项目优先级最高。
 */
export interface ConfigProject extends ConfigLayer {
  /** 父项目 ID；形成环时配置加载会直接失败。 */
  extends?: string | undefined;
}

/**
 * 配置快照。
 *
 * ```json
 * {
 *   "version": 1,
 *   "defaults": { "channel": "email.qq", "channelOptions": { "timeoutMs": 10000 } },
 *   "projects": {
 *     "billing": {
 *       "credentialsRef": "billing/qq-main",
 *       "channelOptions": { "from": "noreply@example.com" }
 *     },
 *     "billing-test": {
 *       "extends": "billing",
 *       "channels": { "email.qq": { "credentialsRef": "billing/qq-test" } }
 *     }
 *   }
 * }
 * ```
 */
export interface ConfigSnapshot {
  /** 配置格式版本，目前固定为 1；省略时按 1 处理。 */
  version?: 1 | undefined;
  /** 全局默认值，优先级最低。 */
  defaults?: ConfigLayer | undefined;
  /** 项目配置，按 ID 索引；发送时用 `meta.projectId` 选择。 */
  projects?: Readonly<Record<string, ConfigProject>> | undefined;
}

/**
 * 配置来源插件。
 *
 * 实现方只需负责「取数据」：返回任意 JSON 值，由核心用 schema 校验。
 * 文件、数据库、配置中心都按这个接口接入，互不影响。
 */
export interface ConfigProvider {
  /** 来源名称，用于日志与错误信息，如 `file:/etc/fengsui.json`。 */
  readonly name: string;

  /**
   * 加载完整配置快照。
   *
   * 返回值可以是任意 JSON 值（通常是对象），核心会做严格校验；
   * 读取失败时应抛错，核心会包装成 `FengsuiError(code: 'config')` 并 fail-fast。
   */
  load(): Promise<unknown>;

  /**
   * 可选的变更订阅。
   *
   * 核心收到通知后会立即清空缓存，下一次 `send()` 重新 `load()`。
   * @returns 取消订阅函数。
   */
  subscribe?(onChange: () => void): () => void;

  /** 释放底层资源（文件监听、数据库连接等）。 */
  close?(): Promise<void>;
}

/** `ConfigResolver.resolve()` 的输入：信封中可能与配置相关的字段。 */
export interface ConfigResolveInput {
  /** 项目 ID，来自 `meta.projectId`；省略时使用解析器的 `defaultProjectId`。 */
  projectId?: string | undefined;
  /** 信封显式指定的渠道；优先级最高。 */
  channel?: string | undefined;
  /** 信封显式指定的凭证引用；优先级最高。 */
  credentialsRef?: string | undefined;
  /** 信封显式指定的渠道选项；会在配置默认值之上深合并。 */
  channelOptions?: Readonly<Record<string, unknown>> | undefined;
  /**
   * 适配器声明的默认凭证引用，优先级最低。
   *
   * 仅当信封与配置都没有提供 `credentialsRef` 时使用；
   * 适合「渠道与凭证固定绑定」的适配器（如每个企业微信机器人一套密钥）。
   */
  defaultCredentialsRef?: string | undefined;
}

/** 只解析渠道的输入。 */
export interface ConfigChannelQuery {
  /** 项目 ID，来自 `meta.projectId`；省略时使用解析器的 `defaultProjectId`。 */
  projectId?: string | undefined;
}

/** 配置解析后的最终值：渠道与凭证引用保证存在。 */
export interface ResolvedConfig {
  /** 最终渠道 ID。 */
  channel: string;
  /** 最终凭证引用。 */
  credentialsRef: string;
  /** 合并后的渠道选项，已包含配置默认值与信封显式值。 */
  channelOptions: Record<string, unknown>;
  /** 实际使用的项目 ID；未指定项目时为 `undefined`。 */
  projectId: string | undefined;
}

/** 创建配置解析器的策略选项。 */
export interface ConfigResolverOptions {
  /** 快照缓存时间（毫秒），默认 30000；`<= 0` 表示每次都重新加载。 */
  cacheTtlMs?: number;
  /** 指定了不存在的项目时是否直接报错，默认 `true`。 */
  strictProject?: boolean;
  /** 未传 `meta.projectId` 时使用的默认项目。 */
  defaultProjectId?: string;
}

/** 配置解析器：把信封字段与配置快照合并成最终投递参数。 */
export interface ConfigResolver {
  /**
   * 解析一次投递的最终配置。
   *
   * @throws {FengsuiError} 配置加载/校验失败抛 `code: 'config'`；
   * 解析后仍缺少 `channel` 或 `credentialsRef` 抛 `code: 'validation'`。
   */
  resolve(input?: ConfigResolveInput): Promise<ResolvedConfig>;

  /**
   * 只解析渠道 ID，供投递器先查适配器、再解析凭证。
   *
   * @returns 未配置任何默认渠道时返回 `undefined`。
   * @throws {FengsuiError} 配置加载/校验失败或项目不存在时抛 `code: 'config'`。
   */
  resolveChannel(input?: ConfigChannelQuery): Promise<string | undefined>;

  /** 手动让缓存失效，下一次 `resolve()` 重新加载。 */
  invalidate(): void;

  /** 取消订阅并释放 Provider 资源。 */
  close(): Promise<void>;
}
