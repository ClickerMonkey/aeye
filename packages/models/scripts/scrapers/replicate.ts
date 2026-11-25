/**
 * Replicate Model Scraper
 *
 * Fetches model information from Replicate API using the Replicate npm module
 */

import type { ModelCapability, ModelInfo } from '@aeye/ai';
import { AI, detectTier } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import * as fs from 'fs/promises';
import openapiTS from 'openapi-typescript';
import * as path from 'path';
import Replicate from 'replicate';
import ts from 'typescript';
import * as url from 'url';
import { a } from '@aeye/core';
import { writeModelTS } from '../codegen';
import { exec, spawn } from 'child_process';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ReplicateModelData {
  url: string;
  owner: string;
  name: string;
  description: string | null;
  visibility: string;
  github_url: string | null;
  paper_url: string | null;
  license_url: string | null;
  run_count: number;
  cover_image_url: string | null;
  default_example: {
    model: string;
    version: string;
    input: Record<string, unknown>;
    output: unknown;
  } | null;
  latest_version: {
    id: string;
    created_at: string;
    cog_version: string;
    openapi_schema: {
      info: {
        title: string;
        version: string;
      };
      paths: Record<string, unknown>;
      components: {
        schemas: {
          Input?: {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          };
          Output?: {
            type: string;
            properties?: Record<string, unknown>;
            items?: unknown;
          };
        };
      };
    };
  } | null;
}

/**
 * Detect capabilities from model name, description, and schema
 */
function detectCapabilities(model: ReplicateModelData): Set<ModelCapability> {
  const capabilities = new Set<ModelCapability>();

  const lowerName = model.name.toLowerCase();
  const lowerDesc = (model.description || '').toLowerCase();

  // Image generation
  if (
    lowerName.includes('stable-diffusion') ||
    lowerName.includes('sdxl') ||
    lowerName.includes('flux') ||
    lowerName.includes('imagen') ||
    lowerName.includes('midjourney') ||
    lowerName.includes('dalle') ||
    lowerDesc.includes('image generation') ||
    lowerDesc.includes('image edit') ||
    lowerDesc.includes('text-to-image')
  ) {
    capabilities.add('image');
  }

  // Vision/image input
  if (
    lowerName.includes('vision') ||
    lowerName.includes('image-to-text') ||
    lowerDesc.includes('image analysis') ||
    lowerDesc.includes('image understanding') ||
    lowerDesc.includes('image edit')
  ) {
    capabilities.add('vision');
  }

  // Transcription/hearing
  if (
    lowerName.includes('whisper') ||
    lowerName.includes('transcribe') ||
    lowerDesc.includes('speech-to-text') ||
    lowerDesc.includes('transcription')
  ) {
    capabilities.add('hearing');
  }

  // Speech/audio output
  if (
    lowerName.includes('tts') ||
    lowerName.includes('speech') ||
    lowerName.includes('voice') ||
    lowerDesc.includes('text-to-speech')
  ) {
    capabilities.add('audio');
  }

  // Embeddings; an embedding model that reads images (CLIP and the like)
  // embeds them in the space of its texts
  if (lowerName.includes('embed') || lowerDesc.includes('embedding')) {
    capabilities.add('embedding');
    if (lowerName.includes('clip') || capabilities.has('vision')) {
      capabilities.add('imageEmbedding');
      capabilities.add('crossModalEmbedding');
    }
  }

  // Chat/language models
  if (
    lowerName.includes('llm') ||
    lowerName.includes('chat') ||
    lowerName.includes('gpt') ||
    lowerName.includes('llama') ||
    lowerName.includes('mistral') ||
    lowerName.includes('gemma') ||
    lowerName.includes('vicuna') ||
    lowerDesc.includes('language model') ||
    lowerDesc.includes('conversational')
  ) {
    capabilities.add('chat');
    capabilities.add('streaming');
  }

  // If no capabilities detected but has a schema, add chat as default
  if (capabilities.size === 0 && model.latest_version?.openapi_schema) {
    capabilities.add('chat');
  }

  return capabilities;
}

/**
 * Convert Replicate model to ModelInfo
 */
function convertReplicateModel(model: ReplicateModelData): ModelInfo {
  const modelId = `${model.owner}/${model.name}`;
  const capabilities = detectCapabilities(model);
  const tier = detectTier(model.name);

  return {
    provider: 'replicate',
    id: modelId,
    name: model.name,
    capabilities: capabilities, // Already an array
    tier,
    pricing: {},
    contextWindow: 0, // Not consistently available in Replicate API
    maxOutputTokens: undefined,
    metadata: {
      owner: model.owner,
      description: model.description,
      runCount: model.run_count,
      githubUrl: model.github_url,
      // paperUrl: model.paper_url,
      // coverImageUrl: model.cover_image_url,
      visibility: model.visibility,
      source: 'replicate',
      latestVersionId: model.latest_version?.id,
      cogVersion: model.latest_version?.cog_version,
      // schema: model.latest_version?.openapi_schema,
    },
  };
}

