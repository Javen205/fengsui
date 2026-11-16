# 烽燧（fengsui）统一消息发送工具：渠道调研与架构设计

## 结论摘要

- 渠道差异集中在三处：**鉴权成本、内容能力、限流治理**。统一层应抽象「能力声明 + 内容降级策略 + 错误归一化」，而不是为每个渠道复制一套发送 API。
- 落地优先级建议：**邮件 SMTP → 钉钉/企微 webhook → 企业级应用消息 → MCP Server**。前两步不需要企业应用审核或可信 IP，能最快验证统一信封是否成立。
- 多渠道路由不应伪装成事务：各渠道独立投递、逐目标回执、允许部分成功；跨渠道「撤回」在邮件场景不存在。
- 凭证只以 `account` / `secretRef` 引用，JSON 信封内禁止出现密码、授权码、webhook key；日志只记录正文长度与哈希。
- 邮件优先使用各邮箱官方 SMTP。Gmail 生产环境建议 OAuth2；应用专用密码仅适合个人或小规模场景。

## 一、渠道调研

### 1.1 能力与限制对比

| 渠道 | 接入方式 | 鉴权 | 内容能力 | 图片/附件 | @成员 | 关键配额与限制 |
|---|---|---|---|---|---|---|
| Gmail SMTP | `smtp.gmail.com`，465/587 | 应用专用密码（需两步验证）或 OAuth2 | 纯文本、HTML、附件 | 附件约 25MB | 不支持 | 个人 500 封/天、Workspace 2000 封/天；每封收件人上限 500 [cite:4][cite:2] |
| Gmail API | `messages.send`，raw MIME | OAuth2，`gmail.send` 等 scope | 纯文本、HTML、附件 | 同 MIME 限制 | 不支持 | 项目 1,200,000 配额单位/分钟；单用户 6,000/分钟；`messages.send` 100 单位；每封 500 收件人 [cite:1][cite:2] |
| QQ 邮箱 SMTP | `smtp.qq.com`，465/587 | 16 位授权码，需先开启 SMTP 服务 | 纯文本、HTML、附件 | 普通附件 50MB，正文+附件 55MB [cite:7] | 不支持 | 存在每分钟/每小时/每日发信量限制，官方将其列为保密数据，不公开具体数值；超限返回 `550 Sender frequency limited` [cite:5][cite:6][cite:8] |
| 163 / 126 SMTP | `smtp.163.com` / `smtp.126.com`，SSL 465/587，明文 25 | 客户端授权码（需短信校验） | 纯文本、HTML、附件 | 官方未明确 | 不支持 | 普通用户 300–400 封/天；基础会员 700–800；超级会员 1300–1400 [cite:9][cite:10][cite:11] |
| 钉钉自定义机器人 | Webhook `robot/send` | `access_token` + 加签/关键词/IP 白名单 | text、markdown、link、actionCard、feedCard；不支持 HTML | **不支持图片和文件** [cite:14] | 支持，最多 50 人 | 20 条/分钟/机器人，超限限流 10 分钟 [cite:12] |
| 钉钉工作通知 | OpenAPI `asyncsend_v2` | AppKey/AppSecret 换 `access_token` + `agent_id` | text、markdown、action_card、link、oa；不支持 HTML | image、voice、file（先上传媒体） [cite:15] | 按 userid/部门投递 | 单次 5000 人；每人每天 500 条；相同内容每人每天 1 条；每分钟 5000 人可收到；消息体 ≤2048 字节 [cite:15] |
| 企业微信消息推送（群机器人） | Webhook `webhook/send` | URL 中的 `key` 即凭证 | text、markdown、markdown_v2、news、file、voice、template_card；不支持 HTML [cite:17] | 图片 ≤2MB；文件 5B–20MB [cite:17][cite:20] | 存在冲突，见 1.4 | 每个机器人 20 条/分钟 [cite:17][cite:20] |
| 企业微信应用消息 | OpenAPI `message/send` | `corpid` + `corpsecret` 换 `access_token` + `agentid`；需可信 IP | text、markdown、textcard、news、mpnews、template_card 等 [cite:18] | image/voice/video/file，先上传临时素材 | `touser`/`toparty`/`totag` | 账号上限 ×200 人次/天；同一成员 30 次/分钟、1000 次/小时；text ≤2048 字节 [cite:18] |

