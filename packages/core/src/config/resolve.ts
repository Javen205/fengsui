/**
 * 配置解析器实现。
 *
 * 职责边界：
 * - Provider 只负责取数据；
 * - 这里负责校验、缓存、项目继承、层级合并与最终缺省检查；
 * - 投递器只在拿到 `ResolvedConfig` 后继续做能力匹配与发送。
 *
 * 合并优先级（从低到高）：
 * 1. `defaults`；
 * 2. `projects.<id>` 的继承链（根祖先 → 当前项目）；
 * 3. 同一层内的 `channels.<channel>`；
 * 4. 信封显式字段（`channel` / `credentialsRef` / `channelOptions`）。
 */
import { FengsuiError } from '../errors';
import { configSnapshotSchema, type ParsedConfigSnapshot } from './schema';
import type {
  ConfigChannelQuery,
  ConfigLayer,
  ConfigProject,
  ConfigProvider,
  ConfigResolveInput,
  ConfigResolver,
  ConfigResolverOptions,
  ResolvedConfig,
} from './types';

/** 默认快照缓存时间：30 秒。 */
const DEFAULT_CACHE_TTL_MS = 30_000;

/** 原型污染防护：合并时跳过的键。 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 创建配置解析器。
 *
 * @param provider 配置来源插件，如 `fileConfig({ path })`。
 * @param options 缓存、项目严格模式等策略。
 */
export function createConfigResolver(
  provider: ConfigProvider,
  options: ConfigResolverOptions = {},
): ConfigResolver {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const strictProject = options.strictProject ?? true;
  const defaultProjectId = options.defaultProjectId;

  let cache: { snapshot: ParsedConfigSnapshot; loadedAt: number } | undefined;
  let closed = false;

  // Provider 支持变更订阅时，收到通知立即失效缓存；下一次 resolve() 重新加载。
  const unsubscribe =
    provider.subscribe === undefined
      ? undefined
      : provider.subscribe(() => {
          cache = undefined;
        });

  async function loadSnapshot(): Promise<ParsedConfigSnapshot> {
    const now = Date.now();
    if (cache !== undefined && cacheTtlMs > 0 && now - cache.loadedAt < cacheTtlMs) {
      return cache.snapshot;
    }

    let raw: unknown;
    try {
      raw = await provider.load();
    } catch (error) {
      throw new FengsuiError({
        code: 'config',
        message: `Config provider "${provider.name}" failed to load configuration: ${describeError(error)}`,
        retryable: false,
        cause: error,
      });
    }

    const parsed = configSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      throw new FengsuiError({
        code: 'config',
        message: `Config provider "${provider.name}" returned an invalid snapshot: ${issues
          .map((issue) => (issue.path.length > 0 ? `${issue.path}: ${issue.message}` : issue.message))
          .join('; ')}`,
        retryable: false,
        details: issues,
      });
    }

    cache = { snapshot: parsed.data, loadedAt: Date.now() };
    return cache.snapshot;
  }

  return {
    async resolve(input: ConfigResolveInput = {}): Promise<ResolvedConfig> {
      const snapshot = await loadSnapshot();
      const projectId = input.projectId ?? defaultProjectId;
      const projectLayers = resolveProjectLayers(snapshot, projectId, strictProject);

      // defaults 永远在最底层，项目继承链按从根到当前项目叠加。
      const layers: ReadonlyArray<ConfigLayer> = [
        ...(snapshot.defaults === undefined ? [] : [snapshot.defaults]),
        ...projectLayers,
      ];

      const channel = input.channel ?? lastDefined(layers, (layer) => layer.channel);
      if (channel === undefined) {
        throw new FengsuiError({
          code: 'validation',
          message:
            'Envelope "channel" is required: set it on the envelope or provide defaults.channel in configuration',
        });
      }

      let credentialsRef: string | undefined;
      const channelOptions: Record<string, unknown> = {};

      for (const layer of layers) {
        if (layer.credentialsRef !== undefined) {
          credentialsRef = layer.credentialsRef;
        }
        if (layer.channelOptions !== undefined) {
          deepMerge(channelOptions, layer.channelOptions);
        }

        const perChannel = layer.channels?.[channel];
        if (perChannel?.credentialsRef !== undefined) {
          credentialsRef = perChannel.credentialsRef;
        }
        if (perChannel?.channelOptions !== undefined) {
          deepMerge(channelOptions, perChannel.channelOptions);
        }
      }

      // 信封显式值拥有最终决定权。
      if (input.credentialsRef !== undefined) {
        credentialsRef = input.credentialsRef;
      }
      if (input.channelOptions !== undefined) {
        deepMerge(channelOptions, input.channelOptions);
      }

      // 最后回退到适配器声明的固定凭证，优先级低于所有配置。
      if (credentialsRef === undefined) {
        credentialsRef = input.defaultCredentialsRef;
      }

      if (credentialsRef === undefined) {
        throw new FengsuiError({
          code: 'validation',
          message: `Envelope "credentialsRef" is required: set it on the envelope or provide a default for channel "${channel}" in configuration`,
          channel,
        });
      }

      return { channel, credentialsRef, channelOptions, projectId };
    },

    async resolveChannel(input: ConfigChannelQuery = {}): Promise<string | undefined> {
      const snapshot = await loadSnapshot();
      const projectId = input.projectId ?? defaultProjectId;
      const layers: ReadonlyArray<ConfigLayer> = [
        ...(snapshot.defaults === undefined ? [] : [snapshot.defaults]),
        ...resolveProjectLayers(snapshot, projectId, strictProject),
      ];
      return lastDefined(layers, (layer) => layer.channel);
    },

    invalidate(): void {
      cache = undefined;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
      cache = undefined;
      await provider.close?.();
    },
  };
}

