import type { ZodType } from 'zod';

import type { HttpClient } from '../../http';
import type { ChannelCapabilities, DeliveryReceipt, MessageKind } from '../capabilities';
import type { Envelope, EnvelopeContent, EnvelopeTarget } from '../envelope';
import type { Logger } from '../logger';

export interface ResolvedCredential {
  readonly ref: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface CredentialResolver {
  resolve(ref: string): Promise<ResolvedCredential>;
}

export interface AdapterContext {
  http: HttpClient;
  credentials: CredentialResolver;
  logger: Logger;
  signal: AbortSignal;
  traceId: string;
  tenantId: string;
  /**
   * Optional per-invocation credential ref.
   * The dispatcher populates it from the envelope on every send.
   * Health-checks can also provide it when the adapter was registered without a default ref.
   */
  credentialsRef?: string | undefined;
}

export interface AdapterNormalizeInput<TOptions = unknown> {
  envelope: Envelope;
  target: EnvelopeTarget | undefined;
  content: EnvelopeContent;
  options: TOptions;
  degradedFrom?: MessageKind | undefined;
  degradedTo?: MessageKind | undefined;
}

export interface NormalizedMessage<TOptions = unknown> {
  channel: string;
  action: string;
  target: EnvelopeTarget | undefined;
  content: EnvelopeContent;
  options: TOptions;
  credentialsRef?: string | undefined;
  idempotencyKey?: string | undefined;
  degradedFrom?: MessageKind | undefined;
  degradedTo?: MessageKind | undefined;
}

export interface ChannelSendResult {
  providerMessageId?: string;
  providerCode?: string;
  providerMessage?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export type ChannelSendOutcome = DeliveryReceipt | ChannelSendResult;

export interface HealthStatus {
  ok: boolean;
  checkedAt?: string;
  latencyMs?: number;
  detail?: string;
}

export type ChannelFallbacks = Readonly<Partial<Record<MessageKind, ReadonlyArray<MessageKind>>>>;

export interface ChannelAdapter<TOptions = unknown> {
  readonly id: string;
  capabilities(): ChannelCapabilities;
  readonly schema: ZodType<TOptions>;
  normalize(input: AdapterNormalizeInput<TOptions>): NormalizedMessage<TOptions>;
  send(message: NormalizedMessage<TOptions>, ctx: AdapterContext): Promise<ChannelSendOutcome>;
  sendBatch?(
    messages: ReadonlyArray<NormalizedMessage<TOptions>>,
    ctx: AdapterContext,
  ): Promise<ReadonlyArray<ChannelSendOutcome>>;
  healthCheck?(ctx: AdapterContext): Promise<HealthStatus>;
  fallbacks?: ChannelFallbacks | undefined;
}
