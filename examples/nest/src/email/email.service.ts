import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Inject, Injectable } from '@nestjs/common';
import ejs from 'ejs';

import { toCredentialEnvKey } from '@javen205/fengsui-core';
import type { DispatchResult, EnvelopeAttachment, EnvelopeContent } from '@javen205/fengsui-core';

import {
  AUTHOR,
  INTRO,
  PROJECTS,
  plainTextIntro,
  projectsCsv,
  type AuthorInfo,
  type ProjectIntro,
} from '../common/project-content.js';
import { FENGSUI_RUNTIME, type FengsuiRuntime } from '../fengsui/fengsui.runtime.js';

/** HTML 模板使用的数据。 */
export interface WelcomeTemplateData {
  name: string;
  greeting: string;
  generatedAt: string;
  intro: { title: string; subtitle: string };
  projects: readonly ProjectIntro[];
  author: AuthorInfo;
}

/** 发送邮件时的通用参数。 */
export interface SendEmailInput {
  to: string;
  name?: string | undefined;
  dryRun?: boolean | undefined;
  channel?: string | undefined;
  credentialsRef?: string | undefined;
}

/** 邮件模板入口；与 `email.service.ts` 编译后位于同一目录。 */
const TEMPLATE_PATH = fileURLToPath(new URL('./templates/welcome.ejs', import.meta.url));

/** 本地附件路径；相对于示例工程根目录。 */
const TXT_ATTACHMENT_PATH = resolve(process.cwd(), 'assets/fengsui-intro.txt');

@Injectable()
export class EmailService {
  private readonly defaultDryRun = process.env.DEMO_DRY_RUN === 'true';

  constructor(@Inject(FENGSUI_RUNTIME) private readonly runtime: FengsuiRuntime) {}

  /** 渲染 HTML 邮件模板。 */
  async renderHtml(name?: string): Promise<string> {
    return ejs.renderFile(TEMPLATE_PATH, this.templateData(name));
  }

  /** 渲染纯文本正文。 */
  renderText(name?: string): string {
    return plainTextIntro(name);
  }

  /** 纯文本邮件。 */
  async sendText(input: SendEmailInput): Promise<DispatchResult> {
    return this.send(input, {
      subject: '【烽燧】纯文本邮件示例',
      text: plainTextIntro(input.name),
    });
  }

  /** HTML 模板邮件；同时提供纯文本兜底，兼容不支持 HTML 的客户端。 */
  async sendHtml(input: SendEmailInput): Promise<DispatchResult> {
    const html = await this.renderHtml(input.name);
    return this.send(input, {
      subject: '烽燧 × IJPay × TNWX：Javen 的开源项目速览',
      html,
      text: plainTextIntro(input.name),
    });
  }

  /** 带附件的邮件：本地 TXT + `data:` URL 内联 CSV。 */
  async sendAttachments(input: SendEmailInput): Promise<DispatchResult> {
    return this.send(input, {
      subject: '【烽燧】附件示例：项目速览 TXT + CSV',
      text: plainTextIntro(input.name),
      attachments: buildAttachments(),
    });
  }

  /** 完整示例：HTML 模板 + 纯文本兜底 + 两个附件。 */
  async sendFull(input: SendEmailInput): Promise<DispatchResult> {
    const html = await this.renderHtml(input.name);
    return this.send(input, {
      subject: '烽燧 × IJPay × TNWX：Javen 的开源项目速览',
      html,
      text: plainTextIntro(input.name),
      attachments: buildAttachments(),
    });
  }

  private async send(input: SendEmailInput, content: EnvelopeContent): Promise<DispatchResult> {
    const dryRun = input.dryRun ?? this.defaultDryRun;
    const from = resolveFromAddress(input);

    return this.runtime.fengsui.send(
      {
        action: 'send',
        ...(input.channel !== undefined && input.channel !== ''
          ? { channel: input.channel }
          : {}),
        ...(input.credentialsRef !== undefined && input.credentialsRef !== ''
          ? { credentialsRef: input.credentialsRef }
          : {}),
        target: { to: [input.to] },
        content,
        ...(from !== undefined && from !== '' ? { channelOptions: { from } } : {}),
        meta: {
          requestId: randomUUID(),
          // 选择配置里的 email 项目：凭证引用与 timeoutMs 只作用于邮件渠道。
          projectId: 'email',
          tags: { example: 'nest-email' },
        },
      },
      dryRun ? { dryRun: true } : {},
    );
  }

  private templateData(name?: string): WelcomeTemplateData {
    const target = name?.trim() !== undefined && name.trim().length > 0 ? name.trim() : '朋友';

    return {
      name: target,
      greeting: `你好，${target}！`,
      generatedAt: new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      }),
      intro: INTRO,
      projects: PROJECTS,
      author: AUTHOR,
    };
  }
}

/**
 * 推导发件人地址。
 *
 * 多数邮箱（尤其 QQ）要求 `from` 与 SMTP 登录账号一致，否则直接断连。
 * 优先使用 `EMAIL_FROM`；否则从凭证 JSON 的 `user` 推导「烽燧 <user>」。
 */
function resolveFromAddress(input: SendEmailInput): string | undefined {
  const explicit = process.env.EMAIL_FROM?.trim();
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const ref = input.credentialsRef?.trim() || 'email/main';
  const raw = process.env[toCredentialEnvKey(ref)];
  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const user = (parsed as { user?: unknown }).user;
    if (typeof user !== 'string' || user.trim() === '') {
      return undefined;
    }
    return `烽燧 <${user.trim()}>`;
  } catch {
    return undefined;
  }
}

/** 本地文件与 `data:` URL 两种附件形态各演示一次。 */
function buildAttachments(): EnvelopeAttachment[] {
  const csv = Buffer.from(projectsCsv(), 'utf8').toString('base64');

  return [
    {
      name: 'fengsui-intro.txt',
      path: TXT_ATTACHMENT_PATH,
      contentType: 'text/plain; charset=utf-8',
    },
    {
      name: 'projects.csv',
      url: `data:text/csv;base64,${csv}`,
      contentType: 'text/csv; charset=utf-8',
    },
  ];
}