const ai = AI
  .with()
  .providers({
    openrouter: new OpenRouterProvider({ 
      apiKey: process.env.OPENROUTER_API_KEY!,
      hooks: {
        chat: {
          beforeRequest: (a, b, c, d) => {
            const now = Date.now().toString();

            const requestResolved = path.resolve(__dirname, '../../cache/replicate', now  + '-request.json');
            fs.writeFile(requestResolved, JSON.stringify(b, null, 2));

            const content = a.messages.map((m) => m.content).join('\n---\n');
            const contentResolved = path.resolve(__dirname, '../../cache/replicate', now + '-content.txt');
            fs.writeFile(contentResolved, content);
          },
          afterRequest: (a, b, c, d) => {
            const now = Date.now().toString();

            const responseResolved = path.resolve(__dirname, '../../cache/replicate', now + '-response.json');
            fs.writeFile(responseResolved, JSON.stringify(c, null, 2));

            const content = c.content;
            const contentResolved = path.resolve(__dirname, '../../cache/replicate', now + '-response.txt');
            fs.writeFile(contentResolved, content);
          },
          onError: (a, b, e, d) => {
            const now = Date.now().toString();

            const errorResolved = path.resolve(__dirname, '../../cache/replicate', now + '-error.txt');
            fs.writeFile(errorResolved, String(e));
          },
        },
      },
    }),
  })
  .create({})
;

const jsonReplacer = (key: string, value: any) => {
  if (value instanceof Set) {
    return Array.from(value);
  }
  return value;
};

const typeInfo = await fs.readFile(path.join(__dirname, 'extract.md'), 'utf-8');

/** A group of optional values with nothing set is left out (decoding already drops the nulls a strict model writes). */
const optionalTransform = <T extends object>(val: T | undefined): T | undefined =>
  !val || Object.values(val).every((v) => v === null || v === undefined) ? undefined : val;

