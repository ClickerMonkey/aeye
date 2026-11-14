#!/usr/bin/env node

/**
 * Runs every workspace package's tests except @aeye/test-integration (live provider calls).
 *
 *   npm run test:unit
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { workspaces } = require(path.join(root, 'package.json'));

const failed = [];
for (const dir of workspaces) {
  const json = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  if (json.name === '@aeye/test-integration' || !json.scripts?.test) continue;
  console.log(`\n=== test ${json.name}`);
  if (spawnSync(`npm run test -w ${json.name}`, { cwd: root, shell: true, stdio: 'inherit' }).status !== 0) {
    failed.push(json.name);
  }
}

if (failed.length) {
  console.error(`\nFailed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nAll unit tests passed.');
