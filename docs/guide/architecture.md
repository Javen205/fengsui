# 目录与架构

> 一座烽燧由台、薪、火与守望的人组成。框架也一样。

这一页回答两个问题：**代码放在哪里**，以及**一封信从进入系统到离开系统，中间经过了什么**。

## 全景

```text
┌──────────────────────────────────────────────┐
│                  业务代码                     │
│         send(envelope) / handler(message)     │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│              @javen205/fengsui-core（核心）            │
│  信封校验 · 配置解析 · 能力协商 · 投递器       │
│  重试/超时/取消 · 幂等 · 回执 · 入站路由       │
└───────┬──────────────────────────┬───────────┘
        │ 注册渠道                  │ 取配置 / 取凭证
┌───────▼──────────┐      ┌────────▼───────────┐
│  渠道适配器插件   │      │  配置与凭证来源     │
│  email / wecom…  │      │  config-file / env │
└───────┬──────────┘      └────────────────────┘
        │ 使用传输契约
┌───────▼──────────────────────────────────────┐
│  @javen205/fengsui-http 契约 → http-fetch / http-axios │
└──────────────────────────────────────────────┘
```

一条最关键的规则：**依赖只向下，核心永不知道具体渠道。**

`@javen205/fengsui-core` 不依赖 nodemailer，不依赖企业微信 SDK，也不依赖 axios。它只定义契约，渠道以插件形式接入。删掉所有渠道插件，核心依然能编译、能测试。

## 目录结构

```text
fengsui/
├─ packages/
│  ├─ core/                  # 核心：契约、信封、投递、配置、入站、插件
│  │  ├─ src/
│  │  │  ├─ adapter/         # ChannelAdapter 契约与上下文
│  │  │  ├─ capabilities.ts  # 渠道能力、回执、汇总
│  │  │  ├─ config/          # ConfigProvider 契约与解析器
│  │  │  ├─ credentials/     # 环境变量凭证解析器
│  │  │  ├─ dispatcher/      # 投递器：重试、超时、幂等、fan-out
│  │  │  ├─ envelope/        # 信封 schema 与校验
│  │  │  ├─ fengsui/         # createFengsui() 实例装配
│  │  │  ├─ idempotency/     # 幂等存储契约与内存实现
│  │  │  ├─ inbound/         # 入站消息、路由器、handler
│  │  │  ├─ plugin/          # 插件契约与上下文
│  │  │  └─ registry/        # 渠道注册表
│  │  └─ test/
│  ├─ http/                  # HTTP 契约：HttpClient、统一错误类型
│  ├─ http-fetch/            # 基于 Node 原生 fetch 的实现
│  ├─ http-axios/            # 基于 axios 的实现
│  ├─ config-file/           # JSON 文件配置来源（可选 watch）
│  ├─ adapter-email/         # SMTP 邮件渠道 + 邮箱 preset
│  └─ adapter-wecom-bot/     # 企业微信智能机器人渠道 + 入站 handler
├─ docs/                     # VitePress 文档站（就是你现在读的）
├─ pnpm-workspace.yaml
├─ tsconfig.base.json        # 共享 TS 配置
├─ tsup.config.base.ts       # 共享打包配置
└─ vitest.config.ts          # 工作区测试配置
```

每个包都遵循同一套结构：`src/` 放实现，`test/` 放测试，`dist/` 是构建产物。

## 包的职责

| 包 | 角色 | 关键导出 |
| --- | --- | --- |
| `@javen205/fengsui-core` | 框架本体，不含任何渠道实现 | `createFengsui`、`dispatchEnvelope`、`FengsuiError`、`ChannelAdapter`、`ConfigProvider`、`InboundRouter` |
| `@javen205/fengsui-http` | 传输契约 | `HttpClient`、`HttpResponse`、`HttpTransportError` |
| `@javen205/fengsui-http-fetch` | 原生 fetch 传输实现 | `createFetchClient()` |
| `@javen205/fengsui-http-axios` | axios 传输实现 | `createAxiosClient()` |
| `@javen205/fengsui-config-file` | 文件配置来源 | `fileConfig()` |
| `@javen205/fengsui-adapter-email` | SMTP 邮件渠道 | `emailPlugin()`、`createEmailAdapter()`、`EMAIL_PRESETS` |
| `@javen205/fengsui-adapter-wecom-bot` | 企业微信机器人渠道 | `wecomBotPlugin()`、`WecomBotManager` |

::: tip 为什么 HTTP 要单独抽契约
有的团队用 axios，有的用 fetch，有的需要统一注入代理、重试或链路头。核心只依赖 `HttpClient` 接口，适配器调用 `requireHttp(ctx)` 取得实现，宿主可以自由替换，不影响渠道代码。
:::

## 分层与依赖方向

