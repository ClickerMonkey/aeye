import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // `@aeye/core`'s published ESM uses extensionless imports that
      // strict Node ESM (which vitest uses) can't resolve. Point to the
      // TS source instead — vitest handles TS natively.
      '@aeye/core': resolve(__dirname, '../core/src/index.ts'),
      // core's source imports @aeye/schema, whose dist isn't built yet.
      '@aeye/schema': resolve(__dirname, '../schema/src/index.ts'),
      // The shared corpus fixtures (packages/schema/src/__tests__/corpus) import gin by name: this source.
      '@aeye/gin': resolve(__dirname, 'src/index.ts'),
    },
  },
});
