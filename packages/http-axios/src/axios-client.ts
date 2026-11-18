import { randomUUID } from 'node:crypto';

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import {
  HttpTransportError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@fengsui/http';

export interface AxiosHttpClientOptions {
  /** Existing axios instance. Defaults to `axios.create(defaults)`. */
  axios?: AxiosInstance;
  /** Defaults forwarded to `axios.create()` when no instance is injected. */
  defaults?: AxiosRequestConfig;
  /** 单次请求默认超时，未在请求里覆盖时生效。默认 15000ms。 */
  defaultTimeoutMs?: number;
  /** 响应体读取上限，默认 5 MiB。 */
  maxResponseBytes?: number;
  /** 超过响应体上限时的行为，默认截断。 */
  onTooLarge?: 'truncate' | 'throw';
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function buildUrl(input: string, query?: HttpRequest['query']): string {
  const url = new URL(input);
  if (!query) {
    return url.toString();
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function displayUrl(input: string): string {
  const url = new URL(input);
  return `${url.origin}${url.pathname}`;
}

function normalizeHeaders(input: unknown): Record<string, string> {
  if (input === null || input === undefined) {
    return {};
  }

  const source =
    typeof input === 'object' && 'toJSON' in input && typeof input.toJSON === 'function'
      ? (input.toJSON() as Record<string, unknown>)
      : (input as Record<string, unknown>);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return headers;
}

function truncateToBytes(text: string, maxBytes: number): { body: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { body: text, truncated: false };
  }
  return { body: buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8'), truncated: true };
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_CANCELED' || (error as { name?: unknown }).name === 'CanceledError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * HttpClient implementation backed by axios.
 * Keeps the same contract as `@fengsui/http-fetch`: non-2xx responses are
 * returned as-is, the raw response body is preserved, and only transport
 * failures (network, timeout, abort, oversized body) throw `HttpTransportError`.
 */
export function createAxiosHttpClient(options: AxiosHttpClientOptions = {}): HttpClient {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const onTooLarge = options.onTooLarge ?? 'truncate';
  const instance =
    options.axios ?? axios.create({ ...(options.defaults ?? {}), responseType: 'text' });

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.json !== undefined && req.body !== undefined) {
        throw new TypeError('HttpRequest.json and HttpRequest.body are mutually exclusive');
      }

      const requestId = req.meta?.requestId ?? randomUUID();
      const startedAt = performance.now();
      const url = buildUrl(req.url, req.query);
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;

      if (req.signal?.aborted === true) {
        throw new HttpTransportError('aborted', 'Request aborted by caller', { requestId });
      }

      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      let data: unknown;
      if (req.json !== undefined) {
        data = JSON.stringify(req.json);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json';
        }
      } else if (req.body !== undefined) {
        data = req.body;
      }

      const config: AxiosRequestConfig = {
        method: req.method,
        url,
        headers,
        data,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        responseType: 'text',
        // Keep the raw payload; adapters parse it themselves.
        transformResponse: [(raw: unknown) => raw],
        // Non-2xx is a provider-level outcome, not a transport failure.
        validateStatus: () => true,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      };

      try {
        const response = await instance.request<unknown>(config);
        const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const { body, truncated } = truncateToBytes(raw, maxResponseBytes);

        if (truncated && onTooLarge === 'throw') {
          throw new HttpTransportError(
            'tooLarge',
            `Response body exceeded ${maxResponseBytes} bytes`,
            { requestId },
          );
        }

        const json = <T = unknown>(): T => {
          if (body.length === 0) {
            return undefined as T;
          }
          return JSON.parse(body) as T;
        };

        return {
          status: response.status,
          headers: normalizeHeaders(response.headers),
          body,
          json,
          requestId,
          durationMs: performance.now() - startedAt,
          ...(truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        if (error instanceof HttpTransportError) {
          throw error;
        }
        if (isAbortError(error)) {
          throw new HttpTransportError('aborted', 'Request aborted by caller', {
            requestId,
            cause: error,
          });
        }
        if (isTimeoutError(error)) {
          throw new HttpTransportError('timeout', `Request timed out after ${timeoutMs}ms`, {
            requestId,
            cause: error,
          });
        }
        throw new HttpTransportError(
          'network',
          `HTTP request to ${displayUrl(url)} failed: ${errorMessage(error)}`,
          { requestId, cause: error },
        );
      }
    },
  };
}
