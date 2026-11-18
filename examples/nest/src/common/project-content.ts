/**
 * 示例内容：三个开源项目的介绍。
 *
 * 邮件模板、纯文本邮件、附件与企业微信机器人共用同一份数据，
 * 避免同一个项目在不同渠道里出现不同说法。
 */

/** 一个可点击的链接。 */
export interface ProjectLink {
  label: string;
  url: string;
}

/** 单个开源项目的介绍。 */
export interface ProjectIntro {
  key: string;
  name: string;
  tagline: string;
  description: string;
  highlights: readonly string[];
  links: readonly ProjectLink[];
}

/** 作者信息。 */
export interface AuthorInfo {
  name: string;
  gitee: string;
}

export const AUTHOR: AuthorInfo = {
  name: 'Javen',
  gitee: 'https://gitee.com/javen205',
};

export const INTRO = {
  title: '三份开源项目，一封信封讲清楚',
  subtitle: '烽燧（fengsui）· IJPay · TNWX —— 来自 Javen 的长期维护与持续迭代。',
} as const;

export const PROJECTS: readonly ProjectIntro[] = [
  {
    key: 'fengsui',
    name: '烽燧 fengsui',
    tagline: '一封信封，万里相传',
    description:
      '以信封为中心、插件化的多渠道消息投递框架。业务只描述“发什么、给谁”，SMTP、企业微信长连接、重试、降级、凭证引用与逐目标回执都交给框架。',
    highlights: [
      '一套信封（channel / action / target / content / meta）表达所有渠道',
      '渠道即插件：核心零渠道依赖，按需安装邮件、企业微信等适配器',
      '配置提供默认值，发送时只写业务字段；dry-run 可先校验后发送',
      '统一错误码与重试策略，失败可观测、可回放',
    ],
    links: [
      { label: 'Gitee · @javen205', url: 'https://gitee.com/javen205' },
      { label: '设计文档', url: 'https://gitee.com/javen205' },
    ],
  },
  {
    key: 'ijpay',
    name: 'IJPay',
    tagline: '让支付触手可及',
    description:
      'Java 支付聚合 SDK，把微信支付、支付宝等常见支付渠道的签名、证书、回调与对账差异收进一致的 API，适合快速接入与长期维护。',
    highlights: [
      '聚合微信支付、支付宝等主流渠道，接口风格保持一致',
      '封装签名、证书、回调验签等易错细节',
      '开箱即用的示例工程，覆盖常见支付场景',
      '社区活跃，持续跟进渠道接口变更',
    ],
    links: [{ label: 'Gitee · IJPay', url: 'https://gitee.com/javen205/IJPay' }],
  },
  {
    key: 'tnwx',
    name: 'TNWX',
    tagline: '微信生态开发脚手架',
    description:
      '基于 TypeScript 的微信生态开发脚手架，覆盖公众号、小程序、企业微信与支付等场景，让开发者把精力放在业务而不是重复的鉴权与签名上。',
    highlights: [
      'TypeScript 编写，类型完备、工程结构清晰',
      '覆盖公众号、小程序、企业微信等常见能力',
      '统一封装 access_token、签名与消息加解密',
      '适合作为中后台服务与微信生态对接的起点',
    ],
    links: [{ label: 'Gitee · TNWX', url: 'https://gitee.com/javen205/TNWX' }],
  },
];

/** 生成称呼，缺省时用“朋友”。 */
export function greeting(name?: string): string {
  const target = name?.trim();
  return target !== undefined && target.length > 0 ? `你好，${target}！` : '你好，朋友！';
}

/** 纯文本邮件正文。 */
export function plainTextIntro(name?: string): string {
  const lines: string[] = [
    '烽燧 · IJPay · TNWX —— Javen 的开源项目速览',
    '',
    greeting(name),
    '',
    '这封信由 NestJS 12 + 烽燧（fengsui）示例应用发出，',
    '同时演示纯文本、HTML 模板与附件三种邮件形态。',
    '',
  ];

  for (const [index, project] of PROJECTS.entries()) {
    lines.push(`${index + 1}. ${project.name} —— ${project.tagline}`);
    lines.push(project.description);
    for (const highlight of project.highlights) {
      lines.push(`   · ${highlight}`);
    }
    lines.push(`   链接：${project.links.map((link) => `${link.label} ${link.url}`).join(' / ')}`);
    lines.push('');
  }

  lines.push('想聊聊支付、微信生态或消息投递？直接回复这封邮件，');
  lines.push(`或到 Gitee @${AUTHOR.name}（${AUTHOR.gitee}）找我。`);

  return lines.join('\n');
}

/** 企业微信 Markdown 正文（企业微信不支持表格，统一用列表）。 */
export function markdownIntro(): string {
  const lines: string[] = ['## 烽燧 · Javen 的开源项目速览', '', greeting(), ''];

  for (const [index, project] of PROJECTS.entries()) {
    lines.push(`**${index + 1}. ${project.name}**`);
    lines.push(`> ${project.tagline}`);
    lines.push(project.description);
    for (const highlight of project.highlights) {
      lines.push(`- ${highlight}`);
    }
    for (const link of project.links) {
      lines.push(`[${link.label}](${link.url})`);
    }
    lines.push('');
  }

  lines.push('回复 `fengsui`、`ijpay`、`tnwx` 或 `帮助` 可再次查看这份清单。');
  return lines.join('\n');
}

/** 附件：项目速览 CSV（带 UTF-8 BOM，Excel 直接打开不乱码）。 */
export function projectsCsv(): string {
  const rows = ['项目,定位,仓库', ...PROJECTS.map((p) => `${p.name},${p.tagline},${p.links[0]?.url ?? AUTHOR.gitee}`)];
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
