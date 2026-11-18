# 烽燧 × NestJS 12 示例

用 **NestJS 12（ESM）** 演示 [烽燧（fengsui）](../../README.md) 的两类消息能力：

- **邮件**：纯文本、EJS HTML 模板、附件（本地文件与 `data:` URL）
- **企业微信智能机器人**：Markdown 主动推送、模板卡片、入站消息自动回复

示例内容介绍 Javen 的三个开源项目：烽燧、[IJPay](https://gitee.com/javen205/IJPay)、[TNWX](https://gitee.com/javen205/TNWX)。

## 目录结构

```text
examples/nest
├── assets/
│   └── fengsui-intro.txt        # 邮件附件：项目介绍纯文本
├── src/
│   ├── common/
│   │   └── project-content.ts   # 三个项目的介绍，邮件与机器人共用
│   ├── email/
│   │   ├── dto/send-email.dto.ts
│   │   ├── templates/welcome.ejs # HTML 邮件模板
│   │   ├── email.controller.ts
│   │   ├── email.service.ts
│   │   └── email.module.ts
│   ├── fengsui/
│   │   ├── fengsui.module.ts    # 全局模块与生命周期
│   │   ├── fengsui.runtime.ts   # 创建烽燧实例、按需启用机器人
│   │   └── nest-logger.ts       # 烽燧日志接到 Nest Logger
│   ├── wecom/
│   │   ├── dto/send-wecom.dto.ts
│   │   ├── wecom.handlers.ts    # 入站消息 / 进入会话 / 兜底日志
│   │   ├── wecom.controller.ts
│   │   ├── wecom.service.ts
│   │   └── wecom.module.ts
│   ├── app.module.ts
│   ├── demo.controller.ts       # GET /demo 演示页面、GET /demo/api 接口索引
│   ├── demo/templates/demo.ejs  # 可视化操作页
│   └── main.ts
├── fengsui.config.json          # 渠道、凭证引用与发件人默认值
├── .env.example                 # 环境变量模板
└── nest-cli.json
```

## 前置要求

- Node.js >= 22
- pnpm（仓库根目录使用 pnpm workspace）

## 快速开始

```bash
# 1. 在仓库根目录安装依赖
pnpm install

# 2. 首次运行或修改了 packages/ 源码后，先构建烽燧各包
pnpm build

# 3. 准备环境变量
cd examples/nest
cp .env.example .env
# 编辑 .env：填入邮箱 SMTP 授权码；如需机器人，再填 Bot ID 与 Secret

# 4. 启动开发模式
pnpm start:dev
```

启动后访问：

- 演示页面：<http://localhost:3000/demo>（按钮直接测试所有接口）
- JSON 接口索引：<http://localhost:3000/demo/api>
- 邮件预览：<http://localhost:3000/demo/email/preview?name=Javen>
- 机器人状态：<http://localhost:3000/demo/wecom/status>

生产模式：

```bash
pnpm build
pnpm start:prod
```

## 可视化演示页面

打开 <http://localhost:3000/demo>，页面提供：

- **邮件**：填入收件人与称呼，点击「纯文本」「HTML 模板」「附件」「完整邮件」直接发送；
  「预览 HTML」会在新标签页打开模板。
- **企业微信机器人**：填入 userid 或 chatid，点击「Markdown」「模板卡片」主动推送；
  「查询状态」查看连接状态。
- **响应面板**：展示每次请求的 HTTP 状态与回执 JSON，方便确认 `dryRun`、错误码与逐目标结果。

页面默认勾选 dry-run，不会真正投递；取消勾选后再点一次即为真实发送。
收件人 / 称呼的默认值可通过 `.env` 里的 `DEMO_EMAIL_TO`、`DEMO_NAME` 预填。

## 配置

### 1. `fengsui.config.json`

```json
{
  "version": 1,
  "defaults": {
    "channel": "email.qq"
  },
  "projects": {
    "email": {
      "credentialsRef": "email/main",
      "channelOptions": { "timeoutMs": 15000 }
    },
    "newsletter": {
      "extends": "email",
      "channelOptions": { "from": "烽燧周刊 <you@qq.com>" }
    }
  }
}
```

- `channel`：默认渠道。邮件可用 `email.qq`、`email.163`、`email.126`、`email.gmail`、
  `email.aliyun`、`email.sina`、`email.outlook`、`email.m365`，也可以直接用 `email.smtp`。
- `credentialsRef`：凭证引用，格式 `租户/账号`。发送请求里可临时覆盖。
- `channelOptions.from`：发件人。多数邮箱要求与 SMTP 登录账号一致；QQ 邮箱不一致会直接断连。
  示例的邮件请求带 `meta.projectId: "email"`，因此只合并 `projects.email` 的配置；
  `projects.newsletter` 里的 `from` 只对显式指定该项目的请求生效。
- 配置按 `defaults` → 项目继承链 → `channels.<channel>` → 信封显式字段逐层深合并，
  所以**不要把邮件专用选项（如 `from`）写进 `defaults.channelOptions`**，否则会一并传给
  企业微信等其它渠道，触发适配器校验失败（`Unrecognized keys`）。
- 配置文件支持热更新（`fileConfig({ watch: true })`），改完下一次发送自动生效。

### 2. `.env`

凭证只从环境变量读取，值为 JSON。**不要把 Secret 写进代码或 `fengsui.config.json`。**

| 变量                           | 说明                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `PORT`                         | HTTP 端口，默认 `3000`                                       |
| `DEMO_DRY_RUN`                 | `true` 时所有发送只校验不投递，适合演示                      |
| `DEMO_EMAIL_TO`                | 演示页面里收件人输入框的默认值，可留空                       |
| `DEMO_NAME`                    | 演示页面里称呼的默认值，默认 `Javen`                         |
| `FENGSUI_CONFIG`               | 配置文件路径，默认 `fengsui.config.json`                     |
| `FENGSUI_CRED_EMAIL_MAIN`      | 邮件凭证：`{"user":"you@qq.com","pass":"SMTP 授权码"}`       |
| `EMAIL_FROM`                   | 可选，发件人。省略时自动取凭证里的 `user` 拼成 `烽燧 <user>` |
| `WECOM_BOTS`                   | 多机器人定义（JSON 数组），优先级高于下面的单机器人变量     |
| `WECOM_BOT_ID`                 | 单机器人简写：Bot ID；留空则关闭机器人能力                  |
| `WECOM_BOT_ALIAS`              | 单机器人简写：别名，默认 `assistant`，决定渠道 `wecom.bot.assistant` |
| `WECOM_CREDENTIALS_REF`        | 单机器人简写：凭证引用，默认 `wecom/<alias>`                |
| `FENGSUI_CRED_WECOM_ASSISTANT` | 机器人 Secret：`{"secret":"..."}`                            |
| `WECOM_DEMO_TO`                | 可选，机器人演示接口的默认目标（userid 或 chatid）           |

凭证变量名由 `credentialsRef` 推导：`email/main` → `FENGSUI_CRED_EMAIL_MAIN`，
`wecom/assistant` → `FENGSUI_CRED_WECOM_ASSISTANT`。别名里的 `-` 会转成 `_`：
`wecom/ops-bot` → `FENGSUI_CRED_WECOM_OPS_BOT`。

`.env` 已被仓库 `.gitignore` 忽略，不会提交。

### 3. 企业微信机器人

1. 在企业微信管理后台创建智能机器人，拿到 **Bot ID** 与 **Secret**；
2. 写入 `.env`。单个机器人：

```dotenv
WECOM_BOT_ID=your-bot-id
WECOM_BOT_ALIAS=assistant
FENGSUI_CRED_WECOM_ASSISTANT={"secret":"your-bot-secret"}
```

多个机器人用 `WECOM_BOTS`（JSON 数组）；每个 `alias` 对应一个 Secret 变量：

```dotenv
WECOM_BOTS=[{"alias":"assistant","botId":"your-bot-id"},{"alias":"support","botId":"another-bot-id"}]
FENGSUI_CRED_WECOM_ASSISTANT={"secret":"your-bot-secret"}
FENGSUI_CRED_WECOM_SUPPORT={"secret":"another-bot-secret"}
```

- `alias` 必须匹配 `^[a-z][a-z0-9-]*$`，且不能重复；渠道 ID 为 `wecom.bot.<alias>`；
- 某个机器人缺少 Secret 时只会跳过它，其余机器人照常启用；
- 一个 `botId` 只能维持一条长连接，本地与服务器不要同时连同一个机器人。

3. 启动后查看连接状态：

```bash
curl http://localhost:3000/demo/wecom/status
```

返回的 `bots` 数组会列出每个机器人的 `enabled`、`state`、`connected` 与未启用原因。
未配置任何机器人时，机器人插件自动关闭，邮件示例不受影响；主动推送接口返回 `503`。

## 邮件示例

| 方法   | 路径                                         | 说明                                 |
| ------ | -------------------------------------------- | ------------------------------------ |
| `GET`  | `/demo/email/preview?name=Javen`             | 浏览器预览 HTML 模板                 |
| `GET`  | `/demo/email/preview?name=Javen&format=text` | 预览纯文本版本                       |
| `POST` | `/demo/email/text`                           | 纯文本邮件                           |
| `POST` | `/demo/email/html`                           | HTML 模板邮件（自动带纯文本兜底）    |
| `POST` | `/demo/email/attachments`                    | 附件邮件：本地 TXT + `data:` URL CSV |
| `POST` | `/demo/email/full`                           | HTML + 纯文本 + 两个附件             |

请求体：

```json
{
  "to": "you@example.com",
  "name": "Javen",
  "dryRun": true,
  "channel": "email.qq",
  "credentialsRef": "email/main"
}
```

除 `to` 外都可省略；`channel` / `credentialsRef` 用于临时覆盖配置。

先用 dry-run 验证：

```bash
curl -X POST http://localhost:3000/demo/email/full \
  -H 'content-type: application/json' \
  -d '{"to":"you@example.com","name":"Javen","dryRun":true}'
```

确认无误后去掉 `dryRun` 即为真实发送。

实现要点：

- 模板位于 `src/email/templates/welcome.ejs`，由 `nest-cli.json` 的 `assets` 复制到 `dist`；
- 模板使用 EJS 渲染，数据来自 `src/common/project-content.ts`；
- 附件演示两种形态：`assets/fengsui-intro.txt`（本地路径）与 CSV（`data:text/csv;base64,...`）；
- 邮件插件默认把 HTML 降级为纯文本，示例仍显式提供 `content.text`。

## 企业微信机器人示例

### 主动推送

| 方法   | 路径                   | 说明                          |
| ------ | ---------------------- | ----------------------------- |
| `GET`  | `/demo/wecom/status`   | 开关、连接状态、最近错误      |
| `POST` | `/demo/wecom/markdown` | 推送 Markdown                 |
| `POST` | `/demo/wecom/card`     | 推送模板卡片（`text_notice`） |

```bash
curl -X POST http://localhost:3000/demo/wecom/markdown \
  -H 'content-type: application/json' \
  -d '{"to":"userid 或 chatid","alias":"assistant","dryRun":true}'
```

`to` 省略时使用 `WECOM_DEMO_TO`；`alias` 省略时使用第一个启用的机器人，
别名不存在返回 `404`，没有可用机器人返回 `503`。演示页面顶部会列出所有机器人，可直接切换。
机器人出站支持 Markdown 与模板卡片，不支持图片等其它消息类型。

### 入站对话

机器人连接后，可以直接在企业微信里与它对话：

- 发送 `fengsui`、`ijpay`、`tnwx`、`帮助` 或 `help`：返回三个项目的 Markdown 介绍；
- 发送其它文本：回显内容并提示可用关键词；
- 新成员进入会话：发送欢迎语；
- 所有入站帧会记录一条 `wecom.inbound` 调试日志。

入站处理位于 `src/wecom/wecom.handlers.ts`，通过 `wecomBotPlugin({ handlers })` 注册。
被动回复需在收到事件后 5 秒内完成；主动推送不受此限制。

## 常见问题

**机器人状态一直是 `disconnected` / `reconnecting`**

检查 `WECOM_BOT_ID` 与 `FENGSUI_CRED_WECOM_ASSISTANT` 是否匹配，Secret 是否完整；
`/demo/wecom/status` 的 `lastError` 会给出认证或网络错误。

**邮件报认证失败**

`pass` 填的是邮箱的 **SMTP 授权码**，不是登录密码；同时确认 `from` 与登录账号一致。

**邮件报 `network` / `ECONNECTION: Connection closed unexpectedly`**

发件人地址与 SMTP 登录账号不一致时，QQ 邮箱会直接断开连接，适配器将其归类为 `network`
并重试，最终 `failed`。示例会自动用凭证里的 `user` 作为发件人；如需自定义，请在 `.env`
设置 `EMAIL_FROM`，且邮箱地址必须与 `FENGSUI_CRED_EMAIL_MAIN` 的 `user` 相同。

**附件找不到**

附件路径按示例工程根目录解析。请在 `examples/nest` 下启动服务，或自行修改
`email.service.ts` 中的 `TXT_ATTACHMENT_PATH`。

**本机 `localhost` 访问不到**

如果服务只监听了 IPv6，可用 `http://[::1]:3000`，或设置 `app.listen(port, '0.0.0.0')`。

**模板样式在邮件客户端里丢失**

部分客户端会裁剪 CSS。示例已尽量使用内联样式与 table 布局，建议在目标客户端再实测一次。
