import type { HttpClient } from '@fengsui/http';
import type { ZodType } from 'zod';

import type { ChannelCapabilities, DeliveryReceipt, MessageKind } from '../capabilities';
import type { Envelope, EnvelopeContent, EnvelopeTarget } from '../envelope';
import type { Logger } from '../logger';

/**
 * 凭证解析结果。
 *
 * `ref` 即信封里的 `credentialsRef`（形如 `tenant/account`），只用于定位与日志；
 * `values` 是渠道约定的键值对，例如邮件使用 `user` / `pass`，OAuth2 使用
 * `clientId` / `clientSecret` / `refreshToken` 或 `accessToken`。
 *
 * 约定：
 * - 不要在 `values` 中返回与凭证无关的配置项（发件人、SMTP 主机等属于渠道配置）；
 * - `values` 只接受字符串，非字符串会被解析器统一转成字符串。
 */
export interface ResolvedCredential {
  readonly ref: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * 凭证解析器接口。
 *
 * 核心层不关心凭证来源（环境变量、Vault、数据库或 KMS），只按 `ref` 取键值对；
 * 解析不到时应抛 `FengsuiError`，`code` 为 `credentials`，便于统一归类。
 */
export interface CredentialResolver {
  /**
   * 解析指定凭证引用。
   *
   * @param ref 形如 `tenant/account`。同一 ref 在多次投递中必须解析到同一份凭证。
   * @throws {FengsuiError} 凭证缺失或格式非法时抛 `code: 'credentials'`。
   */
  resolve(ref: string): Promise<ResolvedCredential>;
}

/**
 * 单次适配器调用的上下文，由投递器为每个目标、每次尝试创建。
 *
 * 生命周期：一次 `send()` 调用内有效；`signal` 会在该次尝试超时或被外部取消时触发。
 * 适配器不应把上下文或其中的 `signal` 缓存到调用之外。
 */
export interface AdapterContext {
  /**
   * 可选的 HTTP 客户端，由宿主注入。
   *
   * 只使用其他传输（如 SMTP）的适配器可以忽略；
   * 需要 HTTP 的适配器应调用 `requireHttp(ctx)`，在缺失时得到可行动的报错。
   */
  http?: HttpClient | undefined;

  /** 凭证解析器。适配器按 `credentialsRef` 取用，不要自行读取环境变量。 */
  credentials: CredentialResolver;

  /** 带上下文字段的日志器，用于记录请求与重试信息。 */
  logger: Logger;

  /** 本次尝试的取消信号：超时或外部取消时触发，适配器应尽快中止 IO。 */
  signal: AbortSignal;

  /** 链路 ID，用于串联一次业务请求内的多次外部调用。 */
  traceId: string;

  /** 租户 ID，默认取 `credentialsRef` 的前缀；用于日志、限流与隔离。 */
  tenantId: string;

