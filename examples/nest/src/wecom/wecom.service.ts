import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { DispatchResult } from '@javen205/fengsui-core';
import type { WecomBotStatus } from '@javen205/fengsui-adapter-wecom-bot';

import { AUTHOR, INTRO, PROJECTS, markdownIntro } from '../common/project-content.js';
import {
  FENGSUI_RUNTIME,
  type FengsuiRuntime,
  type WecomBotView,
} from '../fengsui/fengsui.runtime.js';

/** 主动推送请求体。 */
export interface SendWecomInput {
  /** 单聊 userid 或群聊 chatid。 */
  to: string;
  /** 机器人别名；省略时使用第一个启用的机器人。 */
  alias?: string | undefined;
  dryRun?: boolean | undefined;
}

/** `/demo/wecom/status` 里的单个机器人。 */
export interface WecomBotStatusView extends WecomBotView {
  state?: string;
  connected?: boolean;
  lastError?: string;
}

/** `/demo/wecom/status` 的返回结构。 */
export interface WecomStatusView {
  enabled: boolean;
  hint: string;
  bots: readonly WecomBotStatusView[];
}

@Injectable()
export class WecomService {
  private readonly defaultDryRun = process.env.DEMO_DRY_RUN === 'true';

  constructor(@Inject(FENGSUI_RUNTIME) private readonly runtime: FengsuiRuntime) {}

  /** 查看所有机器人的开关与连接状态。 */
  status(): WecomStatusView {
    const wecom = this.runtime.wecom;
    const live = new Map<string, WecomBotStatus>(
      (wecom.plugin?.bots.listStatus() ?? []).map((bot) => [bot.alias, bot]),
    );

    const bots = wecom.bots.map((bot): WecomBotStatusView => {
      const runtimeStatus = live.get(bot.alias);
      return {
        ...bot,
        ...(runtimeStatus === undefined
          ? {}
          : {
              state: runtimeStatus.state,
              connected: runtimeStatus.connected,
              ...(runtimeStatus.lastError !== undefined
                ? { lastError: runtimeStatus.lastError }
                : {}),
            }),
      };
    });

    return {
      enabled: wecom.enabled,
      hint: wecom.enabled
        ? '可通过 alias 指定机器人；省略时使用第一个启用的机器人。'
        : (wecom.reason ?? '企业微信机器人未启用，请配置 WECOM_BOTS 或 WECOM_BOT_ID'),
      bots,
    };
  }

  /** 以 Markdown 主动推送项目介绍。 */
  async sendMarkdown(input: SendWecomInput): Promise<DispatchResult> {
    const bot = this.resolveBot(input.alias);

    return this.runtime.fengsui.send(
      {
        channel: bot.channel,
        credentialsRef: bot.credentialsRef,
        action: 'send',
        target: { to: [input.to] },
        content: { markdown: markdownIntro() },
        meta: {
          requestId: randomUUID(),
          tags: { example: 'nest-wecom', format: 'markdown', bot: bot.alias },
        },
      },
      this.sendOptions(input),
    );
  }

  /** 以模板卡片主动推送项目介绍。 */
  async sendCard(input: SendWecomInput): Promise<DispatchResult> {
    const bot = this.resolveBot(input.alias);

    return this.runtime.fengsui.send(
      {
        channel: bot.channel,
        credentialsRef: bot.credentialsRef,
        action: 'send',
        target: { to: [input.to] },
        // 卡片之外保留 Markdown 正文：降级或调试时仍有可读内容。
        content: { markdown: markdownIntro() },
        channelOptions: {
          msgtype: 'template_card',
          card: buildIntroCard(),
        },
        meta: {
          requestId: randomUUID(),
          tags: { example: 'nest-wecom', format: 'template_card', bot: bot.alias },
        },
      },
      this.sendOptions(input),
    );
  }

  /** 按别名选机器人；省略时取第一个启用的。 */
  private resolveBot(alias: string | undefined): WecomBotView {
    const wecom = this.runtime.wecom;
    if (!wecom.enabled) {
      throw new ServiceUnavailableException(
        wecom.reason ?? '企业微信机器人未启用，请先配置 WECOM_BOTS 或 WECOM_BOT_ID',
      );
    }

    const available = wecom.bots.filter((bot) => bot.enabled);
    const wanted = alias?.trim();

    if (wanted !== undefined && wanted !== '') {
      const matched = available.find((bot) => bot.alias === wanted);
      if (matched === undefined) {
        throw new NotFoundException(
          `未找到可用的机器人别名 "${wanted}"；可用别名：${available
            .map((bot) => bot.alias)
            .join(', ')}`,
        );
      }
      return matched;
    }

    const first = available[0];
    if (first === undefined) {
      throw new ServiceUnavailableException('没有可用的企业微信机器人');
    }
    return first;
  }

  private sendOptions(input: SendWecomInput): { dryRun?: boolean } {
    const dryRun = input.dryRun ?? this.defaultDryRun;
    return dryRun ? { dryRun: true } : {};
  }
}

/** 文本通知卡片：标题、三个项目、三个跳转链接。 */
function buildIntroCard(): Record<string, unknown> {
  const shortNames: Record<string, string> = {
    fengsui: '烽燧',
    ijpay: 'IJPay',
    tnwx: 'TNWX',
  };

  return {
    card_type: 'text_notice',
    source: { desc: '烽燧 · 开源', desc_color: 0 },
    main_title: {
      title: 'Javen 的开源项目速览',
      desc: '烽燧 / IJPay / TNWX',
    },
    emphasis_content: { title: String(PROJECTS.length), desc: '个开源项目' },
    sub_title_text: INTRO.subtitle,
    horizontal_content_list: PROJECTS.map((project) => ({
      keyname: shortNames[project.key] ?? project.name,
      value: project.tagline,
    })),
    jump_list: PROJECTS.map((project) => ({
      type: 1,
      title: project.name,
      url: project.links[0]?.url ?? AUTHOR.gitee,
    })),
    card_action: { type: 1, url: AUTHOR.gitee },
  };
}
