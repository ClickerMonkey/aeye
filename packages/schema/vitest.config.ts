import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The corpus differentials build the real zod schemas (@aeye/query, gin) many times; on a loaded machine
    // a few take longer than vitest's default 5 s.
    testTimeout: 30_000,
  },
});
