import { z } from 'zod';

import type {
  AdapterContext,
  AdapterNormalizeInput,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelSendOutcome,
  CredentialResolver,
  NormalizedMessage,
} from '../../src/core';
import type { HttpClient } from '../../src/http';

export const unusedHttpClient: HttpClient = {
  async request() {
    throw new Error('A fake adapter test should not perform HTTP requests');
  },
};

export const staticCredentials: CredentialResolver = {
  async resolve(ref) {
    return { ref, values: {} };
  },
};

export interface FakeAdapterState {
  sendCalls: number;
  normalizeCalls: number;
  messages: NormalizedMessage[];
  contexts: AdapterContext[];
}

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  messageKinds: ['text', 'markdown', 'html'],
  attachments: false,
  mentions: false,
  batch: false,
  templates: false,
  receipts: 'sync',
  rateLimit: { scope: 'tenant' },
  idempotency: 'local',
  dryRun: true,
};

export interface FakeAdapterOptions {
  id?: string;
  capabilities?: Partial<ChannelCapabilities>;
  fallbacks?: ChannelAdapter['fallbacks'];
  schema?: z.ZodType<unknown>;
  onSend?: (
    message: NormalizedMessage,
    ctx: AdapterContext,
    state: FakeAdapterState,
  ) => Promise<ChannelSendOutcome>;
  onNormalize?: (input: AdapterNormalizeInput, state: FakeAdapterState) => NormalizedMessage;
}

export interface FakeAdapterHandle {
  adapter: ChannelAdapter;
  state: FakeAdapterState;
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapterHandle {
  const id = options.id ?? 'email.qq';
  const state: FakeAdapterState = {
    sendCalls: 0,
    normalizeCalls: 0,
    messages: [],
    contexts: [],
  };
  const capabilities: ChannelCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };

  const adapter: ChannelAdapter = {
    id,
    schema: options.schema ?? z.record(z.string(), z.unknown()),
    ...(options.fallbacks !== undefined ? { fallbacks: options.fallbacks } : {}),
    capabilities: () => capabilities,
    normalize(input) {
      state.normalizeCalls += 1;
      if (options.onNormalize !== undefined) {
        return options.onNormalize(input, state);
      }
      return {
        channel: id,
        action: input.envelope.action,
        target: input.target,
        content: input.content,
        options: input.options,
        idempotencyKey: input.envelope.meta?.idempotencyKey,
        degradedFrom: input.degradedFrom,
        degradedTo: input.degradedTo,
      };
    },
    async send(message, ctx) {
      state.sendCalls += 1;
      state.messages.push(message);
      state.contexts.push(ctx);
      if (options.onSend !== undefined) {
        return options.onSend(message, ctx, state);
      }
      return { providerMessageId: `fake-${state.sendCalls}` };
    },
  };

  return { adapter, state };
}
