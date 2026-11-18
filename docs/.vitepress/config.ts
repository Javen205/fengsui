import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: '烽燧',
  titleTemplate: ':title · 烽燧 fengsui',
  description:
    '烽燧（fengsui）是一个以信封为中心、插件化的多渠道消息投递框架：一次编写，邮件、企业微信与更多渠道自由抵达。',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['dev/**'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
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
    logo: '/logo.svg',
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
