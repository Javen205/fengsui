import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@fengsui/core': packageSrc('core'),
      '@fengsui/http': packageSrc('http'),
      '@fengsui/http-fetch': packageSrc('http-fetch'),
      '@fengsui/http-axios': packageSrc('http-axios'),
      '@fengsui/config-file': packageSrc('config-file'),
      '@fengsui/adapter-email': packageSrc('adapter-email'),
      '@fengsui/adapter-wecom-bot': packageSrc('adapter-wecom-bot'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    restoreMocks: true,
  },
});
