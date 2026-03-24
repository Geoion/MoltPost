import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['test/e2e/**/*.e2e.test.mjs'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 20000,
  },
});
