import type { ChannelAdapter } from '../adapter';
import { FengsuiError } from '../errors';

export const CHANNEL_DOMAINS = ['email', 'im', 'sms', 'wechat'] as const;

export type ChannelDomain = (typeof CHANNEL_DOMAINS)[number];

const adapters = new Map<string, ChannelAdapter>();

export interface ListAdaptersFilter {
  domain?: ChannelDomain;
}

export function adapterDomain(channelId: string): ChannelDomain | undefined {
  const [domain] = channelId.split('.');
  if (domain === undefined) {
    return undefined;
  }
  return CHANNEL_DOMAINS.includes(domain as ChannelDomain) ? (domain as ChannelDomain) : undefined;
}

export function registerAdapter<TOptions>(adapter: ChannelAdapter<TOptions>): void {
  if (!adapter.id.includes('.')) {
    throw new FengsuiError({
      code: 'internal',
      message: `Adapter id "${adapter.id}" must look like "domain.action"`,
      details: { channelId: adapter.id },
    });
  }

  if (adapters.has(adapter.id)) {
    throw new FengsuiError({
      code: 'internal',
      message: `Adapter "${adapter.id}" is already registered`,
      channel: adapter.id,
      details: { channelId: adapter.id },
    });
  }

  adapters.set(adapter.id, adapter as unknown as ChannelAdapter);
}

export function getAdapter(channelId: string): ChannelAdapter {
  const adapter = adapters.get(channelId);
  if (adapter !== undefined) {
    return adapter;
  }

  const suggestions = suggestAdapterIds(channelId);
  let hint: string;
  if (suggestions.length > 0) {
    hint = ` Did you mean ${suggestions.map((id) => `"${id}"`).join(' or ')}?`;
  } else if (adapters.size > 0) {
    hint = ` Available channels: ${[...adapters.keys()].sort().join(', ')}.`;
  } else {
    hint = ' No adapters are registered.';
  }

  throw new FengsuiError({
    code: 'unsupported',
    message: `Unknown channel "${channelId}".${hint}`,
    channel: channelId,
    details: { channelId, suggestions },
  });
}

export function listAdapters(filter: ListAdaptersFilter = {}): ReadonlyArray<ChannelAdapter> {
  const all = [...adapters.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (filter.domain !== undefined) {
    return all.filter((adapter) => adapterDomain(adapter.id) === filter.domain);
  }
  return all;
}

/** Removes all adapters. Intended for tests and hot-reload scenarios. */
export function clearAdapters(): void {
  adapters.clear();
}

export function suggestAdapterIds(channelId: string, limit = 3): ReadonlyArray<string> {
  return [...adapters.keys()]
    .map((id) => ({ id, distance: editDistance(channelId, id) }))
    .filter(
      ({ id, distance }) => distance <= 2 || id.startsWith(channelId) || channelId.startsWith(id),
    )
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ id }) => id);
}

function editDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );

  for (let row = 1; row < rows; row += 1) {
    const leftChar = left[row - 1];
    for (let column = 1; column < columns; column += 1) {
      const rightChar = right[column - 1];
      const substitutionCost = leftChar === rightChar ? 0 : 1;
      const deletion = (matrix[row - 1]?.[column] ?? 0) + 1;
      const insertion = (matrix[row]?.[column - 1] ?? 0) + 1;
      const substitution = (matrix[row - 1]?.[column - 1] ?? 0) + substitutionCost;
      matrix[row]![column] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[left.length]?.[right.length] ?? Math.max(left.length, right.length);
}