const extract = ai.prompt({
  name: 'extract',
  description: 'Extract model information & a transformer definition from Replicate model data',
  content: `Extract model information & a transformer definition from the following data.
  
<modelData>
{{modelData}}
</modelData>

{{#if modelTypes}}
Here are the types for the model based on the OpenAPI schema:
\`\`\`ts
{{modelTypes}}
\`\`\`

Schemas["Input"] is what convertRequest should return.
Schemas["Output"] is what parseResponse is given as the first argument.

These types will be available and can be referenced like above to ensure type safety.
{{/if}}

Create a TypeScript implementation of a ReplicateTransformer for the model.
Here's an example transformer implementation for reference. This is the exact format to follow:
<exampleTransformerImplementation>
{ 
  // this key comes from modelData.owner/modelData.name
  // // The definition is wrapped in an immediately-invoked function expression so any cached or reusable functions can be defined here.
  "google/nano-banana": (() => {
    // you must use this ReplicateTransformer type to avoid TypeScript errors
    const transformer: ReplicateTransformer = { 
      imageGenerate: {
        // only use variable known to be in this request type based on the types below
        convertRequest: async (request, ctx){{#if modelTypes}}: Promise<Schemas["Input"]>{{/if}} => ({ 
          prompt: request.prompt,
          ...request.extra, // always spread extra to allow for additional parameters
        }),
        // only use known output schema from the model and only use properties expected on the response type based on the types below
        parseResponse: async (response{{#if modelTypes}}: Schemas["Output"]{{/if}}, ctx) => ({
          images: [{ url: await toURL(response) }],
          extra: { response }, // include full response in extra object
        }),
      },
      imageEdit: {
        convertRequest: async (request, ctx){{#if modelTypes}}: Promise<Schemas["Input"]>{{/if}} => ({
          prompt: request.prompt,
          image_input: [await toURL(request.image)],
          ...request.extra, // always spread extra to allow for additional parameters
        }),
        parseResponse: async (response{{#if modelTypes}}: Schemas["Output"]{{/if}}, ctx) => ({
          images: [{ url: await toURL(response) }],
          extra: { response }, // include full response in extra object
        }),
      },
    };
    return transformer;
  })(), // immediately invoke the function to return the typed transformer
}
</exampleTransformerImplementation>

The transformer code you return should match EXACTLY the format above. It will be injected in code like so by the developer:
<transformerResult>
import { toURL, toBase64, toText, toStream, toReadableStream, toFile } from '@aeye/core';
import { ReplicateTransformer } from '@aeye/replicate';

const transformer: Record<string, ReplicateTransformer> = <transformerImplementation>;
</transformerResult>

<availableFunctions>
- \`toURL(resource, mimeType?: string, fallback?: string): Promise<string>\` converts to URL string
- \`toBase64(resource, mimeType?: string, fallback?: string): Promise<string>\`
- \`toText(resource, fallback?: string): Promise<string>\`
- \`toStream(resource, fallback?: Readable): Promise<Readable>\`
- \`toReadableStream(resource, fallback?: ReadableStream): Promise<ReadableStream>\`
- \`toFile(resource, mimeType?: string, filename?: string): Promise<File>\`
</availableFunctions>

Here's how the replicate code looks around the transformer: This is an example to illustrate how the transformer you generate is used.
<replicateCode>
// =============================================================
// Execute
// =============================================================
const { convertRequest, parseResponse } = transformer;
const client = new Replicate({ /* config */ });
const input = await convertRequest(request, ctx);
const output = await client.run(modelId, { input, signal });
const response = await parseResponse(output, ctx);

// =============================================================
// Stream
// =============================================================
const { convertRequest, parseChunk } = transformer;
const client = new Replicate({ /* config */ });
const input = await convertRequest(request, ctx);
for await (const event of client.stream(modelId, { input, signal })) {
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  // Parse chunk using transformer
  const chunk = await parseChunk(event, ctx);
  yield chunk;
}
</replicateCode>

Here is type information you need to use to understand the shape of all the types:
It is EXTREMELY important you only use properties that are guaranteed to be present based on the types below when it comes to transformer, request, response, and chunk types.
The request parameters in the converted request should only be the properties that are known to be in the input schema for the model. The rest may be passed in via \`extra\` property.
<typeInfo>
{{typeInfo}}
</typeInfo>
  `,
  strict: true,
  outputRetries: 3,
  schema: a.object({
    transformerImplementation: a.string()
    // .regex(/^\{\n\s+"[^"]+\/[^"]+": \(\(\) => \{(.|\r|\n)*\}\)\(\),\n\}$/)
      .describe(`The TypeScript implementation of the model handler (without imports or \`\`\` marks) - described BETWEEN the <exampleTransformerImplementation> tags. Follow the rules outlined.`),
    modelInfo: a.object({
      capabilities: a.array(a.enum([
        'chat',
        'tools',
        'vision',
        'json',
        'structured',
        'streaming',
        'reasoning',
        'image',
        'audio',
        'hearing',
        'embedding',
        'imageEmbedding',
        'crossModalEmbedding',
        'zdr'
      ])).describe(`Set of capabilities this model supports:

  - chat: Text input & output
  - tools: Ability to make tool calls
  - vision: Image inputs
  - json: Supports JSON response format 
  - structured: Supports structured output (strict JSON response format)
  - streaming: Supports streaming responses
  - reasoning: Enhanced reasoning capabilities
  - image: Image output
  - audio: Audio output
  - hearing: Audio input
  - embedding: Text -> embedding generation
  - imageEmbedding: Image -> embedding generation
  - crossModalEmbedding: Text and image embeddings share one vector space (CLIP-like)
  - zdr: Supports zero-data-retention through a parameter`),
      tier: a.enum(['flagship', 'efficient', 'legacy', 'experimental']).describe(`Model performance and quality tiers.
  Used for categorizing models by their capabilities and cost.
  
  - flagship: Top-tier models with best performance
  - efficient: Smaller, faster, more cost-effective models
  - legacy: Older models, may be deprecated
  - experimental: Preview/beta models`),
      pricing: a.object({
        text: a.object({
          input: a.number().optional(),
          output: a.number().optional(),
          cached: a.number().optional(),
        }).optional(),
        audio: a.object({
          input: a.number().optional(),
          output: a.number().optional(),
          perSecond: a.number().optional(),
        }).optional(),
        image: a.object({
          input: a.number().optional(),
          output: a.array(a.object({
            quality: a.string().describe('Quality level - like low, medium, high'),
            sizes: a.array(a.object({
              width: a.number(),
              height: a.number(),
              cost: a.number().describe('Cost per image in USD'),
            })).describe('Supported image sizes and their costs'),
          })).optional(),
        }).optional(),
        reasoning: a.object({
          input: a.number().optional(),
          output: a.number().optional(),
          cached: a.number().optional(),
        }).optional(),
        embeddings: a.object({
          cost: a.number().optional(),
        }).optional(),
        perRequest: a.number().optional().describe('Flat cost per request in USD'),
      }).describe('Pricing information. input/output/cached are per 1 million tokens unless otherwise specified. Leave null/undefined if unknown - 0 is free. Do not specify 0 unless it is free.'),
      contextWindow: a.number(),
      maxOutputTokens: a.number().optional(),
      metrics: a.object({
        tokensPerSecond: a.number().optional().describe('Processing speed in tokens per second'),
        timeToFirstToken: a.number().optional().describe('Time to first token in milliseconds'),
        averageRequestDuration: a.number().optional().describe('Average request duration in milliseconds'),
        accuracyScore: a.number().optional().describe('Accuracy score based on benchmark tests 0-1'),
      }).optional()
        .describe('Performance metrics if available'),
      tokenizer: a.enum(([
        'Other', 'GPT', 'Mistral', 'Llama3', 'Qwen3', 'Qwen', 'Gemini', 'DeepSeek', 'Claude', 'Grok', 'Llama4', 'Llama2', 'Cohere', 'Nova', 'Router'
      ])).optional().describe('The tokenizer type used by this model if known, otherwise leave undefined'),
      supportedParameters: a.array(a.enum([
        // Chat Request
        'maxTokens', // max_tokens / max_completion_tokens
        'temperature', // temperature
        'topP', // top_p
        'frequencyPenalty', // frequency_penalty
        'presencePenalty', // presence_penalty
        'stop', // stop
        'seed', // seed
        'responseFormat', // response_format
        'structuredOutput', // structured_outputs
        'tools', // tools
        'toolChoice', // tool_choice
        'logitBias', // logit_bias
        'logProbabilities', // logprobs
        'reason', // reasoning
        // Image
        'imageBackground', // background
        'imageMultiple', // n
        'imageFormat', // output_format ()
        'imageStream', // stream / partial_images
        'imageStyle',
        // Embedding
        'embeddingDimensions', // dimensions
        // Transcription
        'transcribeStream', // stream
        'transcribePrompt', // prompt
        // Speech
        'speechInstructions', // instructions
      ])).optional().describe('The supported parameters for this model'),
    }).describe('The extracted model information'),
  }),
  input: async ({ modelData, modelTypes }: { model: string, modelData: ReplicateModelData, modelTypes: string }) => {
    return {
      modelData: JSON.stringify(modelData, (k, v) => {
        if (k === "embeddings" && Array.isArray(v) && v.length > 20) {
          return [`...${v.length} ${typeof v[0]}s...`];
        }
        if (Array.isArray(v) && v.length > 20) {
          return [`...${v.length} ${typeof v[0]}s...`];
        }
        return v;
      }, 2),
      typeInfo,
      modelTypes,
    };
  },
  config: (input) => ({
    model: input?.model,
    temperature: 0,
    topP: 1,
  }),
})

