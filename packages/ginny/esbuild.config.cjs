const esbuild = require('esbuild');
const fs = require('fs');

const shebangPlugin = {
  name: 'shebang',
  setup(build) {
    build.onEnd(() => {
      const outfile = 'dist/index.js';
      let content = fs.readFileSync(outfile, 'utf8');
      content = content.replace(/^#!.*\n/, '');
      content = '#!/usr/bin/env node\n' + content;
      fs.writeFileSync(outfile, content);
      try {
        fs.chmodSync(outfile, 0o755);
      } catch (e) {
        // Windows doesn't need chmod
      }
    });
  },
};

const esmBanner = {
  js: `
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_func } from 'path';
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_func(__filename);
const require = __createRequire(import.meta.url);
`,
};

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/index.js',
  format: 'esm',
  plugins: [shebangPlugin],
  banner: esmBanner,
  // `puppeteer` is heavy (Chromium download ~170 MB) and only used by
  // web fetching. Externalize it so the bundle does a runtime
  // `require('puppeteer')` instead of inlining it — paired with
  // `optionalDependencies` in package.json, this lets users skip the
  // Chromium install entirely if they don't need web fetching.
  external: ['puppeteer'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
}).catch(() => process.exit(1));
