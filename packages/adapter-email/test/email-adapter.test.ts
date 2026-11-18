import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAdapters,
  dispatchEnvelope,
  registerAdapter,
  silentLogger,
  type CredentialResolver,
} from '@fengsui/core';
import {
  createEmailAdapter,
  EMAIL_CHANNEL_IDS,
  EMAIL_PRESETS,
  resolveEmailTransport,
} from '@fengsui/adapter-email';
import { decodeRfc2047, flattenBodyText, parseMessage, parseMimeEntity } from './helpers/mime';
import { startTestSmtpServer, type TestSmtpServer } from './helpers/smtp-server';

const credentials: CredentialResolver = {
  async resolve(ref) {
    return { ref, values: { user: 'sender@example.com', pass: 'app-password' } };
  },
};

const emptyCredentials: CredentialResolver = {
  async resolve(ref) {
    return { ref, values: {} };
  },
};

let servers: TestSmtpServer[] = [];
let tempDirs: string[] = [];

beforeEach(() => {
  clearAdapters();
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs = [];
});

async function startServer(options?: Parameters<typeof startTestSmtpServer>[0]) {
  const server = await startTestSmtpServer(options);
  servers.push(server);
  return server;
}

function smtpEnvelope(
  port: number,
  overrides: {
    target?: unknown;
    content?: unknown;
    channelOptions?: Record<string, unknown>;
  } = {},
) {
  return {
    channel: 'email.smtp',
    action: 'send',
    target: overrides.target ?? { to: ['to@example.com'] },
    content: overrides.content ?? { subject: 'Hello', text: 'Hello' },
    channelOptions: {
      transport: { host: '127.0.0.1', port, secure: false },
      ...overrides.channelOptions,
    },
    credentialsRef: 'test/smtp',
  };
}

