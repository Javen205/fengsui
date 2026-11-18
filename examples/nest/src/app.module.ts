import { Module } from '@nestjs/common';

import { DemoController } from './demo.controller.js';
import { EmailModule } from './email/email.module.js';
import { FengsuiModule } from './fengsui/fengsui.module.js';
import { WecomModule } from './wecom/wecom.module.js';

@Module({
  imports: [FengsuiModule, EmailModule, WecomModule],
  controllers: [DemoController],
})
export class AppModule {}