async function extractTypes(model: ReplicateModelData): Promise<string> {
  if (!model.latest_version?.openapi_schema) {
    return '';
  }

  let extracted = await extractSchemasString(model.latest_version.openapi_schema as any);
  if (!extracted) {
    return '';
  }

  return extracted.replaceAll('components["schemas"]', 'Schemas').replaceAll('    ', '  ');
}

async function extractSchemasString(schemaObject: any): Promise<string> {
  try {
    const ast = await openapiTS(schemaObject, {
      propertiesRequiredByDefault: false,
      defaultNonNullable: false,
    });
        
    const printer = ts.createPrinter({ 
      newLine: ts.NewLineKind.LineFeed,
      removeComments: true,
    });
    
    const dummySourceFile = ts.createSourceFile("temp.ts", "", ts.ScriptTarget.ESNext, true);

    const componentsNode = ast.find(node => {
      if (ts.isInterfaceDeclaration(node)) {
        const name = printer.printNode(ts.EmitHint.Unspecified, node.name, dummySourceFile);
        return name === 'components';
      }
      return false;
    }) as ts.InterfaceDeclaration | undefined;

    if (!componentsNode) {
      console.error("Error: Could not find the 'components' node in the generated AST.");
      return "";
    }

    let extractedMembersString = "";

    // Get the inner content of the 'schemas' property
    for (const member of componentsNode.members) {
      if (ts.isPropertySignature(member)) {
        const propName = printer.printNode(ts.EmitHint.Unspecified, member.name, dummySourceFile);
        
        if (propName === 'schemas' && member.type && ts.isTypeLiteralNode(member.type)) {
          member.type.members.forEach(schemaMember => {
            extractedMembersString += printer.printNode(ts.EmitHint.Unspecified, schemaMember, dummySourceFile) + "\n";
          });
          break;
        }
      }
    }

    if (!extractedMembersString.trim()) {
      console.error("Error: Found no user-defined schema types within the 'components.schemas' structure.");
      return "";
    }

    return `type Schemas = {\n    ${extractedMembersString.replaceAll('\n', '\n    ').trim()}\n};`;
  } catch (error) {
    console.error("An unexpected error occurred during schema extraction:", error);
    return "";
  }
}

/**
 * Fetch all models from Replicate collections
 */
