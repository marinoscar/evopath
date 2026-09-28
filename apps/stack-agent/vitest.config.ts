import { defineConfig } from 'vitest/config';

// Node environment, no globals: the agent is a plain node:http server and its
// tests inject the command runner, so nothing here ever touches Docker.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
