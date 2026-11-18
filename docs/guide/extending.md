# 如何扩展

> 烽燧的边界不是“支持了哪些渠道”，而是“你能不能接入自己的渠道”。

框架把可替换的部分都做成了契约。你可以只替换其中一层，也可以整套接入。

## 扩展点地图

| 想做的事 | 扩展点 | 接入方式 |
| --- | --- | --- |
| 接入新渠道 | `ChannelAdapter` + `FengsuiPlugin` | `createFengsui({ plugins })` |
| 换配置来源 | `ConfigProvider` | `createFengsui({ config })` |
| 换 HTTP 实现 | `HttpClient` | `createFengsui({ http })` |
| 换凭证来源 | `CredentialResolver` | `createFengsui({ credentials })` |
| 换幂等存储 | `IdempotencyStore` | `createFengsui({ idempotencyStore })` |
| 换日志 | `Logger` | `createFengsui({ logger })` |
| 处理入站消息 | `InboundRouter` / handler | 由平台插件暴露 |
| 调整重试策略 | `maxAttempts` / `attemptTimeoutMs` | `createFengsui()` 或信封 `meta.options` |

## 写一个渠道适配器

假设要接入一个“Webhook”渠道。核心只要求五样东西：**ID、能力、选项 schema、归一化、发送**。

```ts
import { z } from 'zod';
import type {
  AdapterContext,
  AdapterNormalizeInput,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelSendOutcome,
  NormalizedMessage,
} from '@fengsui/core';
import { FengsuiError, requireHttp } from '@fengsui/core';

const schema = z
  .object({
    url: z.string().url(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

type WebhookOptions = z.infer<typeof schema>;

const capabilities: ChannelCapabilities = {
  messageKinds: ['text', 'markdown'],
  attachments: false,
  mentions: false,
  batch: false,
  templates: false,
  receipts: 'sync',
  rateLimit: { scope: 'tenant', perMinute: 600 },
  idempotency: 'local',
  dryRun: true,
};

export function createWebhookAdapter(id = 'im.webhook'): ChannelAdapter<WebhookOptions> {
  return {
    id,
    schema,
    capabilities: () => capabilities,
    fallbacks: { html: ['markdown', 'text'] },

    normalize(input: AdapterNormalizeInput<WebhookOptions>): NormalizedMessage<WebhookOptions> {
      return {
        channel: id,
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
      message: NormalizedMessage<WebhookOptions>,
      ctx: AdapterContext,
    ): Promise<ChannelSendOutcome> {
      const http = requireHttp(ctx);
      const text = message.content.markdown ?? message.content.text;
      if (text === undefined) {
        throw new FengsuiError({
          code: 'validation',
          message: 'Webhook requires content.markdown or content.text',
          channel: id,
        });
      }

      const response = await http.request({
        method: 'POST',
        url: message.options.url,
        json: { text },
        timeoutMs: message.options.timeoutMs,
        signal: ctx.signal,
        meta: { channel: id, traceId: ctx.traceId, tenantId: ctx.tenantId },
      });

      if (response.status >= 400) {
        throw new FengsuiError({
          code: response.status === 429 ? 'rate_limited' : 'channel',
          message: `Webhook responded with ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
          channel: id,
          providerMessage: response.body.slice(0, 500),
        });
      }

      return { providerCode: String(response.status) };
    },
  };
}
```

### 五条实现约定

1. **`id` 形如 `domain.action`**，如 `im.webhook`。注册表会拒绝不含 `.` 的 ID。
2. **`schema` 必须严格**。用 `.strict()` 让拼写错误暴露，而不是静默忽略。
3. **`normalize()` 不产生 IO**。它只做数据变换，便于单测。
4. **`send()` 只处理单个目标**。fan-out、重试、超时、幂等由核心负责。
5. **错误要说清是否可重试**。`network`、`rate_limited` 默认可重试；`validation`、`auth` 不可重试。

### 能力声明怎么填

| 字段 | 含义 |
| --- | --- |
| `messageKinds` | 支持的内容类型，核心据此决定是否需要降级 |
| `attachments` | `false` 或 `{ maxBytes, kinds }` |
| `mentions` | @ 能力 |
| `batch` | `false` 或 `{ maxRecipients }` |
| `templates` | 是否支持模板消息 |
| `receipts` | `sync` / `query` / `callback` / `none` |
| `rateLimit` | 限流维度与建议阈值 |
| `idempotency` | `native` / `local` / `none` |
| `dryRun` | 是否支持只校验不发送 |

如果声明了 `messageKinds: ['text']`，而信封给了 `html`，核心会先查 `fallbacks`：

```ts
fallbacks: { html: ['markdown', 'text'] }
```

按顺序尝试可支持的类型；全部不支持时，`meta.options.fallback` 决定降级还是拒绝（默认 `degrade`）。

### 可选：健康检查

```ts
async healthCheck(ctx: AdapterContext) {
  const startedAt = Date.now();
  try {
    const response = await requireHttp(ctx).request({
      method: 'HEAD',
      url: 'https://example.com/health',
      signal: ctx.signal,
    });
    return { ok: response.status < 500, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
```

::: warning 健康检查不要抛异常
返回 `{ ok: false, detail }` 即可。调用方需要的是状态，不是堆栈。
:::

## 把适配器装进插件

插件负责注册渠道，并在需要时管理连接生命周期。

```ts
import type { FengsuiPlugin, PluginContext } from '@fengsui/core';

export interface WebhookPluginOptions {
  channelId?: string;
}

export function webhookPlugin(options: WebhookPluginOptions = {}): FengsuiPlugin {
  return {
    name: 'webhook',

    register(context: PluginContext) {
      context.adapters.register(
        createWebhookAdapter(options.channelId ?? 'im.webhook'),
      );
    },

    async start() {
      // 需要建连、订阅或预热时在这里做
    },

    async stop() {
      // 释放连接、取消订阅
    },
  };
}
```

```ts
const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  http: createFetchHttpClient(),
  plugins: [webhookPlugin()],
});

await fengsui.send({
  channel: 'im.webhook',
  action: 'send',
  content: { markdown: '**部署完成**' },
  channelOptions: { url: 'https://hooks.example.com/fengsui' },
});
```

插件生命周期：

```text
createFengsui() → register()  同步，只注册，不做 IO
fengsui.start() → start()     建连、订阅
fengsui.close() → stop()      逆序释放
```

## 替换配置来源

实现 `ConfigProvider` 即可接入数据库、Redis 或配置中心。完整示例见[配置系统](/guide/configuration#自定义配置来源)。

```ts
interface ConfigProvider {
  readonly name: string;
  load(): Promise<unknown>;
  subscribe?(onChange: () => void): () => void;
  close?(): Promise<void>;
}
```

## 替换 HTTP 实现

使用内置实现：

```ts
import { createFetchHttpClient } from '@fengsui/http-fetch';
// 或 import { createAxiosHttpClient } from '@fengsui/http-axios';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  http: createFetchHttpClient(),
  plugins: [emailPlugin()],
});
```

自己实现时只需满足一个方法：

```ts
import type { HttpClient, HttpRequest, HttpResponse } from '@fengsui/http';

