import type { CredentialResolver, ResolvedCredential } from '../adapter';
import { FengsuiError } from '../errors';

/** 默认环境变量前缀。所有凭证键都会加上该前缀，避免与业务变量冲突。 */
const DEFAULT_ENV_PREFIX = 'FENGSUI_CRED_';

/**
 * 环境变量凭证解析器的配置。
 *
 * 目前框架没有「全局配置 / 项目配置」两套文件：凭证统一按 `credentialsRef`
 * 从环境变量（或注入的 env 映射）中读取，项目隔离通过 ref 前缀实现，
 * 例如 `project-a/qq-main` 对应 `FENGSUI_CRED_PROJECT_A_QQ_MAIN`。
 */
export interface EnvCredentialResolverOptions {
  /** 自定义环境变量来源，默认 `process.env`；测试时可注入固定映射。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 自定义前缀，默认 `FENGSUI_CRED_`。 */
  prefix?: string;
}

/**
 * 把凭证引用映射为环境变量名。
 *
 * 规则：全部大写，非字母数字字符替换为下划线，去掉首尾下划线，再拼上前缀。
 * 例：`tenant-a/qq-main` → `FENGSUI_CRED_TENANT_A_QQ_MAIN`。
 *
 * @param ref 信封中的 `credentialsRef`，形如 `tenant/account`。
 * @param prefix 环境变量前缀，默认 `FENGSUI_CRED_`。
 */
export function toCredentialEnvKey(ref: string, prefix: string = DEFAULT_ENV_PREFIX): string {
  return (
    prefix +
    ref
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

/**
 * 解析环境变量的值。
 *
 * - 形如 `{"user":"a@b.c","pass":"xxx"}` 的 JSON 对象：逐字段转成字符串；
 * - 其他值：作为单值凭证，放进 `value` 字段。
 *
 * 注意：这里不校验字段完整性，字段约定由各渠道适配器负责。
 */
function parseCredentialValue(raw: string): Readonly<Record<string, string>> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      }
    } catch {
      // 不是合法 JSON，回退为单值凭证。
    }
  }
  return { value: raw };
}

/**
 * 基于环境变量的凭证解析器。
 *
 * 设计取舍：
 * - 框架不读取任何本地配置文件，凭证只从 env 或注入映射来，避免明文落盘；
 * - 「项目级配置」通过 `credentialsRef` 的租户/账号前缀区分，而不是另建配置层级；
 * - 解析失败抛 `FengsuiError(code: 'credentials')`，错误信息包含环境变量名便于排查，
 *   但绝不回显凭证内容。
 */
export class EnvCredentialResolver implements CredentialResolver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #prefix: string;

  constructor(options: EnvCredentialResolverOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? DEFAULT_ENV_PREFIX;
  }

  /**
   * 按 ref 读取凭证。
   *
   * @param ref 形如 `tenant/account`。
   * @throws {FengsuiError} 环境变量缺失或为空时抛 `code: 'credentials'`。
   */
  async resolve(ref: string): Promise<ResolvedCredential> {
    const envKey = toCredentialEnvKey(ref, this.#prefix);
    const raw = this.#env[envKey];
    if (raw === undefined || raw === '') {
      throw new FengsuiError({
        code: 'credentials',
        message: `Credential "${ref}" is not configured (missing environment variable ${envKey})`,
        details: { ref, envKey },
      });
    }

    return { ref, values: parseCredentialValue(raw) };
  }
}

/** 创建环境变量凭证解析器；等价于 `new EnvCredentialResolver(options)`。 */
export function createEnvCredentialResolver(
  options: EnvCredentialResolverOptions = {},
): EnvCredentialResolver {
  return new EnvCredentialResolver(options);
}
