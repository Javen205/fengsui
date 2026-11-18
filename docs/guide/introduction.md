# 项目简介

> 烽燧（fengsui）：一封信封，万里相传。

烽燧是一个用 TypeScript 编写、以**信封（Envelope）**为中心、**一切皆插件**的多渠道消息投递框架。它把“发消息”拆成一件干净的事：业务描述意图，框架负责把意图送到正确的渠道，并照顾好重试、超时、降级、幂等与可观测性。

## 它解决什么问题

大多数项目最终都会长成这样：

```ts
// 业务代码里散落着渠道细节
const transporter = nodemailer.createTransport({ host, port, secure, auth });
await transporter.sendMail({ from, to, subject, html });

const ws = new WSClient({ botId, secret });
ws.on('message.text', async (frame) => { /* ... */ });
```

渠道越多，重复越多：凭证散落、错误处理各写一套、换供应商要改业务、测试时不敢真发。烽燧把这些横向能力收进框架：

- **统一契约**：所有渠道共享同一个信封与回执；
- **统一可靠性**：重试、超时、取消、幂等、逐目标 fan-out；
- **统一配置**：默认渠道、凭证引用、项目继承链；
- **统一入站**：回调与长连接消息归一化为 `InboundMessage`；
- **统一扩展点**：渠道、配置来源、HTTP 客户端、handler 都是插件。

## 四个设计原则

### 1. 渠道只是插件，业务只说意图

核心包 `@fengsui/core` 不依赖 nodemailer、企业微信 SDK 或任何 HTTP 实现。渠道适配器只做三件事：校验渠道选项、把信封归一化、调用供应商接口。业务代码看到的永远是同一封信。

### 2. 配置给默认值，代码给确定性

渠道、凭证引用、发件人、超时都可以由配置提供默认值；业务只写 `target` 与 `content`。配置可以是文件，也可以是数据库或配置中心——只要实现一个 `ConfigProvider`。

### 3. 失败是一等公民

每个目标独立重试、独立超时、独立回执。错误被归类为 `validation`、`credentials`、`auth`、`network`、`rate_limited`、`channel` 等，是否可重试写在错误里，而不是让调用方猜。

### 4. 收发同源

出站走投递器，入站走 `InboundRouter`。回调、WebSocket 长连接、未来更多来源都归一化成同一种消息，handler 可以按 `message.text`、`event.enter_chat` 或 `*` 分流。

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 信封校验 | zod 严格校验，非法字段在发送前失败 |
| 多目标 fan-out | 每个目标独立重试、超时、取消，互不影响 |
| 能力协商与降级 | 渠道声明支持的内容类型，不支持时按 `fallbacks` 降级或拒绝 |
| 幂等 | `meta.idempotencyKey` + 幂等存储，重复发送直接复用历史回执 |
| dry-run | 只校验与规划，不真正发送 |
| 健康检查 | 适配器可实现 `healthCheck`，主动探测渠道可用性 |
| 凭证隔离 | 配置只写 `credentialsRef`，密钥从环境变量或密钥服务解析 |
| 配置多来源 | 文件（已实现）、数据库、Redis、配置中心（按接口扩展） |
| 入站路由 | 事件分发、`{ handled: true }` 短路、TTL 去重、错误隔离 |
| 插件生命周期 | `register` 注册渠道，`start` 建连，`stop` 优雅关闭 |

## 当前状态

已经可用：

- `@fengsui/core`：信封、投递器、能力、错误、日志、凭证、配置、入站、注册表、插件 API；
- `@fengsui/config-file`：JSON 配置文件来源，支持 `watch`；
- `@fengsui/adapter-email`：SMTP 邮件，含 8 个邮箱 preset；
- `@fengsui/adapter-wecom-bot`：企业微信智能机器人，多机器人长连接与入站 handler。

尚未实现：

- IM（钉钉、飞书等）、短信、微信公众号渠道；
- CLI 与 MCP Server。

## 适合谁

- 需要在多个渠道之间切换或同时投递的后端服务；
- 想把“发消息”从业务代码里抽出来的平台团队；
- 需要统一凭证、重试、幂等与观测的中后台系统；
- 想用同一套 handler 接入聊天机器人与回调的团队。

## 不适合谁

- 只需要发一封邮件、不打算长期维护的小脚本；
- 需要可视化流程编排、拖拽式营销自动化的场景（应选专门的营销平台）；
- 期待开箱即用的 SaaS 控制台——烽燧是库，不是托管服务。

下一步：[快速开始](/guide/getting-started)，或者先看看[目录与架构](/guide/architecture)。
