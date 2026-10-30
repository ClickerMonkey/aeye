/**
 * AWS Bedrock Model Scraper
 *
 * Builds model information without AWS credentials: every model in the
 * Markdown model cards of the Bedrock user guide (ids, modalities, APIs,
 * features, limits, end-of-life dates), priced from AWS's public price list
 * offer files, or from a card's own pricing table where it has one.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ModelCapability, ModelInfo, ModelPricing } from '@aeye/ai';
import { detectAWSFamily, detectAWSTier } from '@aeye/aws';
import { writeModelJSON, writeModelTS } from '../codegen';
import { amount, bullets, fetchMarkdown, isoDate, reasoningEfforts, section, tableRecords } from './docs';

const DOCS = 'https://docs.aws.amazon.com/bedrock/latest/userguide';
const OFFERS = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';

/**
 * Price list offers with Bedrock's on-demand prices: Amazon and open-weight
 * models, and the models AWS Marketplace sells (Anthropic, Cohere, ...).
 */
const OFFER_CODES = ['AmazonBedrock', 'AmazonBedrockFoundationModels'];

/**
 * Multipliers to tokens per 1M, by price unit, and to tokens, by limit suffix.
 */
const PER_MILLION: Record<string, number | undefined> = { '1m tokens': 1, '1k tokens': 1000 };
const SCALE: Record<string, number | undefined> = { K: 1e3, M: 1e6 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TextPricing = NonNullable<ModelPricing['text']>;

/**
 * The parts of a price list offer file read here.
 */
interface Offer {
  products: Record<string, { attributes: Record<string, string | undefined> }>;
  terms: {
    OnDemand: Record<string, Record<string, {
      priceDimensions: Record<string, { unit: string; pricePerUnit: { USD: string } }>;
    }>>;
  };
}

/**
 * A model name reduced to the words that tell models apart, so a card's
 * "Llama 3.2 1B Instruct" meets the price list's "Llama 3.2 1B".
 */
function nameKey(name: string): string {
  return name.toLowerCase()
    .replace(/\.0\b/g, '')
    .split(/[^a-z0-9.+]+/)
    .filter(word => word && !['amazon', 'deepseek', 'openai', 'instruct', 'it', 'pt'].includes(word))
    .join('-');
}

/**
 * A model id without its version suffix, as price list usage types name it.
 */
function idKey(id: string): string {
  return id.replace(/-v\d+:\d+$/, '');
}

/**
 * Lowest standard on-demand token prices per 1M tokens, by model name and by
 * the model id usage types carry. Batch, flex, priority, provisioned, and
 * long-cache prices are skipped, and the lowest of the in-region, geographic,
 * and global prices is kept (global cross-region inference has no premium).
 */
async function fetchOfferPricing(region: string): Promise<Map<string, TextPricing>> {
  const pricing = new Map<string, TextPricing>();
  for (const code of OFFER_CODES) {
    const offer: Offer = JSON.parse(await (await fetch(`${OFFERS}/${code}/current/${region}/index.json`)).text());
    for (const [sku, { attributes }] of Object.entries(offer.products)) {
      const { model = attributes.titanModel, inferenceType = '', usagetype = '', feature = '', service_tier = '' } = attributes;
      const kind: keyof TextPricing | undefined =
        /batch|flex|priority|reserved|provisioned|customization|1h|audio|image|video|speech/i.test(`${inferenceType} ${usagetype} ${feature} ${service_tier}`) ? undefined
        : /cache read/i.test(inferenceType) ? 'cached'
        : /cache write/i.test(inferenceType) ? 'cacheWrite'
        : /input/i.test(inferenceType) ? 'input'
        : /output/i.test(inferenceType) ? 'output'
        : undefined;
      const id = /^[A-Z0-9]+-([a-z0-9-]+\.[\w.-]+?)-(?:mantle|input|output|cache)/.exec(usagetype)?.[1];
      for (const term of Object.values(offer.terms.OnDemand[sku] ?? {})) {
        for (const { unit, pricePerUnit } of Object.values(term.priceDimensions)) {
          const perMillion = PER_MILLION[unit.toLowerCase()];
          if (!kind || !perMillion) {
            continue;
          }
          // Rounded to drop float noise from per-1K prices
          const price = Math.round(Number(pricePerUnit.USD) * perMillion * 1e6) / 1e6;
          for (const key of [model && nameKey(model), id]) {
            if (key) {
              const entry = pricing.get(key) ?? {};
              entry[kind] = Math.min(entry[kind] ?? Infinity, price);
              pricing.set(key, entry);
            }
          }
        }
      }
    }
  }
  return pricing;
}

/**
 * Lowest prices in a card's own pricing table; the cards that have one are
 * for models the offer files don't price.
 */
function cardPricing(markdown: string): TextPricing | undefined {
  const rows = tableRecords(section(markdown, 'Pricing'), /Inference option/);
  const lowest = (column: RegExp) => {
    const prices = rows.flatMap(row => [...row].flatMap(([name, cell]) => column.test(name) ? [amount(cell) ?? Infinity] : []));
    const price = Math.min(...prices);
    return Number.isFinite(price) ? price : undefined;
  };
  return rows.length
    ? { input: lowest(/^Input$/), output: lowest(/^Output$/), cached: lowest(/cache read/), cacheWrite: lowest(/cache write/) }
    : undefined;
}

/**
 * A `200K tokens` or `128,000` limit as a number.
 */
function tokens(text: string | undefined): number | undefined {
  const match = /([\d,.]+)\s*([KM])?/.exec(text ?? '');
  const count = amount(match?.[1] ?? '');
  return count === undefined ? undefined : Math.round(count * (SCALE[match?.[2] ?? ''] ?? 1));
}

/**
 * Convert one model card into ModelInfo, or undefined for models the
 * bedrock-runtime endpoint doesn't serve or that have nothing to offer here.
 */
function parseCard(card: string, offers: Map<string, TextPricing>): ModelInfo | undefined {
  // Check icons become marks and links their text; other images, emphasis, and escapes go
  const markdown = card
    .replace(/!\[[^\]]*\]\([^)]*icon-yes\.png\)/g, '✓')
    .replace(/!\[[^\]]*\]\([^)]*icon-no\.png\)/g, '✗')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|\\(?=[^|])/g, '');

  const access = tableRecords(markdown, /Model ID/).find(row => row.get('Endpoint') === 'bedrock-runtime');
  const inferenceIds = [access?.get('Geo inference ID'), access?.get('Global inference ID')]
    .flatMap(cell => cell?.match(/\b[a-z-]+\.[a-z0-9-]+\.[\w.:-]+/g) ?? []);
  // Some cards list only inference profiles, which are the id behind a geography prefix
  const id = [access?.get('Model ID'), ...inferenceIds.map(profile => profile.slice(profile.indexOf('.') + 1))]
    .find(candidate => candidate?.includes('.'));
  if (!id) {
    return undefined;
  }
  const name = /^# (.+)$/m.exec(markdown)?.[1].trim() ?? id;
  const details = bullets(markdown);
  const detail = (key: string) => details.find(d => d.startsWith(`${key}: `))?.slice(key.length + 2);
  // The card from a heading about the bedrock-runtime endpoint, or nothing without one
  const runtime = (heading: string) => {
    const start = markdown.search(new RegExp(`${heading} (using|on) (the )?\`bedrock-runtime\``));
    return start < 0 ? '' : markdown.slice(start);
  };

  // Checked modality (and, on older cards, API and endpoint) cells, e.g. 'input modalities: image'
  const checked = new Set(tableRecords(markdown, /Input modalities/i).flatMap(row =>
    [...row].flatMap(([column, cell]) => cell.startsWith('✓') ? [`${column}: ${cell.slice(1).trim()}`.toLowerCase()] : [])));
  const runtimeAPIs = tableRecords(runtime('APIs supported'), /Converse/)[0];
  const features = (tableRecords(runtime('Features supported'), /Supported/)[0]?.get('Supported') ?? '')
    .split('<br />')
    .map(feature => feature.replace(/^\+?\s*✓\s*/, ''));
  const hasFeature = (feature: string) => features.some(f => f.startsWith(feature));
  const input = (modality: string) => checked.has(`input modalities: ${modality}`);
  const output = (modality: string) => checked.has(`output modalities: ${modality}`);

  const chat = output('text') && (checked.has('apis supported: converse') || !!runtimeAPIs?.get('Converse')?.startsWith('✓'));
  const reasoning = detail('Reasoning')?.startsWith('Supported') ?? false;
  const efforts = /effort(?: configurable:| to) ([^).]+)/i.exec(markdown)?.[1];
  const endOfLife = detail('Model EOL date') ?? '';

  const capabilities = new Set<ModelCapability>();
  const add = (when: boolean, capability: ModelCapability) => {
    if (when) {
      capabilities.add(capability);
    }
  };
  add(chat, 'chat');
  // Converse takes tools for every chat model
  add(chat, 'tools');
  add(chat && hasFeature('Response streaming'), 'streaming');
  add(chat && hasFeature('Structured outputs'), 'structured');
  add(chat && hasFeature('Structured outputs'), 'json');
  add(chat && input('image'), 'vision');
  add(chat && input('video'), 'videoInput');
  add(chat && reasoning, 'reasoning');
  add(input('audio') || input('speech'), 'hearing');
  add(output('speech') || output('audio'), 'audio');
  add(output('image'), 'image');
  add(output('embedding'), 'embedding');
  if (!capabilities.size) {
    return undefined;
  }

  const text = cardPricing(markdown) ?? offers.get(idKey(id)) ?? offers.get(nameKey(name));
  const pricing: ModelPricing = !text ? {}
    : capabilities.has('embedding') ? { embeddings: { cost: text.input } }
    : { text };

  return {
    provider: 'aws',
    id,
    name,
    capabilities,
    tier: detail('Model lifecycle') === 'Legacy' ? 'legacy' : detectAWSTier(detectAWSFamily(id), id),
    contextWindow: tokens(detail('Context window')) ?? 0,
    maxOutputTokens: tokens(detail('Max output tokens')),
    pricing,
    reasoningEfforts: reasoning && efforts ? reasoningEfforts(efforts) : undefined,
    // 'No sooner than <date>' is a floor, not a date
    retiresAt: /sooner/i.test(endOfLife) ? undefined : isoDate(endOfLife),
    metadata: {
      providerName: /^## (.+?) — /m.exec(markdown)?.[1].trim(),
      knowledgeCutoff: detail('Knowledge cutoff'),
      // Without in-region inference, requests go through an inference profile (modelPrefix)
      inRegion: access?.get('In-Region endpoint URL')?.includes('https://') ?? false,
      inferenceIds: inferenceIds.length ? inferenceIds : undefined,
    },
  };
}

