/**
 * 配置插件入口。
 *
 * 核心只依赖这里的契约；具体来源（文件 / SQLite / MySQL / Redis）由独立插件实现，
 * 并通过 `createFengsui({ config: provider })` 注入。
 */
export type {
  ConfigChannelDefaults,
  ConfigChannelQuery,
  ConfigLayer,
  ConfigProject,
  ConfigProvider,
  ConfigResolveInput,
  ConfigResolver,
  ConfigResolverOptions,
  ConfigSnapshot,
  ResolvedConfig,
} from './types';
export { configSnapshotSchema, type ParsedConfigSnapshot } from './schema';
export { createConfigResolver } from './resolve';
