/**
 * 「禁止内联密钥」的统一判定。
 *
 * 信封与配置都可能被写入日志、消息队列或前端代码，因此两者共用同一套规则：
 * 只要出现疑似密钥的字段名，就直接拒绝，强制调用方改用 `credentialsRef`。
 *
 * 判定只检查**字段名**，不检查字段值；忽略大小写与 `_` / `-`，
 * 因此 `webhookKey`、`webhook_key`、`WEBHOOK-KEY` 都会命中。
 */

/**
 * 禁止内联的敏感字段名（忽略大小写与 `_` / `-`）。
 */
export const INLINE_SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'key',
  'sign',
  'apikey',
  'accesskeysecret',
  'webhookkey',
  'authcode',
  'appsecret',
  'clientsecret',
  'accesstoken',
]);

/** 归一化字段名：转小写并去掉 `_` / `-`。 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** 判断字段名是否属于禁止内联的敏感键。 */
export function isInlineSecretKey(key: string): boolean {
  return INLINE_SECRET_KEYS.has(normalizeKey(key));
}

/** 一条命中记录。`path` 为从根节点到该字段的点分路径片段。 */
export interface InlineSecretHit {
  path: ReadonlyArray<string>;
  key: string;
}

/**
 * 递归扫描任意 JSON 值，收集所有疑似内联密钥的字段。
 *
 * 用于配置快照校验：配置里嵌套的 `channelOptions` 也可能写入密钥，
 * 因此不能只检查顶层。数组会逐项扫描，非对象值直接跳过。
 *
 * @param value 待扫描的值（配置快照或任意 JSON）。
 * @param path 当前路径，递归内部使用。
 * @param hits 收集结果，递归内部使用。
 */
export function collectInlineSecrets(
  value: unknown,
  path: ReadonlyArray<string> = [],
  hits: InlineSecretHit[] = [],
): InlineSecretHit[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectInlineSecrets(item, [...path, String(index)], hits);
    });
    return hits;
  }

  if (typeof value !== 'object' || value === null) {
    return hits;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isInlineSecretKey(key)) {
      hits.push({ path: [...path, key], key });
    }
    collectInlineSecrets(child, [...path, key], hits);
  }

  return hits;
}
