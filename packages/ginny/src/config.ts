import fs from 'fs';
import path from 'path';

export interface GinConfig {
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  TAVILY_API_KEY?: string;
  GIN_MODEL?: string;
  GIN_PROVIDER?: string;
  GIN_SEARCH_THRESHOLD?: number;
}

const TEMPLATE: GinConfig = {
  OPENAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_REGION: 'us-east-1',
  TAVILY_API_KEY: '',
  GIN_MODEL: '',
  GIN_PROVIDER: '',
  GIN_SEARCH_THRESHOLD: 20,
};

function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = 'config.json';

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
    const listed = content.split(/\r?\n/).some((line) => line.trim() === entry);
    if (listed) return;
  }

  const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${content}${suffix}${entry}\n`, 'utf-8');
}

/**
 * Load config.json from CWD into process.env. On first run, scaffold a
 * template, update .gitignore, print instructions, and exit.
 *
 * Existing env vars win over config.json — useful for one-off overrides.
 */
export function loadConfig(cwd: string): void {
  const configPath = path.join(cwd, 'config.json');

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(TEMPLATE, null, 2) + '\n', 'utf-8');
    ensureGitignore(cwd);

    console.log(`Created ${configPath}`);
    console.log('Added config.json to .gitignore');
    console.log('');
    console.log('Populate the file before re-running:');
    console.log('  OPENAI_API_KEY / OPENROUTER_API_KEY / AWS_ACCESS_KEY_ID — at least one required');
    console.log('  TAVILY_API_KEY — optional, enables web_search tool');
    console.log('  GIN_PROVIDER — optional, preferred provider (openai | openrouter | aws)');
    console.log('  GIN_MODEL — optional, specific model id');
    console.log('  GIN_SEARCH_THRESHOLD — optional, corpus size below which search returns all (default 20)');
    console.log('');
    console.log('Environment variables still win over config.json values.');
    process.exit(0);
  }

  ensureGitignore(cwd);

  let config: GinConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GinConfig;
  } catch (e: unknown) {
    throw new Error(`Failed to parse config.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const [key, value] of Object.entries(config)) {
    if (process.env[key]) continue; // env wins
    if (value === undefined || value === null || value === '') continue;
    process.env[key] = typeof value === 'string' ? value : String(value);
  }
}
