/**
 * OpenRouter Model Scraper
 *
 * Fetches model information and performance metrics from the OpenRouter API
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as url from 'url';
import { convertOpenRouterModel, fetchEndpointMetrics, fetchModels, fetchZDRModels, type OpenRouterMetrics } from '@aeye/openrouter';
import { writeModelTS } from '../codegen';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Fetch live metrics for many models, a few at a time.
 */
async function fetchMetrics(modelIds: string[], concurrency: number): Promise<Map<string, OpenRouterMetrics>> {
  console.log(`
Fetching endpoint metrics (concurrency: ${concurrency})...`);
  const metrics = new Map<string, OpenRouterMetrics>();
  for (let i = 0; i < modelIds.length; i += concurrency) {
    await Promise.all(modelIds.slice(i, i + concurrency).map(async (id) => {
      const found = await fetchEndpointMetrics(id, process.env.OPENROUTER_API_KEY).catch(() => null);
      if (found) {
        metrics.set(id, found);
      }
    }));
  }
  console.log(`✓ Metrics for ${metrics.size}/${modelIds.length} models
`);
  return metrics;
}

/**
 * Main scraper function
 */
export async function scrapeOpenRouter(
  outputDir: string,
  options: { metrics?: boolean; concurrency?: number } = {}
): Promise<void> {
  const { metrics: scrapeMetrics = false, concurrency = 5 } = options;

  console.log('\n=== OpenRouter Scraper ===\n');

  // Fetch models using existing functions
  const [models, zdrModelIds] = await Promise.all([
    fetchModels(process.env.OPENROUTER_API_KEY),
    fetchZDRModels(process.env.OPENROUTER_API_KEY),
  ]);

  console.log(`✓ Fetched ${models.length} OpenRouter models`);
  console.log(`✓ Fetched ${zdrModelIds.size} ZDR model IDs`);

  // Save raw data
  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(
    path.join(outputDir, 'openrouter-models.json'),
    JSON.stringify({ data: models }, (key, value) => {
      if (value instanceof Set) {
        return Array.from(value);
      }
      return value;
    }, 2)
  );
  console.log(`✓ Saved raw OpenRouter models to openrouter-models.json`);

  if (zdrModelIds.size > 0) {
    await fs.writeFile(
      path.join(outputDir, 'openrouter-zdr.json'),
      JSON.stringify({ data: Array.from(zdrModelIds) }, (key, value) => {
        if (value instanceof Set) {
          return Array.from(value);
        }
        return value;
      }, 2)
    );
    console.log(`✓ Saved ZDR model IDs to openrouter-zdr.json`);
  }

  // Fetch performance metrics if requested
  const metricsMap = scrapeMetrics
    ? await fetchMetrics(models.map((m) => m.id), concurrency)
    : new Map<string, OpenRouterMetrics>();

  // Convert to ModelInfo format
  const modelInfos = models.map((model) =>
    convertOpenRouterModel(model, zdrModelIds, metricsMap.get(model.id))
  );

  // Sort them
  modelInfos.sort((a, b) => a.id.localeCompare(b.id));

  // Save JSON for reference
  await fs.writeFile(
    path.join(outputDir, 'openrouter-modelinfo.json'),
    JSON.stringify(modelInfos, (key, value) => {
      if (value instanceof Set) {
        return Array.from(value);
      }
      return value;
    }, 2)
  );
  console.log(`✓ Saved ${modelInfos.length} models to JSON`);

  // Generate TypeScript file
  const srcDir = path.join(__dirname, '../../src/models');
  await writeModelTS(modelInfos, 'openrouterModels', path.join(srcDir, 'openrouter.ts'));
  console.log(`✓ Generated TypeScript file: src/models/openrouter.ts`);

  console.log('\n✓ OpenRouter scraping complete\n');
}

// CLI execution
if (process.argv[1].endsWith('openrouter.ts')) {
  const args = process.argv.slice(2);
  const outputDir = args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '../../data');
  const scrapeMetrics = args.includes('--metrics');

  const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg
    ? parseInt(concurrencyArg.split('=')[1], 10)
    : 5;

  scrapeOpenRouter(outputDir, { metrics: scrapeMetrics, concurrency }).catch((error) => {
    console.error('✗ OpenRouter scraping failed:', error);
    process.exit(1);
  });
}