/**
 * 解析项目继承链，返回从根祖先到当前项目的层列表。
 *
 * 未指定项目时返回空数组；`strictProject` 为 false 时，未知项目按「无项目」处理。
 */
function resolveProjectLayers(
  snapshot: ParsedConfigSnapshot,
  projectId: string | undefined,
  strictProject: boolean,
): ReadonlyArray<ConfigProject> {
  if (projectId === undefined) {
    return [];
  }

  const projects = snapshot.projects ?? {};
  if (projects[projectId] === undefined) {
    if (!strictProject) {
      return [];
    }
    const available = Object.keys(projects).sort();
    const hint =
      available.length > 0
        ? `; available projects: ${available.join(', ')}`
        : '; no projects are defined';
    throw new FengsuiError({
      code: 'config',
      message: `Unknown project "${projectId}" in configuration${hint}`,
      retryable: false,
      details: { projectId, available },
    });
  }

  return buildExtendsChain(projectId, projects);
}

/**
 * 沿着 `extends` 向上构建继承链，并检测环与缺失父项目。
 *
 * 返回顺序：根祖先 → ... → 当前项目，便于按优先级从低到高依次合并。
 */
function buildExtendsChain(
  projectId: string,
  projects: Readonly<Record<string, ConfigProject>>,
): ReadonlyArray<ConfigProject> {
  const chain: ConfigProject[] = [];
  const visited: string[] = [];
  let current: string | undefined = projectId;

  while (current !== undefined) {
    const cycleStart = visited.indexOf(current);
    if (cycleStart !== -1) {
      const cycle = [...visited.slice(cycleStart), current];
      throw new FengsuiError({
        code: 'config',
        message: `Cyclic project inheritance detected: ${cycle.join(' -> ')}`,
        retryable: false,
        details: { chain: cycle },
      });
    }

    visited.push(current);
    const project: ConfigProject | undefined = projects[current];
    if (project === undefined) {
      const parent = visited[visited.length - 2];
      throw new FengsuiError({
        code: 'config',
        message:
          parent === undefined
            ? `Unknown project "${current}" in configuration`
            : `Project "${parent}" extends unknown project "${current}"`,
        retryable: false,
        details: { projectId: current, parent },
      });
    }

    chain.unshift(project);
    current = project.extends;
  }

  return chain;
}

/** 从后往前找到第一个非 undefined 的值。 */
function lastDefined<T>(
  items: ReadonlyArray<T>,
  pick: (item: T) => string | undefined,
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    const value = pick(item);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** 判断是否为可递归合并的普通对象（排除数组、null 与类实例）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 把 `patch` 深合并进 `target`。
 *
 * - 普通对象递归合并，保证 `channelOptions.headers` 这类嵌套配置逐项覆盖；
 * - 数组与基础类型直接替换；
 * - 合并时复制对象，避免修改缓存的配置快照。
 */
function deepMerge(target: Record<string, unknown>, patch: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }

    if (isPlainObject(value)) {
      const current = target[key];
      const next: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
      deepMerge(next, value);
      target[key] = next;
      continue;
    }

    target[key] = Array.isArray(value) ? [...value] : value;
  }
}

/** 把任意异常转成单行描述，避免错误信息里出现多行堆栈。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
