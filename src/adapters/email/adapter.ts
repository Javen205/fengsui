import { createTransport } from 'nodemailer';
import type { SendMailOptions, Transporter } from 'nodemailer';

import type {
  AdapterContext,
  AdapterNormalizeInput,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelFallbacks,
  ChannelSendOutcome,
  NormalizedMessage,
  ResolvedCredential,
} from '../../core';
import { FengsuiError } from '../../core';
import { normalizeSmtpError } from './errors';
import {
  EMAIL_SMTP_CHANNEL,
  getEmailPreset,
  resolveEmailTransport,
  type EmailAuthType,
  type ResolvedEmailTransport,
} from './presets';
import { emailChannelOptionsSchema, type EmailChannelOptions } from './schema';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const BASE_CAPABILITIES: ChannelCapabilities = {
  messageKinds: ['text', 'html', 'media'],
  attachments: { maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES, kinds: ['file', 'image'] },
  mentions: false,
  batch: false,
  templates: false,
  receipts: 'sync',
  rateLimit: { scope: 'account' },
  idempotency: 'local',
  dryRun: true,
};

const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'message-id',
  'date',
  'reply-to',
  'return-path',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

const DATA_URL_PATTERN = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

interface SentMailInfo {
  messageId?: string;
  response?: string;
  accepted?: unknown[];
  rejected?: unknown[];
}

export interface EmailAdapterOptions {
  /** Defaults to `email.smtp`. */
  id?: string;
  /** Credentials ref used by `healthCheck`, which has no envelope to read it from. */
  credentialsRef?: string;
  /** Adapter-level transport overrides, mainly for tests and `email.smtp` health checks. */
  transport?: {
    host?: string | undefined;
    port?: number | undefined;
    secure?: boolean | undefined;
  };
  capabilities?: Partial<ChannelCapabilities>;
  fallbacks?: ChannelFallbacks;
  maxAttachmentBytes?: number;
}

