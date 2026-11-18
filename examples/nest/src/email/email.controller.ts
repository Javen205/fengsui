import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

// DTO 只出现在参数注解里，但 ValidationPipe 需要它在运行时存在（design:paramtypes）。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SendEmailDto } from './dto/send-email.dto.js';
import { EmailService } from './email.service.js';

/**
 * 邮件示例接口。
 *
 * 每个接口只负责组织内容，渠道、凭证、发件人与超时来自 `fengsui.config.json`；
 * 请求体里的 `channel` / `credentialsRef` 可以临时覆盖配置。
 */
@Controller('demo/email')
export class EmailController {
  constructor(@Inject(EmailService) private readonly email: EmailService) {}

  /** 纯文本邮件。 */
  @Post('text')
  sendText(@Body() dto: SendEmailDto) {
    return this.email.sendText(dto);
  }

  /** HTML 模板邮件。 */
  @Post('html')
  sendHtml(@Body() dto: SendEmailDto) {
    return this.email.sendHtml(dto);
  }

  /** 附件邮件：本地 TXT + `data:` URL CSV。 */
  @Post('attachments')
  sendAttachments(@Body() dto: SendEmailDto) {
    return this.email.sendAttachments(dto);
  }

  /** 完整示例：HTML + 纯文本兜底 + 附件。 */
  @Post('full')
  sendFull(@Body() dto: SendEmailDto) {
    return this.email.sendFull(dto);
  }

  /**
   * 在浏览器里预览模板，不会发信。
   *
   * `?format=text` 返回纯文本版本，其余返回 HTML。
   */
  @Get('preview')
  async preview(
    @Query('name') name: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (format === 'text') {
      res.type('text/plain; charset=utf-8').send(this.email.renderText(name));
      return;
    }

    res.type('text/html; charset=utf-8').send(await this.email.renderHtml(name));
  }
}
