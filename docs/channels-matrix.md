# fengsui 渠道能力矩阵

本文是 [design.md](./design.md) 的渠道事实明细，只记录接入方式、鉴权、能力、配额与坑；架构、信封、路由与企业级方案不在这里重复。所有数值以官方文档为准，官方没有给出的统一写「官方未明确」。各 provider 原生都不是统一 JSON 信封，由 fengsui adapter 归一化。优先级定义见 design.md 第 5 节。

## 1. 邮件：provider preset + 通用 SMTP/IMAP 兜底

同一套 `email` adapter，通过 preset 解析服务器、端口、TLS 与鉴权方式；未列入的邮箱用 `email.smtp` 手工配置，不为每家邮箱写独立代码。

| Preset | channel id | SMTP / IMAP | 鉴权 | 内容与附件 | 关键配额 | 主要坑 | 优先级 |
|---|---|---|---|---|---|---|---|
| QQ 邮箱 | `email.qq` | `smtp.qq.com` 465/587；`imap.qq.com` 993 | 16 位授权码，需先开启 SMTP 服务 | 纯文本、HTML、附件；普通附件 50MB，正文+附件 55MB | 日发信量官方列为保密数据；超限返回 `550 Sender frequency limited` | 不能用 QQ 密码；改主密码会使授权码全部失效 | P0 |
| Gmail | `email.gmail` | `smtp.gmail.com` 465/587；`imap.gmail.com` 993 | OAuth2 优先；应用专用密码需开启两步验证 | 纯文本、HTML、附件约 25MB | 个人 500 封/天，Workspace 2000 封/天；每封 500 收件人 | 触发限额后外发可能暂停最长 24 小时；`From` 伪造与缺少 SPF/DKIM 易进垃圾箱 | P0 |
| 网易 163 | `email.163` | `smtp.163.com` 465/587；`imap.163.com` 993 | 客户端授权码，开启协议需短信校验 | 纯文本、HTML、附件 | 普通用户 300–400 封/天，会员等级更高 | Foxmail 场景官方提示不要勾选 STARTTLS；授权码只展示一次 | P0 |
| 网易 126 | `email.126` | `smtp.126.com` 465/587；`imap.126.com` 993 | 同 163 | 同 163 | 同 163 | 同 163；yeah.net 只需替换域名 | P0 |
| Outlook.com | `email.outlook` | `smtp-mail.outlook.com` 587 STARTTLS；`outlook.office365.com` 993 | OAuth2 / Modern Auth，Basic Auth 已不可用 | 纯文本、HTML、附件 | 官方未明确（受反垃圾策略约束） | 必须使用 OAuth2；旧客户端 Basic Auth 会直接失败 | P0 |
| Microsoft 365 | `email.m365` | `smtp.office365.com` 587 STARTTLS；`outlook.office365.com` 993 | OAuth2；SMTP AUTH 默认关闭，需管理员为邮箱开启 | 纯文本、HTML、附件 | 10,000 收件人/天；30 封/分钟；超额被节流并顺延 | SMTP AUTH 与安全默认值、Basic Auth 策略相互影响；租户策略常导致「密码正确但无法登录」 | P0 |
| 阿里邮箱 | `email.aliyun` | `smtp.qiye.aliyun.com` 465/25；`imap.qiye.aliyun.com` 993 | 三方客户端安全密码；管理员需放开三方登录与 POP/IMAP 权限 | 纯文本、HTML、附件 | 官方未明确 | 587 端口未开通；开了安全密码后不能填登录密码；自定义域名需自备 SSL 证书 | P0 |
| 新浪邮箱 | `email.sina` | `smtp.sina.com` / `smtp.sina.cn` / `smtp.vip.sina.com` 465，465 不通可试 587 | 账号密码 + SMTP AUTH（官方未要求独立授权码） | 纯文本、HTML、附件 | 官方未明确 | 必须勾选「SMTP 服务器要求身份验证」；不同后缀对应不同服务器 | P1 |
| 通用 SMTP | `email.smtp` | 自定义 host/port/secure/requireTLS；IMAP 可选 | `password` / `app-password` / `oauth2` | 取决于服务器 | 取决于服务器 | 需要用户自己保证端口、TLS 与证书；不做自动探测 | P0 |

**邮件统一结论**：`provider preset` 只负责「默认端点 + 默认鉴权」，所有邮件最终都走同一条 `nodemailer` 发送链路；`email.smtp` 是兜底，不承诺每家邮箱的特殊行为。SMTP 的 `250` 只表示服务器已接受，退信是异步的，回执必须保留 `Message-ID` 以便关联 DSN。

## 2. 办公应用 webhook

