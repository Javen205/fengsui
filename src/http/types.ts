export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type HttpQueryPrimitive = string | number | boolean;
export type HttpQueryValue =
  HttpQueryPrimitive | null | undefined | ReadonlyArray<HttpQueryPrimitive>;

export interface HttpRequestMeta {
  requestId?: string;
  channel?: string;
  tenantId?: string;
  traceId?: string;
  operation?: string;
  [key: string]: unknown;
}

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, HttpQueryValue>;
  body?: string | Uint8Array;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  meta?: HttpRequestMeta;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  json<T = unknown>(): T;
  requestId: string;
  durationMs: number;
  truncated?: boolean;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export type HttpTransportErrorKind = 'network' | 'timeout' | 'aborted' | 'tooLarge';

export interface HttpTransportErrorOptions {
  requestId: string;
  cause?: unknown;
}

export class HttpTransportError extends Error {
  readonly kind: HttpTransportErrorKind;
  readonly requestId: string;

  constructor(kind: HttpTransportErrorKind, message: string, options: HttpTransportErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpTransportError';
    this.kind = kind;
    this.requestId = options.requestId;
  }
}
