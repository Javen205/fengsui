import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import {
  FENGSUI_RUNTIME,
  createFengsuiRuntime,
  type FengsuiRuntime,
} from './fengsui.runtime.js';

/**
 * 生命周期绑定：应用启动时拉起长连接插件，关闭时释放全部资源。
 *
 * `start()` 失败（例如机器人 Secret 错误）不会让 HTTP 服务起不来：
 * 错误写日志，`/demo/wecom/status` 会显示 `lastError`，方便排查。
 */
@Injectable()
export class FengsuiLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FengsuiLifecycle.name);

  constructor(@Inject(FENGSUI_RUNTIME) private readonly runtime: FengsuiRuntime) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.runtime.fengsui.start();
    } catch (error) {
      this.logger.error(`烽燧插件启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.runtime.fengsui.close();
  }
}

/** 全局模块：其他模块只需注入 `FENGSUI_RUNTIME`。 */
@Global()
@Module({
  providers: [{ provide: FENGSUI_RUNTIME, useFactory: createFengsuiRuntime }, FengsuiLifecycle],
  exports: [FENGSUI_RUNTIME],
})
export class FengsuiModule {}