  /**
   * 本次调用使用的凭证引用。
   *
   * 投递器会从信封中填入；健康检查等没有信封的场景也可显式提供，
   * 用于覆盖适配器构造时的默认 `credentialsRef`。
   */
  credentialsRef?: string | undefined;
}

/**
 * `normalize()` 的输入。
 *
 * 内容已经过校验与降级处理，`options` 已经过适配器的 `schema` 校验。
 */
export interface AdapterNormalizeInput<TOptions = unknown> {
  /** 通过校验的完整信封，可供适配器读取 `action`、`meta` 等字段。 */
  envelope: Envelope;
  /** 当前投递目标；无目标场景（如按会话发送）为 `undefined`。 */
  target: EnvelopeTarget | undefined;
  /** 降级后的内容，已经按能力选择最终消息类型。 */
  content: EnvelopeContent;
  /** 通过适配器 schema 校验后的 `channelOptions`。 */
  options: TOptions;
  /** 若发生降级，记录原始消息类型。 */
  degradedFrom?: MessageKind | undefined;
  /** 若发生降级，记录最终消息类型。 */
  degradedTo?: MessageKind | undefined;
}

/**
 * 适配器标准化后的消息，`send()` 的唯一入参。
 *
 * 与信封相比，它已经拆出单个目标、绑定凭证引用并携带降级信息，
 * 适配器不需要再关心 fan-out、校验与降级逻辑。
 */
export interface NormalizedMessage<TOptions = unknown> {
  /** 渠道 ID，如 `email.qq`。 */
  channel: string;
  /** 信封中的动作，如 `send`。 */
  action: string;
  /** 当前投递目标。 */
  target: EnvelopeTarget | undefined;
  /** 最终要发送的内容。 */
  content: EnvelopeContent;
  /** 渠道选项（已校验）。 */
  options: TOptions;
  /** 本次发送使用的凭证引用。 */
  credentialsRef?: string | undefined;
  /** 幂等键；投递器已拼接租户与渠道前缀，适配器一般无需处理。 */
  idempotencyKey?: string | undefined;
  /** 降级来源消息类型。 */
  degradedFrom?: MessageKind | undefined;
  /** 降级目标消息类型。 */
  degradedTo?: MessageKind | undefined;
}

/**
 * 适配器成功发送后的简要结果。
 *
 * 适用于单条发送；若适配器需要返回逐目标回执，可改用 `DeliveryReceipt`。
 */
export interface ChannelSendResult {
  /** 服务商返回的消息 ID，便于后续查询与排障。 */
  providerMessageId?: string;
  /** 服务商返回的状态码或错误码。 */
  providerCode?: string;
  /** 服务商的原始响应或错误描述。 */
  providerMessage?: string;
  /** 覆盖默认重试判断；省略时按错误码推断。 */
  retryable?: boolean;
  /** 服务商建议的重试等待时间（毫秒），优先于指数退避。 */
  retryAfterMs?: number;
}

/**
 * `send()` 的返回类型：简要结果或完整回执。
 *
 * 返回 `DeliveryReceipt` 时，投递器会读取其 `status` / `error` 并转换成逐目标结果。
 */
export type ChannelSendOutcome = DeliveryReceipt | ChannelSendResult;

/**
 * 渠道健康状态，供 `healthCheck()` 返回。
 *
 * 健康检查不应抛出异常，失败时返回 `ok: false` 并在 `detail` 中说明原因。
 */
export interface HealthStatus {
  /** 是否可用。 */
  ok: boolean;
  /** 检查时间（ISO 8601）。 */
  checkedAt?: string;
  /** 检查耗时（毫秒）。 */
  latencyMs?: number;
  /** 失败原因或补充说明。 */
  detail?: string;
}

/**
 * 消息类型降级链，键为原始类型，值为按顺序尝试的候选类型。
 *
 * 例如邮件适配器声明 `{ html: ['text'] }`：渠道不支持 HTML 时降级为纯文本。
 * 是否真正降级由信封的 `meta.options.fallback` 控制（默认 `degrade`）。
 */
export type ChannelFallbacks = Readonly<Partial<Record<MessageKind, ReadonlyArray<MessageKind>>>>;

/**
 * 渠道适配器契约。插件通过实现该接口接入一个新渠道。
 *
 * 调用顺序：`capabilities()` → 校验 `channelOptions` → `normalize()` → `send()`（可能重试）。
 * 适配器只负责单个目标，fan-out、超时、重试、幂等与降级均由核心投递器处理。
 *
 * @typeParam TOptions `channelOptions` 的类型，由 `schema` 推导。
 */
export interface ChannelAdapter<TOptions = unknown> {
  /** 渠道 ID，形如 `domain.action`（如 `email.qq`），同时是注册表键与信封的 `channel`。 */
  readonly id: string;

  /** 返回渠道能力声明，核心据此做内容类型校验与降级决策。 */
  capabilities(): ChannelCapabilities;

  /** 校验并收窄 `channelOptions`；核心在每次投递前调用 `safeParse`。 */
  readonly schema: ZodType<TOptions>;

  /** 把信封内容转换为发送所需的标准化消息。应为纯函数，不产生 IO。 */
  normalize(input: AdapterNormalizeInput<TOptions>): NormalizedMessage<TOptions>;

  /**
   * 发送单条消息。
   *
   * @throws {FengsuiError} 失败时抛出，`retryable` 决定是否重试。
   */
  send(message: NormalizedMessage<TOptions>, ctx: AdapterContext): Promise<ChannelSendOutcome>;

  /** 可选的批量发送；未实现时核心会逐条调用 `send()`。 */
  sendBatch?(
    messages: ReadonlyArray<NormalizedMessage<TOptions>>,
    ctx: AdapterContext,
  ): Promise<ReadonlyArray<ChannelSendOutcome>>;

  /** 可选健康检查；失败应返回 `ok: false` 而不是抛异常。 */
  healthCheck?(ctx: AdapterContext): Promise<HealthStatus>;

  /**
   * 可选默认凭证引用。
   *
   * 用于「渠道与凭证固定绑定」的适配器（如每个企业微信机器人一套 botId + secret）：
   * 信封和配置都未提供 `credentialsRef` 时，投递器回退到这个值。
   * 优先级低于配置，配置仍可按项目覆盖。
   */
  readonly defaultCredentialsRef?: string | undefined;

  /** 可选降级链，声明当前渠道不支持某类型时可接受的内容类型。 */
  fallbacks?: ChannelFallbacks | undefined;
}
