import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The WASM parser is loaded once per file; give the first load room on a cold cache.
    testTimeout: 20_000,
  },
})
