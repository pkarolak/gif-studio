import {defineConfig} from 'vitest/config';

const integration = process.env.GIF_STUDIO_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: integration ? ['test/integration/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/integration/**', 'node_modules/**'],
    testTimeout: integration ? 240_000 : 15_000,
    hookTimeout: integration ? 120_000 : 15_000,
    fileParallelism: !integration,
  },
});