| 渠道 | channel id | 接入 / 端点 | 鉴权 | 内容能力 | 媒体与附件 | @ | 关键配额 | 主要坑 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| 钉钉群机器人 | `im.dingtalk.robot` | Webhook `robot/send` | `access_token` + 加签 HMAC-SHA256 / 关键词 / IP 白名单 | text、markdown、link、actionCard、feedCard；不支持 HTML | 不支持图片与文件 | 支持，最多 50 人 | 20 条/分钟/机器人；超限限流 10 分钟 | 加签时间戳误差不得超过 1 小时；IP 白名单不支持 IPv6；群绑定，不能定向到人 | P0 |
| 企业微信群机器人 | `im.wecom.robot` | Webhook `webhook/send` | URL 中的 `key` 即凭证 | text、markdown、markdown_v2、news、file、voice、template_card；不支持 HTML | 图片 ≤2MB；文件 5B–20MB | 接口文档支持 `mentioned_list` / `<@userid>`，官方帮助页称暂不支持，需实测 | 20 条/分钟/机器人 | `key` 泄露即可发垃圾消息；@ 能力存在官方口径冲突 | P0 |
| 飞书群自定义机器人 | `im.feishu.robot` | `https://open.feishu.cn/open-apis/bot/v2/hook/{token}` | Webhook token + 签名 / 关键词 / IP 白名单 | text、post（富文本）、image、share_chat、interactive；不支持 HTML | 图片需先上传或使用 image_key；不支持任意文件 | 支持 `<at user_id="ou_xxx">` / `<at user_id="all">` | 100 次/分钟、5 次/秒（单租户单机器人）；请求体 ≤20KB | 整点/半点易触发 `11232` 限流；签名串是 `timestamp + "\n" + secret` 做 HmacSHA256 | P0 |

**webhook 统一结论**：门槛最低、无需企业应用审核，但只能发到固定群、内容类型少；`target` 通常可省略，由 webhook 绑定群决定。

## 3. 办公应用应用消息

| 渠道 | channel id | 接入 / 端点 | 鉴权 | 内容能力 | 媒体与附件 | @ | 关键配额 | 主要坑 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| 钉钉工作通知 | `im.dingtalk.work` | OpenAPI `asyncsend_v2` | AppKey/AppSecret 换 `access_token` + `agent_id` | text、markdown、action_card、link、oa；不支持 HTML | image、voice、file，需先上传媒体 | 按 `userid` / 部门投递 | 单次 5000 人；每人每天 500 条；相同内容每人每天 1 条；每分钟 5000 人；消息体 ≤2048 字节 | 超限时接口可能仍返回成功但用户收不到，必须查发送结果 | P1 |
| 企业微信应用消息 | `im.wecom.app` | OpenAPI `message/send` | `corpid` + `corpsecret` 换 `access_token` + `agentid`；需可信 IP | text、markdown、textcard、news、mpnews、template_card 等 | image/voice/video/file，先上传临时素材 | `touser` / `toparty` / `totag` | 账号上限 ×200 人次/天；同一成员 30 次/分钟、1000 次/小时；text ≤2048 字节 | 接收人不在可见范围返回 `invaliduser`/`unlicenseduser`；全部无效返回 `81013`；token 必须缓存 | P1 |
| 飞书应用机器人 | `im.feishu.app` | `POST /open-apis/im/v1/messages` | `tenant_access_token`；`receive_id_type` 支持 open_id/union_id/user_id/email/chat_id | text、post、image、file、audio、media、sticker、interactive、share_chat、share_user | 图片、文件、音视频需先上传拿 key | 卡片内 `<at id="ou_xxx">` / `<at id="all">`；文本可用 `<at user_id="...">` | 1000 次/分钟、50 次/秒；同一用户/群 5 QPS；text ≤150KB，卡片/富文本 ≤30KB | 机器人必须在群内且有发言权；用户需在可用范围；`uuid` 1 小时内去重 | P1 |

**应用消息统一结论**：可定向到人/部门/标签，能力比 webhook 完整，但需要应用凭证、可信 IP/可见范围与更严格配额；超限语义常常是「成功但丢弃」，回执必须查询或依赖回调。

## 4. 短信

