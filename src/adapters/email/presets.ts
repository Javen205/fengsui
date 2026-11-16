export type EmailAuthType = 'password' | 'oauth2';

export interface EmailPreset {
  readonly id: string;
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly auth: EmailAuthType;
  /** `email.smtp` has no built-in endpoint and requires `channelOptions.transport.host`. */
  readonly requiresExplicitHost?: boolean;
}

export const EMAIL_SMTP_CHANNEL = 'email.smtp';

export const EMAIL_PRESETS: Readonly<Record<string, EmailPreset>> = {
  'email.smtp': { id: 'email.smtp', auth: 'password', requiresExplicitHost: true },
  'email.qq': { id: 'email.qq', host: 'smtp.qq.com', port: 465, secure: true, auth: 'password' },
  'email.gmail': {
    id: 'email.gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: 'oauth2',
  },
  'email.163': { id: 'email.163', host: 'smtp.163.com', port: 465, secure: true, auth: 'password' },
  'email.126': { id: 'email.126', host: 'smtp.126.com', port: 465, secure: true, auth: 'password' },
  'email.aliyun': {
    id: 'email.aliyun',
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    auth: 'password',
  },
  'email.sina': {
    id: 'email.sina',
    host: 'smtp.sina.com',
    port: 465,
    secure: true,
    auth: 'password',
  },
  'email.outlook': {
    id: 'email.outlook',
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    auth: 'oauth2',
  },
  'email.m365': {
    id: 'email.m365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: 'oauth2',
  },
};

export const EMAIL_CHANNEL_IDS: ReadonlyArray<string> = Object.keys(EMAIL_PRESETS);

export function getEmailPreset(channelId: string): EmailPreset | undefined {
  return EMAIL_PRESETS[channelId];
}

export interface EmailTransportOverrides {
  host?: string | undefined;
  port?: number | undefined;
  secure?: boolean | undefined;
}

export interface ResolvedEmailTransport {
  host: string;
  port: number;
  secure: boolean;
  auth: EmailAuthType;
}

/**
 * Merges a preset with `channelOptions.transport` overrides.
 * `email.smtp` has no host of its own and therefore must be configured explicitly.
 */
export function resolveEmailTransport(
  channelId: string,
  overrides: EmailTransportOverrides = {},
): ResolvedEmailTransport {
  const preset = getEmailPreset(channelId);
  if (preset === undefined) {
    throw new Error(`Unknown email channel "${channelId}"`);
  }

  const host = overrides.host ?? preset.host;
  if (host === undefined) {
    throw new Error(
      `Email channel "${channelId}" requires channelOptions.transport.host to be configured`,
    );
  }

  const port = overrides.port ?? preset.port ?? 465;
  const secure = overrides.secure ?? preset.secure ?? port === 465;

  return { host, port, secure, auth: preset.auth };
}
