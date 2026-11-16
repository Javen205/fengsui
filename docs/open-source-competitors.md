# 烽燧（fengsui）开源竞品调研（补充）

## 结论摘要

- **没有找到与 fengsui 完全同构的项目**：统一 JSON 信封 + SDK/CLI/MCP 三形态 + 国内 IM 原生适配，目前仍是空白。
- **整体最接近的是 Apprise**：100+ 渠道、库 + CLI、原生支持钉钉与企微（含 WeCom 应用与群机器人），但它是 Python、以 URL 配置为中心、无 MCP、无能力声明与统一回执。
- **Node/TS 生态最接近的是 Novu**：40+ provider、可自托管，但定位是工作流/通知基础设施，偏重；国内 IM 无原生 provider，只能走通用 Chat Webhook。
- **MCP 生态只有单渠道 server**：邮件类较成熟，企微群机器人有一个活跃项目，钉钉 MCP 更新停滞且无 License，跨渠道聚合尚无人做。
- **可直接复用**：`nodemailer`（邮件发送）、`imapflow`（未来收件）、`@alicloud/dingtalk`（可选，钉钉应用 API）、`smtp-server`（测试）；其余以借鉴设计为主，不建议作为运行时依赖。

## 一、总览对比

| 项目 | 类型 / 语言 | Star（约） | 最近维护 | License | 渠道覆盖 | 统一 JSON 信封 | 与 fengsui 的差异 / 结论 |
|---|---|---|---|---|---|---|---|
| [Apprise](https://github.com/caronc/apprise) | 通知聚合库 + CLI / Python | 17.7k | 2026-11 | BSD-2-Clause | 100+，含钉钉、企微应用/机器人、邮件 | 部分：API server 收 `urls`+`body`，核心仍是 URL 配置 | 渠道最全、可借鉴服务注册表与 CLI；但 Python、无 MCP、无能力声明，附件与错误语义弱 |
| [Novu](https://github.com/novuhq/novu) | 通知基础设施 / TypeScript | 40.3k | 2026-11 | MIT（核心）+ 商业许可（enterprise） | 40+ provider：邮件/SMS/推送/Chat/In-app；国内 IM 需 Chat Webhook 兜底 | 否：workflow trigger JSON，不是渠道信封 | 有工作流、摘要、延迟、订阅偏好、可观测性；重，且无钉钉/企微原生 provider、无渠道直发 CLI |
| [Notifme-sdk](https://github.com/notifme/notifme-sdk) | 事务通知 SDK / JavaScript | 2.0k | 2026-07 | MIT | 邮件、SMS、推送等约 10 个 provider | 否：函数入参 | 比 fengsui 更聚焦事务通知；无 IM、无 CLI/MCP、无附件跨渠道抽象 |
| [ntfy](https://github.com/binwiederhier/ntfy) | 推送服务器 / Go | 35.3k | 2026-11 | Apache-2.0 | 1：topic 推送 | 否：HTTP topic + message | 是「一个渠道」而非聚合器；无邮件/钉钉/企微，无可比性 |
| [Gotify](https://github.com/gotify/server) | 推送服务器 / Go | 16.2k | 2026-11 | MIT | 1：自托管推送 | 否：应用 token + message | 同上；适合作为 fengsui 未来新增的推送渠道，不是竞品 |
| [node-notifier](https://github.com/mikaelbr/node-notifier) | 桌面通知库 / TypeScript | 5.8k | 2026-10 | MIT | 3：macOS/Windows/Linux 桌面 | 否 | 只做本机通知；可作为 CLI 完成提示的可选依赖，不承担消息渠道 |
| [mcp-email-server](https://github.com/Wh1isper/mcp-email-server) | MCP 邮件 server / Python | 377 | 2026-11 | BSD-3-Clause | 1：邮件（多账号，读/搜/发） | 否：MCP 工具参数 | 邮件读写比我们强；无钉钉/企微、无统一信封、无 CLI |
| [email-mcp](https://github.com/codefuturist/email-mcp) | MCP 邮件 server / TypeScript | 145 | 2026-11 | LGPL-3.0 | 1：IMAP + SMTP | 否 | 同为单渠道；LGPL 对商业集成需评估，适合借鉴工具设计 |
| [resend-mcp](https://github.com/resend/resend-mcp) | 官方 MCP server / TypeScript | 579 | 2026-11 | MIT | 1：Resend | 否 | 绑定单一商业邮件服务；不覆盖自建 SMTP/Gmail/QQ/163 |
| [wecom-bot-mcp-server](https://github.com/loonghao/wecom-bot-mcp-server) | MCP 企微机器人 / Python | 106 | 2026-10 | MIT | 1：企微群机器人 | 否 | 只覆盖企微群机器人；无邮件/钉钉、无应用消息、无统一回执 |
| [dingtalk-mcp](https://github.com/open-dingtalk/dingtalk-mcp) | MCP 钉钉 / 未标注 | 28 | 2025-07 | 无 License | 1：钉钉 | 否 | 官方组织下的早期项目，停更、无 License，不建议依赖 |
| [nodemailer](https://github.com/nodemailer/nodemailer) | 邮件发送库 / TypeScript | 17.7k | 2026-11 | MIT-0 | 1：SMTP | 不适用 | 应直接复用：MIME、附件、DKIM、OAuth2、代理均成熟 |
| [imapflow](https://github.com/postalsys/imapflow) | IMAP 客户端 / TypeScript | 582 | 2026-11 | MIT | 1：IMAP 收件 | 不适用 | 本期只发送可不用；做收件/退信关联时优先复用 |
| [premailer](https://github.com/premailer/premailer) | HTML 邮件预处理 / Ruby | 2.4k | 2026-11 | BSD-3-Clause | 0：预处理 | 不适用 | Ruby 生态，Node 不能直接复用；只借鉴「发送前内联 CSS」的思路 |
| [@alicloud/dingtalk](https://open.dingtalk.com/document/personalapp/download-the-server-side-sdk-1) | 钉钉官方 SDK / Node | npm 包 | 2026-09 | Apache-2.0 | 1：钉钉开放平台 | 否 | 可选依赖；Webhook 单次 POST 不必引入，应用 API 可用 |

## 二、分类结论

### 2.1 通知聚合 / 多渠道发送

Apprise 是唯一在渠道广度上明显超过 fengsui 的项目，且原生覆盖钉钉、企微应用与企微机器人，库和 CLI 都成熟；它的弱项恰好是 fengsui 的强项：没有统一能力声明、没有结构化错误/回执、没有 MCP，配置以 URL 字符串为主，凭证容易散落在 URL 中。Novu 更像「通知中台」，适合有工作流、摘要、订阅偏好和 In-app 收件箱需求的产品；如果 fengsui 只做「渠道 + JSON 直发」，引入 Novu 属于过度设计。ntfy、Gotify 是单一推送渠道，Notifme 只覆盖邮件/SMS/推送，均不构成整体竞品。

### 2.2 Node/TS 多渠道 SDK

Novu 的 providers 层是最值得借鉴的抽象：统一 provider 接口、凭据校验、重试与可观测性；但它没有钉钉/企微原生 provider，国内场景只能配 Chat Webhook。Notifme-sdk 轻量、MIT、维护正常，但能力边界停在邮件/SMS/推送。node-notifier 只做桌面通知。结论：Node 生态没有「邮件 + 钉钉 + 企微 + CLI/MCP」的开源同构项目。

### 2.3 MCP 发消息 server

邮件 MCP 已相对成熟（`mcp-email-server` 支持多账号读写搜索，`email-mcp` 支持 IMAP+SMTP），但都是单渠道、工具参数各自定义。企微只有群机器人 MCP，钉钉 MCP 停更且无 License。**没有跨渠道、可枚举能力、统一信封的 MCP server**，这是 fengsui 最明确的空白区。

### 2.4 邮件底层库

`nodemailer` 直接复用为邮件适配器内核，覆盖 SMTP/TLS、MIME、附件、DKIM、OAuth2；`imapflow` 留给后续收件与退信关联；`premailer` 是 Ruby，Node 侧不能直接复用，只借鉴「发送前内联 CSS」的预处理步骤。

### 2.5 钉钉 / 企微 SDK 现状

钉钉有官方 Node SDK（`@alicloud/dingtalk`，Apache-2.0，2026-09 仍在更新）与官方 Stream SDK（`dingtalk-stream`，MIT，41★），应用 API 可选官方 SDK；Webhook 只是一次 POST，不值得引入。企业微信没有官方 Node SDK，社区包多为小体量或单一场景（如 `wecompass` 0.1.0、`wework-chat-node` 仅覆盖会话存档），**建议 fengsui 自己做薄封装 + token 缓存**，不要依赖半维护包。

### 2.6 排除项

- **Courier**：核心闭源，只有各端 SDK 与 MCP connector，不构成开源竞品。
- **Knock**：核心闭源 SaaS，仅客户端 SDK 开源，不构成开源竞品。
- **Notifox**：仅检索到 2014 年的 Pebble 手表项目；**message-kit** 未检索到有影响力的仓库/npm 包。
- **Raven**：Sentry 旧客户端，2022 年已归档，不是通知聚合器。

## 三、复用、借鉴与差异化

| 决策 | 对象 | 具体做法 |
|---|---|---|
| 直接复用 | `nodemailer`（MIT-0） | 邮件适配器：SMTP、MIME、附件、DKIM、OAuth2 |
| 直接复用 | `imapflow`（MIT） | 仅在做收件/退信关联时引入 |
| 可选复用 | `@alicloud/dingtalk`（Apache-2.0） | 钉钉应用 API 的 typed client；Webhook 仍用原生 fetch |
| 测试复用 | `smtp-server` | 本地 SMTP 捕获，验证 MIME 与附件 |
| 借鉴设计 | Apprise | 服务注册表、URL/配置模型、100+ 渠道的分类方式；不引入 Python 运行时 |
| 借鉴设计 | Novu providers | provider 接口、凭据校验、重试与指标；不引入工作流/队列 |
| 借鉴设计 | 邮件 MCP servers | 工具命名、参数 schema、读写能力拆分 |
| 不采用 | ntfy / Gotify / Notifme / node-notifier | 能力边界不匹配，最多作为未来单渠道扩展 |

**差异化建议**

1. **统一信封 + 能力声明**：用 `channel + target + content + channelOptions + meta` 做唯一入口，发送前按 `capabilities()` 校验与降级；竞品普遍是 URL 配置、workflow JSON 或单渠道工具参数，没有这个层。
2. **国内 IM 一等公民**：把钉钉加签/IP 白名单、企微可信 IP/可见范围/token 缓存、`invaliduser` 与 `81013` 处理做成内建能力，而不是让用户自己拼 HTTP。
3. **SDK / CLI / MCP 同核**：同一信封、同一回执、同一错误码；竞品要么只有库 + CLI（Apprise），要么只有单渠道 MCP。
4. **凭证外置与可运维**：`account`/`secretRef`、日志脱敏、dry-run、逐目标回执与部分成功；比 URL 内嵌 key 的模型更适合团队使用。

## 参考来源

- [Apprise](https://github.com/caronc/apprise) / [Apprise PyPI](https://pypi.org/project/apprise/)
- [Novu](https://github.com/novuhq/novu) / [Novu 渠道集成](https://novu.co/integrations/channels/)
- [ntfy](https://github.com/binwiederhier/ntfy)、[Gotify](https://github.com/gotify/server)、[Notifme-sdk](https://github.com/notifme/notifme-sdk)
- [mcp-email-server](https://github.com/Wh1isper/mcp-email-server)、[email-mcp](https://github.com/codefuturist/email-mcp)、[resend-mcp](https://github.com/resend/resend-mcp)
- [wecom-bot-mcp-server](https://github.com/loonghao/wecom-bot-mcp-server)、[dingtalk-mcp](https://github.com/open-dingtalk/dingtalk-mcp)
- [nodemailer](https://github.com/nodemailer/nodemailer)、[imapflow](https://github.com/postalsys/imapflow)、[premailer](https://github.com/premailer/premailer)
- [@alicloud/dingtalk（钉钉官方 SDK 下载页）](https://open.dingtalk.com/document/personalapp/download-the-server-side-sdk-1)、[dingtalk-stream](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
