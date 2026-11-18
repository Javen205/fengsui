import { fileURLToPath } from 'node:url';

import { Controller, Get, Res } from '@nestjs/common';
import ejs from 'ejs';
import type { Response } from 'express';

/** 演示页面模板；编译后位于 `dist/demo/templates`。 */
const PAGE_PATH = fileURLToPath(new URL('./demo/templates/demo.ejs', import.meta.url));

/**
 * 演示入口。
 *
 * - `GET /demo`：可视化操作页，点按钮即可测试所有接口；
 * - `GET /demo/api`：JSON 接口索引。
 */
@Controller('demo')
export class DemoController {
  @Get()
  async page(@Res() res: Response): Promise<void> {
    const html = await ejs.renderFile(PAGE_PATH, {
      defaultEmail: process.env.DEMO_EMAIL_TO?.trim() ?? '',
      defaultName: process.env.DEMO_NAME?.trim() || 'Javen',
      defaultWecomTarget: process.env.WECOM_DEMO_TO?.trim() ?? '',
    });

    res.type('text/html; charset=utf-8').send(html);
  }

  @Get('api')
  index() {
    return {
      name: '烽燧 fengsui × NestJS 12 示例',
      description:
        '演示邮件（纯文本 / HTML 模板 / 附件）与企业微信智能机器人（Markdown / 模板卡片 / 入站对话）。',
      ui: 'GET /demo（可视化操作页）',
      email: {
        preview: 'GET /demo/email/preview?name=Javen（浏览器预览 HTML 模板）',
        previewText: 'GET /demo/email/preview?name=Javen&format=text',
        text: 'POST /demo/email/text',
        html: 'POST /demo/email/html',
        attachments: 'POST /demo/email/attachments',
        full: 'POST /demo/email/full',
        body: { to: 'you@example.com', name: 'Javen', dryRun: true },
      },
      wecom: {
        status: 'GET /demo/wecom/status',
        markdown: 'POST /demo/wecom/markdown',
        card: 'POST /demo/wecom/card',
        body: { to: 'userid 或 chatid', alias: '机器人别名（可选，默认第一个）', dryRun: true },
      },
    };
  }
}