### 1.2 邮件渠道

**Gmail** 提供两条路径：SMTP 与 Gmail API。SMTP 实现最简单，但账号密码登录已不可用，必须使用应用专用密码（要求开启两步验证），或使用 OAuth2/XOAUTH2；后者更适合多用户、可撤销授权的生产场景。[cite:3] Gmail API 通过 `messages.send` 发送 base64url 编码的原始 MIME，能力与 SMTP 等价，但需要 Google Cloud 项目与 OAuth 同意屏。[cite:1] 常见坑：个人账号每天 500 封、Workspace 2000 封；触发限制后外发可能被暂停最长 24 小时；`From` 伪造、缺少 SPF/DKIM 会显著提高进垃圾箱概率。[cite:4]

**QQ 邮箱** 默认关闭 POP3/IMAP/SMTP，需在网页端手动开启并生成 16 位授权码；第三方客户端**不能使用 QQ 密码**，修改 QQ 主密码会使全部授权码立即失效。[cite:5][cite:6] 服务端地址为 `smtp.qq.com`，465 或 587，SSL/TLS。[cite:5] 附件上限 50MB，正文加附件 55MB；每日发信量有上限但官方未公布具体数字，超限表现为 `550 Sender frequency limited`。[cite:7][cite:8]

**网易 163 / 126** 使用「客户端授权码」，开启协议时需短信校验，授权码只展示一次；126 与 yeah.net 只需替换服务器域名中的参数。[cite:9][cite:11] 官方帮助明确提示 Foxmail 场景**不要勾选 STARTTLS**，并给出 SSL 端口组合（SMTP 465/587）。[cite:11] 每日额度按会员等级区分，普通用户 300–400 封，且官方说明仍可能受其他因素影响。[cite:10] 三个邮箱的共同坑是：SMTP 的 `250` 响应只表示服务器已接受，最终投递失败会异步退信，回执必须保留 `Message-ID` 以便关联退信。

### 1.3 钉钉

**自定义机器人 Webhook** 适合群级告警，不需要创建应用。安全设置三选一或组合：自定义关键词、加签、IP 白名单。[cite:13] 加签算法为 `Base64(HMAC-SHA256(timestamp + "\n" + secret))` 后再 URL 编码，时间戳与请求时间误差不得超过 1 小时；IP 白名单不支持 IPv6。[cite:13] Webhook 消息类型受限于 text、link、markdown、actionCard、feedCard，**不能直接发图片或文件**。[cite:14] 限制为 20 条/分钟/机器人，超过后限流 10 分钟；官方未明确单条文本字节上限。[cite:12] 请求体支持 `msgUuid` 作为幂等键，适合超时重试。

**工作通知** 面向个人/部门，需要企业内部应用凭证（AppKey/AppSecret 换 `access_token`，有效期 7200 秒）与 `agent_id`。[cite:16][cite:15] 支持 text、image、voice、file、link、oa、markdown、action_card，媒体需先上传。限制较硬：单次最多 5000 人、每人每天 500 条、相同内容每人每天仅 1 条、每分钟最多 5000 人接收；超出限制时接口仍返回成功但用户收不到，必须查询发送结果。[cite:15]

### 1.4 企业微信

**消息推送（原群机器人）** 只需群内创建并复制 Webhook，`key` 即凭证，泄露即可被用于发垃圾消息，必须按密钥管理。[cite:17] 支持 text、markdown、markdown_v2、image、news、file、voice、template_card；text ≤2048 字节，markdown/markdown_v2 ≤4096 字节，图片（base64 前）≤2MB，文件 5B–20MB。[cite:17][cite:20] 频率为 20 条/分钟/机器人。[cite:17][cite:20]

关于 @成员存在官方口径冲突：接口文档 91770 提供 `mentioned_list`、`mentioned_mobile_list` 与 `<@userid>` 扩展语法；官方帮助页 14931 则称「暂不支持通过消息推送 @成员」。[cite:17][cite:20] 本设计按接口文档实现，但在能力声明中标记为「需实测」，首次接入时以目标群实际效果为准，避免把不可用能力暴露给上层。

