/**
 * fengsui HTTP 传输契约。
 *
 * 该文件只定义接口与错误类型，不含任何实现；具体实现由传输插件提供：
 * - `@fengsui/http-fetch`：Node 原生 `fetch`
 * - `@fengsui/http-axios`：axios
 *
 * 契约要点：
 * - GET、POST 以及其他常用方法均支持，方法通过 `HttpRequest.method` 透传给实现。
 * - 4xx/5xx 属于业务/对端结果，**不抛异常**，由调用方读取 `status` 判断。
 * - 只有传输层失败（网络、超时、主动取消、响应超限）才抛 `HttpTransportError`。
 * - 实现不负责重试、缓存、鉴权与业务解包，这些由调用方或 adapter 处理。
 *
 * @example GET
 * ```ts
 * const response = await http.request({
 *   method: 'GET',
 *   url: 'https://api.example.com/users',
 *   query: { page: 1, tags: ['a', 'b'] },
 *   headers: { authorization: `Bearer ${token}` },
 * });
 * const users = response.json<User[]>();
 * ```
 *
 * @example POST
 * ```ts
 * const response = await http.request({
 *   method: 'POST',
 *   url: 'https://api.example.com/messages',
 *   json: { text: 'hello' }, // 自动序列化并补 content-type: application/json
 * });
 * ```
 */

/**
 * 支持的 HTTP 方法。
 *
 * 覆盖 fetch 与 axios 的常用能力：`GET` / `POST` 是主要使用路径，
 * `PUT` / `PATCH` / `DELETE` 用于更新与删除，`HEAD` 用于探活。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** query 参数允许的标量类型：string、number、boolean。 */
export type HttpQueryPrimitive = string | number | boolean;

/**
 * 单个 query 参数的取值。
 *
 * - 标量：按 `key=value` 拼接；
 * - 数组：展开为重复键，如 `{ tag: ['a', 'b'] }` → `?tag=a&tag=b`；
 * - `null` / `undefined`：整项跳过，不生成空键。
 */
export type HttpQueryValue =
  | HttpQueryPrimitive
  | null
  | undefined
  | ReadonlyArray<HttpQueryPrimitive>;

/**
 * 请求的追踪元信息，仅用于日志、指标与链路关联。
 *
 * 传输实现可以忽略这里的任何字段，不参与签名、鉴权或路由。
 */
export interface HttpRequestMeta {
  /** 请求唯一标识。未提供时由实现生成（通常为 UUID），并回填到 `HttpResponse.requestId`。 */
  requestId?: string;
  /** 渠道标识，如 `email.qq`，用于按渠道统计。 */
  channel?: string;
  /** 租户标识，用于多租户隔离与日志过滤。 */
  tenantId?: string;
  /** 链路 ID，用于串联一次业务请求内的多次外部调用。 */
  traceId?: string;
  /** 操作名，如 `send`、`healthCheck`，用于指标分组。 */
  operation?: string;
  /** 允许附加自定义字段，实现会原样透传给日志。 */
  [key: string]: unknown;
}

/**
 * 一次 HTTP 请求的输入。
 */
export interface HttpRequest {
  /** HTTP 方法。GET、POST 均支持，其余见 {@link HttpMethod}。 */
  method: HttpMethod;

  /** 完整的绝对 URL，必须包含协议与主机，例如 `https://api.example.com/v1/users`。 */
  url: string;

  /**
   * 自定义请求头。
   *
   * 键建议使用小写；实现会与默认头合并，同名时以这里的值为准。
   * 使用 `json` 时若未指定 `content-type`，实现会自动补 `application/json`。
   */
  headers?: Record<string, string>;

  /** 查询参数。数组展开为重复键，`null` / `undefined` 跳过。 */
  query?: Record<string, HttpQueryValue>;

  /**
   * 原始请求体，支持字符串或字节数组。
   *
   * 与 {@link HttpRequest.json} 互斥：同时提供会抛 `TypeError`。
   * 使用它时需要自行设置合适的 `content-type`。
   */
  body?: string | Uint8Array;

  /**
   * 结构化请求体，将序列化为 JSON 字符串发送。
   *
   * 与 {@link HttpRequest.body} 互斥；未指定 `content-type` 时自动补 `application/json`。
   */
  json?: unknown;

  /**
   * 单次请求超时（毫秒），包含建立连接与读取响应的时间。
   *
   * 省略时使用实现的默认值（两个内置实现均为 15000ms）；传 `0` 表示不额外设置超时。
   * 超时会抛 `HttpTransportError`，`kind` 为 `timeout`。
   */
  timeoutMs?: number;

