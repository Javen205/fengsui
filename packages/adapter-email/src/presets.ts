/**
 * 邮件认证方式。
 * - `password`：SMTP 用户名 + 密码/授权码；
 * - `oauth2`：OAuth2 访问令牌（或 refreshToken 换取），常见于 Gmail / Outlook / M365。
 */
export type EmailAuthType = 'password' | 'oauth2';

/**
 * 内置邮箱服务商的连接参数（全局默认值）。
 *
 * 这里只放公开的端点信息，**不放任何凭证**；凭证始终通过 `credentialsRef` 解析。
 * 单次投递可用 `channelOptions.transport` 覆盖 host/port/secure。
 */
export interface EmailPreset {
  /** 渠道 ID，如 `email.qq`。 */
  readonly id: string;
  /** SMTP 主机；`email.smtp` 不内置，必须由调用方提供。 */
  readonly host?: string;
  /** 端口，465 通常为隐式 TLS，587 通常为 STARTTLS。 */
  readonly port?: number;
  /** 是否使用隐式 TLS（`secure: true`）。 */
  readonly secure?: boolean;
  /** 认证方式，决定需要哪些凭证字段。 */
  readonly auth: EmailAuthType;
  /** 是否必须显式提供 host（`email.smtp` 为 true）。 */
  readonly requiresExplicitHost?: boolean;
}

/** 通用 SMTP 渠道 ID；没有内置端点，需在 `channelOptions.transport` 中指定。 */
export const EMAIL_SMTP_CHANNEL = 'email.smtp';

/**
 * 内置邮箱 preset 表。
 *
 * 作用：提供各服务商的默认 host/port/TLS 与认证方式，避免每次发送重复配置。
 * 不包含凭证、发件人、超时、连接池等运行时配置，这些分别由
 * `credentialsRef`、`channelOptions.from`、`channelOptions.timeoutMs`、
 * `channelOptions.pool` 提供。
 */
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

/** 全部内置邮件渠道 ID，供插件批量注册。 */
export const EMAIL_CHANNEL_IDS: ReadonlyArray<string> = Object.keys(EMAIL_PRESETS);

/** 按渠道 ID 取 preset；未知渠道返回 `undefined`。 */
export function getEmailPreset(channelId: string): EmailPreset | undefined {
  return EMAIL_PRESETS[channelId];
}

/**
 * 单次投递的传输覆盖项，来自信封的 `channelOptions.transport`。
 *
 * 优先级最高：会覆盖 preset 的默认端点。
 */
export interface EmailTransportOverrides {
  host?: string | undefined;
  port?: number | undefined;
  secure?: boolean | undefined;
}

/** 合并 preset 与覆盖项后的最终连接参数。 */
export interface ResolvedEmailTransport {
  host: string;
  port: number;
  secure: boolean;
  auth: EmailAuthType;
}

/**
 * 合并 preset 与单次覆盖项，得到最终 SMTP 连接参数。
 *
 * 合并优先级：`channelOptions.transport` > preset 默认值 > 端口推断。
 * `email.smtp` 没有内置 host，未显式提供时抛错。
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
