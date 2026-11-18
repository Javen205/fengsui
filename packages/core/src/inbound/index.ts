/**
 * 入站消息与 handler 路由。
 *
 * 核心只提供通用契约与路由；平台协议（企业微信、飞书等）由各自插件归一化后接入。
 */
export type {
  InboundChat,
  InboundContext,
  InboundDispatchInput,
  InboundDispatchResult,
  InboundHandler,
  InboundHandlerOutcome,
  InboundKind,
  InboundMedia,
  InboundMessage,
  InboundQuote,
  InboundRouterOptions,
  InboundSender,
} from './types';
export { InboundRouter } from './router';
