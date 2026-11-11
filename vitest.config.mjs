import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    hookTimeout: 180000,
    testTimeout: 30000,
    // The in-memory replica set is a shared process-wide resource; running
    // suites in parallel against it produces cross-test interference.
    fileParallelism: false,
  },
});
