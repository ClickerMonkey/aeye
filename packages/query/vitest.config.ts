import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `@aeye/core`'s published ESM uses extensionless imports that strict Node
      // ESM (which vitest uses) can't resolve, and its `dist` lags the source.
      // Point to the TS source instead — vitest handles TS natively. Mirrors
      // gin's vitest config.
      '@aeye/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Measure every source file (so untested files count as 0%, not omitted).
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        // Type-only declaration files (interfaces / *Def shapes / type aliases) —
        // no executable code, so coverage is not meaningful.
        'src/schema.ts',
        'src/node.ts',
      ],
      reporter: ['text', 'text-summary'],
      // Enforce full coverage — the suite fails if any metric drops below 100%.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