export function createEmailAdapter(
  options: EmailAdapterOptions = {},
): ChannelAdapter<EmailChannelOptions> {
  const channelId = options.id ?? EMAIL_SMTP_CHANNEL;
  if (getEmailPreset(channelId) === undefined) {
    throw new Error(`Unknown email channel "${channelId}"`);
  }

  const capabilities: ChannelCapabilities = {
    ...BASE_CAPABILITIES,
    attachments: {
      maxBytes: options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
      kinds: ['file', 'image'],
    },
    ...options.capabilities,
  };
  const fallbacks: ChannelFallbacks = options.fallbacks ?? { html: ['text'] };
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const defaultCredentialsRef = options.credentialsRef;

  return {
    id: channelId,
    schema: emailChannelOptionsSchema,
    capabilities: () => capabilities,
    fallbacks,

    normalize(
      input: AdapterNormalizeInput<EmailChannelOptions>,
    ): NormalizedMessage<EmailChannelOptions> {
      return {
        channel: channelId,
        action: input.envelope.action,
        target: input.target,
        content: input.content,
        options: input.options,
        credentialsRef: input.envelope.credentialsRef,
        idempotencyKey: input.envelope.meta?.idempotencyKey,
        degradedFrom: input.degradedFrom,
        degradedTo: input.degradedTo,
      };
    },

    async send(
      message: NormalizedMessage<EmailChannelOptions>,
      ctx: AdapterContext,
    ): Promise<ChannelSendOutcome> {
      const ref = message.credentialsRef ?? defaultCredentialsRef;
      if (ref === undefined) {
        throw new FengsuiError({
          code: 'credentials',
          message: `Email adapter "${channelId}" requires credentialsRef`,
          channel: channelId,
        });
      }
      if (ctx.signal.aborted) {
        throw new FengsuiError({
          code: 'network',
          message: 'Email send aborted before the SMTP conversation started',
          retryable: false,
          channel: channelId,
        });
      }

      const credential = await ctx.credentials.resolve(ref);
      const channelOptions = message.options;
      const transportConfig = resolveTransportOrThrow(channelId, {
        transport: { ...options.transport, ...channelOptions.transport },
      });
      const auth = resolveAuth(channelId, transportConfig.auth, credential);
      const mail = await buildMail({
        channelId,
        message,
        from: channelOptions.from ?? credential.values.user,
        maxAttachmentBytes,
      });

      const transporter = createTransport({
        host: transportConfig.host,
        port: transportConfig.port,
        secure: transportConfig.secure,
        auth,
        ...buildPoolOptions(channelOptions.pool),
        connectionTimeout: channelOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        greetingTimeout: channelOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        socketTimeout: channelOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      try {
        const info = (await transporter.sendMail(mail)) as SentMailInfo;
        const accepted = info.accepted ?? [];
        const rejected = info.rejected ?? [];
        if (accepted.length === 0 && rejected.length > 0) {
          throw new FengsuiError({
            code: 'channel',
            message: `SMTP server rejected all recipients: ${rejected.map(String).join(', ')}`,
            channel: channelId,
            ...(info.response !== undefined ? { providerMessage: info.response } : {}),
            details: { rejected },
          });
        }

        return {
          ...(info.messageId !== undefined ? { providerMessageId: info.messageId } : {}),
          ...(info.response !== undefined ? { providerMessage: info.response } : {}),
        };
      } catch (error) {
        throw normalizeSmtpError(error, channelId);
      } finally {
        if (isPoolEnabled(channelOptions.pool)) {
          closeTransporter(transporter);
        }
      }
    },

    async healthCheck(ctx: AdapterContext) {
      // Prefer the per-invocation ref from ctx (e.g. set by a health-check runner),
      // fall back to the adapter-level defaultRef set at construction time.
      const ref = ctx.credentialsRef ?? defaultCredentialsRef;
      const startedAt = Date.now();
      const checkedAt = new Date(startedAt).toISOString();

      if (ref === undefined) {
        return {
          ok: false,
          checkedAt,
          detail:
            'healthCheck requires credentialsRef: either register with createEmailAdapter({ credentialsRef }) ' +
            'or provide ctx.credentialsRef when invoking healthCheck',
        };
      }

      try {
        const credential = await ctx.credentials.resolve(ref);
        const transportConfig = resolveTransportOrThrow(channelId, {
          transport: options.transport,
        });
        const auth = resolveAuth(channelId, transportConfig.auth, credential);
        const transporter = createTransport({
          host: transportConfig.host,
          port: transportConfig.port,
          secure: transportConfig.secure,
          auth,
          connectionTimeout: DEFAULT_TIMEOUT_MS,
          greetingTimeout: DEFAULT_TIMEOUT_MS,
          socketTimeout: DEFAULT_TIMEOUT_MS,
        });

        try {
          await transporter.verify();
          return { ok: true, checkedAt, latencyMs: Date.now() - startedAt };
        } finally {
          closeTransporter(transporter);
        }
      } catch (error) {
        const normalized =
          error instanceof FengsuiError ? error : normalizeSmtpError(error, channelId);
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          detail: `${normalized.code}: ${normalized.message}`,
        };
      }
    },
  };
}

interface BuildMailArgs {
  channelId: string;
  message: NormalizedMessage<EmailChannelOptions>;
  from: string | undefined;
  maxAttachmentBytes: number;
}

async function buildMail(args: BuildMailArgs): Promise<SendMailOptions> {
  const { channelId, message, maxAttachmentBytes } = args;
  const { content, target, options } = message;

  const to = target?.to ?? [];
  if (to.length === 0) {
    throw new FengsuiError({
      code: 'validation',
      message: `Email channel "${channelId}" requires target.to`,
      channel: channelId,
    });
  }
  if (content.text === undefined && content.html === undefined) {
    throw new FengsuiError({
      code: 'validation',
      message: `Email channel "${channelId}" requires content.text or content.html`,
      channel: channelId,
    });
  }
  if (args.from === undefined) {
    throw new FengsuiError({
      code: 'credentials',
      message: `Email channel "${channelId}" requires a credential field "user" or channelOptions.from`,
      channel: channelId,
    });
  }

  const mail: SendMailOptions = {
    from: args.from,
    to: [...to],
    subject: content.subject ?? deriveSubject(content),
    text: content.text,
    html: content.html,
  };

  const cc = target?.cc ?? [];
  const bcc = target?.bcc ?? [];
  if (cc.length > 0) {
    mail.cc = [...cc];
  }
  if (bcc.length > 0) {
    mail.bcc = [...bcc];
  }
  if (options.replyTo !== undefined) {
    mail.replyTo = options.replyTo;
  }

  const headers = sanitizeHeaders(channelId, options.headers);
  if (headers !== undefined) {
    mail.headers = headers;
  }

  if (content.attachments !== undefined && content.attachments.length > 0) {
    mail.attachments = await buildAttachments(channelId, content.attachments, maxAttachmentBytes);
  }

  return mail;
}

function deriveSubject(content: NormalizedMessage['content']): string {
  const firstLine =
    content.text?.split(/\r?\n/).find((line) => line.trim().length > 0) ??
    (content.html !== undefined ? content.html.replace(/<[^>]*>/g, ' ').trim() : undefined);
  return firstLine !== undefined && firstLine.length > 0 ? firstLine.slice(0, 120) : '(no subject)';
}

async function buildAttachments(
  channelId: string,
  attachments: NonNullable<NormalizedMessage['content']['attachments']>,
  maxAttachmentBytes: number,
): Promise<NonNullable<SendMailOptions['attachments']>> {
  const built: NonNullable<SendMailOptions['attachments']> = [];

  for (const attachment of attachments) {
    if (attachment.size !== undefined && attachment.size > maxAttachmentBytes) {
      throw new FengsuiError({
        code: 'validation',
        message: `Attachment "${attachment.name}" is ${attachment.size} bytes, which exceeds the ${maxAttachmentBytes} byte email limit`,
        channel: channelId,
        details: { attachment: attachment.name, size: attachment.size, maxAttachmentBytes },
      });
    }

    if (attachment.path !== undefined) {
      built.push({
        filename: attachment.name,
        path: attachment.path,
        ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
      });
      continue;
    }

    if (attachment.url !== undefined) {
      if (attachment.url.startsWith('http://') || attachment.url.startsWith('https://')) {
        throw new FengsuiError({
          code: 'unsupported',
          message: `Remote attachment URLs are not fetched (SSRF protection); use a local path or a data: URL for "${attachment.name}"`,
          channel: channelId,
          details: { attachment: attachment.name },
        });
      }

      const match = DATA_URL_PATTERN.exec(attachment.url);
      if (match === null) {
        throw new FengsuiError({
          code: 'unsupported',
          message: `Attachment "${attachment.name}" must provide a local path or a data: URL`,
          channel: channelId,
          details: { attachment: attachment.name },
        });
      }

      const [, mediaType, base64Flag, payload = ''] = match;
      const buffer =
        base64Flag === ';base64'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload), 'utf8');

      if (buffer.byteLength > maxAttachmentBytes) {
        throw new FengsuiError({
          code: 'validation',
          message: `Attachment "${attachment.name}" is ${buffer.byteLength} bytes, which exceeds the ${maxAttachmentBytes} byte email limit`,
          channel: channelId,
          details: {
            attachment: attachment.name,
            size: buffer.byteLength,
            maxAttachmentBytes,
          },
        });
      }

      const contentType = attachment.contentType ?? mediaType;
      built.push({
        filename: attachment.name,
        content: buffer,
        ...(contentType !== undefined ? { contentType } : {}),
      });
      continue;
    }

    throw new FengsuiError({
      code: 'validation',
      message: `Attachment "${attachment.name}" requires either path or url (data: URL)`,
      channel: channelId,
      details: { attachment: attachment.name },
    });
  }

  return built;
}

