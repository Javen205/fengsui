import 'dotenv/config';
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

const port = Number(process.env.PORT ?? 3000);

const app = await NestFactory.create(AppModule);

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
);
app.enableShutdownHooks();

await app.listen(port);

const url = await app.getUrl();
console.log('');
console.log(`烽燧示例服务已启动：${url}`);
console.log(`  演示页面    ${url}/demo`);
console.log(`  接口索引    ${url}/demo/api`);
console.log(`  邮件预览    ${url}/demo/email/preview?name=Javen`);
console.log(`  机器人状态  ${url}/demo/wecom/status`);
console.log('');
