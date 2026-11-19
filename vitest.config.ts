import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@javen205/fengsui-core': packageSrc('core'),
      '@javen205/fengsui-http': packageSrc('http'),
      '@javen205/fengsui-http-fetch': packageSrc('http-fetch'),
      '@javen205/fengsui-http-axios': packageSrc('http-axios'),
      '@javen205/fengsui-config-file': packageSrc('config-file'),
      '@javen205/fengsui-adapter-email': packageSrc('adapter-email'),
      '@javen205/fengsui-adapter-wecom-bot': packageSrc('adapter-wecom-bot'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    restoreMocks: true,
  },
});
