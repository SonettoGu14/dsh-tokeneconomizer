import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Integration tests mount the real `dsh-*` services and drive real agent turns,
 * so they run in one forked process (shared `DSH_HOME`) and get a longer timeout
 * than the unit suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sonettogu14/dsh-te-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // One process: every test points process.env.DSH_HOME at its own temp dir.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
