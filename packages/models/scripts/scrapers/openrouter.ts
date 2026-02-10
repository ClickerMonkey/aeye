/**
 * OpenRouter Model Scraper
 *
 * Fetches model information from OpenRouter API endpoints and scrapes performance metrics
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as url from 'url';
import { fetchModels, fetchZDRModels, convertOpenRouterModel } from '@aeye/openrouter';
import { writeModelTS } from '../codegen';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Scrape performance metrics from OpenRouter model page
 */
async function scrapeModelMetrics(modelId: string, browser: puppeteer.Browser): Promise<{
  modelId: string;
  metrics: {
    latency?: number;
    throughput?: number;
    uptime?: number;
  } | null;
}> {
  const page = await browser.newPage();

  try {
    // OpenRouter model URLs use the canonical slug format
    const url = `https://openrouter.ai/${modelId}`;
    const response = await page.goto(url, {
      waitUntil: ['domcontentloaded', 'networkidle2'],
      timeout: 30000,
    });

    if (!response || response.status() === 404) {
      return { modelId, metrics: null };
    }

    const bodyText = await page.$eval('body', el => el.textContent || '');
    const metrics: { latency?: number; throughput?: number; uptime?: number } = {};

    // Latency0.62sThroughput47.46tpsUptime100.0%Uptime 100.0

    // Look for latency (in ms)
    const latencyMatch = bodyText.match(/latency[:\s]*([0-9.]+)\s*s/i);
    if (latencyMatch) {
      metrics.latency = parseFloat(latencyMatch[1]);
    }

    // Look for throughput (tokens/second)
    const throughputMatch = bodyText.match(/throughput[:\s]*([0-9.]+)\s*tps/i);
    if (throughputMatch) {
      metrics.throughput = parseFloat(throughputMatch[1]);
    }

    // Look for uptime (percentage)
    const uptimeMatch = bodyText.match(/uptime[:\s]*([0-9.]+)%/i);
    if (uptimeMatch) {
      metrics.uptime = parseFloat(uptimeMatch[1]);
    }

    if (!latencyMatch || !throughputMatch || !uptimeMatch) {
      console.log(`⚠ No metrics found on page ${modelId}`);
      await fs.writeFile(`./data/pages/openrouter-${modelId.replace(/[^a-z]/gi, '')}.html`, bodyText);
    }

    return { modelId, metrics };
  } catch (error) {
    console.log(`  ✗ Error scraping metrics for ${modelId}:`, error instanceof Error ? error.message : error);
    return { modelId, metrics: null };
  } finally {
    await page.close();
  }
}

/**
 * Scrape metrics for multiple models in parallel with concurrency control
 */
async function scrapeMetricsParallel(
  modelIds: string[],
  concurrency: number = 5
): Promise<Map<string, { latency?: number; throughput?: number; uptime?: number }>> {
  console.log(`\nScraping performance metrics from OpenRouter model pages (concurrency: ${concurrency})...`);

  const browser = await puppeteer.launch({ headless: true });
  const results = new Map<string, { latency?: number; throughput?: number; uptime?: number }>();

  try {
    // Process in batches with concurrency control
    for (let i = 0; i < modelIds.length; i += concurrency) {
      const batch = modelIds.slice(i, i + concurrency);
      console.log(`  Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(modelIds.length / concurrency)} (${batch.length} models)...`);

      const batchResults = await Promise.all(
        batch.map((modelId) => scrapeModelMetrics(modelId, browser))
      );

      // Store results
      for (const { modelId, metrics } of batchResults) {
        if (metrics) {
          results.set(modelId, metrics);
        }
      }

      console.log(`    ✓ Scraped ${batchResults.filter((r) => r.metrics).length}/${batch.length} models`);
    }

    console.log(`✓ Scraped metrics for ${results.size}/${modelIds.length} models\n`);
  } finally {
    await browser.close();
  }

  return results;
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

  // Scrape performance metrics if requested
  let metricsMap = new Map<string, { latency?: number; throughput?: number; uptime?: number }>();

  if (scrapeMetrics) {
    const modelIds = models.map((m) => m.id);
    metricsMap = await scrapeMetricsParallel(modelIds, concurrency);
  }

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