describe('email adapter', () => {
  it('sends text + html with subject, recipients, replyTo and correct Chinese encoding', async () => {
    const server = await startServer();
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(
      smtpEnvelope(server.port, {
        target: {
          to: ['to@example.com', 'second@example.com'],
          cc: ['cc@example.com'],
          bcc: ['bcc@example.com'],
        },
        content: {
          subject: '构建完成 #1234',
          text: '纯文本正文',
          html: '<b>HTML 正文</b>',
        },
        channelOptions: {
          replyTo: 'reply@example.com',
          headers: { 'X-Build-Id': '1234' },
        },
      }),
      { credentials },
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.results[0]?.providerMessageId).toBeTruthy();

    const message = server.messages[0];
    expect(message).toBeDefined();
    const parsed = parseMessage(message!.raw);

    expect(decodeRfc2047(parsed.headers.subject ?? '')).toBe('构建完成 #1234');
    expect(parsed.headers['reply-to']).toBe('reply@example.com');
    expect(parsed.headers['x-build-id']).toBe('1234');
    expect(parsed.headers['content-type']).toContain('multipart/alternative');

    const body = flattenBodyText(parseMimeEntity(message!.raw));
    expect(body).toContain('纯文本正文');
    expect(body).toContain('<b>HTML 正文</b>');

    expect(message!.mailFrom).toBe('sender@example.com');
    expect(message!.rcptTo).toEqual(
      expect.arrayContaining([
        'to@example.com',
        'second@example.com',
        'cc@example.com',
        'bcc@example.com',
      ]),
    );
  });

  it('sends local path and base64 data URL attachments', async () => {
    const server = await startServer();
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const directory = await mkdtemp(join(tmpdir(), 'fengsui-email-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'report.txt');
    await writeFile(filePath, 'local file body', 'utf8');

    const receipt = await dispatchEnvelope(
      smtpEnvelope(server.port, {
        content: {
          subject: 'Attachments',
          text: 'see attached',
          attachments: [
            { name: 'report.txt', path: filePath },
            {
              name: 'note.txt',
              url: `data:text/plain;base64,${Buffer.from('data-url-body').toString('base64')}`,
            },
          ],
        },
      }),
      { credentials },
    );

    expect(receipt.status).toBe('sent');
    const raw = server.messages[0]?.raw ?? '';

    expect(raw).toMatch(/filename="?report\.txt"?/);
    expect(raw).toContain(Buffer.from('local file body').toString('base64'));
    expect(raw).toMatch(/filename="?note\.txt"?/);
    expect(raw).toContain(Buffer.from('data-url-body').toString('base64'));
    expect(raw.toLowerCase()).toContain('content-disposition: attachment');
  });

  it('rejects remote attachment URLs instead of fetching them', async () => {
    const server = await startServer();
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(
      smtpEnvelope(server.port, {
        content: {
          subject: 'Remote attachment',
          text: 'see attached',
          attachments: [{ name: 'remote.txt', url: 'https://example.com/remote.txt' }],
        },
      }),
      { credentials, maxAttempts: 1 },
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({ errorCode: 'unsupported', attempts: 1 });
    expect(server.messages).toHaveLength(0);
  });

  it('degrades html-only content to text when html is not supported', async () => {
    const server = await startServer();
    registerAdapter(
      createEmailAdapter({ id: 'email.smtp', capabilities: { messageKinds: ['text', 'media'] } }),
    );

    const receipt = await dispatchEnvelope(
      smtpEnvelope(server.port, {
        content: { subject: 'Build', html: '<p>Hello <b>world</b></p>' },
      }),
      { credentials },
    );

    expect(receipt.degraded).toBe(true);
    expect(receipt.results[0]).toMatchObject({
      status: 'sent',
      degradedFrom: 'html',
      degradedTo: 'text',
    });

    const message = server.messages[0];
    expect(message).toBeDefined();
    const parsed = parseMessage(message!.raw);
    expect(parsed.headers['content-type']).toContain('text/plain');
    expect(parsed.headers['content-type']).not.toContain('text/html');
    expect(flattenBodyText(parseMimeEntity(message!.raw))).toContain('Hello world');
  });

  it('maps SMTP 535 to a non-retryable auth error', async () => {
    const server = await startServer({ rejectAuth: true });
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(smtpEnvelope(server.port), {
      credentials,
      maxAttempts: 3,
      sleep: async () => undefined,
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'auth',
      retryable: false,
      attempts: 1,
    });
    expect(receipt.error).toMatchObject({ code: 'auth', retryable: false });
  });

  it('maps SMTP 450 to a retryable network error', async () => {
    const server = await startServer({
      rejectRcptCode: 450,
      rejectRcptMessage: '450 4.2.0 Mailbox busy',
    });
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(smtpEnvelope(server.port), {
      credentials,
      maxAttempts: 2,
      sleep: async () => undefined,
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'network',
      retryable: true,
      attempts: 2,
    });
    expect(server.messages).toHaveLength(0);
  });

  it('maps a refused connection to a network error', async () => {
    const server = await startServer();
    const port = server.port;
    await server.close();
    servers = servers.filter((candidate) => candidate !== server);
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(smtpEnvelope(port), {
      credentials,
      maxAttempts: 1,
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'network',
      retryable: true,
      attempts: 1,
    });
  });

  it('returns a credentials error when the credential is missing', async () => {
    registerAdapter(createEmailAdapter({ id: 'email.smtp' }));

    const receipt = await dispatchEnvelope(smtpEnvelope(25_252), {
      credentials: emptyCredentials,
      maxAttempts: 1,
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'credentials',
      retryable: false,
      attempts: 1,
    });
  });

  it('verifies the SMTP connection through healthCheck', async () => {
    const server = await startServer();
    const adapter = createEmailAdapter({
      id: 'email.smtp',
      credentialsRef: 'test/smtp',
      transport: { host: '127.0.0.1', port: server.port, secure: false },
    });

    const health = await adapter.healthCheck!({
      credentials,
      logger: silentLogger,
      signal: new AbortController().signal,
      traceId: 'trace-health',
      tenantId: 'test',
    });

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('healthCheck resolves credentialsRef from ctx when preset was registered without one', async () => {
    const server = await startServer();
    // 模拟 registerEmailAdapters() 的批量注册：不传 credentialsRef
    const adapter = createEmailAdapter({
      id: 'email.smtp',
      transport: { host: '127.0.0.1', port: server.port, secure: false },
    });

    // ctx 提供 credentialsRef
    const health = await adapter.healthCheck!({
      credentials,
      credentialsRef: 'test/smtp',
      logger: silentLogger,
      signal: new AbortController().signal,
      traceId: 'trace-health-ctx',
      tenantId: 'test',
    });

    expect(health.ok).toBe(true);
  });
});

describe('email presets', () => {
  const expected: ReadonlyArray<readonly [string, string, number, boolean]> = [
    ['email.qq', 'smtp.qq.com', 465, true],
    ['email.gmail', 'smtp.gmail.com', 465, true],
    ['email.163', 'smtp.163.com', 465, true],
    ['email.126', 'smtp.126.com', 465, true],
    ['email.aliyun', 'smtp.qiye.aliyun.com', 465, true],
    ['email.sina', 'smtp.sina.com', 465, true],
    ['email.outlook', 'smtp-mail.outlook.com', 587, false],
    ['email.m365', 'smtp.office365.com', 587, false],
  ];

  it('registers every built-in email channel', () => {
    expect([...EMAIL_CHANNEL_IDS].sort()).toEqual(
      ['email.smtp', ...expected.map(([id]) => id)].sort(),
    );
    expect(EMAIL_PRESETS['email.smtp']?.requiresExplicitHost).toBe(true);
  });

  it.each(expected)('%s resolves host/port/secure from its preset', (id, host, port, secure) => {
    expect(resolveEmailTransport(id)).toMatchObject({ host, port, secure });
  });

  it('requires transport.host for email.smtp and allows overrides', () => {
    expect(() => resolveEmailTransport('email.smtp')).toThrow(/transport\.host/);
    expect(
      resolveEmailTransport('email.smtp', { host: 'mail.local', port: 2525, secure: false }),
    ).toEqual({ host: 'mail.local', port: 2525, secure: false, auth: 'password' });
    expect(resolveEmailTransport('email.qq', { host: '127.0.0.1', port: 1025 })).toEqual({
      host: '127.0.0.1',
      port: 1025,
      secure: true,
      auth: 'password',
    });
  });

  it('uses OAuth2 for Gmail, Outlook and Microsoft 365', () => {
    expect(resolveEmailTransport('email.gmail').auth).toBe('oauth2');
    expect(resolveEmailTransport('email.outlook').auth).toBe('oauth2');
    expect(resolveEmailTransport('email.m365').auth).toBe('oauth2');
    expect(resolveEmailTransport('email.qq').auth).toBe('password');
  });
});
