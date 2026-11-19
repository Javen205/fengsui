import { resolve } from 'node:path';

import type { Fengsui, FengsuiPlugin } from '@javen205/fengsui-core';
import { createEnvCredentialResolver, createFengsui, toCredentialEnvKey } from '@javen205/fengsui-core';
import { fileConfig } from '@javen205/fengsui-config-file';
import { emailPlugin } from '@javen205/fengsui-adapter-email';
import {
  WECOM_BOT_ALIAS_PATTERN,
  wecomBotPlugin,
  type WecomBotDefinition,
  type WecomBotPlugin,
} from '@javen205/fengsui-adapter-wecom-bot';

import { createWecomHandlers } from '../wecom/wecom.handlers.js';
import { createFengsuiLogger } from './nest-logger.js';

/** DI 令牌：整个示例共享一个烽燧实例与一份机器人运行信息。 */
export const FENGSUI_RUNTIME = Symbol('FENGSUI_RUNTIME');

/** 单个机器人的运行信息。 */
export interface WecomBotView {
  alias: string;
  channel: string;
  credentialsRef: string;
  botId: string;
  enabled: boolean;
  /** 未启用的原因；`enabled` 为 true 时不存在。 */
  reason?: string;
}

/** 企业微信机器人的运行信息；可以同时启用多个机器人。 */
export interface WecomRuntimeInfo {
  /** 是否至少有一个机器人可用。 */
  enabled: boolean;
  bots: readonly WecomBotView[];
  /** 所有机器人都不可用时的汇总原因，直接展示在 `/demo/wecom/status`。 */
  reason?: string;
  /** 仅在 `enabled` 为 true 时存在。 */
  plugin?: WecomBotPlugin;
}

/** 示例运行期依赖。 */
export interface FengsuiRuntime {
  fengsui: Fengsui;
  wecom: WecomRuntimeInfo;
}

/**
 * 创建烽燧实例。
 *
 * 组合方式：
 * - 邮件插件常驻；
 * - 企业微信机器人支持同时配置多个：
 *   - `WECOM_BOTS`：JSON 数组，如
 *     `[{"alias":"assistant","botId":"..."},{"alias":"support","botId":"..."}]`；
 *   - 或单机器人简写 `WECOM_BOT_ID` + `WECOM_BOT_ALIAS`；
 * - 每个机器人必须有对应的 Secret 环境变量（`FENGSUI_CRED_<REF>`），
 *   缺失的机器人会被跳过，其余机器人照常启用；
 * - 凭证永远从环境变量读取，不写入代码或配置。
 */
export function createFengsuiRuntime(): FengsuiRuntime {
  const logger = createFengsuiLogger();
  const plugins: FengsuiPlugin[] = [emailPlugin()];
  const { definitions, issues } = readBotDefinitions();

  const views: WecomBotView[] = [];
  const enabledDefinitions: WecomBotDefinition[] = [];
  const seenAliases = new Set<string>();

  for (const definition of definitions) {
    const channel = `wecom.bot.${definition.alias}`;
    const credentialsRef = definition.credentialsRef ?? `wecom/${definition.alias}`;
    const secretKey = toCredentialEnvKey(credentialsRef);

    let reason: string | undefined;
    if (!WECOM_BOT_ALIAS_PATTERN.test(definition.alias)) {
      reason = `别名 "${definition.alias}" 不合法，必须匹配 ${WECOM_BOT_ALIAS_PATTERN}`;
    } else if (seenAliases.has(definition.alias)) {
      reason = `别名 "${definition.alias}" 重复`;
    } else if ((process.env[secretKey] ?? '').trim() === '') {
      reason = `未配置环境变量 ${secretKey}`;
    }

    if (reason !== undefined) {
      views.push({ ...definition, channel, credentialsRef, enabled: false, reason });
      issues.push(reason);
      continue;
    }

    seenAliases.add(definition.alias);
    enabledDefinitions.push({ ...definition, credentialsRef });
    views.push({ ...definition, channel, credentialsRef, enabled: true });
  }

  const wecom: WecomRuntimeInfo = {
    enabled: enabledDefinitions.length > 0,
    bots: views,
    ...(enabledDefinitions.length === 0
      ? {
          reason:
            issues.length > 0
              ? issues.join('; ')
              : '未配置 WECOM_BOTS 或 WECOM_BOT_ID，企业微信机器人能力已关闭',
        }
      : {}),
  };

  if (wecom.enabled) {
    wecom.plugin = wecomBotPlugin({
      bots: enabledDefinitions,
      handlers: createWecomHandlers(),
    });
    plugins.push(wecom.plugin);
    logger.info('wecom.enabled', {
      bots: enabledDefinitions.map((bot) => ({
        alias: bot.alias,
        channel: `wecom.bot.${bot.alias}`,
      })),
    });
  } else {
    logger.warn('wecom.disabled', { reason: wecom.reason });
  }

  const configPath = resolve(process.cwd(), process.env.FENGSUI_CONFIG ?? 'fengsui.config.json');

  const fengsui = createFengsui({
    credentials: createEnvCredentialResolver(),
    config: fileConfig({ path: configPath, watch: true }),
    logger,
    plugins,
  });

  return { fengsui, wecom };
}

/**
 * 读取机器人定义。
 *
 * 优先使用 `WECOM_BOTS`（JSON 数组），否则回退到单机器人变量。
 * 解析失败的条目会记录到 `issues`，不影响其它机器人。
 */
function readBotDefinitions(): {
  definitions: WecomBotDefinition[];
  issues: string[];
} {
  const raw = process.env.WECOM_BOTS?.trim();
  if (raw !== undefined && raw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { definitions: [], issues: ['WECOM_BOTS 不是合法的 JSON'] };
    }

    if (!Array.isArray(parsed)) {
      return { definitions: [], issues: ['WECOM_BOTS 必须是 JSON 数组'] };
    }

    const definitions: WecomBotDefinition[] = [];
    const issues: string[] = [];

    for (const [index, item] of parsed.entries()) {
      const definition = toDefinition(item);
      if (typeof definition === 'string') {
        issues.push(`WECOM_BOTS[${index}]：${definition}`);
        continue;
      }
      definitions.push(definition);
    }

    return { definitions, issues };
  }

  const botId = process.env.WECOM_BOT_ID?.trim() ?? '';
  if (botId === '') {
    return { definitions: [], issues: [] };
  }

  const alias = process.env.WECOM_BOT_ALIAS?.trim() || 'assistant';
  const credentialsRef = process.env.WECOM_CREDENTIALS_REF?.trim();

  return {
    definitions: [
      { alias, botId, ...(credentialsRef !== undefined && credentialsRef !== '' ? { credentialsRef } : {}) },
    ],
    issues: [],
  };
}

/** 把 `WECOM_BOTS` 的单个元素转成定义；失败时返回原因字符串。 */
function toDefinition(value: unknown): WecomBotDefinition | string {
  if (typeof value !== 'object' || value === null) {
    return '必须是对象';
  }

  const record = value as Record<string, unknown>;
  const alias = typeof record.alias === 'string' ? record.alias.trim() : '';
  const botId = typeof record.botId === 'string' ? record.botId.trim() : '';

  if (alias === '') {
    return '缺少 alias';
  }
  if (botId === '') {
    return `机器人 "${alias}" 缺少 botId`;
  }

  const credentialsRef =
    typeof record.credentialsRef === 'string' ? record.credentialsRef.trim() : '';

  return { alias, botId, ...(credentialsRef !== '' ? { credentialsRef } : {}) };
}
