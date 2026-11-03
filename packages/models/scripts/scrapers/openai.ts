/**
 * OpenAI Model Scraper
 *
 * Builds model information for every model the API lists from the Markdown
 * versions of OpenAI's docs: each model page (details, pricing, endpoints,
 * features), the pricing page (GPT Image token prices), and the deprecations
 * page (shutdown dates).
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectTier, type ModelCapability, type ModelInfo, type ModelParameter, type ModelPricing } from '@aeye/ai';
import { writeModelJSON, writeModelTS } from '../codegen';
import { amount, bullets, fetchMarkdown, isoDate, reasoningEfforts, section, subsections, tableRows } from './docs';

const DOCS = 'https://developers.openai.com/api/docs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A dated snapshot suffix, which shares its base model's page.
 */
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

/**
 * Fetch a docs page as Markdown, or undefined when it doesn't exist.
 */
function fetchPage(page: string): Promise<string | undefined> {
  return fetchMarkdown(`${DOCS}/${page}.md`);
}

/**
 * Shutdown date of each model the deprecations page lists, as YYYY-MM-DD.
 */
async function fetchRetirements(): Promise<Map<string, string>> {
  const retirements = new Map<string, string>();
  for (const [date, models] of tableRows(await fetchPage('deprecations') ?? '')) {
    const retiresAt = isoDate(date);
    if (retiresAt) {
      for (const [, id] of models.matchAll(/`([^`/]+)`/g)) {
        retirements.set(id, retiresAt);
      }
    }
  }
  return retirements;
}

/**
 * GPT Image token prices from the pricing page's standard image table,
 * since image model pages carry none.
 */
async function fetchImagePricing(): Promise<Map<string, ModelPricing>> {
  const markdown = await fetchPage('pricing') ?? '';
  const start = markdown.indexOf('Image generation models');
  const table = markdown.slice(start).split('### Grouped Pricing Table data')[1] ?? '';
  const pricing = new Map<string, ModelPricing>();
  for (const [model, modality, input, output, cached] of tableRows(table.split('\n\n\n')[0])) {
    const entry = pricing.get(model) ?? {};
    if (modality === 'Image') {
      entry.image = { input: amount(input), tokens: amount(output) };
    } else if (modality === 'Text') {
      entry.text = { input: amount(input), output: amount(output), cached: amount(cached) };
    }
    pricing.set(model, entry);
  }
  return pricing;
}

/**
 * Prices from a model page's Pricing section.
 */
function parsePricing(markdown: string): ModelPricing {
  const pricing: ModelPricing = {};
  for (const [name, body] of subsections(section(markdown, 'Pricing'))) {
    const price = (metric: string) => amount(tableRows(body).find(([m]) => m === metric)?.[1] ?? '');
    switch (name) {
      case 'Text tokens':
        pricing.text = { input: price('Input'), output: price('Output'), cached: price('Cached input'), cacheWrite: price('Cache writes') };
        break;
      case 'Audio tokens':
        pricing.audio = { input: price('Input'), output: price('Output') };
        break;
      case 'Image tokens':
        pricing.image = { input: price('Input'), tokens: price('Output') };
        break;
      case 'Embeddings':
        pricing.embeddings = { cost: price('Cost') };
        break;
      case 'Transcription audio duration': {
        const perMinute = price('Price');
        pricing.audio = { perSecond: perMinute && perMinute / 60 };
        break;
      }
    }
  }
  return pricing;
}

/**
 * Convert one model page into ModelInfo.
 */
function parseModel(id: string, markdown: string, retirements: Map<string, string>, extraPricing: ModelPricing | undefined): ModelInfo {
  const details = bullets(section(markdown, 'Model details'));
  const detail = (pattern: RegExp) => details.map(d => pattern.exec(d)?.[1]).find(Boolean);
  const list = (pattern: RegExp) => detail(pattern)?.split(',').map(s => s.trim()) ?? [];

  const inputs = list(/^Input modalities: (.+)$/);
  const outputs = list(/^Output modalities: (.+)$/);
  const features = new Set(bullets(section(markdown, 'Supported features')));
  const endpoints = new Set(tableRows(section(markdown, 'Endpoints')).flatMap(([name, , support]) => support === 'Supported' ? [name] : []));
  const reasons = details.includes('Reasoning token support');
  const efforts = /Reasoning\.effort supports: ([^.]+)\./.exec(markdown)?.[1];
  // Deprecations list snapshots, so an alias retires with its default snapshot
  const snapshot = detail(/^Default snapshot: `(.+)`$/);
  const retiresAt = retirements.get(id) ?? retirements.get(id.replace(SNAPSHOT, '')) ?? (snapshot && retirements.get(snapshot));

  const chat = (endpoints.has('Chat Completions') || endpoints.has('Responses')) && outputs.includes('text');
  const capabilities = new Set<ModelCapability>();
  const parameters = new Set<ModelParameter>();
  const allow = (when: boolean, ...params: ModelParameter[]) => {
    if (when) {
      params.forEach(p => parameters.add(p));
    }
  };
  const add = (when: boolean, capability: ModelCapability, ...params: ModelParameter[]) => {
    if (when) {
      capabilities.add(capability);
    }
    allow(when, ...params);
  };

  add(chat, 'chat', 'maxTokens', 'serviceTier');
  add(chat && features.has('streaming'), 'streaming');
  add(chat && features.has('function_calling'), 'tools', 'tools', 'toolChoice');
  add(chat && features.has('structured_outputs'), 'structured', 'responseFormat', 'structuredOutput');
  add(chat && features.has('structured_outputs'), 'json');
  add(chat && inputs.includes('image'), 'vision');
  add(chat && inputs.includes('audio'), 'hearing');
  add(chat && features.has('file_uploads'), 'files');
  add(chat && outputs.includes('audio'), 'audio');
  add(chat && reasons, 'reasoning', 'reason', 'verbosity');
  // Sampling controls are rejected by reasoning models
  allow(chat && !reasons, 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'stop', 'seed', 'logitBias', 'logProbabilities');
  add(endpoints.has('Image generation'), 'image', 'imageBackground', 'imageMultiple', 'imageFormat', 'imageStream');
  add(endpoints.has('Image edit'), 'image');
  add(endpoints.has('Speech generation'), 'audio', 'speechInstructions');
  add(endpoints.has('Transcription'), 'hearing', 'transcribeStream', 'transcribePrompt');
  add(endpoints.has('Embeddings'), 'embedding', 'embeddingDimensions');

  return {
    provider: 'openai',
    id,
    name: /^# (.+)$/m.exec(markdown)?.[1].trim() ?? id,
    capabilities,
    supportedParameters: parameters,
    tier: detectTier(id),
    contextWindow: amount(detail(/^([\d,]+) context window$/) ?? '') ?? 0,
    maxOutputTokens: amount(detail(/^([\d,]+) max output tokens$/) ?? ''),
    pricing: { ...parsePricing(markdown), ...extraPricing },
    reasoningEfforts: efforts ? reasoningEfforts(efforts) : undefined,
    retiresAt,
    metadata: {
      knowledgeCutoff: detail(/^(.+) knowledge cutoff$/),
      responsesOnly: endpoints.has('Responses') && !endpoints.has('Chat Completions'),
    },
  };
}

/**
 * Model ids the API lists for the configured key.
 */
async function fetchModelIds(): Promise<string[]> {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  const data: { data?: { id: string }[] } = JSON.parse(await response.text());
  if (!data.data) {
    throw new Error('Invalid response from OpenAI API');
  }
  return data.data.map(model => model.id).sort();
}

/**
 * Main scraper function
 */
export async function scrapeOpenAI(
  outputDir: string,
  options: { concurrency?: number } = {}
): Promise<void> {
  const { concurrency = 8 } = options;
  console.log('\n=== OpenAI Scraper ===\n');

  const [ids, retirements, imagePricing] = await Promise.all([fetchModelIds(), fetchRetirements(), fetchImagePricing()]);
  console.log(`✓ ${ids.length} models listed, ${retirements.size} with shutdown dates`);

  // A snapshot without its own page shares its base model's page
  const pages = new Map<string, Promise<string | undefined>>();
  const page = (slug: string) => {
    const markdown = pages.get(slug) ?? fetchPage(`models/${slug}`);
    pages.set(slug, markdown);
    return markdown;
  };

  const models: ModelInfo[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    await Promise.all(ids.slice(i, i + concurrency).map(async id => {
      const base = id.replace(SNAPSHOT, '');
      const markdown = await page(id) ?? await page(base);
      if (markdown) {
        models.push(parseModel(id, markdown, retirements, imagePricing.get(id) ?? imagePricing.get(base)));
      } else {
        skipped.push(id);
      }
    }));
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`✓ Parsed ${models.length} models${skipped.length ? `, no docs page for: ${skipped.join(', ')}` : ''}`);

  await writeModelJSON(models, path.join(outputDir, 'openai-modelinfo.json'));
  await writeModelTS(models, 'openaiModels', path.join(__dirname, '../../src/models/openai.ts'));
  console.log('✓ Generated TypeScript file: src/models/openai.ts\n');
}

// CLI execution
if (process.argv[1].endsWith('openai.ts')) {
  const args = process.argv.slice(2);
  const outputDir = args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '../../data');
  const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));

  scrapeOpenAI(outputDir, { concurrency: concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) : undefined }).catch((error) => {
    console.error('✗ OpenAI scraping failed:', error);
    process.exit(1);
  });
}