**应用消息** 需要自建应用，`corpid` + `corpsecret` 换 `access_token`（有效期 7200 秒，必须缓存，不能频繁调用 gettoken）。[cite:19] 发送时指定 `agentid` 与 `touser`/`toparty`/`totag`，单次最多 1000 个 userid、100 个部门、100 个标签。[cite:18] 频率为「账号上限 ×200 人次/天」，同一成员 30 次/分钟、1000 次/小时，超出部分被丢弃且接口可能不报错。[cite:18] 常见坑：接收人不在应用可见范围会返回 `invaliduser`/`unlicenseduser`；全部接收人无效时返回 `81013`；调用 IP 需配置到应用「企业可信 IP」；管理端开启「始终进入主页」时，微信端文本会被截断到 20 字节。[cite:18]

### 1.5 跨渠道抽象结论

1. **邮件是唯一能自由承载 HTML 与任意附件的渠道**；IM 渠道的「富文本」是各自 Markdown 子集或卡片模板，不能假设 HTML 可移植。
2. **IM 渠道分两层**：webhook 门槛最低但只能发到固定群、内容类型少；应用消息可定向到人/部门，但需要应用凭证、可信 IP、可见范围与更严格的配额。
3. **限流语义不同**：钉钉/企微 webhook 是硬限流；应用消息超限可能「成功但丢弃」；邮件是日额度与垃圾邮件风控。统一层必须返回可解释的回执，而不是只看 HTTP 200。
4. **幂等能力不均**：钉钉 webhook 有 `msgUuid`，企微应用消息有重复检查开关，邮件依赖 `Message-ID`。核心层应统一 `idempotencyKey`，由适配器尽力映射。

## 二、架构设计

### 2.1 统一请求信封

调用方只提交「渠道 + 一个 JSON」。信封由公共元信息（`version`、`account`、`action`、`options`、`meta`）与四个业务段（`channel`、`target`、`content`、`channelOptions`）组成。公共字段跨渠道复用，渠道差异全部收进 `channelOptions`，避免污染核心模型。

```json
{
  "version": 1,
  "channel": "email.qq",
  "account": "qq-main",
  "action": "send",
  "target": { "to": ["receiver@example.com"], "cc": [], "bcc": [] },
  "content": {
    "subject": "构建完成",
    "text": "构建 #1234 已通过",
    "html": "<b>构建 #1234 已通过</b>",
    "attachments": [{ "path": "./report.pdf" }]
  },
  "channelOptions": { "replyTo": "ops@example.com" },
  "options": { "dryRun": false, "fallback": "reject", "timeoutMs": 15000 },
  "meta": { "requestId": "req-1", "idempotencyKey": "build-1234" }
}
```

| 渠道标识 | `target` 映射 | `content` 映射 | 典型 `channelOptions` |
|---|---|---|---|
| `email.gmail` / `email.qq` / `email.163` / `email.126` | `to`/`cc`/`bcc` | `subject`、`text`、`html`、`attachments` | `from`、`replyTo`、`headers` |
| `dingtalk.robot` | 忽略（绑定 Webhook 所在群） | `text` 或 `markdown` | `msgType`、`at`、`msgUuid` |
| `dingtalk.work` | `to` → `userid_list`；`departmentIds` → `dept_id_list` | 自动选择 text/markdown/action_card | `agentId`、`toAllUser` |
| `wecom.robot` | 忽略（绑定群） | `text`、`markdown`、`markdown_v2`、`news`、`file` | `msgType`、`mentions` |
| `wecom.app` | `to`/`departmentIds`/`tagIds` | text/markdown/textcard/news/template_card | `agentId`、`safe`、`duplicateCheck` |

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 否 | 默认 1；仅不兼容变更时递增 |
| `channel` | 是 | 渠道标识，可为字符串或数组 |
| `account` | 否 | 凭证配置引用，如 `qq-main`；禁止内联密钥 |
| `action` | 否 | 默认 `send`；预留 `send_batch` |
| `target` | 视渠道 | 邮件为 `to/cc/bcc`；企微应用为 `to/departmentIds/tagIds`；webhook 可省略 |
| `content` | 是 | `subject`、`text`、`markdown`、`html`、`attachments`、`mentions`、`card` |
| `channelOptions` | 否 | 渠道特有字段，如 `agentId`、`msgType`、`at`、`safe` |
| `options` | 否 | `dryRun`、`fallback`、`timeoutMs`、`failFast` |
| `meta` | 否 | `requestId`、`idempotencyKey` |

