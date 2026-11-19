# 使用指南

这一页覆盖“发一条消息”背后的完整契约：信封、目标、降级、重试、幂等、回执与错误。

## 信封

信封是调用方与核心之间唯一的输入契约：

```ts
await fengsui.send({
  version: 1,
  channel: 'email.qq',
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: '标题', text: '正文' },
  channelOptions: { from: 'bot@qq.com' },
  credentialsRef: 'qq/main',
  meta: {
    projectId: 'billing',
    traceId: 'trace-123',
    idempotencyKey: 'deploy-1234',
    tags: { source: 'ci' },
    options: { fallback: 'degrade', timeoutMs: 10_000 },
  },
});
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 否 | 固定为 `1`，默认 `1` |
| `channel` | 否 | 渠道 ID，如 `email.qq`、`wecom.bot.support`；省略时取配置默认值 |
| `action` | 是 | 动作名，由适配器解释，常用 `send` |
| `target` | 否 | 单个目标对象或目标数组；数组表示 fan-out |
| `content` | 是 | 正文：`subject` / `text` / `html` / `markdown` / `attachments` / `data` / `url` |
| `channelOptions` | 否 | 单次投递的渠道选项，由适配器 schema 二次校验 |
| `credentialsRef` | 否 | 凭证引用 `tenant/account`；省略时取配置或适配器默认值 |
| `meta` | 否 | 追踪、幂等、项目、标签与本次选项 |

所有对象都是 `.strict()`：写错字段会直接报错，而不是被静默忽略。信封与 `channelOptions` 中禁止出现 `password`、`secret`、`token` 等内联密钥。

## 目标与 fan-out

`target` 的字段按渠道解释：

| 字段 | 典型渠道 |
| --- | --- |
| `to` / `cc` / `bcc` | 邮件 |
| `userIds` / `chatId` | IM、企业微信 |
| `phoneNumbers` | 短信 |
| `openIds` | 微信 |
| `departmentIds` / `tagIds` | 组织类渠道 |

传数组表示多组目标：每个目标独立重试、独立超时、独立回执。某个收件人失败不会影响其他收件人。

## 能力协商与降级

每个适配器声明自己的能力：

```ts
{
  messageKinds: ['text', 'mail'],
  attachments: { maxBytes: 20 * 1024 * 1024, kinds: ['image', 'file'] },
  mentions: false,
  batch: false,
  templates: true,
  receipts: 'sync',
  rateLimit: { scope: 'account' },
  idempotency: 'local',
  dryRun: true,
}
```

投递器会根据 `content` 推断消息类型，并与 `messageKinds` 比对。不支持时：

- `meta.options.fallback = 'degrade'`（默认）：按适配器的 `fallbacks` 链降级，例如 `html → text`；
- `meta.options.fallback = 'reject'`：直接抛 `unsupported`。

回执会带 `degraded: true` 与逐目标的 `degradedFrom` / `degradedTo`，方便确认实际发送形态。

## 重试、超时与取消

```ts
const controller = new AbortController();

await fengsui.send(envelope, { signal: controller.signal });
```

| 配置 | 位置 | 默认值 |
| --- | --- | --- |
| 总尝试次数 | `createFengsui({ maxAttempts })` | `3`（含首次） |
| 单次尝试超时 | `createFengsui({ attemptTimeoutMs })` | `15000` ms |
| 本次超时 | `meta.options.timeoutMs` | 覆盖全局 |
| 取消 | `send(envelope, { signal })` | 无 |

只有错误标记为 `retryable` 才会重试；`validation`、`credentials`、`auth` 等不会浪费次数。重试按指数退避并加入抖动。

## 幂等

```ts
await fengsui.send({
  ...envelope,
  meta: { idempotencyKey: 'order-1024-shipped' },
});
```

- 幂等键最终形如 `tenantId:channel:idempotencyKey`；
- 命中历史回执时不再发送，返回 `deduplicated: true`；
- 默认使用内存实现 `InMemoryIdempotencyStore`；生产环境可实现 `IdempotencyStore` 接 Redis；
- dry-run 不写入幂等存储。

```ts
import { createFengsui, InMemoryIdempotencyStore } from '@javen205/fengsui-core';

const fengsui = createFengsui({
  credentials,
  plugins: [emailPlugin()],
  idempotencyStore: new InMemoryIdempotencyStore({ ttlMs: 24 * 60 * 60 * 1000 }),
});
```

## 回执

```ts
interface DispatchResult {
  channel: string;
  requestId: string;
  status: 'sent' | 'partial' | 'failed' | 'skipped';
  results: TargetDeliveryResult[];
  summary: { total: number; sent: number; failed: number; skipped: number };
  deduplicated: boolean;
  dryRun: boolean;
  durationMs: number;
  providerMessageId?: string;
  degraded?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}
```

单个目标的结果包含 `target`、`status`（`sent` / `failed` / `skipped`）、`providerMessageId`、`attempts`、`durationMs`、`errorCode`、`retryable` 等字段。排查问题时先看 `results`，再看 `summary`。

## 错误分类

| 错误码 | 含义 | 默认可重试 |
| --- | --- | --- |
| `validation` | 信封或渠道选项非法 | 否 |
| `credentials` | 凭证缺失或不可用 | 否 |
| `unsupported` | 渠道不支持该内容类型或能力 | 否 |
| `auth` | 鉴权失败（签名、token、权限） | 否 |
| `rate_limited` | 被服务商限流 | 是 |
| `network` | 网络或传输失败 | 是 |
| `channel` | 服务商业务错误 | 否 |
| `budget` | 超出预算或配额 | 否 |
| `config` | 配置来源不可用或快照非法 | 否 |
| `internal` | 框架内部错误 | 否 |

适配器可以显式设置 `retryable` 覆盖默认策略。

## dry-run 与健康检查

```ts
// 只校验与规划，不发送
await fengsui.send(envelope, { dryRun: true });

// 探测渠道
const health = await fengsui.healthCheck('email.qq', { credentialsRef: 'qq/main' });
console.log(health.ok, health.latencyMs, health.detail);
```

`healthCheck` 使用适配器声明的默认凭证（若有），或由 `credentialsRef` 显式指定。

## 观测

- `meta.requestId` 缺省时自动生成 UUID，并写入回执；
- `meta.traceId` 缺省时等于 `requestId`，贯穿投递日志与适配器上下文；
- 注入 `Logger`（pino / winston / console 包装）即可接管 `debug` / `info` / `warn` / `error`；
- 日志只记录渠道、状态、计数、耗时与错误摘要，不记录凭证与正文。

## 关闭

```ts
await fengsui.close();
```

`close()` 会逆序调用插件的 `stop()`（例如断开企业微信长连接），并释放配置 Provider 的文件监听等资源。