```text
业务代码
  ↓
@javen205/fengsui-core           ← 只依赖契约，不依赖实现
  ↓ 依赖
@javen205/fengsui-http           ← 纯类型与错误契约
  ↑ 实现
http-fetch / http-axios

@javen205/fengsui-adapter-*      → 依赖 core + http 契约 + 各自的供应商 SDK
@javen205/fengsui-config-file    → 只依赖 core 的 ConfigProvider 契约
```

三条硬规则：

1. **核心不 import 任何渠道包**。渠道通过 `plugins` 注入。
2. **适配器不解析环境变量**。凭证一律通过 `ctx.credentials.resolve(ref)` 获取。
3. **配置不保存密钥**。配置文件只写 `credentialsRef`，`channelOptions` 也不接受内联密钥。

## 一封信的旅程

```text
send(input)
  │
  ├─ 1. 校验信封            zod 严格校验，未知字段直接失败
  ├─ 2. 解析渠道            信封 → 配置默认值 → 报错
  ├─ 3. 解析配置            项目继承 + 层级深合并 + 凭证引用
  ├─ 4. 查注册表            找不到渠道 → unsupported
  ├─ 5. 校验渠道选项        适配器 schema.safeParse
  ├─ 6. 能力协商与降级      html → text 等
  ├─ 7. 展开目标            fan-out 成逐目标投递
  ├─ 8. 幂等检查            命中则直接复用历史回执
  ├─ 9. 逐目标发送          独立重试、超时、取消、退避
  └─ 10. 汇总回执           sent / partial / failed / skipped
```

源码位置：

- 入口：`packages/core/src/dispatcher/index.ts`
- 信封校验：`packages/core/src/envelope/schema.ts`
- 配置合并：`packages/core/src/config/resolve.ts`
- 实例装配：`packages/core/src/fengsui/index.ts`

### 为什么逐目标而不是整批

邮件群发里，一个地址写错不该让另外九十九个人收不到。所以投递器把 `target` 展开成独立任务：

- 每个目标独立尝试 `maxAttempts` 次；
- 每次尝试独立超时（默认 15 秒）；
- 单个目标失败只影响该目标的回执；
- 最终汇总成 `sent`、`partial`、`failed` 或 `skipped`。

`send()` 不会因为单个目标失败而抛异常。只有信封非法、渠道不存在、渠道选项非法这类“根本没法开始”的问题才会抛错。

## 插件生命周期

```text
createFengsui()
  └─ plugin.register(context)    同步，只注册渠道，不做 IO

fengsui.start()
  └─ plugin.start(context)       建长连接、订阅事件（按注册顺序）

fengsui.close()
  └─ plugin.stop(context)        逆序释放，最后关闭配置 Provider
```

对应契约在 [plugin/index.ts](file:///Users/javen/Documents/work/git/fengsui/packages/core/src/plugin/index.ts)。

纯发送型插件可以不实现 `start/stop`，由适配器在首次 `send()` 时懒连接。企业微信机器人这类需要长连接的插件，则在 `start()` 中建立连接，并在 `stop()` 中断开。

## 核心模块速查

| 模块 | 你会在什么时候碰到它 |
| --- | --- |
| `envelope` | 拼信封、处理校验错误 |
| `capabilities` | 判断渠道支持哪些内容、如何汇总回执 |
| `dispatcher` | 想理解重试、超时、幂等、降级的具体行为 |
| `config` | 自定义配置来源、理解合并优先级 |
| `credentials` | 换凭证来源（Vault、KMS、数据库） |
| `inbound` | 写机器人 handler、理解事件路由与去重 |
| `registry` | 动态注册渠道、查询渠道能力 |
| `plugin` | 编写自己的插件 |
| `fengsui` | 创建实例、启动与关闭 |

## 设计取舍

**整份配置快照，而不是按 key 查询。**  
Provider 每次返回完整配置，核心负责校验、缓存、继承与合并。这样来源可以是文件、数据库或配置中心，核心逻辑不随来源变化。

**严格 schema，而不是宽松透传。**  
信封与渠道选项都是 `.strict()`。拼错字段会在发送前失败，而不是静默丢失。代价是新增字段要显式声明，收益是排障成本大幅下降。

**错误是数据，不是字符串。**  
`FengsuiError` 带 `code`、`retryable`、`channel`、`details`。调用方与监控系统可以按结构处理，而不是解析错误文案。

**入站与出站共用一套归一化思路。**  
出站有 `Envelope`，入站有 `InboundMessage`。平台差异被插件吸收，业务只面对统一的 handler 上下文与回复器。

## 接下来读什么

- 想知道怎么发不同类型的消息：[使用指南](/guide/usage)
- 想接入自己的渠道：[如何扩展](/guide/extending)
- 想看具体渠道的细节：[邮件 SMTP](/guide/channels/email) / [企业微信机器人](/guide/channels/wecom-bot)
