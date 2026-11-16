import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@sonettogu14/dsh-te-core': coreSrc },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
