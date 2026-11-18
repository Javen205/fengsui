/**
 * 信封与配置共用的标识符约束。
 *
 * 单独抽出来是为了让「信封校验」和「配置文件校验」使用同一套规则，
 * 避免两处正则漂移导致配置能通过、发送时却被拒绝。
 */

/** 渠道 ID 形如 `domain.action`，如 `email.qq`、`sms.aliyun`。 */
export const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** 凭证引用形如 `tenant/account`，用于隔离不同租户或项目的凭证。 */
export const CREDENTIALS_REF_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
