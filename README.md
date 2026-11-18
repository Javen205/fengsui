# 烽燧（fengsui）

统一消息发送工具。核心只保留框架，HTTP 传输与渠道都以插件形式提供：

- `@fengsui/core`：统一信封、能力匹配、校验、路由、重试/超时/fan-out、凭证解析、幂等存储与插件 API。
- `@fengsui/http`：`HttpClient` 契约，不含实现。
- `@fengsui/http-fetch`：基于 Node 原生 `fetch` 的默认传输。
- `@fengsui/http-axios`：基于 `axios` 的传输，`axios` 为 peer 依赖。
- `@fengsui/config-file`：从 JSON 文件读取配置，发送时可省略渠道与凭证等默认值，支持文件变更热刷新。
- `@fengsui/adapter-email`：邮件插件，含通用 `email.smtp` 与 `email.qq`、`email.gmail`、`email.163`、`email.126`、`email.aliyun`、`email.sina`、`email.outlook`、`email.m365` 八个 preset。
- `@fengsui/adapter-wecom-bot`：企业微信智能机器人插件，支持多机器人、WebSocket 长连接、入站 handler 与收发回复。

CLI 与 MCP Server 尚未实现；IM、短信、微信公众号渠道尚未实现。

## 已支持渠道

| Channel                   | 传输                            | 认证                           | 说明                                                             |
| ------------------------- | ------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `email.smtp`              | SMTP                            | 密码/授权码（`user` + `pass`） | 必须通过 `channelOptions.transport.host` 指定服务器              |
| `email.qq`                | smtp.qq.com:465                 | 授权码                         | 需先在邮箱开启 SMTP 服务                                         |
| `email.gmail`             | smtp.gmail.com:465              | OAuth2                         | 凭证需 `accessToken` 或 `clientId`/`clientSecret`/`refreshToken` |
| `email.163` / `email.126` | smtp.163.com / smtp.126.com:465 | 授权码                         | 需开启 SMTP 并完成短信校验                                       |
| `email.aliyun`            | smtp.qiye.aliyun.com:465        | 三方客户端安全密码             | 需管理员放开三方登录                                             |
| `email.sina`              | smtp.sina.com:465               | 密码                           | 需勾选 SMTP 身份验证                                             |
| `email.outlook`           | smtp-mail.outlook.com:587       | OAuth2                         | STARTTLS                                                         |
| `email.m365`              | smtp.office365.com:587          | OAuth2                         | 需管理员开启 SMTP AUTH                                           |
| `wecom.bot.<alias>`       | WebSocket 长连接                | `botId` + `secret`             | 企业微信智能机器人；每个机器人一个别名与一条连接                 |

```ts
import { createEnvCredentialResolver, createFengsui } from '@fengsui/core';
import { createFetchHttpClient } from '@fengsui/http-fetch';
import { emailPlugin } from '@fengsui/adapter-email';

const fengsui = createFengsui({
  http: createFetchHttpClient(),
  credentials: createEnvCredentialResolver(),
  plugins: [emailPlugin()],
});

const receipt = await fengsui.send({
  channel: 'email.qq',
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: '构建完成', text: '构建 #1234 已通过' },
  credentialsRef: 'tenant-a/qq-main',
});
```

邮件凭证通过环境变量 `FENGSUI_CRED_TENANT_A_QQ_MAIN` 提供（JSON 对象或单值），支持字段 `user`、`pass`、`clientId`、`clientSecret`、`refreshToken`、`accessToken`。

## 配置默认值

发送时不必重复填写渠道与凭证。把默认值写进配置文件，信封只保留业务字段：

```json
{
  "version": 1,
  "defaults": {
    "channel": "email.qq",
    "channelOptions": { "timeoutMs": 10000 }
  },
  "projects": {
    "billing": {
      "credentialsRef": "billing/qq-main",
      "channelOptions": { "from": "noreply@example.com" }
    }
  }
}
```

```ts
import { createEnvCredentialResolver, createFengsui } from '@fengsui/core';
import { fileConfig } from '@fengsui/config-file';
import { emailPlugin } from '@fengsui/adapter-email';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  config: fileConfig({ path: './fengsui.config.json', watch: true }),
  plugins: [emailPlugin()],
});

await fengsui.send({
  action: 'send',
  meta: { projectId: 'billing' },
  target: { to: ['ops@example.com'] },
  content: { subject: '构建完成', text: '构建 #1234 已通过' },
});
```

优先级从低到高：preset → 适配器构造参数 → 配置 `defaults` → 项目继承链 → `channels.<channelId>` → 信封显式字段。配置只允许 `credentialsRef`，禁止内联密钥；来源可替换，SQLite / MySQL / Redis 后续按同一个 `ConfigProvider` 契约提供。

换传输只改一行注入：

```ts
import { createAxiosHttpClient } from '@fengsui/http-axios';
// http: createFetchHttpClient() → http: createAxiosHttpClient()
```

