# 企业微信机器人

> 一个机器人，一条长连接；既能主动推送，也能听懂每一句话。

企业微信渠道把每个智能机器人映射成一个独立渠道 `wecom.bot.<alias>`。出站走统一信封，入站走 handler。

## 安装与启用

```bash
pnpm add @javen205/fengsui-core @javen205/fengsui-adapter-wecom-bot
```

```ts
import { createFengsui, createEnvCredentialResolver } from '@javen205/fengsui-core';
import { wecomBotPlugin } from '@javen205/fengsui-adapter-wecom-bot';

const wecom = wecomBotPlugin({
  bots: [
    { alias: 'support', botId: 'your-bot-id' },
    { alias: 'alert', botId: 'another-bot-id' },
  ],
  handlers: {
    'message.text': async ({ message, reply }) => {
      await reply.markdown(`收到：${message.text ?? ''}`);
      return { handled: true };
    },
  },
});

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  plugins: [wecom],
});

await fengsui.start();
```

- `alias` 决定渠道 ID：`wecom.bot.support`、`wecom.bot.alert`；
- `botId` 不是密钥，可以随代码走；
- `secret` 只能通过 `credentialsRef` 解析；
- `fengsui.start()` 才会建立长连接；纯发送场景可以省略，首次 `send()` 会懒连接。

## 凭证

默认凭证引用为 `wecom/<alias>`：

```bash
FENGSUI_CRED_WECOM_SUPPORT='{"secret":"机器人密钥"}'
```

也可以在机器人定义里指定：

```ts
{
  alias: 'support',
  botId: 'your-bot-id',
  credentialsRef: 'project-a/wecom-support',
}
```

凭证必须包含 `secret`；可选包含 `botId`，用于按项目覆盖同一个机器人的 ID。

## 主动发送

出站只支持企业微信主动推送的两种形态：**Markdown** 与 **模板卡片**。

```ts
await fengsui.send({
  channel: 'wecom.bot.support',
  action: 'send',
  target: { chatId: 'zhangsan' },
  content: { markdown: '**部署完成**\n> 版本 1.4.2' },
});
```

目标解析顺序：

```text
target.chatId → target.userIds[0] → target.to[0] → target.openIds[0]
```

单聊填 `userid`，群聊填 `chatid`。普通文本会按 Markdown 发送（企业微信渲染纯文本没有问题）。

### 模板卡片

```ts
await fengsui.send({
  channel: 'wecom.bot.alert',
  action: 'send',
  target: { chatId: 'ops-group' },
  content: { markdown: '触发告警' },
  channelOptions: {
    msgtype: 'template_card',
    card: {
      card_type: 'text_notice',
      // 其余字段遵循企业微信模板卡片文档
    },
  },
});
```

渠道选项只有两个字段：

| 字段 | 说明 |
| --- | --- |
| `msgtype` | `markdown` 或 `template_card`；省略时根据 `card` 是否存在推断 |
| `card` | 模板卡片对象；存在时优先按卡片发送 |

::: warning 主动推送的限制
企业微信主动推送不支持图片、文件、语音等媒体类型。需要发送媒体时，请通过入站事件中的 `reply.upload()` + `reply.media()`，或 `reply.sendTo()` 组合实现。
:::

## 入站 handler

插件把 SDK 的 WebSocket 帧归一化为统一的 `InboundMessage`，再按事件名路由。

事件名规则：

```text
消息：message.<type>      如 message.text、message.image、message.mixed
事件：event.<eventtype>   如 event.enter_chat、event.template_card_event
通配：*
```

```ts
const wecom = wecomBotPlugin({
  bots: [{ alias: 'support', botId: 'your-bot-id' }],
  handlers: {
    'message.text': async ({ message, reply }) => {
      if (message.text?.includes('工单')) {
        return { markdown: '已为你创建工单。' };
      }
    },

    'event.enter_chat': async ({ reply }) => {
      await reply.welcome({ msgtype: 'text', text: { content: '你好，有什么可以帮你？' } });
    },

    '*': async ({ message, logger }) => {
      logger.debug('wecom.message', { channel: message.channel, kind: message.kind });
    },
  },
});
```

handler 返回值：

| 返回 | 效果 |
| --- | --- |
| `void` | 继续执行后续 handler |
| `{ handled: true }` | 短路后续 handler |
| `{ text }` / `{ markdown }` / `{ card }` | 插件自动回复，优先级 `card` > `markdown` > `text` |

自动回复可通过 `autoReply: false` 关闭。

## 回复器

`reply` 绑定当前事件的原始帧：

