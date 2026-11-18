import { BadRequestException, Body, Controller, Get, Inject, Post } from '@nestjs/common';

// DTO 只出现在参数注解里，但 ValidationPipe 需要它在运行时存在（design:paramtypes）。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SendWecomDto } from './dto/send-wecom.dto.js';
import { WecomService } from './wecom.service.js';

/**
 * 企业微信机器人示例接口。
 *
 * 机器人未配置时返回 503，并附带需要补齐的环境变量，不影响邮件示例。
 */
@Controller('demo/wecom')
export class WecomController {
  constructor(@Inject(WecomService) private readonly wecom: WecomService) {}

  /** 机器人开关、连接状态与最近错误。 */
  @Get('status')
  status() {
    return this.wecom.status();
  }

  /** 主动推送 Markdown。 */
  @Post('markdown')
  sendMarkdown(@Body() dto: SendWecomDto) {
    return this.wecom.sendMarkdown({
      to: resolveTarget(dto.to),
      alias: dto.alias,
      dryRun: dto.dryRun,
    });
  }

  /** 主动推送模板卡片。 */
  @Post('card')
  sendCard(@Body() dto: SendWecomDto) {
    return this.wecom.sendCard({
      to: resolveTarget(dto.to),
      alias: dto.alias,
      dryRun: dto.dryRun,
    });
  }
}

/** 请求体优先，其次环境变量；两者都没有时给出明确提示。 */
function resolveTarget(to: string | undefined): string {
  const target = to?.trim() || process.env.WECOM_DEMO_TO?.trim() || '';
  if (target === '') {
    throw new BadRequestException(
      '缺少发送目标：请在请求体传 to（userid 或 chatid），或配置环境变量 WECOM_DEMO_TO',
    );
  }
  return target;
}