| 厂商 | channel id | 接入 / 端点 | 鉴权 | 模板与签名 | 批量 | 回执 / 上行 | 关键限制 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| 阿里云短信 | `sms.aliyun` | `dysmsapi.aliyuncs.com`，`SendSms` / `SendBatchSms` | AccessKeyId / AccessKeySecret | `SignName` + `TemplateCode` + `TemplateParam` | `SendSms` 同签名同模板最多 1000 个号码；`SendBatchSms` 最多 100 个号码、可不同签名/变量 | `QuerySendDetails` 查询发送状态；上行需单独开通 | 签名与模板必须审核通过；群发有延迟 | P1 |
| 腾讯云短信 | `sms.tencent` | `sms.tencentcloudapi.com`，`SendSms` / `SendMultiSms` | SDKAppID + AppKey（TC3-HMAC-SHA256） | `TemplateID` + `TemplateParamSet` + `Sign` | 单发/群发 API；单次上限官方未明确 | 状态回调；上行需单独配置 | 默认同号码同内容 30 秒 1 条、同号码每日 10 条，控制台可调 | P1 |
| 华为云短信 | `sms.huawei` | MSGSMS API，`/api/sms/send` | AppKey/AppSecret，X-WSSE 签名 | `templateId` + `signature` + 模板变量 | 单次最多 500 个接收号码 | 状态回调；上行需单独配置 | 同号码 15 条/分钟；单条最多 500 字 | P2 |
| 云片 | `sms.yunpian` | `https://sms.yunpian.com/v2/sms/single_send.json` 等 | `apikey` | `text` 或 `tpl_id` + 模板变量；签名需后台报备 | 提供批量接口，单次上限官方未明确 | 状态回调；上行需单独配置 | 签名、模板需审核；验证码场景要求行为验证码 | P2 |
| SUBMAIL | `sms.submail` | `https://api.mysubmail.com/message/send` 等 | `appid` + `appkey`/`signature` | `content` 或 `template_id` + `vars`；签名在模板/内容中体现 | 提供批量接口，单次上限官方未明确 | 状态回调；上行需单独配置 | 国内短信签名与模板需审核；国际短信规则按地区不同 | P2 |

**短信统一结论**：国内短信不是「填一段文本就能发」，而是「签名 + 模板 + 变量」的强约束模型。`content.text` 只作为可读摘要，真正下发必须由 `channelOptions.signName/templateId/templateParams` 驱动；缺模板应直接 `UNSUPPORTED_CONTENT`，不能静默降级。

## 5. 微信生态

| 能力 | channel id / action | 接入 / 端点 | 鉴权 | 内容能力 | 媒体 | 关键规则 | 主要坑 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| 公众号模板消息 | `wechat.mp.template` / `send` | `POST /cgi-bin/message/template/send` | `access_token`（公众号） | 模板消息，字段由 `template_id` 的 `data` 决定；可带 `url` / `miniprogram` | 不支持附件 | 仅认证服务号；每账号最多 25 个模板；日调用上限 10 万次（粉丝量提升另计） | 只能用于服务通知，不能营销；用户需与业务有实际交互；模板参数占位符按官方 `{{key.DATA}}` 格式 | P2 |
| 公众号订阅通知 | `wechat.mp.subscribe` / `send` | `POST /cgi-bin/message/subscribe/bizsend` | `access_token` | `template_id` + `data` + `page` + `miniprogram_state` + `lang` | 不支持附件 | 一次性订阅：一次授权发一条；长期订阅：仅政务民生、医疗等公共服务类目 | 必须用户主动订阅；一次性授权不能当长期授权用 | P2 |
| 公众号客服消息 | `wechat.mp.custom` / `send` | `POST /cgi-bin/message/custom/send` | `access_token` | text、image、voice、video、music、news、mpnews、menu、miniprogrampage | 可用临时/永久素材 `media_id` | 用户发消息后 5 条/48 小时；点菜单/关注/扫码后 3 条/1 分钟 | 超出 48 小时返回 `45015`；下发额度不累加 | P2 |
| 微信客服（Kf） | `wechat.kf` / `send` | `POST https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg` | 微信客服 Secret 换 `access_token` | text、image、voice、video、file、link、miniprogram、msgmenu、location | 需先上传临时素材 | 仅允许微信客服 Secret 获取的 token；受客服会话状态与窗口约束 | 不能用公众号 token；欢迎语/事件响应需用事件 `code` | P3 |
| 素材管理 | `wechat.mp.material` / `upload` | 临时 `/cgi-bin/media/upload`；永久 `/cgi-bin/material/add_material` | `access_token` | 图片、语音、视频、缩略图 | 图片 10MB、语音 2MB/60s、视频 10MB、缩略图 64KB | 临时素材 3 天后 `media_id` 失效；永久素材计入账号配额 | 官方临时素材页存在 2MB/10MB 口径差异，按实际账号类型实测 | P2 |

**微信统一结论**：模板/订阅是「强授权 + 强模板」；客服消息是「48 小时窗口 + 条数额度」；Kf 是独立客服体系，token 与公众号不通用。素材必须先上传换 `media_id`，不能直接把二进制塞进发送接口。

