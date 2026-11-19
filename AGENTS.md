# AGENTS.md

本文件面向在本仓库工作的 AI 编码代理。人类贡献流程见 [README](README.md#如何贡献)，使用文档见 [docs/guide](docs/guide/getting-started.md)。

## 项目定位

烽燧（fengsui）是以「信封」为中心、插件化的多渠道消息投递框架。业务只描述 `channel`、`action`、`target`、`content`，凭证解析、重试、降级、幂等与回执由框架负责。

Monorepo：pnpm workspace + TypeScript ESM + tsup 打包 + Vitest，Node.js >= 22，pnpm 12。

## 仓库结构

```text
packages/
├── core/               # 信封、校验、调度、重试、配置解析、凭证、幂等、插件 API
├── http/               # HttpClient 契约（无实现）
├── http-fetch/         # fetch 实现
├── http-axios/         # axios 实现（axios 为 peer）
├── config-file/        # JSON 配置来源与文件监听
├── adapter-email/      # 邮件渠道（nodemailer）
└── adapter-wecom-bot/  # 企业微信机器人（长连接 + 入站 handler）
examples/nest/          # 可运行的 NestJS 示例
docs/guide/             # 面向用户的文档（发布到站点）
docs/dev/               # 设计、渠道矩阵与调研存档（srcExclude，不发布）
```

## 常用命令

```bash
pnpm install
pnpm build        # pnpm -r build，递归构建全部包
pnpm test         # vitest run
pnpm lint         # eslint .
pnpm typecheck    # tsc --noEmit
pnpm format:check # prettier 校验；格式化用 pnpm format
pnpm docs:dev     # 本地预览文档站
pnpm docs:build   # 构建文档站
```

单包与单测：

```bash
pnpm --filter @javen205/fengsui-core build
pnpm vitest run packages/core/test/config.test.ts
```

注意：`examples/` 依赖已构建的 `dist`，改动 `packages/` 源码后需先 `pnpm build` 再跑示例。

## 架构边界

- **core 不含渠道实现**。新增渠道应新建 `packages/adapter-*`，通过 `FengsuiPlugin.register()` 注册，不要在 core 内按渠道加分支。
- **传输通过契约注入**。适配器用 `requireHttp(ctx)` 取 `HttpClient`，不要直接 `import axios` 或调用全局 `fetch`。
- **依赖方向**：`adapter-*` / `config-file` → `core` → `http`；`http-fetch` / `http-axios` 只实现 `http` 契约。
- **配置合并顺序**：`defaults` → 项目继承链（根祖先到当前项目）→ `channels.<channel>` → 信封显式字段，`channelOptions` 会跨层深合并。
  - 不要把邮件专用选项（如 `from`）放进 `defaults.channelOptions`，它会合并到所有渠道并导致其它适配器 schema 校验失败。
  - 需要隔离时使用 `meta.projectId` 选择项目级配置。
- **信封字段固定**：`channel` / `action` / `target` / `content` / `channelOptions` / `credentialsRef` / `meta`，不要新增顶层字段。

## 代码约定

- ESM + tsup，`moduleResolution: Bundler`：相对导入**不带** `.js` 后缀，与文档示例保持一致。
- 包名统一 `@javen205/fengsui-*`，内部依赖写 `workspace:^`；发布时 pnpm 会改写为实际版本。
- TypeScript 严格模式，公共类型从包入口导出；避免 `any` 与隐式 `as`。
- 渠道选项 schema 使用 zod 且必须 `.strict()`，让拼写错误显式失败。
- 错误统一抛 `FengsuiError`，带 `code`、`channel`、`retryable`；上游响应写入 `providerMessage` 前先截断。
- 凭证只经 `CredentialResolver` 解析，环境变量键由 `credentialsRef` 推导为 `FENGSUI_CRED_<REF>`；任何密钥都不得写入代码、配置或提交到仓库。
- 注释与文档使用中文；注释解释「为什么」，不复述代码。

## 测试

- 测试位于 `packages/*/test`，`vitest.config.ts` 通过 alias 指向各包 `src`，无需先构建。
- 新渠道至少要覆盖：`normalize()` 的数据映射、HTTP 错误到 `FengsuiError` 的映射、可重试判定。
- 使用假 `HttpClient` / 假 SDK 客户端，避免真实网络；端到端可用 `msw` 或本地 `smtp-server`。
- 修改 dispatcher、config 或 credentials 行为时必须补对应测试。

## 文档

- 面向用户的内容写 `docs/guide`；设计依据、渠道矩阵、竞品调研写 `docs/dev`（已排除出站点，不需要删除）。
- README 只保留：项目简介、设计架构、如何开发、如何贡献；其余细节放 guide 并通过链接引用。
- 新增 guide 页面后同步更新 [docs/.vitepress/config.ts](docs/.vitepress/config.ts) 的导航与侧边栏。
- 文档正文与代码块注释统一使用中文。

## 示例

- `examples/nest` 是真实可运行的 NestJS 12 示例；`.env` 不入库，只提交 `.env.example` 占位。
- 包名或公共 API 变更后，同步修改示例导入与文档中的代码片段。

## 发布

- npm scope 为 `@javen205/fengsui-*`，发布前必须 `pnpm build` 且 `pnpm test` 通过。
- 发布命令：

```bash
pnpm -r publish --access public --registry=https://registry.npmjs.org --no-git-checks
```

- 发布前确认 `.env`、凭证与密钥未被 git 跟踪；`package.json` 的 `files` 只包含构建产物与必要资源。
- npm 账号启用了 staged publishing，发布后可能出现 `0.0.0-stage` 占位版本，属正常现象。

## 提交

- 开发分支为 `dev`（GitHub 默认分支）：功能分支从 `dev` 切出，PR 面向 `dev`；`master` 只用于发布。
- 提交信息遵循 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:`。
- 不要主动提交或推送；仅在用户明确要求时执行 `git commit` / `git push`。
