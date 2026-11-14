#!/usr/bin/env node
/**
 * One-time setup: give every public package in packages/* a trusted publisher on npmjs.com, so the
 * Release workflow (.github/workflows/release.yml, environment `npm`) can publish it without a token.
 *
 *   node scripts/npm-trust.mjs            # log in if needed, then add the missing trusted publishers
 *   node scripts/npm-trust.mjs --dry-run  # list what it would do
 *
 * It uses npm 11+ (`npm trust`), fetched into a temp folder, so the global npm is left alone. Every
 * npm step that needs the account prints an npmjs.com link to open and approve (login and 2FA), not
 * a code prompt. Packages that already trust this repo's release.yml are skipped, so it's safe to
 * run again. A package has to exist on npm before it can trust anything: publish it once by hand.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';
const shell = process.platform === 'win32';

// Child mode: run npm's CLI as if in a terminal, so 2FA is a web link (npm only offers it to a TTY).
if (process.argv[2] === '--npm-child') {
  const [, , , npmDir, ...args] = process.argv;
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.argv = [process.argv[0], join(npmDir, 'bin', 'npm-cli.js'), ...args, '--auth-type=web', '--browser=false'];
  createRequire(import.meta.url)(join(npmDir, 'lib', 'cli.js'))(process);
} else {
  await main();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!repo) throw new Error(`origin isn't a GitHub repo: ${remote}`);

  const names = readdirSync('packages')
    .map((dir) => join('packages', dir, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')))
    .filter((json) => !json.private)
    .map((json) => json.name)
    .sort();

  const prefix = join(tmpdir(), 'npm-trust-cli');
  const npmDir = join(prefix, 'node_modules', 'npm');
  if (!existsSync(join(npmDir, 'lib', 'commands', 'trust'))) {
    console.log('Fetching the latest npm for `npm trust`...');
    mkdirSync(prefix, { recursive: true });
    execFileSync('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', 'npm@latest'], { stdio: 'inherit', shell });
  }
  /** Runs npm; with capture, its output is collected but any npmjs.com approval link is still printed as it comes. */
  const npm = (args, capture = false) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [import.meta.filename, '--npm-child', npmDir, ...args], {
        stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      });
      let stdout = '';
      const watch = (chunk) => {
        const text = chunk.toString();
        stdout += text;
        for (const link of text.match(/https:\/\/www\.npmjs\.com\/(?:auth|login)\S+/g) ?? []) {
          console.log(`Approve: ${link}`);
        }
      };
      child.stdout?.on('data', watch);
      child.stderr?.on('data', watch);
      child.on('close', (status) => done({ status, stdout }));
    });
  const quiet = (args) => spawnSync('npm', args, { encoding: 'utf8', shell });

  const missing = names.filter((name) => quiet(['view', name, 'name']).status !== 0);
  if (missing.length) console.log(`Not on npm yet (publish each once by hand, then re-run): ${missing.join(', ')}`);
  const todo = names.filter((name) => !missing.includes(name));

  if (dryRun) {
    console.log(`Would trust ${repo} ${WORKFLOW} (environment ${ENVIRONMENT}) for: ${todo.join(', ')}`);
    return;
  }

  if ((await npm(['whoami'], true)).status !== 0) {
    console.log('\nLog in: open the link below and approve.');
    if ((await npm(['login'])).status !== 0) throw new Error('npm login failed');
  }

  const failed = [];
  for (const name of todo) {
    const list = await npm(['trust', 'list', name, '--json'], true);
    if (list.status === 0 && list.stdout.includes(repo) && list.stdout.includes(WORKFLOW)) {
      console.log(`= ${name}: already trusts ${repo} ${WORKFLOW}`);
      continue;
    }
    console.log(`\n+ ${name}: trusting ${repo} ${WORKFLOW} (environment ${ENVIRONMENT})`);
    const args = ['trust', 'github', name, '--file', WORKFLOW, '--repo', repo, '--env', ENVIRONMENT, '--allow-publish', '--yes'];
    if ((await npm(args)).status !== 0) failed.push(name);
  }

  if (failed.length) {
    console.error(`\nFailed: ${failed.join(', ')}. Re-run to retry them.`);
    process.exit(1);
  }
  console.log(`\nDone: ${todo.length} packages trust ${repo} ${WORKFLOW}.`);
}
