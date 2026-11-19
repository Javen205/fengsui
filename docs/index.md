---
layout: home

hero:
  name: 烽燧
  text: 一封信封，万里相传
  tagline: 以信封为中心、插件化的多渠道消息投递框架。业务只说“发什么、给谁”，渠道、凭证、重试与降级交给烽燧。
  image:
    src: /assets/images/logo.svg
    alt: 烽燧
  actions:
    - theme: brand
      text: 5 分钟上手
      link: /guide/getting-started
    - theme: alt
      text: 读设计故事
      link: /guide/introduction

features:
  - title: 一封信封，统一表达
    details: channel、action、target、content、meta 五个字段描述一次投递。业务代码不关心 SMTP、WebSocket 还是 HTTP。
  - title: 渠道即插件
    details: 核心不依赖任何渠道 SDK。装邮件才有 nodemailer，装企业微信才有长连接，按需引入、互不牵连。
  - title: 配置给默认值
    details: 默认渠道、凭证引用、发件人、项目继承链都能预先配置。发送时只写业务字段，不再复制粘贴接口参数。
  - title: 失败是一等公民
    details: 统一错误码区分 validation、auth、network、rate_limited；可重试标记、逐目标回执、幂等存储开箱即用。
  - title: 收发一体
    details: 通用入站契约与 InboundRouter 把回调、长连接消息归一化，handler 可按事件分流并直接回复。
  - title: 可演练、可观测
    details: dry-run 先校验后发送，healthCheck 主动探活，traceId 贯穿日志与回执，上线前就能把路径走一遍。
---

## 为什么叫“烽燧”

两千年前，戍卒在烽火台上点燃一堆柴薪，信号便沿着山脊一座座传下去。点火的人不需要知道下一座台子用什么燃料，只需要表达一件事：**有消息，往哪里传。**

烽燧做的是同一件事。业务代码只负责写“信”，渠道适配器负责“点火”，中间的配置、凭证、重试、降级与观测由框架接力。

```ts
import { createEnvCredentialResolver, createFengsui } from '@javen205/fengsui-core';
import { fileConfig } from '@javen205/fengsui-config-file';
import { emailPlugin } from '@javen205/fengsui-adapter-email';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  config: fileConfig({ path: './fengsui.config.json' }),
  plugins: [emailPlugin()],
});

// 渠道、凭证、发件人来自配置，业务只描述这封信
const receipt = await fengsui.send({
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: '部署完成', text: 'v1.2.0 已上线' },
});

console.log(receipt.status, receipt.providerMessageId);
```

<div style="margin-top: 2rem; text-align: center; color: var(--vp-c-text-2);">
  从一封信封开始，把消息送到该去的地方。
</div>
