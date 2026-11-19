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
} from '@javen205/fengsui-core';
import { FengsuiError, requireHttp } from '@javen205/fengsui-core';

// 选项 schema 只描述 channelOptions，核心会在投递前用它校验
const schema = z
  .object({
    url: z.string().url(), // 目标 webhook 地址
    timeoutMs: z.number().int().positive().optional(), // 单次请求超时，可选
  })
  .strict(); // 严格模式：拼错的字段直接报错，不会被静默忽略

type WebhookOptions = z.infer<typeof schema>;

// 能力声明决定核心如何降级、限流、去重与生成回执
const capabilities: ChannelCapabilities = {
  messageKinds: ['text', 'markdown'], // 支持的内容类型
  attachments: false, // 不支持附件
  mentions: false, // 不支持 @
  batch: false, // 一次只发一个目标
  templates: false, // 不支持模板消息
  receipts: 'sync', // 发送响应即回执
  rateLimit: { scope: 'tenant', perMinute: 600 }, // 建议阈值，供上层参考
  idempotency: 'local', // 由核心在本地去重
  dryRun: true, // 支持只校验不发送
};

export function createWebhookAdapter(id = 'im.webhook'): ChannelAdapter<WebhookOptions> {
  return {
    // 渠道 ID 必须是 domain.action，注册表会校验格式与唯一性
    id,
    schema,

    // 用函数返回能力，便于按实例或运行时配置动态调整
    capabilities: () => capabilities,

    // 内容降级顺序：不支持 html 时先尝试 markdown，再退到 text
    fallbacks: { html: ['markdown', 'text'] },

    // 只做数据整理，禁止 IO：这样单测不需要网络或 mock 服务器
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
      // 从上下文取注入的 HttpClient，不直接 import axios/fetch
      const http = requireHttp(ctx);

      // 优先发 markdown，其次纯文本
      const text = message.content.markdown ?? message.content.text;
      if (text === undefined) {
        // 入参问题归为 validation，不可重试
        throw new FengsuiError({
          code: 'validation',
          message: 'Webhook requires content.markdown or content.text',
          channel: id,
        });
      }

      // 只发一次请求；ctx.signal 用于上游超时或取消
      const response = await http.request({
        method: 'POST',
        url: message.options.url,
        json: { text },
        timeoutMs: message.options.timeoutMs,
        signal: ctx.signal,
        meta: { channel: id, traceId: ctx.traceId, tenantId: ctx.tenantId },
      });

      // 把渠道状态翻译成框架错误码，并明确是否可重试
      if (response.status >= 400) {
        throw new FengsuiError({
          code: response.status === 429 ? 'rate_limited' : 'channel',
          message: `Webhook responded with ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
          channel: id,
          // 截断响应体，避免把整页 HTML 塞进错误信息
          providerMessage: response.body.slice(0, 500),
        });
      }

      // 只返回渠道侧回执；重试、fan-out 与结果聚合由核心负责
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
// 核心按数组顺序寻找第一个受支持的类型
fallbacks: { html: ['markdown', 'text'] }
```

按顺序尝试可支持的类型；全部不支持时，`meta.options.fallback` 决定降级还是拒绝（默认 `degrade`）。

### 可选：健康检查

```ts
async healthCheck(ctx: AdapterContext) {
  const startedAt = Date.now();
  try {
    // 用一个轻量请求探测，不要发真实业务消息
    const response = await requireHttp(ctx).request({
      method: 'HEAD',
      url: 'https://example.com/health',
      signal: ctx.signal,
    });
    // 5xx 视为不健康；4xx 说明服务可达，只是路径或权限不对
    return { ok: response.status < 500, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  } catch (error) {
    // 网络异常不向外抛，转成状态返回
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
import type { FengsuiPlugin, PluginContext } from '@javen205/fengsui-core';

export interface WebhookPluginOptions {
  channelId?: string; // 允许调用方覆盖默认渠道 ID
}

export function webhookPlugin(options: WebhookPluginOptions = {}): FengsuiPlugin {
  return {
    name: 'webhook', // 出现在日志与错误信息里

    // 同步执行：只注册适配器与能力，不做任何 IO
    register(context: PluginContext) {
      context.adapters.register(createWebhookAdapter(options.channelId ?? 'im.webhook'));
    },

    // fengsui.start() 时调用：建连、订阅或预热
    async start() {},

    // fengsui.close() 时逆序调用：释放连接、取消订阅
    async stop() {},
  };
}
```

```ts
const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(), // 凭证从环境变量读取
  http: createFetchHttpClient(), // HTTP 实现，可换成 axios
  plugins: [webhookPlugin()], // 注册上面写的渠道插件
});

await fengsui.send({
  channel: 'im.webhook', // 插件注册的渠道 ID
  action: 'send',
  content: { markdown: '**部署完成**' }, // 无 target：webhook 的收件方由 url 决定
  channelOptions: { url: 'https://hooks.example.com/fengsui' }, // 由 adapter schema 校验
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
  readonly name: string; // 用于日志与错误信息
  load(): Promise<unknown>; // 返回原始快照，由核心校验与缓存
  subscribe?(onChange: () => void): () => void; // 可选：变更时失效缓存，返回取消订阅函数
  close?(): Promise<void>; // 可选：释放连接或文件监听
}
```

## 替换 HTTP 实现

使用内置实现：

```ts
import { createFetchHttpClient } from '@javen205/fengsui-http-fetch';
// 或 import { createAxiosHttpClient } from '@javen205/fengsui-http-axios';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  // 注入哪种实现都可以，适配器只依赖 HttpClient 契约
  http: createFetchHttpClient(),
  plugins: [emailPlugin()],
});
```

自己实现时只需满足一个方法：

```ts
import type { HttpClient, HttpRequest, HttpResponse } from '@javen205/fengsui-http';

const http: HttpClient = {
  // req 已包含 method、url、headers、json/body、timeoutMs 与 signal
  async request(req: HttpRequest): Promise<HttpResponse> {
    // 只发一次请求；4xx/5xx 正常返回，传输失败（DNS、超时、断连）抛 HttpTransportError
  },
};
```

::: tip 不要在这里做业务重试
HTTP 契约只负责一次请求。重试属于投递器，放在这里会与 `maxAttempts`、退避和幂等冲突。
:::

## 替换凭证来源

```ts
import type { CredentialResolver, ResolvedCredential } from '@javen205/fengsui-core';

export class VaultCredentialResolver implements CredentialResolver {
  // ref 来自信封或配置，如 tenant-a/qq-main
  async resolve(ref: string): Promise<ResolvedCredential> {
    // 按需读取外部凭证；核心会缓存解析结果
    const values = await vault.read(`secret/data/fengsui/${ref}`);
    return { ref, values };
  }
}
```

约定：`values` 里只放渠道需要的凭证字段，不要混入发件人、SMTP 主机这类配置。

## 替换幂等存储

```ts
import type { IdempotencyStore, DeliveryReceipt } from '@javen205/fengsui-core';

export class RedisIdempotencyStore implements IdempotencyStore<DeliveryReceipt> {
  // ttl 应与业务保留回执的时长一致
  constructor(private readonly redis: RedisClient, private readonly ttlSeconds = 86400) {}

  // 命中时返回已有回执，核心据此跳过重复投递
  async get(key: string) {
    const raw = await this.redis.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as DeliveryReceipt);
  }

  // 发送成功后写入；key 已由核心拼好，无需自己加前缀
  async set(key: string, value: DeliveryReceipt) {
    await this.redis.set(key, JSON.stringify(value), { EX: this.ttlSeconds });
  }
}
```

键由投递器拼接为 `tenantId:channelId:idempotencyKey`，存储实现不需要关心组成规则。

## 自定义日志

```ts
import type { Logger } from '@javen205/fengsui-core';

const logger: Logger = {
  // event 是点分事件名（如 dispatcher.start），fields 是结构化上下文
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
  // 假凭证：不读环境变量，也不接触真实密钥
  credentials: {
    async resolve(ref) {
      return { ref, values: { secret: 'test' } };
    },
  },
  http: fakeHttp, // 假客户端，直接返回预设响应
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