## 6. 预留扩展

| 渠道 | 建议 channel id | 接入方式 | 是否需要改核心 | 说明 |
|---|---|---|---|---|
| Slack | `im.slack.webhook` | Incoming Webhook / Web API | 否 | 独立 adapter，`content.markdown` 映射 Block Kit |
| Microsoft Teams | `im.teams.webhook` | Incoming Webhook / Graph | 否 | 独立 adapter，Adaptive Card 放 `channelOptions.card` |
| Telegram | `im.telegram.bot` | Bot API `sendMessage` | 否 | 独立 adapter，支持 text/photo/document |
| Discord | `im.discord.webhook` | Webhook | 否 | 独立 adapter，`content` 映射 embeds |

扩展方式：新增 `@fengsui/adapter-<name>` 包，实现同一 `ChannelAdapter` 契约并注册 `channel id`；核心、CLI、MCP 不改代码。第三方 adapter 通过显式配置加载，不做自动扫描。

## 7. 官方文档索引

**邮件**

- QQ 邮箱：[客户端安全登录](https://help.mail.qq.com/detail/0/1088)、[授权码](https://help.mail.qq.com/detail/0/985)、[附件大小](https://service.mail.qq.com/detail/0/479)、[550 频率限制](https://service.mail.qq.com/detail/0/174)
- Gmail：[发送 API](https://developers.google.cn/workspace/gmail/api/guides/sending?hl=zh-cn)、[配额](https://developers.google.cn/workspace/gmail/api/reference/quota?hl=zh-cn)、[发送限制](https://support.google.com/mail/answer/22839)（中国大陆需可访问 Google 网络）
- 网易：[开启客户端协议](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b)、[每日发信量](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac27ae9194e21b954ec)
- Outlook / Microsoft 365：[Outlook.com POP/IMAP/SMTP 设置](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040)、[启用/禁用 SMTP AUTH](https://learn.microsoft.com/zh-cn/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission)、[Exchange Online 外发限额](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot)、[应用发送邮件配置](https://learn.microsoft.com/zh-cn/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365)
- 阿里邮箱：[IMAP/POP/SMTP 地址与端口](https://help.aliyun.com/zh/document_detail/438661.html)
- 新浪邮箱：[免费邮箱 POP/IMAP/SMTP 服务器](http://help.sina.com.cn/comquestiondetail/view/160/)

**办公应用**

- 钉钉：[自定义机器人发群消息](https://open.dingtalk.com/document/development/custom-robots-send-group-messages)、[安全设置](https://open.dingtalk.com/document/dingstart/customize-robot-security-settings)、[消息类型](https://open.dingtalk.com/document/development/robot-message-type)、[工作通知](https://open.dingtalk.com/document/development/asynchronous-sending-of-enterprise-session-messages)
- 企业微信：[消息推送](https://developer.work.weixin.qq.com/document/path/91770)、[应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[access_token](https://developer.work.weixin.qq.com/document/path/91039)
- 飞书：[自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)

**短信**

- 阿里云：[SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)、[SendBatchSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendbatchsms)
- 腾讯云：[发送短信](https://cloud.tencent.com/document/product/382/38778)、[错误码](https://cloud.tencent.com/document/product/382/3771)
- 华为云：[发送短信 API](https://support.huaweicloud.com/intl/zh-cn/api-msgsms/sms_05_0001.html)、[发送频率限制](https://support.huaweicloud.com/intl/en-us/productdesc-msgsms/sms_01_0004.html)
- 云片：[单条发送](https://www.yunpian.com/official/document/sms/zh_CN/domestic_single_send)
- SUBMAIL：[短信发送 API](https://www.mysubmail.com/documents/FppOR3)

**微信生态**

- [模板消息](https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Interface.html)、[发送模板消息](https://developers.weixin.qq.com/doc/service/api/notify/template/api_sendtemplatemessage)
- [订阅通知](https://developers.weixin.qq.com/doc/service/guide/product/subscription_messages/intro.html)、[发送订阅通知](https://developers.weixin.qq.com/doc/service/api/notify/notify/api_sendnewsubscribemsg)
- [客服消息](https://developers.weixin.qq.com/doc/service/guide/product/kf/intro.html)、[发送客服消息](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage)
- [微信客服发送消息](https://kf.weixin.qq.com/api/doc/path/94744)
- [新增临时素材](https://developers.weixin.qq.com/doc/subscription/api/material/temporary/api_uploadtempmedia.html)、[上传永久素材](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_addmaterial.html)
