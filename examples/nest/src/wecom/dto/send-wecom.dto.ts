import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** 企业微信主动推送请求体。 */
export class SendWecomDto {
  /** 单聊 userid 或群聊 chatid；省略时使用 WECOM_DEMO_TO。 */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'to 不能为空' })
  to?: string;

  /** 机器人别名；省略时使用第一个启用的机器人。 */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'alias 不能为空' })
  alias?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
