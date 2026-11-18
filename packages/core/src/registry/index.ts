import type { ChannelAdapter } from '../adapter';
import { FengsuiError } from '../errors';

/**
 * 渠道域白名单。渠道 ID 的第一段必须命中其中之一，
 * 用于 `list({ domain })` 过滤与统计，不影响注册本身。
 */
export const CHANNEL_DOMAINS = ['email', 'im', 'sms', 'wechat', 'wecom'] as const;

export type ChannelDomain = (typeof CHANNEL_DOMAINS)[number];

/** `list()` 的过滤条件。 */
export interface ListAdaptersFilter {
  /** 只返回指定域的渠道，如 `email`。 */
  domain?: ChannelDomain;
}

/** 从渠道 ID 中解析域；格式非法或不在白名单时返回 `undefined`。 */
export function adapterDomain(channelId: string): ChannelDomain | undefined {
  const [domain] = channelId.split('.');
  if (domain === undefined) {
    return undefined;
  }
  return CHANNEL_DOMAINS.includes(domain as ChannelDomain) ? (domain as ChannelDomain) : undefined;
}

/**
 * 渠道注册表（实例级）。
 *
 * 每个 `createFengsui()` 实例持有独立注册表，插件注册互不影响；
 * 模块级函数只是默认注册表的兼容包装。
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, ChannelAdapter>();

  /**
   * 注册渠道。
   *
   * @throws {FengsuiError} ID 不含 `.` 或重复注册时抛 `code: 'internal'`，
   * 让插件冲突在启动阶段暴露，而不是发送时才发现。
   */
  register<TOptions>(adapter: ChannelAdapter<TOptions>): void {
    if (!adapter.id.includes('.')) {
      throw new FengsuiError({
        code: 'internal',
        message: `Adapter id "${adapter.id}" must look like "domain.action"`,
        details: { channelId: adapter.id },
      });
    }

    if (this.#adapters.has(adapter.id)) {
      throw new FengsuiError({
        code: 'internal',
        message: `Adapter "${adapter.id}" is already registered`,
        channel: adapter.id,
        details: { channelId: adapter.id },
      });
    }

    this.#adapters.set(adapter.id, adapter as unknown as ChannelAdapter);
  }

  /**
   * 按渠道 ID 取适配器。
   *
   * @throws {FengsuiError} 未注册时抛 `code: 'unsupported'`，
   * 并在 message 中给出拼写建议或可用渠道列表。
   */
  get(channelId: string): ChannelAdapter {
    const adapter = this.#adapters.get(channelId);
    if (adapter !== undefined) {
      return adapter;
    }

    const suggestions = this.suggest(channelId);
    let hint: string;
    if (suggestions.length > 0) {
      hint = ` Did you mean ${suggestions.map((id) => `"${id}"`).join(' or ')}?`;
    } else if (this.#adapters.size > 0) {
      hint = ` Available channels: ${[...this.#adapters.keys()].sort().join(', ')}.`;
    } else {
      hint = ' No adapters are registered.';
    }

    throw new FengsuiError({
      code: 'unsupported',
      message: `Unknown channel "${channelId}".${hint}`,
      channel: channelId,
      details: { channelId, suggestions },
    });
  }

  /** 判断渠道是否已注册。 */
  has(channelId: string): boolean {
    return this.#adapters.has(channelId);
  }

  /** 列出已注册渠道，按 ID 排序；可只取某个域。 */
  list(filter: ListAdaptersFilter = {}): ReadonlyArray<ChannelAdapter> {
    const all = [...this.#adapters.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (filter.domain !== undefined) {
      return all.filter((adapter) => adapterDomain(adapter.id) === filter.domain);
    }
    return all;
  }

  /** 移除全部渠道。仅用于测试与热重载，生产环境不要调用。 */
  clear(): void {
    this.#adapters.clear();
  }

  /**
   * 为拼写错误的渠道 ID 生成候选。
   *
   * 规则：编辑距离 ≤ 2，或互为前缀；按距离与字典序排序后取前 `limit` 个。
   */
  suggest(channelId: string, limit = 3): ReadonlyArray<string> {
    return [...this.#adapters.keys()]
      .map((id) => ({ id, distance: editDistance(channelId, id) }))
      .filter(
        ({ id, distance }) => distance <= 2 || id.startsWith(channelId) || channelId.startsWith(id),
      )
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ id }) => id);
  }
}

/** 创建一个空注册表；每个 `createFengsui()` 实例持有自己的注册表。 */
export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}

/** 模块级默认注册表，仅服务兼容 API。 */
const defaultRegistry = createAdapterRegistry();

/** 向默认注册表注册渠道。新代码建议使用 `createFengsui({ plugins })`。 */
export function registerAdapter<TOptions>(adapter: ChannelAdapter<TOptions>): void {
  defaultRegistry.register(adapter);
}

/** 从默认注册表取渠道。 */
export function getAdapter(channelId: string): ChannelAdapter {
  return defaultRegistry.get(channelId);
}

/** 列出默认注册表中的渠道。 */
export function listAdapters(filter: ListAdaptersFilter = {}): ReadonlyArray<ChannelAdapter> {
  return defaultRegistry.list(filter);
}

/** 清空默认注册表。仅用于测试。 */
export function clearAdapters(): void {
  defaultRegistry.clear();
}

/** 基于默认注册表生成渠道 ID 候选。 */
export function suggestAdapterIds(channelId: string, limit = 3): ReadonlyArray<string> {
  return defaultRegistry.suggest(channelId, limit);
}

/** 经典动态规划编辑距离，用于渠道 ID 拼写建议。 */
function editDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );

  for (let row = 1; row < rows; row += 1) {
    const leftChar = left[row - 1];
    for (let column = 1; column < columns; column += 1) {
      const rightChar = right[column - 1];
      const substitutionCost = leftChar === rightChar ? 0 : 1;
      const deletion = (matrix[row - 1]?.[column] ?? 0) + 1;
      const insertion = (matrix[row]?.[column - 1] ?? 0) + 1;
      const substitution = (matrix[row - 1]?.[column - 1] ?? 0) + substitutionCost;
      matrix[row]![column] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[left.length]?.[right.length] ?? Math.max(left.length, right.length);
}
