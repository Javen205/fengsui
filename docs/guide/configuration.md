# 配置系统

> 让业务只说“发给谁、发什么”，剩下的交给配置。

烽燧的配置系统解决一个很具体的问题：**同一个渠道设置，不该在每封信封里重复写一百遍**。

渠道用哪个、凭证引用叫什么、发件人是谁、超时多久——这些都可以由配置提供默认值。业务代码只保留真正属于这一次投递的信息，配置负责把项目之间的差异安放好。

## 一条最小配置

```json
{
  "version": 1,
  "defaults": {
    "channel": "email.qq",
    "credentialsRef": "qq/main",
    "channelOptions": {
      "from": "noreply@example.com",
      "timeoutMs": 10000
    }
  }
}
```

把它接入实例：

```ts
import { createFengsui, createEnvCredentialResolver } from '@javen205/fengsui-core';
import { fileConfig } from '@javen205/fengsui-config-file';
import { emailPlugin } from '@javen205/fengsui-adapter-email';

const fengsui = createFengsui({
  credentials: createEnvCredentialResolver(),
  config: fileConfig({ path: './fengsui.config.json', watch: true }),
  plugins: [emailPlugin()],
});
```

现在发送时，`channel` 与 `credentialsRef` 都可以省略：

```ts
await fengsui.send({
  action: 'send',
  content: { subject: '日报', text: '今日一切正常。' },
  target: { to: ['ops@example.com'] },
});
```

配置只提供**默认值**，不剥夺调用方的决定权。信封里写了什么，就以什么为准。

## 配置文件的结构

```json
{
  "version": 1,
  "defaults": {
    "channel": "email.smtp",
    "credentialsRef": "shared/mailer",
    "channelOptions": {
      "from": "noreply@example.com",
      "transport": { "host": "smtp.example.com", "port": 465, "secure": true }
    },
    "channels": {
      "email.qq": {
        "credentialsRef": "shared/qq",
        "channelOptions": { "from": "notice@qq.com" }
      }
    }
  },
  "projects": {
    "billing": {
      "channel": "email.aliyun",
      "credentialsRef": "billing/mailer",
      "channelOptions": { "from": "billing@example.com" }
    },
    "billing-test": {
      "extends": "billing",
      "channels": {
        "email.aliyun": {
          "credentialsRef": "billing/test-mailer",
          "channelOptions": { "from": "test@example.com" }
        }
      }
    }
  }
}
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `version` | 配置格式版本，目前固定为 `1`，可省略 |
| `defaults` | 全局默认层，优先级最低 |
| `defaults.channel` | 默认渠道 ID，如 `email.qq` |
| `defaults.credentialsRef` | 默认凭证引用，形如 `tenant/account` |
| `defaults.channelOptions` | 默认渠道选项 |
| `defaults.channels.<channelId>` | 只对某个渠道生效的默认值，优先级高于同层通用字段 |
| `projects.<id>` | 项目层，发送时用 `meta.projectId` 选择 |
| `projects.<id>.extends` | 继承父项目，形成继承链 |

## 合并优先级

从低到高，一共四层：

```text
defaults
  → projects.<id> 的继承链（根祖先 → … → 当前项目）
    → 同一层内的 channels.<channelId>
      → 信封显式字段（channel / credentialsRef / channelOptions）
```

几点容易踩坑的细节：

- **`channels.<id>` 高于同层通用字段**。上一层写了 `credentialsRef`，下一层只覆盖 `channels["email.qq"].credentialsRef`，就只影响 QQ 邮件，其他渠道继续沿用上一层。
- **`channelOptions` 是深合并**。`headers`、`transport` 这类嵌套对象逐项覆盖，而不是整体替换。
- **信封永远最高**。配置是默认值，不是强制值。

深合并的例子：

```json
{
  "defaults": {
    "channelOptions": {
      "from": "noreply@example.com",
      "headers": { "X-Env": "prod", "X-Team": "platform" }
    }
  }
}
```

```ts
channelOptions: {
  headers: { 'X-Team': 'billing' },
}
```

最终 `from` 保留配置值，`headers` 合并为 `{ "X-Env": "prod", "X-Team": "billing" }`。

## 项目继承

`extends` 让项目配置可以拼装，而不是复制粘贴：

```json
{
  "projects": {
    "base": {
      "channel": "email.aliyun",
      "channelOptions": { "from": "noreply@example.com", "timeoutMs": 10000 }
    },
    "billing": {
      "extends": "base",
      "credentialsRef": "billing/mailer"
    },
    "billing-test": {
      "extends": "billing",
      "channels": {
        "email.aliyun": { "credentialsRef": "billing/test-mailer" }
      }
    }
  }
}
```

`billing-test` 最终继承到：`base` 的渠道与超时 → `billing` 的凭证引用 → 自己的测试凭证。

继承链出现环或父项目不存在时，配置加载会直接失败并给出链路径：

```text
Cyclic project inheritance detected: a -> b -> a
Project "billing" extends unknown project "missing"
```

::: tip 严格项目模式
默认 `strictProject: true`：`meta.projectId` 写了不存在的项目会直接报错，并列出可用项目。  
如果灰度或测试环境希望“未知项目按无项目处理”，可以显式关闭：

```ts
createFengsui({
  credentials: createEnvCredentialResolver(),
  config: fileConfig({ path: './fengsui.config.json' }),
  configOptions: { strictProject: false, defaultProjectId: 'billing' },
  plugins: [emailPlugin()],
});
```
:::

## 缓存、热更新与关闭

配置是“整份快照”模型：Provider 每次返回完整配置，核心负责校验、缓存与合并。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheTtlMs` | `30000` | 快照缓存时间；`<= 0` 表示每次都重新加载 |
| `strictProject` | `true` | 未知项目是否直接报错 |
| `defaultProjectId` | 无 | 未传 `meta.projectId` 时使用的项目 |

