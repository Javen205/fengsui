import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { defineConfig } from 'vitepress';
import type { Plugin } from 'vite';

const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * 仓库根目录的 `assets/` 不在 VitePress 的 publicDir 内：
 * - dev 时直接把 `/assets/**` 请求映射到仓库根目录；
 * - build 时复制进产物目录，保证文档里写的 `/assets/images/...` 路径不变。
 */
function rootAssetsPlugin(): Plugin {
  let repoRoot = '';
  let outDir = '';
  let isSsr = false;

  return {
    name: 'fengsui-root-assets',
    configResolved(config) {
      repoRoot = resolve(config.root, '..');
      outDir = config.build.outDir;
      isSsr = Boolean(config.build.ssr);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (!pathname.startsWith('/assets/')) {
          next();
          return;
        }

        const assetsRoot = resolve(repoRoot, 'assets');
        const file = resolve(repoRoot, `.${decodeURIComponent(pathname)}`);
        // 防止 ../ 跳出 assets 目录
        if (!file.startsWith(assetsRoot)) {
          next();
          return;
        }

        try {
          const body = readFileSync(file);
          res.setHeader(
            'Content-Type',
            ASSET_MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          );
          res.end(body);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      if (isSsr || !existsSync(resolve(repoRoot, 'assets'))) {
        return;
      }
      copyDirectory(resolve(repoRoot, 'assets'), resolve(outDir, 'assets'));
    },
  };
}

function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}

export default defineConfig({
  lang: 'zh-CN',
  title: '烽燧',
  titleTemplate: ':title · 烽燧 fengsui',
  description:
    '烽燧（fengsui）是一个以信封为中心、插件化的多渠道消息投递框架：一次编写，邮件、企业微信与更多渠道自由抵达。',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['dev/**'],
  vite: {
    plugins: [rootAssetsPlugin()],
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/assets/images/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#e8590c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '烽燧 fengsui' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '以信封为中心、插件化的多渠道消息投递框架。',
      },
    ],
  ],
  themeConfig: {
    logo: '/assets/images/logo.svg',
    siteTitle: '烽燧',
    nav: [
      { text: '指南', link: '/guide/introduction' },
      { text: '渠道', link: '/guide/channels/email' },
      { text: '架构', link: '/guide/architecture' },
      { text: '扩展', link: '/guide/extending' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '项目简介', link: '/guide/introduction' },
            { text: '快速开始', link: '/guide/getting-started' },
          ],
        },
        {
          text: '核心概念',
          items: [
            { text: '使用指南', link: '/guide/usage' },
            { text: '配置系统', link: '/guide/configuration' },
          ],
        },
        {
          text: '项目',
          items: [
            { text: '目录与架构', link: '/guide/architecture' },
            { text: '如何扩展', link: '/guide/extending' },
          ],
        },
        {
          text: '渠道',
          items: [
            { text: '邮件 SMTP', link: '/guide/channels/email' },
            { text: '企业微信机器人', link: '/guide/channels/wecom-bot' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
    outline: {
      level: [2, 3],
      label: '本页目录',
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },
    lastUpdated: {
      text: '最后更新于',
    },
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    footer: {
      message: '一封信封，万里相传。',
      copyright: 'MIT License · 烽燧 fengsui',
    },
  },
});
