import type { DeliveryReceipt } from '../capabilities';

export interface IdempotencyStore<T = DeliveryReceipt> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
}

export class InMemoryIdempotencyStore<T = DeliveryReceipt> implements IdempotencyStore<T> {
  readonly #entries = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.#entries.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    this.#entries.set(key, value);
  }
}
