import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    // Keep local worker pressure bounded while independent GLM/worktree jobs run.
    maxWorkers: 4,
  },
})