const http: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    // 只发一次请求；4xx/5xx 正常返回，传输失败抛 HttpTransportError
  },
};
```

::: tip 不要在这里做业务重试
HTTP 契约只负责一次请求。重试属于投递器，放在这里会与 `maxAttempts`、退避和幂等冲突。
:::

## 替换凭证来源

```ts
import type { CredentialResolver, ResolvedCredential } from '@fengsui/core';

export class VaultCredentialResolver implements CredentialResolver {
  async resolve(ref: string): Promise<ResolvedCredential> {
    const values = await vault.read(`secret/data/fengsui/${ref}`);
    return { ref, values };
  }
}
```

约定：`values` 里只放渠道需要的凭证字段，不要混入发件人、SMTP 主机这类配置。

## 替换幂等存储

```ts
import type { IdempotencyStore, DeliveryReceipt } from '@fengsui/core';

export class RedisIdempotencyStore implements IdempotencyStore<DeliveryReceipt> {
  constructor(private readonly redis: RedisClient, private readonly ttlSeconds = 86400) {}

  async get(key: string) {
    const raw = await this.redis.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as DeliveryReceipt);
  }

  async set(key: string, value: DeliveryReceipt) {
    await this.redis.set(key, JSON.stringify(value), { EX: this.ttlSeconds });
  }
}
```

键由投递器拼接为 `tenantId:channelId:idempotencyKey`，存储实现不需要关心组成规则。

## 自定义日志

```ts
import type { Logger } from '@fengsui/core';

const logger: Logger = {
  debug(event, fields) { pino.debug({ ...fields, event }); },
  info(event, fields) { pino.info({ ...fields, event }); },
  warn(event, fields) { pino.warn({ ...fields, event }); },
  error(event, fields) { pino.error({ ...fields, event }); },
};
```

日志事件名使用点分格式，如 `dispatcher.start`、`dispatcher.finished`，便于按前缀聚合。

## 测试建议

- **单测适配器**：注入假的 `HttpClient` 或假 SDK 客户端，断言请求体与错误映射。
- **单测插件**：调用 `register()` 后检查注册表，不建真实连接。
- **端到端**：用本地 smtp-server、msw 或 fake client 替代外部服务。
- **重试与超时**：投递器支持注入 `sleep` 与 `random`，测试时可以跳过节流等待。

```ts
const fengsui = createFengsui({
  credentials: {
    async resolve(ref) {
      return { ref, values: { secret: 'test' } };
    },
  },
  http: fakeHttp,
  plugins: [webhookPlugin()],
});
```

## 扩展检查清单

- [ ] 渠道 ID 符合 `domain.action`，且不与现有渠道冲突
- [ ] 选项 schema 使用 `.strict()`
- [ ] `normalize()` 不产生 IO
- [ ] `send()` 只处理单个目标，不自行 fan-out
- [ ] 错误带 `code` 与 `retryable`
- [ ] 能力声明与实际支持一致
- [ ] 凭证只通过 `ctx.credentials.resolve(ref)` 获取
- [ ] 插件在 `stop()` 中释放所有资源
- [ ] 有对应的假客户端或本地服务测试

完成后，回到[使用指南](/guide/usage)确认信封字段与回执语义，或者直接看两个真实实现：[邮件 SMTP](/guide/channels/email) 与 [企业微信机器人](/guide/channels/wecom-bot)。
