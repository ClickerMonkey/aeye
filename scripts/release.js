#!/usr/bin/env node

/**
 * Release script for @aeye monorepo
 *
 * Publishes every public workspace package whose version isn't on npm yet,
 * each after the internal packages it depends on. The packages to publish,
 * and every internal package they build against, are built clean first
 * (dist and tsbuildinfo removed: a stale file such as an old dist/schema.js
 * would shadow a newer module), and nothing is published unless every build
 * succeeds. Versions already on npm are skipped, so it's safe to run again.
 *
 * Usage:
 *   npm run release                  # Publish (run `npm login` first)
 *   npm run release -- --dry-run     # Build and pack without publishing
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

/** Runs a command with its output shown; whether it succeeded. */
const run = (command) => spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' }).status === 0;

/** Runs a command quietly; its output when it succeeded, else empty. */
const quiet = (command) => {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

// Public workspace packages by name
const packages = new Map();
for (const dir of fs.readdirSync(path.join(root, 'packages'))) {
  const file = path.join(root, 'packages', dir, 'package.json');
  if (fs.existsSync(file)) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json.private) {
      packages.set(json.name, { dir: path.dirname(file), json });
    }
  }
}

/** The internal packages a package builds and runs against. */
const internal = (name) => {
  const { json } = packages.get(name);
  return Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies })
    .filter(dep => dep !== name && packages.has(dep));
};

// Every package after the ones it depends on
const order = [];
const visit = (name, trail) => {
  if (order.includes(name)) return;
  if (trail.includes(name)) fail(`Dependency cycle: ${[...trail, name].join(' -> ')}`);
  internal(name).forEach(dep => visit(dep, [...trail, name]));
  order.push(name);
};
[...packages.keys()].sort().forEach(name => visit(name, []));

const version = (name) => packages.get(name).json.version;
const unpublished = order.filter(name => !quiet(`npm view ${name}@${version(name)} version`));
if (!unpublished.length) {
  console.log('Every package version is already on npm.');
  process.exit(0);
}
console.log(`To publish: ${unpublished.map(name => `${name}@${version(name)}`).join(', ')}`);

if (!dryRun && !quiet('npm whoami')) fail('Not logged in to npm: run npm login first.');

// The packages to publish and everything they build against
const needed = new Set();
const need = (name) => {
  if (!needed.has(name)) {
    needed.add(name);
    internal(name).forEach(need);
  }
};
unpublished.forEach(need);

for (const name of order.filter(name => needed.has(name))) {
  const { dir, json } = packages.get(name);
  if (!json.scripts?.build) continue;
  fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  fs.readdirSync(dir).filter(file => file.endsWith('.tsbuildinfo')).forEach(file => fs.rmSync(path.join(dir, file)));
  console.log(`\n=== build ${name}`);
  if (!run(`npm run build -w ${name}`)) fail(`Build failed: ${name}`);
}

for (const name of unpublished) {
  console.log(`\n=== publish ${name}@${version(name)}`);
  if (!run(`npm publish -w ${name} --access public${dryRun ? ' --dry-run' : ''}`)) fail(`Publish failed: ${name}@${version(name)}`);
}

console.log(dryRun ? '\nDry run complete: nothing was published.' : '\nPublished. npm can take a few minutes to show new versions.');
