import { Module } from '@nestjs/common';

import { WecomController } from './wecom.controller.js';
import { WecomService } from './wecom.service.js';

@Module({
  controllers: [WecomController],
  providers: [WecomService],
  exports: [WecomService],
})
export class WecomModule {}
