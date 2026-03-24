import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['test/e2e/real-e2e.test.mjs'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Real CF requests can be slow; give each test plenty of time
    testTimeout: 30000,
    hookTimeout: 25000,
    // Run tests sequentially to avoid rate limit collisions
    sequence: {
      concurrent: false,
    },
  },
});
