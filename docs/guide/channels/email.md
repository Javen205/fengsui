# 邮件 SMTP

> 最古老的信道，仍然是最可靠的那一条。

邮件渠道基于 nodemailer，内置常见邮箱服务商的连接参数（preset），你只需要提供凭证与正文。

## 安装与启用

邮件渠道是独立包，按需安装：

```bash
pnpm add @javen205/fengsui-core @javen205/fengsui-adapter-email
```

```ts
import { createFengsui, createEnvCredentialResolver } from '@javen205/fengsui-core';
import { emailPlugin } from '@javen205/fengsui-adapter-email';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  plugins: [emailPlugin()],
});
```

`emailPlugin()` 会一次性注册全部内置渠道：

| 渠道 ID | 服务商 | 默认端点 | 认证 |
| --- | --- | --- | --- |
| `email.smtp` | 通用 SMTP | 需显式提供 host | 密码 |
| `email.qq` | QQ 邮箱 | `smtp.qq.com:465` | 授权码 |
| `email.gmail` | Gmail | `smtp.gmail.com:465` | OAuth2 |
| `email.163` | 网易 163 | `smtp.163.com:465` | 密码/授权码 |
| `email.126` | 网易 126 | `smtp.126.com:465` | 密码/授权码 |
| `email.aliyun` | 阿里企业邮箱 | `smtp.qiye.aliyun.com:465` | 密码 |
| `email.sina` | 新浪邮箱 | `smtp.sina.com:465` | 密码 |
| `email.outlook` | Outlook | `smtp-mail.outlook.com:587` | OAuth2 |
| `email.m365` | Microsoft 365 | `smtp.office365.com:587` | OAuth2 |

只使用其中几个渠道时，可以用 `createEmailAdapter()` 手动注册，避免暴露多余渠道。

## 凭证