文件来源额外支持：

```ts
fileConfig({
  path: './fengsui.config.json',
  watch: true,
  debounceMs: 100,
});
```

- `watch: true` 监听文件变化，变更后立即让缓存失效，下一次发送自动使用新配置；
- `debounceMs` 防止编辑器多次写盘触发重复加载；
- 文件暂时不存在、监听失败都不会让进程崩溃，退化为按 TTL 重新读取；
- `fengsui.close()` 会取消订阅并关闭文件监听。

`ConfigResolver` 由 `createFengsui()` 内部持有，实例不暴露手动失效入口；生产环境建议用 `watch` 或较短的 `cacheTtlMs`，让配置变更自然生效。

## 自定义配置来源

配置来源只负责“取数据”，不负责校验与合并。接入数据库、Redis 或配置中心，实现同一个 `ConfigProvider` 即可：

```ts
import type { ConfigProvider, FengsuiPlugin } from '@javen205/fengsui-core';

interface DbConfigOptions {
  query: () => Promise<unknown>;
  subscribe?: (onChange: () => void) => () => void;
}

function dbConfig(options: DbConfigOptions): ConfigProvider {
  return {
    name: 'db:settings',

    async load() {
      return options.query();
    },

    subscribe(onChange) {
      return options.subscribe?.(onChange) ?? (() => {});
    },
  };
}
```

```ts
createFengsui({
  credentials: createEnvCredentialResolver(),
  config: dbConfig({
    query: async () => db.settings.findFirst({ where: { app: 'fengsui' } }),
    subscribe: (onChange) => bus.on('settings.changed', onChange),
  }),
  plugins: [emailPlugin()],
});
```

::: warning Provider 的职责边界
- `load()` 返回任意 JSON 值，核心会用 schema 做严格校验；
- 读取或解析失败时应抛错，核心会包装成 `FengsuiError(code: 'config')` 并 fail-fast；
- 支持 `subscribe()` 时，通知核心后会立即清空缓存；
- `close()` 用于释放数据库连接、监听器等资源。
:::

## 凭证：配置里永远不写密钥

配置只能写 `credentialsRef`，密钥由 `CredentialResolver` 解析。默认的环境变量解析器按下面的规则映射：

```text
ref = tenant/account
→ 全部大写
→ 非字母数字替换为下划线
→ 去掉首尾下划线
→ 加上前缀 FENGSUI_CRED_
```

| `credentialsRef` | 环境变量 |
| --- | --- |
| `qq/main` | `FENGSUI_CRED_QQ_MAIN` |
| `billing/mailer` | `FENGSUI_CRED_BILLING_MAILER` |
| `wecom/support` | `FENGSUI_CRED_WECOM_SUPPORT` |

值支持两种形态：

```bash
# JSON 对象：字段按渠道约定解析
FENGSUI_CRED_QQ_MAIN='{"user":"bot@qq.com","pass":"授权码"}'

# 单值：放入 value 字段
FENGSUI_CRED_SOME_TOKEN='abc123'
```

邮件使用 `user` + `pass`（OAuth2 使用 `accessToken` 或 `clientId/clientSecret/refreshToken`）；企业微信机器人使用 `secret`。

::: danger 不要把密钥写进配置文件
信封、`channelOptions`、配置文件都不接受内联密钥。核心会主动检查 `password`、`secret`、`token` 这类字段名并直接拒绝，避免“临时图省事”变成长期泄露。
:::

## 常见问题

**发送报 `channel is required`**  
信封没写 `channel`，配置里也没有 `defaults.channel` 或项目级 `channel`。检查配置是否加载成功。

**发送报 `credentialsRef is required`**  
信封没写凭证引用，配置也没有为当前渠道提供默认值，且适配器没有声明 `defaultCredentialsRef`。

**配置改了但不生效**  
检查是否设置了较大的 `cacheTtlMs`；文件来源建议开启 `watch: true`，或在部署流程中重启/触发缓存失效。

**项目继承报环**  
`extends` 形成了循环。错误信息会打印完整链路，按链路断开其中一条即可。

**未知项目**  
确认 `meta.projectId` 拼写，或把 `strictProject` 设为 `false`（不推荐在生产环境长期这样做）。

下一步：[目录与架构](/guide/architecture)，看看这些配置最终是如何被投递器消费的。
