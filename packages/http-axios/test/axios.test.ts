import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpTransportError } from '@javen205/fengsui-http';
import { createAxiosHttpClient } from '@javen205/fengsui-http-axios';
import { afterEach, describe, expect, it } from 'vitest';

interface TestServer {
  origin: string;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const testServer: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  servers.push(testServer);
  return testServer;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('createAxiosHttpClient', () => {
  it('sends GET with query and headers and exposes the raw body', async () => {
    const server = await startServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ path: url.pathname, q: url.searchParams.get('q'), header: req.headers['x-test'] }),
      );
    });

    const client = createAxiosHttpClient();
    const response = await client.request({
      method: 'GET',
      url: `${server.origin}/items`,
      query: { q: 'a b' },
      headers: { 'x-test': 'yes' },
    });

    expect(response.status).toBe(200);
    expect(response.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json<{ path: string; q: string; header: string }>()).toEqual({
      path: '/items',
      q: 'a b',
      header: 'yes',
    });
  });

  it('serializes json bodies and sets content-type', async () => {
    const server = await startServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          method: req.method,
          contentType: req.headers['content-type'],
          body: await readBody(req),
        }),
      );
    });

    const client = createAxiosHttpClient();
    const response = await client.request({
      method: 'POST',
      url: `${server.origin}/echo`,
      json: { ok: true },
    });

    expect(response.json<{ method: string; contentType: string; body: string }>()).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  it('returns non-2xx responses instead of throwing', async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 502;
      res.end('upstream down');
    });

    const client = createAxiosHttpClient();
    const response = await client.request({ method: 'GET', url: `${server.origin}/fail` });

    expect(response.status).toBe(502);
    expect(response.body).toBe('upstream down');
  });

  it('maps timeouts to an HttpTransportError with kind=timeout', async () => {
    const server = await startServer((_req, res) => {
      setTimeout(() => res.end('late'), 200);
    });

    const client = createAxiosHttpClient({ defaultTimeoutMs: 30 });

    await expect(client.request({ method: 'GET', url: `${server.origin}/slow` })).rejects.toMatchObject(
      { name: 'HttpTransportError', kind: 'timeout' },
    );
  });

  it('maps pre-aborted requests to kind=aborted', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    const controller = new AbortController();
    controller.abort();

    const client = createAxiosHttpClient();

    await expect(
      client.request({ method: 'GET', url: `${server.origin}/abort`, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('truncates oversized responses by default', async () => {
    const server = await startServer((_req, res) => res.end('a'.repeat(64)));

    const client = createAxiosHttpClient({ maxResponseBytes: 16 });
    const response = await client.request({ method: 'GET', url: `${server.origin}/big` });

    expect(response.body).toHaveLength(16);
    expect(response.truncated).toBe(true);
  });

  it('rejects requests that set both json and body', async () => {
    const client = createAxiosHttpClient();

    await expect(
      client.request({ method: 'POST', url: 'http://127.0.0.1:1/nope', json: {}, body: 'x' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('wraps connection failures as kind=network', async () => {
    const client = createAxiosHttpClient({ defaultTimeoutMs: 200 });

    await expect(client.request({ method: 'GET', url: 'http://127.0.0.1:1/nope' })).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpTransportError && error.kind === 'network',
    );
  });
});