凭证通过 `credentialsRef` 解析，环境变量命名规则见[配置系统](/guide/configuration#凭证-配置里永远不写密钥)。

### 密码 / 授权码

```bash
FENGSUI_CRED_QQ_MAIN='{"user":"bot@qq.com","pass":"你的授权码"}'
```

```ts
await fengsui.send({
  channel: 'email.qq',
  action: 'send',
  credentialsRef: 'qq/main',
  content: { subject: '你好', text: '这是一封信。' },
  target: { to: ['someone@example.com'] },
});
```

::: tip QQ、163 等邮箱需要“授权码”
直接用登录密码通常会认证失败。请先在邮箱后台开启 SMTP 服务并生成授权码。
:::

### OAuth2

Gmail、Outlook、M365 使用 OAuth2。凭证支持两种形态：

```bash
# 已有 access token
FENGSUI_CRED_GMAIL_MAIN='{"user":"bot@gmail.com","accessToken":"ya29..."}'

# 用 refresh token 换取
FENGSUI_CRED_GMAIL_MAIN='{"user":"bot@gmail.com","clientId":"...","clientSecret":"...","refreshToken":"..."}'
```

`accessToken` 优先；缺失时才要求 `clientId` / `clientSecret` / `refreshToken` 三件套。

## 第一条邮件

```ts
const receipt = await fengsui.send({
  channel: 'email.qq',
  action: 'send',
  credentialsRef: 'qq/main',
  content: {
    subject: '烽燧已就绪',
    text: '纯文本正文。',
    html: '<p>富文本正文，<strong>可选</strong>。</p>',
  },
  target: {
    to: ['ops@example.com'],
    cc: ['lead@example.com'],
    bcc: ['audit@example.com'],
  },
});

console.log(receipt.status); // sent | partial | failed | skipped
```

`subject` 可以省略：适配器会取正文第一个非空行（去除 HTML 标签后）截断为 120 个字符。

## 渠道选项

`channelOptions` 是单次投递级配置，会与配置默认值深合并。

```ts
channelOptions: {
  from: '通知中心 <noreply@example.com>',
  replyTo: 'support@example.com',
  timeoutMs: 20000,
  pool: { maxConnections: 3, maxMessages: 100 },
  transport: { host: 'smtp.internal.example.com', port: 587, secure: false },
  headers: { 'X-Env': 'prod' },
}
```

| 字段 | 说明 |
| --- | --- |
| `from` | 发件人；省略时使用凭证里的 `user` |
| `replyTo` | 回复地址 |
| `timeoutMs` | SMTP 连接 / 问候 / socket 超时，默认 15000 |
| `pool` | `true` 或 `{ maxConnections, maxMessages }`；省略时每次新建连接 |
| `transport` | 覆盖 preset 的 `host` / `port` / `secure` |
| `headers` | 附加邮件头，保留头会被拒绝 |
| `charset` | 目前仅支持 `utf-8` |

::: warning 保留头不可覆盖
`From`、`To`、`Cc`、`Bcc`、`Subject`、`Message-ID`、`Date`、`Reply-To`、`Return-Path`、`MIME-Version`、`Content-Type` 等由适配器生成。尝试覆盖会直接报 `validation` 错误。
:::

## 附件

附件支持**本地路径**或 **`data:` URL**：

```ts
content: {
  subject: '月度报表',
  text: '详见附件。',
  attachments: [
    { name: 'report.pdf', path: './out/report.pdf', contentType: 'application/pdf' },
    { name: 'logo.png', url: 'data:image/png;base64,iVBORw0KGgo...' },
  ],
}
```

规则：

- 单个附件默认上限 25 MiB，可通过 `createEmailAdapter({ maxAttachmentBytes })` 调整；
- 提供 `size` 时会提前校验，避免读到一半才发现超限；
- **不会主动抓取 `http(s)` 远程附件**（防止 SSRF），请先下载到本地或使用 `data:` URL；
- 附件总大小与类型最终仍受服务商限制。

## 能力与降级

| 能力 | 声明 |
| --- | --- |
| 内容类型 | `text`、`html`、`media` |
| 附件 | `file`、`image`，默认上限 25 MiB |
| 批量 | 不支持（核心逐目标发送） |
| 模板 | 不支持 |
| 回执 | `sync` |
| 幂等 | `local` |
| dry-run | 支持 |
| 限流维度 | `account` |

默认降级链是 `{ html: ['text'] }`：渠道不支持 HTML 时降级为纯文本。实际是否降级由 `meta.options.fallback` 控制（默认 `degrade`）。

## 健康检查

```ts
const health = await fengsui.healthCheck('email.qq', {
  credentialsRef: 'qq/main',
});
```

健康检查会建立 SMTP 连接并执行 `verify()`，失败时返回 `{ ok: false, detail }`，不抛异常。

## 错误映射

SMTP 错误会被归类为统一的 `FengsuiError`：

| 情况 | `code` | 可重试 |
| --- | --- | --- |
| 4xx 临时失败 | `network` | 是 |
| 530 / 534 / 535 认证失败 | `auth` | 否 |
| 550 / 551 / 553 收件人拒绝 | `channel` | 否 |
| 552 / 554 内容被拒 | `channel` | 否 |
| 连接超时、DNS、连接重置 | `network` | 是 |
| 其他 | `channel` | 否 |

## 常见问题

**认证失败**  
确认使用的是授权码而不是登录密码；确认服务商已开启 SMTP；OAuth2 检查 token 是否过期或 scope 是否包含发信权限。

**连接超时**  
检查网络与端口。465 通常为隐式 TLS（`secure: true`），587 通常为 STARTTLS（`secure: false`）。

**部分收件人失败**  
查看回执 `results`，每个目标都有独立状态与服务商返回信息。

**附件发送失败**  
确认路径可读、大小未超限；远程 URL 不会被抓取，需要先落地成本地文件。

**发件人被拒**  
很多服务商要求 `from` 与认证账号一致或属于已验证域名。优先使用凭证里的 `user`，或配置已验证的发件地址。

下一步可以看看另一个真实实现：[企业微信机器人](/guide/channels/wecom-bot)。
