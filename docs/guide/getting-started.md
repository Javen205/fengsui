# 快速开始

用十分钟，把第一条消息发出去。

## 环境要求

- Node.js **>= 22**
- pnpm **12+**

## 在仓库中开发

```bash
git clone <repo-url> fengsui
cd fengsui

pnpm install
pnpm build
pnpm test
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 构建全部 workspace 包 |
| `pnpm test` | 运行全部 Vitest 用例 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint |
| `pnpm docs:dev` | 本地启动本站在线预览 |
| `pnpm docs:build` | 构建静态文档站 |

## 在应用中使用

当前各包以 workspace 形式组织。在你的应用 `package.json` 中按需引用：

```json
{
  "dependencies": {
    "@fengsui/core": "workspace:^",
    "@fengsui/adapter-email": "workspace:^"
  }
}
```

只装你需要的渠道插件。核心包不会替你引入 nodemailer 或企业微信 SDK。

## 第一条消息

### 1. 配置凭证

凭证不写进代码，也不写进配置文件。默认从环境变量读取：

```bash
# 引用名 qq/main → 环境变量 FENGSUI_CRED_QQ_MAIN
export FENGSUI_CRED_QQ_MAIN='{"user":"bot@qq.com","pass":"你的 SMTP 授权码"}'
```

命名规则：`credentialsRef` 全部大写，非字母数字字符替换为下划线，再加前缀 `FENGSUI_CRED_`。

### 2. 创建实例

```ts
import { createEnvCredentialResolver, createFengsui } from '@fengsui/core';
import { emailPlugin } from '@fengsui/adapter-email';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  plugins: [emailPlugin()],
});
```

`emailPlugin()` 会注册 `email.smtp` 与全部内置邮箱 preset（`email.qq`、`email.gmail`、`email.163` 等）。

### 3. 发送

```ts
const receipt = await fengsui.send({
  channel: 'email.qq',
  action: 'send',
  credentialsRef: 'qq/main',
  target: { to: ['ops@example.com'] },
  content: {
    subject: '烽燧已点火',
    text: '第一条消息发送成功。',
  },
});

console.log(receipt.status); // 'sent' | 'partial' | 'failed'
console.log(receipt.results[0]?.providerMessageId);
```

一次投递可以带多个目标：

```ts
await fengsui.send({
  channel: 'email.qq',
  action: 'send',
  credentialsRef: 'qq/main',
  target: { to: ['a@example.com', 'b@example.com'] },
  content: { subject: '值班提醒', text: '今晚 22:00 发布。' },
});
```

每个目标独立重试、独立超时、独立回执，不会因为一个人失败而拖垮整批。

### 4. 先演练，再上线

```ts
const preview = await fengsui.send(
  {
    channel: 'email.qq',
    action: 'send',
    credentialsRef: 'qq/main',
    target: { to: ['ops@example.com'] },
    content: { subject: '演练', text: '只校验，不发送' },
  },
  { dryRun: true },
);

console.log(preview.dryRun); // true
```

dry-run 会完成信封校验、渠道解析、能力匹配与降级规划，但不触碰供应商接口。适合在 CI 与发布前跑一遍。

## 用配置减少重复

把渠道、凭证、发件人写进配置文件，业务发送就只剩“给谁、发什么”：

```json
{
  "version": 1,
  "defaults": {
    "channel": "email.qq",
    "credentialsRef": "qq/main",
    "channelOptions": {
      "from": "烽燧 <bot@qq.com>"
    }
  }
}
```

```ts
import { fileConfig } from '@fengsui/config-file';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  config: fileConfig({ path: './fengsui.config.json', watch: true }),
  plugins: [emailPlugin()],
});

await fengsui.send({
  action: 'send',
  target: { to: ['ops@example.com'] },
  content: { subject: '配置生效了', text: '这次没有写渠道和凭证。' },
});
```

更多层级、项目继承与热更新见[配置系统](/guide/configuration)。

## 下一步

- 了解信封、目标、回执与错误：[使用指南](/guide/usage)
- 配置默认渠道与项目继承：[配置系统](/guide/configuration)
- 接入企业微信机器人：[企业微信机器人](/guide/channels/wecom-bot)
- 写一个自己的渠道：[如何扩展](/guide/extending)