  /**
   * 取消信号。调用方 `abort()` 后请求应尽快终止。
   *
   * 取消会抛 `HttpTransportError`，`kind` 为 `aborted`。
   * 建议与 `AbortSignal.timeout()` 或 `AbortSignal.any()` 组合使用。
   */
  signal?: AbortSignal;

  /** 追踪元信息，不影响请求本身。 */
  meta?: HttpRequestMeta;
}

/**
 * 一次 HTTP 请求的结果。
 *
 * 只要服务端返回了响应，无论状态码是 2xx 还是 4xx/5xx，都会以本结构返回；
 * 只有传输失败才抛 {@link HttpTransportError}。
 */
export interface HttpResponse {
  /** 原始 HTTP 状态码。是否视为成功由调用方决定，实现不做判断。 */
  status: number;

  /** 响应头，键统一为小写；同名多值以逗号合并。 */
  headers: Readonly<Record<string, string>>;

  /** 原始响应体文本。二进制响应需要调用方自行解码（如 base64 或 Buffer）。 */
  body: string;

  /**
   * 惰性解析响应体为 JSON。
   *
   * 每次调用都会重新解析；空 body 返回 `undefined`；
   * body 不是合法 JSON 时抛出原生 `SyntaxError`。泛型仅用于标注类型，不做运行时校验。
   */
  json<T = unknown>(): T;

  /** 本次请求的唯一标识，用于与服务端日志、应用日志关联。 */
  requestId: string;

  /** 传输耗时（毫秒），从发起请求到响应体读取完成，不含业务处理时间。 */
  durationMs: number;

  /**
   * 响应体是否被截断。
   *
   * 仅当体积超过实现配置的上限且策略为 `truncate` 时为 `true`；
   * 未设置该字段表示响应体完整。
   */
  truncated?: boolean;
}

/**
 * HTTP 传输接口，所有传输插件都实现该契约。
 *
 * 实现约定：
 * - 不重试、不缓存、不跟随业务语义，只做一次请求；
 * - 4xx/5xx 正常返回 {@link HttpResponse}，不抛异常；
 * - 网络失败、超时、取消、响应超限抛 {@link HttpTransportError}；
 * - 保证 `HttpResponse.requestId` 与 `HttpResponse.durationMs` 始终有值。
 *
 * @example 注入到 fengsui 实例
 * ```ts
 * const fengsui = createFengsui({
 *   credentials: createEnvCredentialResolver(),
 *   http: createFetchHttpClient(), // 或 createAxiosHttpClient()
 *   plugins: [emailPlugin()],
 * });
 * ```
 */
export interface HttpClient {
  /**
   * 执行一次 HTTP 请求。
   *
   * @param req 请求描述，GET 与 POST 均通过 `method` 区分。
   * @returns 服务端响应（含非 2xx）。
   * @throws {HttpTransportError} 传输层失败时抛出。
   */
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * 传输错误的类型。
 *
 * - `network`：DNS、连接被拒、TLS 握手、连接中断等；
 * - `timeout`：超过 `timeoutMs` 或实现默认超时；
 * - `aborted`：调用方通过 `signal` 主动取消；
 * - `tooLarge`：响应体超过上限且策略为 `throw`。
 *
 * 错误分类用于重试决策：`network` / `timeout` 通常可重试，
 * `aborted` 不应重试，`tooLarge` 需要调整响应上限或改用流式处理。
 */
export type HttpTransportErrorKind = 'network' | 'timeout' | 'aborted' | 'tooLarge';

/** 构造 {@link HttpTransportError} 的选项。 */
export interface HttpTransportErrorOptions {
  /** 出错请求的标识，便于与日志关联。 */
  requestId: string;
  /** 底层错误（如 fetch/axios 抛出的异常），会挂到 `Error.cause`。 */
  cause?: unknown;
}

/**
 * 传输层错误。只有传输失败会抛出，业务状态码不会。
 *
 * @example
 * ```ts
 * try {
 *   await http.request({ method: 'POST', url, json: payload });
 * } catch (error) {
 *   if (error instanceof HttpTransportError && error.kind === 'timeout') {
 *     // 可重试
 *   }
 *   throw error;
 * }
 * ```
 */
export class HttpTransportError extends Error {
  /** 错误类别，见 {@link HttpTransportErrorKind}。 */
  readonly kind: HttpTransportErrorKind;

  /** 出错请求的标识。 */
  readonly requestId: string;

  constructor(kind: HttpTransportErrorKind, message: string, options: HttpTransportErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpTransportError';
    this.kind = kind;
    this.requestId = options.requestId;
  }
}