## 企业微信智能机器人

每个机器人对应一个渠道 `wecom.bot.<alias>`。`alias` 只允许小写字母、数字与连字符，`botId` 写在代码里，`secret` 通过 `credentialsRef` 解析（默认 `wecom/<alias>`）：

```bash
FENGSUI_CRED_WECOM_SUPPORT='{"secret":"..."}'
```

```ts
import { createEnvCredentialResolver, createFengsui } from '@fengsui/core';
import { wecomBotPlugin } from '@fengsui/adapter-wecom-bot';

const plugin = wecomBotPlugin({
  bots: [
    { alias: 'support', botId: 'support-bot-id' },
    { alias: 'sales', botId: 'sales-bot-id' },
  ],
  handlers: {
    // 返回 { markdown } 时插件自动回复；返回 { handled: true } 短路后续 handler
    'message.text': async ({ message }) => ({ markdown: `收到：${message.text ?? ''}` }),
    'message.image': async ({ message, reply }) => {
      const image = message.images?.[0];
      if (image !== undefined) {
        const file = await reply.download(image.url, image.aesKey);
        // 转业务逻辑：OCR、存档、审核……
      }
    },
    'event.enter_chat': async ({ reply }) => {
      await reply.welcome({ msgtype: 'text', text: { content: '你好，有什么可以帮你？' } });
      return { handled: true };
    },
  },
});

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  plugins: [plugin],
});

await fengsui.start(); // 建连；只发不收时也可省略，首次 send() 会懒连接
plugin.bots.status('support'); // 连接状态、最近认证时间、重连次数与最后错误

await fengsui.send({
  channel: 'wecom.bot.support',
  action: 'send',
  target: { chatId: 'userid-or-chatid' },
  content: { markdown: '**构建成功**' },
});

await fengsui.close(); // 断开全部连接
```

- **入站事件**：`message.text` / `message.image` / `message.mixed` / `message.voice` / `message.file` / `message.video`、`event.enter_chat`、`event.template_card_event`、`event.feedback_event`、`event.disconnected_event`，以及兜底 `*`。
- **回复 API**：`text`、`markdown`、`stream`、`welcome`、`card`、`streamWithCard`、`updateCard`、`media`、`upload`、`sendTo`、`download`。
- **出站限制**：主动推送只支持 Markdown 与模板卡片；卡片通过 `channelOptions.card` 传入。文本按 Markdown 发送。
- **去重**：默认 10 分钟窗口（`dedupeTtlMs`），按渠道 + `msgid` 去重。
- **单连接约束**：一个 `botId` 只能有一条长连接；多副本部署时只让一个副本调用 `fengsui.start()`，或引入选主。

## 入口

| 包 | 作用 |
| --- | --- |
| `@fengsui/core` | 信封、校验、投递、注册表、插件 API、`createFengsui()` |
| `@fengsui/http` | `HttpClient` 契约与 `HttpTransportError` |
| `@fengsui/http-fetch` | 原生 `fetch` 实现 |
| `@fengsui/http-axios` | `axios` 实现 |
| `@fengsui/config-file` | JSON 配置文件来源（可选 watch） |
| `@fengsui/adapter-email` | 邮件渠道插件 |
| `@fengsui/adapter-wecom-bot` | 企业微信智能机器人插件 |

## 命令

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## 目录

```text
packages/
├── core/            # @fengsui/core：envelope / adapter / credentials / registry / idempotency / dispatcher / plugin / fengsui
├── http/            # @fengsui/http：HttpClient 契约
├── http-fetch/      # @fengsui/http-fetch：fetch 实现
├── http-axios/      # @fengsui/http-axios：axios 实现
├── config-file/     # @fengsui/config-file：JSON 配置来源与文件监听
├── adapter-email/   # @fengsui/adapter-email：nodemailer 邮件 adapter、preset、错误映射
└── adapter-wecom-bot/ # @fengsui/adapter-wecom-bot：企业微信机器人长连接、入站路由与回复器
docs/                # 设计方案与调研
```

## 工程约定

- **模块解析用 Bundler**：源码由 tsup 打包为自包含的 ESM/CJS 产物，不产生相对 import，因此不需要 NodeNext 的 `.js` 后缀约束；类型检查与打包语义保持一致。
- **多包 workspace**：根 `package.json` 为 private，不对外发布；各包独立 `package.json`/`tsconfig`/`tsup.config`，内部依赖统一 `workspace:^`。
- **依赖收口**：`zod` 只在 core，`nodemailer` 只在邮件插件，`axios` 只作为 HTTP axios 插件的 peer；不装插件就不会引入对应依赖。
- **测试**：`vitest.config.ts` 统一收集 `packages/*/test`，通过 alias 直接指向各包 `src`，无需先构建。
- **插件优先**：新增渠道或传输时新建 `packages/adapter-*` / `packages/http-*`，不在 core 内加实现。
