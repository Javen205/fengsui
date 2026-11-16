# 烽燧（fengsui）

统一消息发送工具的骨架。当前已落地：

- 统一信封的 Zod schema、解析结果类型、能力与回执类型、统一错误模型。
- 可替换的 HTTP 传输层：默认基于 Node 原生 `fetch`，支持注入自定义 `HttpClient`。
- Core 投递骨架：Adapter 契约、注册表、环境变量凭证解析、内存幂等存储，以及投递器的校验、能力降级、重试、超时、fan-out 与 dry-run。
- 邮件渠道（基于 `nodemailer`）：通用 `email.smtp`，以及 `email.qq`、`email.gmail`、`email.163`、`email.126`、`email.aliyun`、`email.sina`、`email.outlook`、`email.m365` 八个 preset。

CLI 与 MCP Server 尚未实现；IM、短信、微信渠道尚未实现。

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

```ts
import {
  createEmailAdapter,
  registerAdapter,
  dispatchEnvelope,
  createEnvCredentialResolver,
  createFetchHttpClient,
} from 'fengsui';

registerAdapter(createEmailAdapter({ id: 'email.qq' }));

const receipt = await dispatchEnvelope(
  {
    channel: 'email.qq',
    action: 'send',
    target: { to: ['ops@example.com'] },
    content: { subject: '构建完成', text: '构建 #1234 已通过' },
    credentialsRef: 'tenant-a/qq-main',
  },
  {
    http: createFetchHttpClient(),
    credentials: createEnvCredentialResolver(),
  },
);
```

邮件凭证通过环境变量 `FENGSUI_CRED_TENANT_A_QQ_MAIN` 提供（JSON 对象或单值），支持字段 `user`、`pass`、`clientId`、`clientSecret`、`refreshToken`、`accessToken`。

## 入口

```ts
import { parseEnvelope, FengsuiError } from 'fengsui/core';
import { createFetchHttpClient } from 'fengsui/http';
```

同时提供根入口：

```ts
import { parseEnvelope, createFetchHttpClient } from 'fengsui';
```

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
src/
├── core/
│   ├── envelope/      # 信封 schema 与解析
│   ├── adapter/       # ChannelAdapter / AdapterContext 契约
│   ├── credentials/   # EnvCredentialResolver
│   ├── registry/      # adapter 注册与建议
│   ├── idempotency/   # IdempotencyStore 与内存实现
│   └── dispatcher/    # 投递、降级、重试、超时、汇总
├── adapters/
│   └── email/         # nodemailer 邮件 adapter、preset、错误映射
├── http/              # HttpClient 类型与 fetch 实现
└── index.ts           # 根入口
tests/                 # 单元测试、fake adapter 与本地 SMTP helper
docs/                  # 设计方案与调研
```

## 工程约定

- **模块解析用 Bundler**：源码由 tsup 打包为自包含的 ESM/CJS 产物，不产生相对 import，因此不需要 NodeNext 的 `.js` 后缀约束；类型检查与打包语义保持一致。
- **单包**：不建 monorepo，通过 `exports` 暴露 `fengsui`、`fengsui/core`、`fengsui/http`。
