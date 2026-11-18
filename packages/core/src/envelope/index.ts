/**
 * 统一信封（envelope）的校验入口。
 *
 * 对外只暴露 `parseEnvelope`（不抛异常）与 `validateEnvelopeOrThrow`（抛 `FengsuiError`）；
 * 字段约束与「禁止内联密钥」规则都在 `schema.ts` 中定义。
 */
export * from './schema';