**校验方式**：用 Zod 定义 `BaseEnvelope`，再以 `channel` 做判别联合（discriminated union）；公共字段先校验，渠道 schema 负责必填项、互斥项与字节上限。未知字段一律拒绝，防止拼写错误被静默忽略。发送前执行 `capabilities()` 检查：例如 `dingtalk.robot` 收到 `attachments` 时直接返回 `UNSUPPORTED_CONTENT`，或按 `options.fallback = "degrade"` 明确降级为文本链接。

IM 渠道的复用示例：

```json
{"channel":"dingtalk.robot","account":"ops-group","content":{"markdown":"### 告警\n- 服务: api\n- 状态: 失败"},"channelOptions":{"msgType":"markdown","at":{"userIds":["u001"],"isAtAll":false}},"meta":{"idempotencyKey":"alert-123"}}
```

```json
{"channel":"wecom.app","account":"corp-app","target":{"to":["zhangsan"],"departmentIds":["1"]},"content":{"text":"构建完成"},"channelOptions":{"agentId":1000002,"safe":0},"meta":{"idempotencyKey":"build-1234"}}
```

**扩展新渠道**：新增一个适配器包，实现统一接口并注册 `channel` 与 schema；核心路由、CLI、MCP 不需要改动。信封 `version` 只在不兼容变更时递增。

### 2.2 适配器接口

```ts
interface ChannelAdapter {
  readonly id: ChannelId;
  capabilities(): ChannelCapabilities;
  validate(input: unknown): ValidationResult;
  send(req: SendRequest, ctx: AdapterContext): Promise<SendReceipt>;
  normalizeError(err: unknown, req: SendRequest): ChannelError;
}
```

- `capabilities()`：声明文本/Markdown/HTML/图片/文件/卡片/@、单条字节上限、收件人上限、是否支持幂等与 dry-run。CLI 与 MCP 直接用它生成帮助与工具描述，避免文档与实现漂移。
- `validate()`：只做渠道级校验，公共校验由核心完成。
- `send()`：完成凭证解析、令牌缓存、媒体上传、请求发送与响应归一化；不向上层抛原始 SDK 异常。
- `normalizeError()`：把 HTTP 状态、`errcode`、SMTP 响应码映射到统一错误码。

### 2.3 三种入口共用核心

| 形态 | 参数映射 | 输出约定 |
|---|---|---|
| 库 API | `createFengsui(config)`，`fengsui.send(envelope)` | 返回 `SendReceipt`；失败抛 `FengsuiError` |
| CLI | `fengsui send --channel email.qq --json @payload.json`，支持 stdin | stdout 输出单行 JSON 回执；退出码 0 成功、2 校验失败、3 鉴权失败、4 限流、5 渠道拒绝 |
| MCP Server | 工具 `send_message`（入参即信封）、`list_channels`、`describe_channel` | `structuredContent` 返回回执；文本摘要供人阅读；错误映射为 MCP 工具错误 |

三者只做「参数解析 + 结果序列化」，业务逻辑全部在核心与适配器，避免出现 CLI 能发、MCP 不能发的分叉。

### 2.4 多渠道路由

`channel` 允许为字符串或数组。核心将其展开为多个投递任务，使用 `Promise.allSettled` 并发执行，返回逐目标回执：

```json
{
  "requestId": "req-1",
  "results": [
    { "channel": "email.qq", "ok": true, "providerMessageId": "<...>" },
    { "channel": "dingtalk.robot", "ok": false, "error": { "code": "RATE_LIMITED", "retryable": true, "retryAfterMs": 60000 } }
  ]
}
```