async function fetchAllModels(apiKey?: string): Promise<ReplicateModelData[]> {
  console.log('Fetching Replicate models...');

  const client = new Replicate({
    auth: apiKey || process.env.REPLICATE_API_KEY,
  });

  const allModels: ReplicateModelData[] = [];
  const seenModels = new Set<string>();

  // Collections to scrape
  const collections = [
    'text-to-image',
    'image-to-text',
    'text-to-speech',
    'speech-to-text',
    'super-resolution',
    'image-editing',
    'ai-face-generator',
    'ai-music-generation',
    'text-recognition-ocr',
    'flux',
    'ai-image-restoration',
    'text-classification',
    'sketch-to-image',
    'embedding-models',
    'vision-models',
  ];

  console.log(`Fetching models from ${collections.length} collections...`);

  for (const collectionSlug of collections) {
    try {
      console.log(`  Fetching collection: ${collectionSlug}...`);

      const collection = await client.collections.get(collectionSlug);

      if (collection.models) {
        for (const model of collection.models) {
          const modelId = `${(model as any).owner}/${(model as any).name}`;

          // Skip duplicates
          if (seenModels.has(modelId)) {
            continue;
          }

          seenModels.add(modelId);
          allModels.push(model as ReplicateModelData);
        }

        console.log(`    ✓ Found ${collection.models.length} models in ${collectionSlug}`);
      }
    } catch (error) {
      console.log(`    ⚠ Failed to fetch collection ${collectionSlug}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`\n✓ Fetched ${allModels.length} unique Replicate models`);

  return allModels;
}

/**
 * Fetch model details including schema (for cache)
 */
async function fetchModelSchema(
  modelId: string,
  client: Replicate
): Promise<{
  modelId: string;
  data: ReplicateModelData | null;
}> {
  try {
    const [owner, name] = modelId.split('/');
    const model = await client.models.get(owner, name);
    return { modelId, data: model as ReplicateModelData };
  } catch (error) {
    console.log(`  ⚠ Failed to fetch model ${modelId}:`, error instanceof Error ? error.message : error);
    return { modelId, data: null };
  }
}

/**
 * Fetch schemas in parallel with concurrency control
 */
async function fetchSchemasParallel(
  models: ReplicateModelData[],
  apiKey: string,
  concurrency: number = 50
): Promise<Record<string, ReplicateModelData>> {
  console.log(`\nCaching detailed model schemas (concurrency: ${concurrency})...`);

  const client = new Replicate({
    auth: apiKey,
  });

  const schemasCache: Record<string, ReplicateModelData> = {};

  // First, add models that already have schemas
  for (const model of models) {
    const modelId = `${model.owner}/${model.name}`;
    if (model.latest_version?.openapi_schema) {
      schemasCache[modelId] = model;
    }
  }

  // Find models that need schema fetching
  const modelsToFetch = models.filter((model) => {
    return !model.latest_version?.openapi_schema;
  });

  if (modelsToFetch.length === 0) {
    console.log(`✓ All ${models.length} models already have schemas\n`);
    return schemasCache;
  }

  console.log(`  ${Object.keys(schemasCache).length - modelsToFetch.length} models already have schemas`);
  console.log(`  Fetching schemas for ${modelsToFetch.length} models...\n`);

  // Process in batches with concurrency control
  const modelIdsToFetch = modelsToFetch.map((m) => `${m.owner}/${m.name}`);

  for (let i = 0; i < modelIdsToFetch.length; i += concurrency) {
    const batch = modelIdsToFetch.slice(i, i + concurrency);
    console.log(`  Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(modelIdsToFetch.length / concurrency)} (${batch.length} models)...`);

    const batchResults = await Promise.all(
      batch.map((modelId) => fetchModelSchema(modelId, client))
    );

    // Store results
    for (const { modelId, data } of batchResults) {
      if (data) {
        schemasCache[modelId] = data;
      }
    }

    console.log(`    ✓ Fetched ${batchResults.filter((r) => r.data).length}/${batch.length} schemas`);
  }

  console.log(`\n✓ Cached ${Object.keys(schemasCache).length} model schemas\n`);

  return schemasCache;
}

function cleanSchema(model: ReplicateModelData) {
  const schema = model.latest_version?.openapi_schema as any;
  if (schema) {
    // delete schema.components.schemas.Status;
    delete schema.components.schemas.WebhookEvent;
    delete schema.components.schemas.ValidationError;
    delete schema.components.schemas.PredictionRequest;
    delete schema.components.schemas.PredictionResponse;
    delete schema.components.schemas.HTTPValidationError;
  }
}

/**
 * Main scraper function
 */
export async function scrapeReplicate(
  outputDir: string,
  cacheDir?: string,
  options: { 
    concurrency?: number, 
    transformers?: boolean,
    transformerModel: string,
    transformersOnly?: boolean,
    transformConcurrency?: number,
    models?: string[],
    n?: number,
  } = {
    transformerModel: 'google/gemini-2.5-pro',
  }
): Promise<void> {
  const { concurrency = 50 } = options;

  const apiKey = process.env.REPLICATE_API_KEY;
  if (!apiKey) {
    console.error('✗ REPLICATE_API_KEY environment variable is required');
    process.exit(1);
  }

  let models: ReplicateModelData[]

  if (!options.transformersOnly) {
    console.log('\n=== Replicate Scraper ===\n');
    
    // Fetch all models from collections
    models = await fetchAllModels(apiKey);

    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Save raw models data
    await fs.writeFile(
      path.join(outputDir, 'replicate-models.json'),
      JSON.stringify({ data: models }, jsonReplacer, 2)
    );

    console.log(`✓ Saved raw Replicate models to replicate-models.json`);
  } else {
    const modelsData = await fs.readFile(
      path.join(outputDir, 'replicate-models.json'),
      'utf-8'
    );
    const parsed = JSON.parse(modelsData);
    models = parsed.data as ReplicateModelData[];

    console.log(`\n✓ Loaded ${models.length} Replicate models from cache\n`);
  }

  models.forEach(cleanSchema);

  // Sort models by owner/name
  models.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));  

  // Convert to ModelInfo format
  const modelInfos = models.map(convertReplicateModel);

  try {
    const modelInfoCache = await fs.readFile(
      path.join(outputDir, 'replicate-modelinfo.json'),
      'utf-8'
    );
    const parsed = JSON.parse(modelInfoCache) as ModelInfo[];
    for (const info of parsed) {
      const existing = modelInfos.findIndex((m) => m.id === info.id);
      if (existing >= 0) {
        modelInfos[existing] = info;
      }
    }
  } catch (e: any) {
    // Ignore if file doesn't exist
    console.error(`⚠ Could not load existing model info cache: ${e.message}`);
  }

  let schemasCache: Record<string, ReplicateModelData> = {};

  // Create cache directory if specified
  if (cacheDir) {
    if (!options.transformersOnly) {
      await fs.mkdir(cacheDir, { recursive: true });

      // Cache detailed model schemas (for transformer generation)
      schemasCache = await fetchSchemasParallel(models, apiKey, concurrency);

      // Save schemas cache
      await fs.writeFile(
        path.join(cacheDir, 'replicate-schemas.json'),
        JSON.stringify(schemasCache, jsonReplacer, 2)
      );

      console.log(`✓ Saved ${Object.keys(schemasCache).length} model schemas to ${cacheDir}/replicate-schemas.json`);
      console.log('  (This cache file is for transformer generation and should not be committed)');

      // Chunk it up to 80,000 character files for easier loading later
      const chunkSize = 80000;
      const schemaEntries = Object.entries(schemasCache);
      let currentChunk: Record<string, ReplicateModelData> = {};
      let currentSize = 0;
      let chunkIndex = 1;
      for (const [modelId, modelData] of schemaEntries) {
        const entryString = JSON.stringify({ [modelId]: modelData });
        if (currentSize + entryString.length > chunkSize && Object.keys(currentChunk).length > 0) {
          // Save current chunk
          await fs.writeFile(
            path.join(cacheDir, `replicate-schemas-chunk-${chunkIndex}.json`),
            JSON.stringify(currentChunk, null, 2)
          );
          console.log(`✓ Saved schema chunk ${chunkIndex} with ${Object.keys(currentChunk).length} models`);
          chunkIndex++;
          currentChunk = {};
          currentSize = 0;
        }
        currentChunk[modelId] = modelData;
        currentSize += entryString.length;
      }
      // Save any remaining chunk
      if (Object.keys(currentChunk).length > 0) {
        await fs.writeFile(
          path.join(cacheDir, `replicate-schemas-chunk-${chunkIndex}.json`),
          JSON.stringify(currentChunk, null, 2)
        );
        console.log(`✓ Saved schema chunk ${chunkIndex} with ${Object.keys(currentChunk).length} models`);
      }
    } else {
      // Load schemas cache from file
      const schemasData = await fs.readFile(
        path.join(cacheDir, 'replicate-schemas.json'),
        'utf-8'
      );
      schemasCache = JSON.parse(schemasData) as Record<string, ReplicateModelData>;

      console.log(`\n✓ Loaded ${Object.keys(schemasCache).length} model schemas from cache\n`);
    }

    for (const modelData of Object.values(schemasCache)) {
      cleanSchema(modelData);
    }

    // Calculate number of unique schemas
    const uniqueSchemas = new Set<string>();
    for (const modelData of Object.values(schemasCache)) {
      if (modelData.latest_version) {
        uniqueSchemas.add(JSON.stringify(modelData.latest_version.openapi_schema.components.schemas));
      }
    }
  
    console.log(`\n✓ Found ${uniqueSchemas.size} unique model schemas across ${Object.keys(schemasCache).length} models\n`);

    // Generate Model Transformers
    if (options.transformers) {
      console.log('=== Generating Model Transformers ===\n');

      // Create replicate transformers directory
      await fs.mkdir(
        path.join(cacheDir, 'replicate'), 
        { recursive: true }
      );

      let transformingModels = models;
      let overwrite = false;
      
      // Filter to only models with schemas if transformers are desired
      if (options.models && options.models.length > 0) {
        const modelSet = new Set(options.models);
        transformingModels = transformingModels.filter((model) => {
          const modelId = `${model.owner}/${model.name}`;
          return modelSet.has(modelId);
        });
        overwrite = true;
      }

      // If models were not specified, filter out already transformed models
      if (!overwrite) {
        const alreadyTransformed = await fs.readdir(
          path.resolve(cacheDir, '../src/transformers/replicate'),
        );
        const alreadyTransformedSet = new Set(
          alreadyTransformed
            .filter((filename) => filename.endsWith('.ts') && filename !== 'index.ts')
            .map((filename) => filename.replace('.ts', ''))
        );
        transformingModels = transformingModels.filter((model) => {
          const modelId = `${model.owner}/${model.name}`;
          const transformedFile = modelId.replace(/[^\w]/g, '-');

          return !alreadyTransformedSet.has(transformedFile);
        });
      }

      // Only first N models if specified
      if (options.n && options.n > 0) {
        transformingModels = transformingModels.slice(0, options.n);
      }

      // Call extractor for each model
      console.log(`Generating transformers for ${transformingModels.length} models...\n`);

      // Use specified concurrency for transformations
      const concurrency = options.transformConcurrency !== undefined && options.transformConcurrency <= 0 
        ? transformingModels.length
        : options.transformConcurrency ?? 1;

      let nextModelIndex = 0;

      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        const worker = (async () => {
          while (nextModelIndex < transformingModels.length) {
            const model = transformingModels[nextModelIndex];
            nextModelIndex++;
            const modelId = `${model.owner}/${model.name}`;
            const transformedFile = modelId.replace(/[^\w]/g, '-') + '.ts';
            const modelData = schemasCache[modelId] || model;

            console.log(`\n--- Generating transformer for model: ${modelId},  ---`);

            try {
              const modelTypes = await extractTypes(modelData);

              const result = await extract.get('result', { 
                modelData, 
                modelTypes,
                model: options.transformerModel 
              });
              if (!result) {
                console.log(`  ✗ Failed to generate transformer for model: ${modelId}`);
                continue;
              }

              const converted = convertReplicateModel(modelData);

              const translatedModelInfo: ModelInfo<'replicate'> = {
                id: converted.id,
                provider: 'replicate',
                name: converted.name,
                contextWindow: result.modelInfo.contextWindow,
                maxOutputTokens: result.modelInfo.maxOutputTokens,
                pricing: Object.fromEntries(Object.entries(result.modelInfo.pricing).filter(([, v]) => typeof v !== 'object' || optionalTransform(v) !== undefined)),
                tier: result.modelInfo.tier,
                capabilities: new Set(result.modelInfo.capabilities),
                metrics: optionalTransform(result.modelInfo.metrics),
                tokenizer: result.modelInfo.tokenizer,
                supportedParameters: new Set(result.modelInfo.supportedParameters),
                metadata: converted.metadata,
              };

              const replaceIndex = modelInfos.findIndex((m) => m.id === translatedModelInfo.id);
              if (replaceIndex >= 0) {
                modelInfos[replaceIndex] = translatedModelInfo;
              } else {
                console.log(`  ⚠ ModelInfo for ${modelId} not found in main list, adding new entry`);
              }

              let fixedTransformerImplementation = result.transformerImplementation;
              if (fixedTransformerImplementation.startsWith('"')) {
                fixedTransformerImplementation = `{\n  ${fixedTransformerImplementation}\n}`;
              }

              const coreImports = [
                fixedTransformerImplementation.includes('toURL') ? 'toURL' : null,
                fixedTransformerImplementation.includes('toBase64') ? 'toBase64' : null,
                fixedTransformerImplementation.includes('toText') ? 'toText' : null,
                fixedTransformerImplementation.includes('toStream') ? 'toStream' : null,
                fixedTransformerImplementation.includes('toReadableStream') ? 'toReadableStream' : null,
                fixedTransformerImplementation.includes('toFile') ? 'toFile' : null,
              ].filter((i) => i !== null) as string[];

              const validatedFile = path.resolve(cacheDir, '../src/transformers/replicate', transformedFile);
              await fs.writeFile(
                validatedFile,
                `
${coreImports.length > 0 ? `import { ${coreImports.join(', ')} } from '@aeye/core';` : ''}
import { ReplicateTransformer } from '@aeye/replicate';

${modelTypes}

export default ${fixedTransformerImplementation}
`.trim()
              );

              if (await isValidTypeScript(validatedFile)) {
                console.log(`  ✓ Validated transformer implementation for ${modelId}`);
              } else {
                console.log(`  ✗ Generated transformer for model ${modelId} is not valid TypeScript, skipping save.`);
                await fs.rename(validatedFile, validatedFile + '.invalid');
                continue; 
              }
            } catch (e: any) {
              console.log(`  ✗ Error generating transformer for model ${modelId}:`, e instanceof Error ? e.message : e);
            }
          }        
        })();
        workers.push(worker);
      }

      await Promise.all(workers);

      console.log(`\n✓ Generated transformers for ${transformingModels.length} models in ${path.join(cacheDir, 'replicate')}\n`);

      // Generate index file
      const transformerTarget = path.join(__dirname, '../../src/transformers/replicate');
      const transformerFiles = await fs.readdir(transformerTarget);
      const transformerSet = new Set(
        transformerFiles
          .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
          .map((f) => f.replace('.ts', ''))
      );

      // // For each file
      // import name from './name.ts';

      // // Final export
      // export const replicateTransformers: Record<string, ReplicateTransformer> = {
      //   ...name,
      // };

      await fs.writeFile(
        path.join(transformerTarget, 'index.ts'),
        `
import { ReplicateTransformer } from '@aeye/replicate';

${Array.from(transformerSet).map((name) => `import ${name.replace(/-/g, '_')} from './${name}';`).join('\n')}

export const replicateTransformers: Record<string, ReplicateTransformer> = {
  ${Array.from(transformerSet).map((name) => `...${name.replace(/-/g, '_')},`).join('\n  ')}
};`.trim()
      );
      
      console.log(`✓ Generated Replicate transformers index file\n`);
    }
  }

  // Save JSON for reference
  await fs.writeFile(
    path.join(outputDir, 'replicate-modelinfo.json'),
    JSON.stringify(modelInfos, jsonReplacer, 2)
  );
  console.log(`✓ Saved ${modelInfos.length} models to JSON`);

  // Generate TypeScript file
  const srcDir = path.join(__dirname, '../../src/models');
  await writeModelTS(modelInfos, 'replicateModels', path.join(srcDir, 'replicate.ts'));
  console.log(`✓ Generated TypeScript file: src/models/replicate.ts`);

  console.log('\n✓ Replicate scraping complete\n');
}

function isValidTypeScript(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tsc = spawn('npx', ['tsc', '--noEmit', '--skipLibCheck', file], {
      shell: true,
    });
    
    tsc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    
    tsc.on('error', (error) => {
      reject(error);
    });
  });
}

// CLI execution
if (process.argv[1].endsWith('replicate.ts')) {
  const cleanArg = (a: string) => (/^["'`](.*)["'`]$/.exec(a) || ['', a])[1];

  const args = process.argv.slice(2).map(cleanArg);

  const outputDir = args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '../../data');
  const cacheDir = args.find((arg, i) => i > 0 && !arg.startsWith('--') && !args[i - 1].startsWith('--')) || path.join(__dirname, '../../cache');

  const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg
    ? parseInt(concurrencyArg.split('=')[1], 10)
    : 50;

  const transformers = args.includes('--transformers');

  const transformersOnly = args.includes('--transformers-only');

  const transformerModelArg = args.find((arg) => arg.startsWith('--transformer-model='));
  const transformerModel = transformerModelArg
    ? cleanArg(transformerModelArg.split('=', 2)[1])
    : 'google/gemini-2.5-pro';

  const modelsArg = args.find((arg) => arg.startsWith('--models='));
  let models: string[] | undefined = undefined;
  if (modelsArg) {
    models = modelsArg.substring(9).split(',').map((m) => m.trim());
    models = models.map(cleanArg)
    models = models.filter((m) => m.length > 0);
  }

  const nArg = args.find((arg) => arg.startsWith('--n='));;
  const n = nArg ? parseInt(cleanArg(nArg.split('=')[1]), 10) : undefined;

  const transformConcurrencyArg = args.find((arg) => arg.startsWith('--transform-concurrency='));
  const transformConcurrency = transformConcurrencyArg
    ? parseInt(transformConcurrencyArg.split('=')[1], 10)
    : concurrency;

  const params = { concurrency, transformers, transformersOnly, transformerModel, transformConcurrency, models, n };

  console.debug('Scrape parameters:', { outputDir, cacheDir, ...params });

  scrapeReplicate(outputDir, cacheDir, params).catch((error) => {
    console.error('✗ Replicate scraping failed:', error);
    process.exit(1);
  });
}
