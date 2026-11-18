import type { DeliveryReceipt } from '../capabilities';

/**
 * 幂等存储契约。
 *
 * 键由投递器拼接为 `tenantId:channelId:idempotencyKey`，避免不同租户/渠道互相覆盖。
 * 读取发生在发送前，写入发生在整次投递完成后；命中时直接返回既有回执并标记 `deduplicated`。
 */
export interface IdempotencyStore<T = DeliveryReceipt> {
  /** 读取已有回执；不存在时返回 `undefined`。 */
  get(key: string): Promise<T | undefined>;
  /** 保存回执。 */
  set(key: string, value: T): Promise<void>;
}

/**
 * 进程内幂等存储。
 *
 * 仅用于单实例或测试：数据保存在 Map 中，进程重启即丢失，且不会清理过期记录。
 * 生产环境应替换为 Redis / 数据库实现，并自行处理 TTL 与容量。
 */
export class InMemoryIdempotencyStore<T = DeliveryReceipt> implements IdempotencyStore<T> {
  readonly #entries = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.#entries.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    this.#entries.set(key, value);
  }
}
