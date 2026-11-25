import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const src = (pkg: string) => resolve(__dirname, `../${pkg}/src/index.ts`);

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      // The sibling packages from source (their dist lags, and isn't rebuilt here).
      '@aeye/schema': src('schema'),
      '@aeye/core': src('core'),
      '@aeye/ai': src('ai'),
      '@aeye/gin': src('gin'),
      '@aeye/models': src('models'),
      '@aeye/openai': src('openai'),
      '@aeye/openrouter': src('openrouter'),
      '@aeye/aws': src('aws'),
    },
  },
});
