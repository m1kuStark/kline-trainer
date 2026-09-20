import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    // Preserve the same assertions/concurrency without Windows fork IPC failures.
    // Tests that need their own cwd launch a real child instead of mutating a worker.
    pool: 'threads',
    // Keep local worker pressure bounded while independent GLM/worktree jobs run.
    maxWorkers: 4,
  },
})