/**
 * Main scraper function
 */
export async function scrapeAWS(
  outputDir: string,
  options: { region?: string; concurrency?: number } = {}
): Promise<void> {
  const { region = 'us-east-1', concurrency = 8 } = options;
  console.log('\n=== AWS Bedrock Scraper ===\n');

  const [index, offers] = await Promise.all([fetchMarkdown(`${DOCS}/model-cards.md`), fetchOfferPricing(region)]);
  const pages = [...new Set((index ?? '').match(/model-card-[\w-]+\.md/g))];
  if (!pages.length) {
    throw new Error('No model cards listed in the Bedrock user guide');
  }
  console.log(`✓ ${pages.length} model cards, ${offers.size} priced models in ${region}`);

  const models: ModelInfo[] = [];
  for (let i = 0; i < pages.length; i += concurrency) {
    await Promise.all(pages.slice(i, i + concurrency).map(async page => {
      const model = parseCard(await fetchMarkdown(`${DOCS}/${page}`) ?? '', offers);
      if (model) {
        models.push(model);
      }
    }));
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  const unpriced = models.filter(m => !Object.keys(m.pricing).length).map(m => m.id);
  console.log(`✓ Parsed ${models.length} bedrock-runtime models${unpriced.length ? `, no prices for: ${unpriced.join(', ')}` : ''}`);

  await writeModelJSON(models, path.join(outputDir, 'aws-modelinfo.json'));
  await writeModelTS(models, 'awsModels', path.join(__dirname, '../../src/models/aws.ts'));
  console.log('✓ Generated TypeScript file: src/models/aws.ts\n');
}

// CLI execution
if (process.argv[1].endsWith('aws.ts')) {
  const args = process.argv.slice(2);
  const outputDir = args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '../../data');
  const regionArg = args.find((arg) => arg.startsWith('--region='));

  scrapeAWS(outputDir, { region: regionArg?.split('=')[1] }).catch((error) => {
    console.error('✗ AWS Bedrock scraping failed:', error);
    process.exit(1);
  });
}
