import { randomUUID } from 'node:crypto';

import { HttpTransportError, type HttpClient, type HttpRequest, type HttpResponse } from '@javen205/fengsui-http';

export interface FetchHttpClientOptions {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBody(
  response: Response,
  maxBytes: number,
  requestId: string,
  onTooLarge: 'truncate' | 'throw',
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: '', truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    const remaining = maxBytes - received;
    if (value.byteLength > remaining) {
      const slice = value.slice(0, Math.max(0, remaining));
      text += decoder.decode(slice, { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }

    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();

  if (truncated && onTooLarge === 'throw') {
    throw new HttpTransportError('tooLarge', `Response body exceeded ${maxBytes} bytes`, {
      requestId,
    });
  }

  return { body: text, truncated };
}

export function createFetchHttpClient(options: FetchHttpClientOptions = {}): HttpClient {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const onTooLarge = options.onTooLarge ?? 'truncate';

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.json !== undefined && req.body !== undefined) {
        throw new TypeError('HttpRequest.json and HttpRequest.body are mutually exclusive');
      }

      const requestId = req.meta?.requestId ?? randomUUID();
      const startedAt = performance.now();
      const url = buildUrl(req.url, req.query);
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;

      const timeoutController = new AbortController();
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          timeoutController.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, timeoutMs);
        timer.unref();
      }

      const signal = req.signal
        ? AbortSignal.any([req.signal, timeoutController.signal])
        : timeoutController.signal;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        headers.set(key, value);
      }

      const init: RequestInit = {
        method: req.method,
        headers,
        signal,
      };

      if (req.json !== undefined) {
        init.body = JSON.stringify(req.json);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      } else if (req.body !== undefined) {
        init.body = req.body as BodyInit;
      }

      try {
        const response = await fetch(url, init);
        const normalizedHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          normalizedHeaders[key.toLowerCase()] = value;
        });

        const { body, truncated } = await readBody(
          response,
          maxResponseBytes,
          requestId,
          onTooLarge,
        );

        const json = <T = unknown>(): T => {
          if (body.length === 0) {
            return undefined as T;
          }
          return JSON.parse(body) as T;
        };

        return {
          status: response.status,
          headers: normalizedHeaders,
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
        if (req.signal?.aborted) {
          throw new HttpTransportError('aborted', 'Request aborted by caller', {
            requestId,
            cause: error,
          });
        }
        if (timedOut) {
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
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}
