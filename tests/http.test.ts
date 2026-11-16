import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createFetchHttpClient } from '../src/http';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe('createFetchHttpClient', () => {
  it('returns a 200 JSON response without throwing', async () => {
    server.use(
      http.post('https://api.test/echo', async ({ request }) => {
        expect(await request.json()).toEqual({ hello: 'world' });
        return HttpResponse.json(
          { ok: true },
          { headers: { 'X-Request-Id': 'provider-request-1' } },
        );
      }),
    );

    const client = createFetchHttpClient();
    const response = await client.request({
      method: 'POST',
      url: 'https://api.test/echo',
      json: { hello: 'world' },
      meta: { requestId: 'req-1' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('provider-request-1');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toContain('"ok":true');
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
    expect(response.requestId).toBe('req-1');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.truncated).toBeUndefined();
  });

  it('returns non-2xx responses instead of throwing', async () => {
    server.use(http.get('https://api.test/fail', () => new HttpResponse('boom', { status: 503 })));

    const client = createFetchHttpClient();
    const response = await client.request({ method: 'GET', url: 'https://api.test/fail' });

    expect(response.status).toBe(503);
    expect(response.body).toBe('boom');
  });

  it('throws a timeout error when the request exceeds timeoutMs', async () => {
    server.use(
      http.get('https://api.test/slow', async () => {
        await delay('infinite');
        return new HttpResponse('late');
      }),
    );

    const client = createFetchHttpClient();

    await expect(
      client.request({ method: 'GET', url: 'https://api.test/slow', timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: 'HttpTransportError', kind: 'timeout' });
  });

  it('throws an aborted error when the caller aborts', async () => {
    server.use(
      http.get('https://api.test/abort', async () => {
        await delay('infinite');
        return new HttpResponse('late');
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const client = createFetchHttpClient();

    await expect(
      client.request({
        method: 'GET',
        url: 'https://api.test/abort',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'HttpTransportError', kind: 'aborted' });
  });

  it('truncates oversized response bodies and marks them', async () => {
    server.use(
      http.get('https://api.test/large', () => new HttpResponse('x'.repeat(500), { status: 200 })),
    );

    const client = createFetchHttpClient({ maxResponseBytes: 100 });
    const response = await client.request({ method: 'GET', url: 'https://api.test/large' });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(100);
    expect(response.truncated).toBe(true);
  });

  it('can throw a tooLarge error instead of truncating', async () => {
    server.use(http.get('https://api.test/large-strict', () => new HttpResponse('x'.repeat(500))));

    const client = createFetchHttpClient({ maxResponseBytes: 100, onTooLarge: 'throw' });

    await expect(
      client.request({ method: 'GET', url: 'https://api.test/large-strict' }),
    ).rejects.toMatchObject({ name: 'HttpTransportError', kind: 'tooLarge' });
  });

  it('normalizes response headers to lowercase', async () => {
    server.use(
      http.get(
        'https://api.test/headers',
        () => new HttpResponse('ok', { headers: { 'X-Custom-Header': 'value' } }),
      ),
    );

    const client = createFetchHttpClient();
    const response = await client.request({ method: 'GET', url: 'https://api.test/headers' });

    expect(response.headers['x-custom-header']).toBe('value');
  });

  it('encodes query values, arrays and existing query strings', async () => {
    server.use(
      http.get('https://api.test/search', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('existing')).toBe('1');
        expect(url.searchParams.get('q')).toBe('中文 空格');
        expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
        return new HttpResponse('ok');
      }),
    );

    const client = createFetchHttpClient();
    const response = await client.request({
      method: 'GET',
      url: 'https://api.test/search?existing=1',
      query: { q: '中文 空格', tag: ['a', 'b'], skip: undefined },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
  });

  it('generates a requestId and measures duration when meta is absent', async () => {
    server.use(http.get('https://api.test/ok', () => HttpResponse.json({ ok: true })));

    const client = createFetchHttpClient();
    const response = await client.request({ method: 'GET', url: 'https://api.test/ok' });

    expect(response.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps network failures as transport errors', async () => {
    server.use(http.get('https://api.test/network-error', () => HttpResponse.error()));

    const client = createFetchHttpClient();

    await expect(
      client.request({ method: 'GET', url: 'https://api.test/network-error' }),
    ).rejects.toMatchObject({ name: 'HttpTransportError', kind: 'network' });
  });
});
