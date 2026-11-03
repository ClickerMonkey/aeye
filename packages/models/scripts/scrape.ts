/**
 * Main Model Scraper
 *
 * Coordinates scraping from all sources: OpenAI, OpenRouter, Replicate, and AWS
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { scrapeOpenAI } from './scrapers/openai';
import { scrapeOpenRouter } from './scrapers/openrouter';
import { scrapeReplicate } from './scrapers/replicate';
import { scrapeAWS } from './scrapers/aws';
import { generateModelsIndexTS, generateMainIndexTS } from './codegen';

type Source = 'openai' | 'openrouter' | 'replicate' | 'aws';

const SOURCES: Source[] = ['openai', 'openrouter', 'replicate', 'aws'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ScraperOptions {
  outputDir?: string;
  cacheDir?: string;
  sources?: Source[];
  concurrency?: number;
  scrapeMetrics?: boolean;
  awsRegion?: string;
}

/**
 * Run all model scrapers
 */
export async function scrapeAllModels(options: ScraperOptions = {}): Promise<void> {
  const outputDir = options.outputDir || path.join(__dirname, '../data');
  const cacheDir = options.cacheDir || path.join(__dirname, '../cache');
  const sources = options.sources || SOURCES;
  const concurrency = options.concurrency || 5;
  const scrapeMetrics = options.scrapeMetrics || false;
  const awsRegion = options.awsRegion;

  console.log('========================================');
  console.log('Model Information Scraper');
  console.log('========================================\n');
  console.log(`Output directory: ${outputDir}`);
  console.log(`Cache directory: ${cacheDir}`);
  console.log(`Sources: ${sources.join(', ')}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Scrape metrics: ${scrapeMetrics}\n`);

  // Create directories
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  // Track results
  const results: Record<string, { success: boolean; error?: string }> = {};

  // Scrape OpenRouter
  if (sources.includes('openrouter')) {
    try {
      await scrapeOpenRouter(outputDir, { metrics: scrapeMetrics, concurrency });
      results.openrouter = { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n✗ OpenRouter scraping failed: ${message}\n`);
      results.openrouter = { success: false, error: message };
    }
  }

  // Scrape OpenAI
  if (sources.includes('openai')) {
    try {
      await scrapeOpenAI(outputDir, { concurrency });
      results.openai = { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n✗ OpenAI scraping failed: ${message}\n`);
      results.openai = { success: false, error: message };
    }
  }

  // Scrape Replicate
  if (sources.includes('replicate')) {
    try {
      await scrapeReplicate(outputDir, cacheDir, { concurrency, transformerModel: 'google/gemini-2.5-pro' });
      results.replicate = { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n✗ Replicate scraping failed: ${message}\n`);
      results.replicate = { success: false, error: message };
    }
  }

  // Scrape AWS
  if (sources.includes('aws')) {
    try {
      await scrapeAWS(outputDir, { region: awsRegion });
      results.aws = { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n✗ AWS scraping failed: ${message}\n`);
      results.aws = { success: false, error: message };
    }
  }

  // Summary
  console.log('========================================');
  console.log('Scraping Summary');
  console.log('========================================\n');

  for (const [source, result] of Object.entries(results)) {
    if (result.success) {
      console.log(`✓ ${source.padEnd(12)} Success`);
    } else {
      console.log(`✗ ${source.padEnd(12)} Failed: ${result.error}`);
    }
  }

  const successCount = Object.values(results).filter((r) => r.success).length;
  const totalCount = Object.keys(results).length;

  console.log(`\n${successCount}/${totalCount} sources completed successfully\n`);

  // Any failed source fails the run; the sources that succeeded still regenerate
  if (successCount < totalCount) {
    process.exitCode = 1;
  }

  // Generate index files
  if (successCount > 0) {
    console.log('Generating index files...');

    const srcDir = path.join(__dirname, '../src');

    // Generate src/models/index.ts
    await fs.writeFile(
      path.join(srcDir, 'models/index.ts'),
      generateModelsIndexTS(),
      'utf-8'
    );
    console.log('✓ Generated src/models/index.ts');

    // Generate src/index.ts
    await fs.writeFile(
      path.join(srcDir, 'index.ts'),
      generateMainIndexTS(),
      'utf-8'
    );
    console.log('✓ Generated src/index.ts');

    console.log('\n✓ All files generated successfully\n');
  }
}

// CLI execution
if (process.argv[1].endsWith('scrape.ts')) {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const outputDir = args.find((arg) => arg.startsWith('--output='))?.split('=')[1];
  const cacheDir = args.find((arg) => arg.startsWith('--cache='))?.split('=')[1];
  const sourcesArg = args.find((arg) => arg.startsWith('--sources='))?.split('=')[1];
  const sources = sourcesArg
    ? sourcesArg.split(',').flatMap((name) => SOURCES.filter((source) => source === name))
    : undefined;

  const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg
    ? parseInt(concurrencyArg.split('=')[1], 10)
    : undefined;

  const scrapeMetrics = args.includes('--metrics');

  const awsRegionArg = args.find((arg) => arg.startsWith('--aws-region='));
  const awsRegion = awsRegionArg
    ? awsRegionArg.split('=')[1]
    : undefined;

  scrapeAllModels({
    outputDir,
    cacheDir,
    sources,
    concurrency,
    scrapeMetrics,
    awsRegion,
  }).catch((error) => {
    console.error('✗ Scraping failed:', error);
    process.exit(1);
  });
}