| 方法 | 用途 |
| --- | --- |
| `text(content)` | 回复纯文本（内部走一次性流式消息） |
| `markdown(content)` | 回复 Markdown |
| `stream({ id, content, finish })` | 流式回复，复用同一个 `id` 逐步刷新 |
| `welcome(body)` | 欢迎语，仅 `enter_chat` 事件可用 |
| `card(card, feedback?)` | 回复模板卡片 |
| `streamWithCard(options)` | 流式消息 + 模板卡片组合 |
| `updateCard(card, userIds?)` | 更新已发送的卡片，仅 `template_card_event` 可用 |
| `upload(file, options)` | 上传临时素材，返回 `media_id` |
| `media(type, mediaId, videoOptions?)` | 回复临时素材 |
| `sendTo(chatId, body)` | 主动推送到会话，不受回复窗口限制 |
| `download(url, aesKey?)` | 下载并解密媒体 |
| `hasPendingAck()` | 是否还有未确认的回复 |
| `frame` / `channel` | 原始帧与渠道 ID |

::: danger 被动回复有 5 秒窗口
`text`、`markdown`、`stream`、`card`、`welcome` 等被动回复必须在收到事件后 **5 秒内**调用，超时后企业微信会关闭回复窗口。耗时任务请先 `ack` 或直接使用 `sendTo()` 主动推送。
:::

## 多机器人与动态管理

插件对象暴露 `bots`（即 `WecomBotManager`）：

```ts
wecom.bots.status('support');      // 单个机器人状态
wecom.bots.listStatus();           // 全部状态
wecom.bots.on('*', 'message.text', handler); // 动态注册 handler
wecom.bots.router('support');      // 取路由器
await wecom.bots.send('support', 'zhangsan', body); // 直接发送
```

连接状态：

```text
idle → connecting → connected → authenticated
                    ↘ reconnecting ↗
                    ↘ disconnected / stopped
```

`status()` 会返回 `state`、`connected`、最近连接/认证/断开时间、重连次数与最后一次错误。

## 连接与重连参数

每个机器人可单独覆盖 SDK 参数：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用，默认 `true`；禁用后不注册渠道也不建连 |
| `scene` / `plugVersion` | 透传给 SDK |
| `reconnectInterval` | 重连基础延迟，SDK 默认 1000ms |
| `maxReconnectAttempts` | 最大重连次数，默认 10；`-1` 无限 |
| `maxAuthFailureAttempts` | 认证失败最大重试次数，默认 5；`-1` 无限 |
| `heartbeatInterval` | 心跳间隔，默认 30000ms |
| `requestTimeout` | 请求超时，默认 10000ms |
| `wsUrl` | 自定义 WebSocket 地址 |
| `wsOptions` | 透传给底层 `ws` 的 TLS 等选项 |
| `maxReplyQueueSize` | 单个 `req_id` 的回复队列上限，默认 500 |
| `handlers` | 该机器人专属 handler，与插件级 handler 合并执行 |

插件级选项：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `dedupeTtlMs` | 10 分钟 | 入站去重窗口；`<= 0` 关闭 |
| `dedupeMaxEntries` | 10000 | 去重缓存上限 |
| `connectTimeoutMs` | 10000 | 建连并等待认证的超时 |
| `autoReply` | `true` | 是否自动发送 handler 返回的 `text` / `markdown` / `card` |
| `onError` | 无 | handler 抛错回调（错误同时写日志） |

## 能力与降级

| 能力 | 声明 |
| --- | --- |
| 内容类型 | `text`、`markdown` |
| 模板 | 支持（通过 `channelOptions.card`） |
| 附件 | 不支持 |
| 批量 | 不支持 |
| 回执 | `sync` |
| 幂等 | `local` |
| dry-run | 支持 |
| 限流维度 | `bot` |

默认降级链 `{ html: ['text'] }`。

## 健康检查

```ts
const health = await fengsui.healthCheck('wecom.bot.support');
```

健康检查会等待机器人认证通过，默认超时 5 秒；失败时返回 `{ ok: false, detail }`。

## 常见问题

**收不到消息**  
确认调用了 `fengsui.start()`，或至少发送过一次触发懒连接；检查 `status()` 是否到达 `authenticated`。

**回复超时**  
被动回复窗口只有 5 秒。耗时逻辑请改用 `reply.sendTo()` 主动推送。

**认证失败**  
确认 `secret` 正确且机器人已启用；检查 `maxAuthFailureAttempts` 是否耗尽。

**同一个机器人被重复建连**  
每个 `alias` 在一个实例内唯一。多个实例使用同一个机器人会产生多条连接，建议由单一实例负责收发。

**handler 没被触发**  
检查事件名：消息是 `message.<type>`，事件是 `event.<eventtype>`；确认 handler 没有被前一个 `{ handled: true }` 短路。

---

到这里，两个内置渠道就介绍完了。想接入自己的渠道，请继续阅读[如何扩展](/guide/extending)。