function sanitizeHeaders(
  channelId: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new FengsuiError({
        code: 'validation',
        message: `Invalid header name "${name}"`,
        channel: channelId,
        details: { header: name },
      });
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new FengsuiError({
        code: 'validation',
        message: `Header "${name}" is managed by the adapter and cannot be overridden`,
        channel: channelId,
        details: { header: name },
      });
    }
    if (/[\r\n]/.test(value)) {
      throw new FengsuiError({
        code: 'validation',
        message: `Header "${name}" must not contain CR/LF`,
        channel: channelId,
        details: { header: name },
      });
    }
    result[name] = value;
  }

  return result;
}

function resolveTransportOrThrow(
  channelId: string,
  options: EmailChannelOptions,
): ResolvedEmailTransport {
  try {
    return resolveEmailTransport(channelId, options.transport ?? {});
  } catch (error) {
    throw new FengsuiError({
      code: 'validation',
      message: error instanceof Error ? error.message : String(error),
      channel: channelId,
      cause: error,
    });
  }
}

type EmailAuth =
  | { user: string; pass: string }
  | { type: 'OAuth2'; user: string; accessToken: string }
  | { type: 'OAuth2'; user: string; clientId: string; clientSecret: string; refreshToken: string };

function resolveAuth(
  channelId: string,
  authType: EmailAuthType,
  credential: ResolvedCredential,
): EmailAuth {
  const values = credential.values;
  const user = values.user;
  if (user === undefined || user.length === 0) {
    throw new FengsuiError({
      code: 'credentials',
      message: `Credential "${credential.ref}" is missing "user"`,
      channel: channelId,
      details: { ref: credential.ref },
    });
  }

  if (authType === 'oauth2') {
    if (values.accessToken !== undefined && values.accessToken.length > 0) {
      return { type: 'OAuth2', user, accessToken: values.accessToken };
    }

    const { clientId, clientSecret, refreshToken } = values;
    if (
      clientId === undefined ||
      clientSecret === undefined ||
      refreshToken === undefined ||
      refreshToken.length === 0
    ) {
      throw new FengsuiError({
        code: 'credentials',
        message: `Credential "${credential.ref}" requires accessToken or clientId/clientSecret/refreshToken for OAuth2`,
        channel: channelId,
        details: { ref: credential.ref },
      });
    }
    return { type: 'OAuth2', user, clientId, clientSecret, refreshToken };
  }

  if (values.pass === undefined || values.pass.length === 0) {
    throw new FengsuiError({
      code: 'credentials',
      message: `Credential "${credential.ref}" is missing "pass" (password or app password)`,
      channel: channelId,
      details: { ref: credential.ref },
    });
  }
  return { user, pass: values.pass };
}

function buildPoolOptions(pool: EmailChannelOptions['pool']): {
  pool?: boolean;
  maxConnections?: number;
  maxMessages?: number;
} {
  if (pool === undefined || pool === false) {
    return {};
  }
  if (pool === true) {
    return { pool: true };
  }
  return {
    pool: true,
    ...(pool.maxConnections !== undefined ? { maxConnections: pool.maxConnections } : {}),
    ...(pool.maxMessages !== undefined ? { maxMessages: pool.maxMessages } : {}),
  };
}

function isPoolEnabled(pool: EmailChannelOptions['pool']): boolean {
  return pool === true || (typeof pool === 'object' && pool !== null);
}

function closeTransporter(transporter: Transporter): void {
  transporter.close();
}

export function createEmailAdapters(): ReadonlyArray<ChannelAdapter<EmailChannelOptions>> {
  return [
    EMAIL_SMTP_CHANNEL,
    'email.qq',
    'email.gmail',
    'email.163',
    'email.126',
    'email.aliyun',
    'email.sina',
    'email.outlook',
    'email.m365',
  ].map((id) => createEmailAdapter({ id }));
}
