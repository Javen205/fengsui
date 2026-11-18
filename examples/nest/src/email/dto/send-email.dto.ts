import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** 邮件发送请求体；渠道与凭证引用省略时使用配置文件里的默认值。 */
export class SendEmailDto {
  @IsEmail({}, { message: 'to 必须是合法邮箱地址' })
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60, { message: 'name 最长 60 个字符' })
  name?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** 覆盖默认渠道，例如 `email.163`、`email.gmail`。 */
  @IsOptional()
  @IsString()
  channel?: string;

  /** 覆盖默认凭证引用，例如 `email/backup`。 */
  @IsOptional()
  @IsString()
  credentialsRef?: string;
}