取舍：**不做跨渠道事务，也不自动重试非幂等渠道**。可选 `options.failFast` 仅停止后续投递，不回滚已完成投递。需要「同一内容多渠道」时，各渠道按自身能力裁剪：邮件保留 HTML 与附件，IM 自动降级为「文本 + 链接」，降级必须在回执中标记 `degraded: true`，不能静默丢内容。

### 2.5 敏感信息管理

- 凭证来源：环境变量（CI/容器）或 `~/.config/fengsui/config.json`（权限 0600）；信封只允许 `account` 或 `secretRef`，schema 显式拒绝 `password`、`token`、`key` 等字段。
- 配置示例：`{"accounts":{"qq-main":{"channel":"email.qq","user":"a@qq.com","secretRef":"FENGSUI_QQ_AUTH_CODE"}}}`。
- 日志：只记录 `channel`、`requestId`、耗时、结果、正文长度与 SHA-256，不记录正文与凭证；错误信息中的 URL 查询参数、Authorization 头、`key` 参数统一脱敏。
- 不持久化原始信封；需要审计时保存回执与内容哈希，不保存附件内容。

### 2.6 错误模型与可观测性

统一错误结构：

```ts
type ErrorCategory =
  | "validation" | "unsupported_content" | "auth" | "rate_limit"
  | "recipient" | "provider" | "network" | "timeout" | "internal";

interface ChannelError {
  code: string; category: ErrorCategory; retryable: boolean;
  retryAfterMs?: number; channel: string; providerCode?: string;
  providerMessage?: string; requestId: string;
}
```

- 可重试：网络错误、超时、5xx、明确限流（带 `Retry-After`）。不可重试：校验失败、鉴权失败、内容不支持、接收人全部无效。
- 部分失败：钉钉/企微返回的 `invaliduser`、`invalidparty` 作为 `invalidRecipients` 放入回执，不对整批重试，避免重复打扰有效接收人。
- 幂等：`meta.idempotencyKey` 优先映射渠道能力；无原生幂等的渠道由核心做短期去重（内存或本地文件），并在回执中说明 `idempotency: "native" | "local" | "none"`。
- 可观测性：结构化日志 + 指标（按渠道统计成功/失败/限流/延迟），回执统一包含 `requestId`、`channel`、`providerMessageId`、`acceptedCount`、`invalidRecipients`、`retryAfterMs`。

### 2.7 技术选型与目录结构

选择 **Node.js 22 LTS + TypeScript（strict）+ pnpm workspace**：库、CLI、MCP 共用一套类型与校验；`nodemailer` 覆盖 SMTP/TLS/附件；官方 MCP SDK 成熟；`zod` 同时服务运行时校验与工具 schema；`pino` 做结构化日志；`vitest` + `msw` + `smtp-server` 覆盖无真实发送的测试。

```text
fengsui/
├── packages/
│   ├── core/                 # 信封、schema、注册表、路由、错误、脱敏、回执
│   ├── adapter-email/        # gmail / qq / 163 / 126（SMTP，预留 Gmail API）
│   ├── adapter-dingtalk/     # robot / work
│   └── adapter-wecom/        # robot / app
├── apps/
│   ├── cli/
│   └── mcp/
├── examples/
└── docs/
```

### 2.8 分阶段落地

1. **阶段一**：核心信封 + 适配器注册 + `dryRun`；邮件 SMTP（QQ 优先，163/126/Gmail 同构）+ CLI。无需企业应用，能最快验证参数模型与错误模型。
2. **阶段二**：钉钉自定义机器人、企业微信消息推送。补齐签名、限流回执、@ 能力实测与降级策略。
3. **阶段三**：钉钉工作通知、企业微信应用消息。引入 access_token 缓存、媒体上传、可信 IP 与可见范围校验。
4. **阶段四**：MCP Server、多渠道广播、指标与审计；再评估 Gmail API OAuth2 与收件能力。

### 2.9 测试策略

