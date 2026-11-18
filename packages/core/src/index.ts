/**
 * `@fengsui/core` 公共入口。
 *
 * 只导出框架能力：信封、能力与回执类型、统一错误、日志、适配器契约、
 * 凭证解析、配置插件契约、入站路由、注册表、幂等、投递器、插件 API
 * 与 `createFengsui()`。不导出任何渠道实现或 HTTP 实现 —— 它们由插件包提供。
 */
export * from './envelope';
export * from './capabilities';
export * from './errors';
export * from './logger';
export * from './adapter';
export * from './credentials';
export * from './config';
export * from './inbound';
export * from './registry';
export * from './idempotency';
export * from './dispatcher';
export * from './plugin';
export * from './fengsui';

export type {
  HttpClient,
  HttpMethod,
  HttpQueryValue,
  HttpRequest,
  HttpRequestMeta,
  HttpResponse,
  HttpTransportError,
  HttpTransportErrorKind,
} from '@fengsui/http';
