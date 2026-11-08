import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/layout.ts', 'src/types.ts', 'src/highlights.ts'],
    },
  },
})
