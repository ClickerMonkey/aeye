import fs from 'fs';
import path from 'path';

export interface GinConfig {
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  // AWS creds normally come from the SDK's credential chain (env, SSO, IAM
  // role, ~/.aws/credentials, etc.) — these are here for users who prefer
  // to pin them in config.json instead.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  TAVILY_API_KEY?: string;
  GIN_MODEL?: string;
  GIN_PROVIDER?: string;
  GIN_SEARCH_THRESHOLD?: number;
  GIN_TOOL_ITERATIONS?: number;
}

const TEMPLATE: GinConfig = {
  OPENAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
  AWS_REGION: 'us-east-1',
  TAVILY_API_KEY: '',
  GIN_MODEL: '',
  GIN_PROVIDER: '',
  GIN_SEARCH_THRESHOLD: 20,
  GIN_TOOL_ITERATIONS: 100,
};

function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entries = ['config.json', 'ginny.log'];

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }
  const existing = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !existing.has(e));
  if (missing.length === 0) return;

  const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    gitignorePath,
    `${content}${suffix}${missing.join('\n')}\n`,
    'utf-8',
  );
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
    console.log('Added config.json + ginny.log to .gitignore');
    console.log('');
    console.log('Populate the file before re-running:');
    console.log('  At least one AI provider:');
    console.log('    - OPENAI_API_KEY (openai)');
    console.log('    - OPENROUTER_API_KEY (openrouter)');
    console.log('    - AWS Bedrock — any valid AWS credential source works (env vars,');
    console.log('      `aws sso login`, IAM role, ~/.aws/credentials, etc.). Ginny');
    console.log('      probes the credential chain at startup; AWS_REGION optional.');
    console.log('  TAVILY_API_KEY — optional, enables web_search tool');
    console.log('  GIN_PROVIDER — optional, preferred provider (openai | openrouter | aws)');
    console.log('  GIN_MODEL — optional, specific model id');
    console.log('  GIN_SEARCH_THRESHOLD — optional, corpus size below which search returns all (default 20)');
    console.log('  GIN_TOOL_ITERATIONS — optional, max tool-call iterations per prompt run (default 100)');
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