- **单元测试**：信封判别联合、字节上限、能力降级、错误映射、脱敏规则。
- **本地 SMTP 捕获**：用 `smtp-server` 在 `127.0.0.1` 启动捕获服务，断言 MIME 结构、HTML/纯文本替代、附件文件名与大小、`Message-ID`；覆盖认证失败、TLS 失败、超时。
- **Webhook 契约测试**：本地 HTTP mock 返回官方错误结构；对钉钉加签用官方示例参数做固定向量测试；模拟 20 条/分钟限流与企微 `81013`。
- **CLI / MCP 快照**：校验退出码、stdout 单行 JSON、MCP 工具 schema 与 `structuredContent`。
- **可选真实冒烟**：`FENGSUI_LIVE_TEST=1` 时向自己的邮箱/群发送一条固定消息，默认关闭，避免 CI 误发。

## 三、需要拍板的开放问题

1. **首个落地渠道**：建议 `email.qq`（授权码门槛低、能覆盖附件/HTML），是否同意？还是先做钉钉机器人以最快打通告警场景？
2. **是否需要收件/读取能力**：本期只做发送，还是同时规划 IMAP / Gmail API 读取与邮件解析？后者会显著增加凭证与合规复杂度。
3. **MCP 与 CLI 的优先级**：先 CLI 还是先 MCP？建议先 CLI，MCP 复用同一信封，晚一阶段接入。
4. **广播失败语义**：多渠道路由采用「部分成功 + 逐目标回执」是否符合预期？是否需要「全成功才算成功」的严格模式？
5. **凭证存储**：只支持环境变量，还是同时支持本地配置文件与系统钥匙串？后者体验更好，但跨平台实现成本更高。

## 四、开源竞品

开源通知聚合器、Node/TS SDK、MCP server 与邮件底层库的对比、可复用依赖及差异化结论，见 [开源竞品调研](./open-source-competitors.md)。

## 参考来源

- [cite:1] [Gmail API `users.messages.send`](https://developers.google.cn/workspace/gmail/api/reference/rest/v1/users.messages/send?hl=zh-cn)
- [cite:2] [Gmail API 用量限额](https://developers.google.cn/workspace/gmail/api/reference/quota?hl=zh-cn)
- [cite:3] [Gmail API 撰写并发送电子邮件](https://developers.google.cn/workspace/gmail/api/guides/sending?hl=zh-cn)
- [cite:4] [Gmail 发送限制（Google 官方帮助，中国大陆网络需可访问 Google）](https://support.google.com/mail/answer/22839)
- [cite:5] [QQ 邮箱客户端安全登录指南](https://help.mail.qq.com/detail/0/1088)
- [cite:6] [QQ 邮箱授权码说明](https://help.mail.qq.com/detail/0/985)
- [cite:7] [QQ 邮箱普通附件大小](https://service.mail.qq.com/detail/0/479)
- [cite:8] [QQ 邮箱 550 Sender frequency limited](https://service.mail.qq.com/detail/0/174)
- [cite:9] [网易邮箱如何开启客户端协议](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b)
- [cite:10] [网易邮箱每日发信量上限](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac27ae9194e21b954ec)
- [cite:11] [网易邮箱 Foxmail 设置与服务器端口](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25c12dcb3d46222b6)
- [cite:12] [钉钉自定义机器人发送群消息](https://open.dingtalk.com/document/development/custom-robots-send-group-messages)
- [cite:13] [钉钉自定义机器人安全设置](https://open.dingtalk.com/document/dingstart/customize-robot-security-settings)
- [cite:14] [钉钉机器人消息发送与接收类型](https://open.dingtalk.com/document/development/robot-message-type)
- [cite:15] [钉钉发送工作通知](https://open.dingtalk.com/document/development/asynchronous-sending-of-enterprise-session-messages)
- [cite:16] [钉钉获取企业内部应用 access_token](https://open.dingtalk.com/document/development/obtain-orgapp-token)
- [cite:17] [企业微信消息推送配置说明](https://developer.work.weixin.qq.com/document/path/91770)
- [cite:18] [企业微信发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)
- [cite:19] [企业微信获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)
- [cite:20] [企业微信如何设置消息推送](https://open.work.weixin.qq.com/help/wap/detail?docid=14931)
